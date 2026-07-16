import { json } from "@remix-run/node";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";
import isoCountries from "i18n-iso-countries";
import jaLocale from "i18n-iso-countries/langs/ja.json";
import { useEffect, useMemo, useState } from "react";

import VendorManagementShell from "../components/vendor/VendorManagementShell";

isoCountries.registerLocale(jaLocale);

const RETURN_COUNTRY_OPTIONS = Object.entries(
  isoCountries.getNames("ja", { select: "official" }),
)
  .map(([code, label]) => ({ code, label }))
  .sort((left, right) => {
    if (left.code === "JP") return -1;
    if (right.code === "JP") return 1;
    return left.label.localeCompare(right.label, "ja-JP");
  });

const JAPAN_PREFECTURES = [
  "北海道",
  "青森県",
  "岩手県",
  "宮城県",
  "秋田県",
  "山形県",
  "福島県",
  "茨城県",
  "栃木県",
  "群馬県",
  "埼玉県",
  "千葉県",
  "東京都",
  "神奈川県",
  "新潟県",
  "富山県",
  "石川県",
  "福井県",
  "山梨県",
  "長野県",
  "岐阜県",
  "静岡県",
  "愛知県",
  "三重県",
  "滋賀県",
  "京都府",
  "大阪府",
  "兵庫県",
  "奈良県",
  "和歌山県",
  "鳥取県",
  "島根県",
  "岡山県",
  "広島県",
  "山口県",
  "徳島県",
  "香川県",
  "愛媛県",
  "高知県",
  "福岡県",
  "佐賀県",
  "長崎県",
  "熊本県",
  "大分県",
  "宮崎県",
  "鹿児島県",
  "沖縄県",
];

export const loader = async ({ request }) => {
  const { requireVendorContext, getVendorPublicContext } =
    await import("../services/vendorManagement.server.js");
  const { getVendorReturnAddressState } =
    await import("../services/withdrawalDirectReturns.server.js");
  const { vendor, store } = await requireVendorContext(request);
  const addressState = await getVendorReturnAddressState(store.id);

  return json({
    ...getVendorPublicContext(vendor, store),
    addressState,
  });
};

export const action = async ({ request }) => {
  const { requireVendorContext } =
    await import("../services/vendorManagement.server.js");
  const {
    activateVendorReturnAddress,
    returnAddressFromFormData,
    saveVendorReturnAddressDraft,
  } = await import("../services/withdrawalDirectReturns.server.js");
  const { vendor, store } = await requireVendorContext(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "save_draft");

  if (intent === "save_draft") {
    const result = await saveVendorReturnAddressDraft({
      vendorStoreId: store.id,
      values: returnAddressFromFormData(formData),
      changedBy: `vendor:${vendor.id}`,
    });
    return json(result, { status: result.status || (result.ok ? 200 : 400) });
  }

  if (intent === "activate") {
    const result = await activateVendorReturnAddress({
      vendorStoreId: store.id,
      draftId: formData.get("draftId"),
      changedBy: `vendor:${vendor.id}`,
    });
    return json(result, { status: result.status || (result.ok ? 200 : 400) });
  }

  return json({ ok: false, error: "unsupported_intent" }, { status: 400 });
};

function initialValues(address) {
  return {
    recipientName: address?.recipientName || "",
    postalCode: address?.postalCode || "",
    countryCode: address?.countryCode || "JP",
    region: address?.region || "",
    city: address?.city || "",
    address1: address?.address1 || "",
    address2: address?.address2 || "",
    phone: address?.phone || "",
    instructions: address?.instructions || "",
  };
}

function isAddressConfirmed(address) {
  return Boolean(
    address?.confirmedAt &&
    address?.canReceiveReturnsConfirmed &&
    address?.buyerDisclosureConfirmed &&
    address?.legalRecipientConfirmed,
  );
}

function postalDigits(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

export default function VendorReturnAddressPage() {
  const { vendor, store, addressState } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const draft = addressState.draft;
  const active = addressState.active;
  const [values, setValues] = useState(() => initialValues(draft || active));
  const [confirmed, setConfirmed] = useState(() => isAddressConfirmed(draft));
  const [postalState, setPostalState] = useState({
    status: "idle",
    candidates: [],
  });
  const isSubmitting = navigation.state === "submitting";
  const draftConfirmed = isAddressConfirmed(draft);
  const countryLabel = useMemo(
    () =>
      RETURN_COUNTRY_OPTIONS.find(
        (country) => country.code === values.countryCode,
      )?.label || values.countryCode,
    [values.countryCode],
  );

  useEffect(() => {
    const normalized = postalDigits(values.postalCode);
    if (values.countryCode !== "JP" || normalized.length !== 7) {
      setPostalState({ status: "idle", candidates: [] });
      return undefined;
    }

    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      setPostalState({ status: "loading", candidates: [] });
      const params = new URLSearchParams({
        countryCode: "JP",
        postalCode: normalized,
        vendorId: vendor.id,
      });
      try {
        const response = await fetch(`/api/postal-address?${params}`, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok || !result.ok || !result.found) {
          setPostalState({
            status:
              result.error === "invalid_postal_code" ? "idle" : "not-found",
            candidates: [],
          });
          return;
        }
        const candidates = result.candidates || [];
        const first = candidates[0];
        setValues((current) => ({
          ...current,
          postalCode: result.postalCode || current.postalCode,
          region: first?.region || current.region,
          city: first?.city || current.city,
          address1: first?.address1 || current.address1,
        }));
        setPostalState({ status: "found", candidates, selectedIndex: 0 });
      } catch (error) {
        if (error?.name !== "AbortError") {
          setPostalState({ status: "error", candidates: [] });
        }
      }
    }, 450);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [values.countryCode, values.postalCode, vendor.id]);

  function updateValue(name, value) {
    setValues((current) => ({ ...current, [name]: value }));
    setConfirmed(false);
  }

  function applyPostalCandidate(index) {
    const candidate = postalState.candidates[index];
    if (!candidate) return;
    setValues((current) => ({
      ...current,
      region: candidate.region,
      city: candidate.city,
      address1: candidate.address1,
    }));
    setConfirmed(false);
    setPostalState((current) => ({ ...current, selectedIndex: index }));
  }

  return (
    <VendorManagementShell
      activeItem="return-address"
      storeName={store.storeName}
      title="返品受取先"
    >
      {actionData?.ok ? (
        <div
          className="vendor-note"
          style={{ color: "#047857", background: "#ecfdf5" }}
        >
          {navigation.formData?.get("intent") === "activate"
            ? "返品受取先を有効にしました。"
            : "下書きを保存しました。"}
        </div>
      ) : null}
      {actionData && !actionData.ok ? (
        <div className="vendor-note vendor-note--danger">
          {errorMessage(actionData.error, actionData.errors)}
        </div>
      ) : null}

      <section className="vendor-card">
        <h2 className="vendor-section-title">現在の状態</h2>
        <p className="vendor-section-subtitle">
          商品の返品を実際に受け取れる住所だけを登録してください。店舗情報の住所は自動利用されません。
        </p>
        <div className="vendor-description-list">
          <div className="vendor-description-row">
            <div className="vendor-description-term">有効な返送先</div>
            <div className="vendor-description-value">
              {active ? formatAddress(active) : "未設定"}
            </div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">下書き</div>
            <div className="vendor-description-value">
              {draft ? `バージョン ${draft.version}` : "なし"}
            </div>
          </div>
        </div>
      </section>

      <section className="vendor-card">
        <h2 className="vendor-section-title">返送先を登録・更新</h2>
        <p className="vendor-section-subtitle">
          まず下書きを保存し、内容を確認してから有効化します。既に購入者へ送信済みの住所は変更されません。
        </p>
        <Form method="post" className="vendor-form">
          <input type="hidden" name="intent" value="save_draft" />
          <input type="hidden" name="countryLabel" value={countryLabel} />

          <div className="return-address-grid">
            <TextField
              autoComplete="name"
              label="宛名"
              name="recipientName"
              onChange={updateValue}
              required
              value={values.recipientName}
            />
            <TextField
              autoComplete="tel"
              inputMode="tel"
              label="電話番号"
              name="phone"
              onChange={updateValue}
              placeholder="例：03-1234-5678"
              value={values.phone}
            />

            <SelectField
              autoComplete="country"
              label="国・地域"
              name="countryCode"
              onChange={updateValue}
              required
              value={values.countryCode}
            >
              {RETURN_COUNTRY_OPTIONS.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.label}（{country.code}）
                </option>
              ))}
            </SelectField>
            <div className="vendor-form__field">
              <label className="vendor-form__label" htmlFor="postalCode">
                郵便番号
              </label>
              <input
                aria-describedby="postal-lookup-status"
                autoComplete="postal-code"
                className="vendor-form__input"
                id="postalCode"
                inputMode={values.countryCode === "JP" ? "numeric" : "text"}
                maxLength={values.countryCode === "JP" ? 8 : undefined}
                name="postalCode"
                onChange={(event) =>
                  updateValue("postalCode", event.target.value)
                }
                placeholder={
                  values.countryCode === "JP"
                    ? "例：100-0001"
                    : "郵便番号を入力"
                }
                required
                type="text"
                value={values.postalCode}
              />
              {values.countryCode === "JP" ? (
                <div
                  className={`return-address-lookup return-address-lookup--${postalState.status}`}
                  id="postal-lookup-status"
                  aria-live="polite"
                >
                  {postalLookupMessage(postalState.status)}
                </div>
              ) : null}
            </div>

            {postalState.candidates.length > 1 ? (
              <label className="vendor-form__field return-address-grid__wide">
                <span className="vendor-form__label">住所候補</span>
                <select
                  className="vendor-form__select"
                  onChange={(event) =>
                    applyPostalCandidate(Number(event.target.value))
                  }
                  value={postalState.selectedIndex || 0}
                >
                  {postalState.candidates.map((candidate, index) => (
                    <option
                      key={`${candidate.region}-${candidate.city}-${candidate.address1}`}
                      value={index}
                    >
                      {candidate.region} {candidate.city} {candidate.address1}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {values.countryCode === "JP" ? (
              <SelectField
                autoComplete="address-level1"
                label="都道府県"
                name="region"
                onChange={updateValue}
                required
                value={values.region}
              >
                <option value="">選択してください</option>
                {JAPAN_PREFECTURES.map((prefecture) => (
                  <option key={prefecture} value={prefecture}>
                    {prefecture}
                  </option>
                ))}
              </SelectField>
            ) : (
              <TextField
                autoComplete="address-level1"
                label="州・都道府県・地域"
                name="region"
                onChange={updateValue}
                value={values.region}
              />
            )}
            <TextField
              autoComplete="address-level2"
              label="市区町村"
              name="city"
              onChange={updateValue}
              required
              value={values.city}
            />
            <TextField
              autoComplete="address-line1"
              className="return-address-grid__wide"
              label={values.countryCode === "JP" ? "町名・番地" : "住所1"}
              name="address1"
              onChange={updateValue}
              placeholder={
                values.countryCode === "JP" ? "例：千代田1-1" : undefined
              }
              required
              value={values.address1}
            />
            <TextField
              autoComplete="address-line2"
              className="return-address-grid__wide"
              label="建物名・部屋番号"
              name="address2"
              onChange={updateValue}
              value={values.address2}
            />
          </div>

          <label className="vendor-form__field">
            <span className="vendor-form__label">返送時の注意事項</span>
            <textarea
              className="vendor-form__textarea"
              name="instructions"
              onChange={(event) =>
                updateValue("instructions", event.target.value)
              }
              placeholder="例：平日10時から17時に受け取れます。"
              rows={4}
              value={values.instructions}
            />
          </label>

          <label className="return-address-confirmation">
            <input
              checked={confirmed}
              name="returnAddressConfirmed"
              onChange={(event) => setConfirmed(event.target.checked)}
              type="checkbox"
            />
            <span>
              <strong>この住所を返品受取先として確認しました</strong>
              <small>
                当店舗または正当に指定した受取人が返品を受領でき、返送案内時に購入者へ住所が開示されます。
              </small>
            </span>
          </label>

          <div className="vendor-form__actions">
            <button
              className="vendor-shell__button"
              disabled={isSubmitting}
              type="submit"
            >
              下書きを保存
            </button>
          </div>
        </Form>
      </section>

      {draft ? (
        <section className="vendor-card">
          <h2 className="vendor-section-title">下書きを有効化</h2>
          <p className="vendor-section-subtitle">
            {draftConfirmed
              ? "内容を確認し、この返送先を購入者への案内に使用できる状態にします。以前の住所は履歴として保持されます。"
              : "上の確認欄を選択して下書きを保存すると、有効化できます。"}
          </p>
          <Form method="post">
            <input type="hidden" name="intent" value="activate" />
            <input type="hidden" name="draftId" value={draft.id} />
            <button
              className="vendor-shell__button vendor-shell__button--primary"
              disabled={isSubmitting || !draftConfirmed}
              type="submit"
            >
              この返送先を有効にする
            </button>
          </Form>
        </section>
      ) : null}

      <style>{`
        .return-address-grid{
          display:grid;
          grid-template-columns:repeat(2,minmax(0,1fr));
          gap:20px;
        }
        .return-address-grid__wide{
          grid-column:1 / -1;
        }
        .return-address-lookup{
          min-height:20px;
          color:#6b7280;
          font-size:13px;
          line-height:1.5;
        }
        .return-address-lookup--found{ color:#047857; }
        .return-address-lookup--not-found,
        .return-address-lookup--error{ color:#9a3412; }
        .return-address-confirmation{
          display:flex;
          align-items:flex-start;
          gap:12px;
          padding:16px;
          border:1px solid #d1d5db;
          border-radius:8px;
          background:#f9fafb;
          cursor:pointer;
        }
        .return-address-confirmation input{
          width:18px;
          height:18px;
          margin:2px 0 0;
          flex:0 0 auto;
        }
        .return-address-confirmation span{
          display:grid;
          gap:4px;
          color:#111827;
          font-size:14px;
          line-height:1.6;
        }
        .return-address-confirmation small{
          color:#6b7280;
          font-size:13px;
        }
        @media (max-width:760px){
          .return-address-grid{ grid-template-columns:1fr; }
          .return-address-grid__wide{ grid-column:auto; }
        }
      `}</style>
    </VendorManagementShell>
  );
}

function TextField({
  className = "",
  label,
  name,
  onChange,
  value,
  required = false,
  ...inputProps
}) {
  return (
    <label className={`vendor-form__field ${className}`.trim()}>
      <span className="vendor-form__label">{label}</span>
      <input
        {...inputProps}
        className="vendor-form__input"
        name={name}
        onChange={(event) => onChange(name, event.target.value)}
        required={required}
        type="text"
        value={value}
      />
    </label>
  );
}

function SelectField({
  children,
  label,
  name,
  onChange,
  value,
  required = false,
  ...selectProps
}) {
  return (
    <label className="vendor-form__field">
      <span className="vendor-form__label">{label}</span>
      <select
        {...selectProps}
        className="vendor-form__select"
        name={name}
        onChange={(event) => onChange(name, event.target.value)}
        required={required}
        value={value}
      >
        {children}
      </select>
    </label>
  );
}

function postalLookupMessage(status) {
  if (status === "loading") return "郵便番号から住所を検索しています。";
  if (status === "found")
    return "住所を自動入力しました。番地以降を確認してください。";
  if (status === "not-found")
    return "住所が見つかりませんでした。手入力してください。";
  if (status === "error")
    return "住所検索を利用できません。手入力はそのまま行えます。";
  return "7桁を入力すると住所を自動入力します。";
}

function formatAddress(address) {
  return [
    address.recipientName,
    address.postalCode,
    address.countryLabel || address.countryCode,
    address.region,
    address.city,
    address.address1,
    address.address2,
  ]
    .filter(Boolean)
    .join(" ");
}

function errorMessage(error, errors) {
  if (error === "confirmation_required")
    return "返送先の確認を選択して下書きを保存してください。";
  if (error === "draft_not_found") return "有効化する下書きが見つかりません。";
  if (errors && Object.keys(errors).length)
    return "必須項目を入力してください。";
  return "処理できませんでした。入力内容を確認してください。";
}

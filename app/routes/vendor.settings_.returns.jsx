import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";

import VendorManagementShell from "../components/vendor/VendorManagementShell";

export const loader = async ({ request }) => {
  const { requireVendorContext, getVendorPublicContext } = await import(
    "../services/vendorManagement.server.js"
  );
  const { getVendorReturnAddressState } = await import(
    "../services/withdrawalDirectReturns.server.js"
  );
  const { vendor, store } = await requireVendorContext(request);
  const addressState = await getVendorReturnAddressState(store.id);

  return json({
    ...getVendorPublicContext(vendor, store),
    addressState,
  });
};

export const action = async ({ request }) => {
  const { requireVendorContext } = await import(
    "../services/vendorManagement.server.js"
  );
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
    countryLabel: address?.countryLabel || "日本",
    region: address?.region || "",
    city: address?.city || "",
    address1: address?.address1 || "",
    address2: address?.address2 || "",
    phone: address?.phone || "",
    instructions: address?.instructions || "",
  };
}

export default function VendorReturnAddressPage() {
  const { store, addressState } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const draft = addressState.draft;
  const active = addressState.active;
  const values = initialValues(draft || active);
  const isSubmitting = navigation.state === "submitting";

  return (
    <VendorManagementShell
      activeItem="return-address"
      storeName={store.storeName}
      title="返品受取先"
    >
      {actionData?.ok ? (
        <div className="vendor-note" style={{ color: "#047857", background: "#ecfdf5" }}>
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
          <div className="vendor-form__grid">
            <Field label="宛名" name="recipientName" value={values.recipientName} required />
            <Field label="郵便番号" name="postalCode" value={values.postalCode} required />
            <Field label="国・地域コード" name="countryCode" value={values.countryCode} required />
            <Field label="国・地域名" name="countryLabel" value={values.countryLabel} />
            <Field label="都道府県・州" name="region" value={values.region} />
            <Field label="市区町村" name="city" value={values.city} />
            <Field label="住所" name="address1" value={values.address1} required />
            <Field label="建物名・部屋番号" name="address2" value={values.address2} />
            <Field label="電話番号" name="phone" value={values.phone} />
          </div>
          <label className="vendor-form__field">
            <span className="vendor-form__label">返送時の注意事項</span>
            <textarea
              className="vendor-form__input"
              name="instructions"
              defaultValue={values.instructions}
              rows={4}
            />
          </label>
          <div className="vendor-form__field" style={{ gap: 10 }}>
            <Check name="canReceiveReturnsConfirmed">
              この住所で返品商品を実際に受け取れます。
            </Check>
            <Check name="buyerDisclosureConfirmed">
              返送案内時に、この住所が購入者へ開示されることを確認しました。
            </Check>
            <Check name="legalRecipientConfirmed">
              当店舗または正当に指定した受取人の住所です。
            </Check>
          </div>
          <div className="vendor-form__actions">
            <button className="vendor-shell__button" disabled={isSubmitting} type="submit">
              下書きを保存
            </button>
          </div>
        </Form>
      </section>

      {draft ? (
        <section className="vendor-card">
          <h2 className="vendor-section-title">下書きを有効化</h2>
          <p className="vendor-section-subtitle">
            3つの確認に同意した下書きだけを有効化できます。以前の住所は履歴として保持されます。
          </p>
          <Form method="post">
            <input type="hidden" name="intent" value="activate" />
            <input type="hidden" name="draftId" value={draft.id} />
            <button
              className="vendor-shell__button vendor-shell__button--primary"
              disabled={isSubmitting}
              type="submit"
            >
              この返送先を有効にする
            </button>
          </Form>
        </section>
      ) : null}
    </VendorManagementShell>
  );
}

function Field({ label, name, value, required = false }) {
  return (
    <label className="vendor-form__field">
      <span className="vendor-form__label">{label}</span>
      <input
        className="vendor-form__input"
        name={name}
        defaultValue={value}
        required={required}
        type="text"
      />
    </label>
  );
}

function Check({ name, children }) {
  return (
    <label style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
      <input name={name} type="checkbox" style={{ marginTop: 4 }} />
      <span>{children}</span>
    </label>
  );
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
  if (error === "confirmation_required") return "3つの確認をすべて選択して保存してください。";
  if (error === "draft_not_found") return "有効化する下書きが見つかりません。";
  if (errors && Object.keys(errors).length) return "必須項目を入力してください。";
  return "処理できませんでした。入力内容を確認してください。";
}

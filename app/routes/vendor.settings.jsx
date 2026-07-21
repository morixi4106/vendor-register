import { json, redirect } from "@remix-run/node";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";
import VendorManagementShell from "../components/vendor/VendorManagementShell";
import { useVendorScopedPath } from "../components/vendor/vendorNavigation";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function badgeClass(label) {
  const dangerLabels = ["要確認", "差し戻し", "停止中", "制限あり"];
  const warningLabels = ["審査中", "申請中", "公開準備中", "確認中"];
  const successLabels = ["承認済み", "稼働中", "公開済み"];
  let tone = "neutral";

  if (dangerLabels.includes(label)) tone = "danger";
  if (warningLabels.includes(label)) tone = "warning";
  if (successLabels.includes(label)) tone = "success";

  return `vendor-shell__badge vendor-shell__badge--${tone}`;
}

function createFormValues(values = {}) {
  return {
    storeName: String(values.storeName || "").trim(),
    managementEmail: String(values.managementEmail || "").trim(),
  };
}

export const loader = async ({ request }) => {
  const { getVendorPublicContext, requireVendorContext } = await import(
    "../services/vendorManagement.server"
  );
  const { vendor, store } = await requireVendorContext(request);
  const { getVendorGovernanceSettings } = await import(
    "../services/marketplaceGovernance.server.js"
  );
  const url = new URL(request.url);
  const governance = await getVendorGovernanceSettings({
    vendorId: vendor.id,
    vendorStoreId: store.id,
  });

  return json({
    ...getVendorPublicContext(vendor, store),
    saved: url.searchParams.get("saved") === "1",
    governance,
  });
};

export const action = async ({ request }) => {
  const {
    appendVendorIdToPath,
    requireVendorContext,
    updateVendorSettings,
  } = await import(
    "../services/vendorManagement.server"
  );
  const { vendor, store } = await requireVendorContext(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "save");

  if (intent === "save_compliance_profile") {
    const {
      getVendorGovernanceSettings,
      sellerComplianceProfileFromFormData,
      upsertSellerComplianceProfile,
    } = await import("../services/marketplaceGovernance.server.js");
    const governance = await getVendorGovernanceSettings({
      vendorId: vendor.id,
      vendorStoreId: store.id,
    });
    if (!governance?.seller?.id) {
      return json({ ok: false, formError: "出店者情報が見つかりません。" }, { status: 404 });
    }
    const values = sellerComplianceProfileFromFormData(formData);
    if (
      values.entityType === "UNSET" ||
      !values.legalName ||
      !values.countryCode ||
      !values.address1 ||
      !values.antisocialDeclarationAt ||
      !values.shipFromConfirmedAt ||
      !values.privacyNoticeAcceptedAt
    ) {
      return json(
        { ok: false, formError: "法的情報と3つの確認事項をすべて入力してください。" },
        { status: 400 },
      );
    }
    await upsertSellerComplianceProfile({
      sellerId: governance.seller.id,
      values,
    });
    return redirect(appendVendorIdToPath("/vendor/settings?saved=1", vendor.id));
  }

  if (intent === "accept_seller_agreement") {
    const {
      getCurrentSellerAgreementDocumentHash,
      getVendorGovernanceSettings,
      recordSellerAgreementAcceptance,
    } = await import("../services/marketplaceGovernance.server.js");
    const governance = await getVendorGovernanceSettings({
      vendorId: vendor.id,
      vendorStoreId: store.id,
    });
    const documentHash = getCurrentSellerAgreementDocumentHash(process.env);
    if (
      !governance?.seller?.id ||
      governance.agreementVersion === "UNCONFIGURED" ||
      !governance.agreementUrl ||
      !documentHash
    ) {
      return json(
        { ok: false, formError: "出店者契約の本文、版、または文書ハッシュが未設定です。運営へ連絡してください。" },
        { status: 503 },
      );
    }
    if (formData.get("agreementConfirmed") !== "on") {
      return json({ ok: false, formError: "契約内容への同意を確認してください。" }, { status: 400 });
    }
    await recordSellerAgreementAcceptance({
      sellerId: governance.seller.id,
      version: governance.agreementVersion,
      documentHash,
      acceptedBy: vendor.managementEmail,
      source: "VENDOR_SETTINGS",
      ipAddress:
        request.headers.get("cf-connecting-ip") ||
        request.headers.get("x-forwarded-for"),
      userAgent: request.headers.get("user-agent"),
    });
    return redirect(appendVendorIdToPath("/vendor/settings?saved=1", vendor.id));
  }

  if (intent !== "save") {
    return json(
      {
        ok: false,
        formError: "未対応の操作です。",
        fieldErrors: {},
        values: createFormValues(),
      },
      { status: 400 }
    );
  }

  const values = createFormValues({
    storeName: formData.get("storeName"),
    managementEmail: formData.get("managementEmail"),
  });
  const fieldErrors = {};

  if (!values.storeName) {
    fieldErrors.storeName = "店舗名を入力してください。";
  }

  if (!values.managementEmail) {
    fieldErrors.managementEmail = "管理メールを入力してください。";
  } else if (!EMAIL_PATTERN.test(values.managementEmail)) {
    fieldErrors.managementEmail = "管理メールの形式を確認してください。";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return json(
      {
        ok: false,
        formError: "入力内容を確認してください。",
        fieldErrors,
        values,
      },
      { status: 400 }
    );
  }

  const result = await updateVendorSettings({
    vendorId: vendor.id,
    storeId: store.id,
    storeName: values.storeName,
    managementEmail: values.managementEmail,
  });

  if (!result.ok) {
    return json(
      {
        ok: false,
        formError: result.publicError,
        fieldErrors: {},
        values,
      },
      { status: result.status }
    );
  }

  return redirect(appendVendorIdToPath("/vendor/settings?saved=1", vendor.id));
};

export default function VendorSettingsPage() {
  const actionData = useActionData();
  const navigation = useNavigation();
  const { vendor, store, saved, governance } = useLoaderData();
  const monthlyReportPath = useVendorScopedPath("/vendor/reports/monthly");
  const isSaving =
    navigation.state !== "idle" && navigation.formMethod?.toLowerCase() === "post";
  const fieldErrors = actionData?.fieldErrors || {};
  const formValues =
    actionData?.values ||
    createFormValues({
      storeName: store.storeName,
      managementEmail: vendor.managementEmail,
    });
  const formKey = `${formValues.storeName}:${formValues.managementEmail}:${saved ? "saved" : "idle"}:${actionData?.formError || ""}`;

  return (
    <VendorManagementShell
      activeItem="settings"
      storeName={store.storeName}
      title="設定"
    >
      {saved ? (
        <section className="vendor-card">
          <div
            className="vendor-note"
            style={{
              borderColor: "#a7f3d0",
              background: "#ecfdf5",
              color: "#047857",
            }}
          >
            保存しました。
          </div>
        </section>
      ) : null}

      {actionData?.formError ? (
        <section className="vendor-card">
          <div className="vendor-note vendor-note--danger">{actionData.formError}</div>
        </section>
      ) : null}

      <section className="vendor-card">
        <h2 className="vendor-section-title">店舗情報の更新</h2>
        <p className="vendor-section-subtitle">
          店舗名と管理メールを変更できます。店舗URLは運営側で確認するため、ここでは表示のみです。
        </p>

        <Form key={formKey} method="post" className="vendor-form">
          <input type="hidden" name="intent" value="save" />

          <div className="vendor-form__grid">
            <div className="vendor-form__field">
              <label className="vendor-form__label" htmlFor="storeName">
                店舗名
              </label>
              <input
                className="vendor-form__input"
                defaultValue={formValues.storeName}
                id="storeName"
                name="storeName"
                type="text"
              />
              {fieldErrors.storeName ? (
                <p
                  className="vendor-helper-text"
                  style={{ marginTop: 0, color: "#b91c1c" }}
                >
                  {fieldErrors.storeName}
                </p>
              ) : (
                <p className="vendor-helper-text">
                  店舗管理画面と店舗情報の表示に使う名称です。
                </p>
              )}
            </div>

            <div className="vendor-form__field">
              <label className="vendor-form__label" htmlFor="managementEmail">
                管理メール
              </label>
              <input
                className="vendor-form__input"
                defaultValue={formValues.managementEmail}
                id="managementEmail"
                name="managementEmail"
                type="email"
              />
              {fieldErrors.managementEmail ? (
                <p
                  className="vendor-helper-text"
                  style={{ marginTop: 0, color: "#b91c1c" }}
                >
                  {fieldErrors.managementEmail}
                </p>
              ) : (
                <p className="vendor-helper-text">
                  ログインコードや運営連絡に使う管理用メールアドレスです。
                </p>
              )}
            </div>
          </div>

          <div className="vendor-description-list">
            <div className="vendor-description-row">
              <div className="vendor-description-term">handle</div>
              <div className="vendor-description-value">
                <div>{vendor.handle}</div>
                <p className="vendor-helper-text" style={{ margin: "6px 0 0" }}>
                  店舗ページのURLに使う識別名です。変更が必要な場合は運営に連絡してください。
                </p>
              </div>
            </div>
            <div className="vendor-description-row">
              <div className="vendor-description-term">ステータス</div>
              <div className="vendor-description-value">
                <span className={badgeClass(vendor.statusLabel)}>
                  {vendor.statusLabel}
                </span>
              </div>
            </div>
          </div>

          <div className="vendor-form__actions">
            <button
              className="vendor-shell__button vendor-shell__button--primary"
              disabled={isSaving}
              type="submit"
            >
              {isSaving ? "保存中..." : "変更を保存"}
            </button>
          </div>
        </Form>
      </section>

      <section className="vendor-card">
        <h2 className="vendor-section-title">店舗詳細</h2>
        <div className="vendor-description-list">
          <div className="vendor-description-row">
            <div className="vendor-description-term">店舗オーナー</div>
            <div className="vendor-description-value">{store.ownerName}</div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">連絡先メール</div>
            <div className="vendor-description-value">{store.email}</div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">電話番号</div>
            <div className="vendor-description-value">{store.phone}</div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">住所</div>
            <div className="vendor-description-value">{store.address}</div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">国</div>
            <div className="vendor-description-value">{store.country}</div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">カテゴリー</div>
            <div className="vendor-description-value">{store.category}</div>
          </div>
        </div>
      </section>

      <section className="vendor-card">
        <h2 className="vendor-section-title">販売主体・事業者情報</h2>
        <p className="vendor-section-subtitle">
          購入者への表示、商品審査、返金や精算の責任判定に使います。一般の店舗住所を自動転用せず、内容を明示して申請してください。
        </p>
        <Form method="post" className="vendor-form">
          <input type="hidden" name="intent" value="save_compliance_profile" />
          <div className="vendor-form__grid">
            <div className="vendor-form__field">
              <label className="vendor-form__label" htmlFor="entityType">事業形態</label>
              <select
                className="vendor-form__select"
                defaultValue={governance?.seller?.complianceProfile?.entityType || "UNSET"}
                id="entityType"
                name="entityType"
                required
              >
                <option value="UNSET" disabled>選択してください</option>
                <option value="INDIVIDUAL">個人・個人事業</option>
                <option value="CORPORATION">法人</option>
              </select>
            </div>
            <GovernanceInput label="法的名称・氏名" name="legalName" required value={governance?.seller?.complianceProfile?.legalName} />
            <GovernanceInput label="代表者名" name="representativeName" value={governance?.seller?.complianceProfile?.representativeName} />
            <GovernanceInput label="郵便番号" name="postalCode" value={governance?.seller?.complianceProfile?.postalCode} />
            <GovernanceInput label="国コード" maxLength={2} name="countryCode" required value={governance?.seller?.complianceProfile?.countryCode || "JP"} />
            <GovernanceInput label="都道府県・州" name="region" value={governance?.seller?.complianceProfile?.region} />
            <GovernanceInput label="市区町村" name="city" value={governance?.seller?.complianceProfile?.city} />
            <GovernanceInput label="住所" name="address1" required value={governance?.seller?.complianceProfile?.address1} />
            <GovernanceInput label="建物名・部屋番号" name="address2" value={governance?.seller?.complianceProfile?.address2} />
            <GovernanceInput label="電話番号" name="phone" value={governance?.seller?.complianceProfile?.phone} />
            <GovernanceInput label="適格請求書発行事業者番号" name="invoiceRegistrationNumber" value={governance?.seller?.complianceProfile?.invoiceRegistrationNumber} />
            <div className="vendor-form__field">
              <label className="vendor-form__label" htmlFor="permitsJson">許認可・届出</label>
              <textarea className="vendor-form__textarea" defaultValue={governance?.seller?.complianceProfile?.permitsJson?.note || ""} id="permitsJson" name="permitsJson" rows={3} />
            </div>
            <div className="vendor-form__field">
              <label className="vendor-form__label"><input defaultChecked={Boolean(governance?.seller?.complianceProfile?.antisocialDeclarationAt)} name="antisocialDeclarationConfirmed" required type="checkbox" /> 反社会的勢力に該当せず、関係を有しないことを申告します</label>
              <label className="vendor-form__label"><input defaultChecked={Boolean(governance?.seller?.complianceProfile?.shipFromConfirmedAt)} name="shipFromConfirmed" required type="checkbox" /> 登録した発送元情報から実際に発送できることを確認しました</label>
              <label className="vendor-form__label"><input defaultChecked={Boolean(governance?.seller?.complianceProfile?.privacyNoticeAcceptedAt)} name="privacyNoticeAccepted" required type="checkbox" /> 注文処理に必要な購入者情報だけを目的内で扱います</label>
            </div>
          </div>
          <div className="vendor-form__actions">
            <button className="vendor-shell__button vendor-shell__button--primary" type="submit">事業者情報を審査へ提出</button>
          </div>
        </Form>
      </section>

      <section className="vendor-card">
        <h2 className="vendor-section-title">出店者契約</h2>
        <p className="vendor-section-subtitle">
          現在の規約版: {governance?.agreementVersion || "未設定"} / 状態: {governance?.readiness?.activeAgreement ? "同意済み" : "同意待ち"}
        </p>
        {governance?.agreementUrl ? (
          <p>
            <a
              className="vendor-shell__button"
              href={governance.agreementUrl}
              rel="noreferrer noopener"
              target="_blank"
            >
              契約本文を確認する
            </a>
          </p>
        ) : (
          <p className="vendor-alert vendor-alert--warning">
            契約本文を準備中です。設定が完了するまで同意操作はできません。
          </p>
        )}
        {!governance?.readiness?.activeAgreement ? (
          <Form method="post" className="vendor-form">
            <input type="hidden" name="intent" value="accept_seller_agreement" />
            <label className="vendor-form__label">
              <input name="agreementConfirmed" required type="checkbox" />
              現在の出店者契約、販売責任、返金・相殺、禁止商品、個人情報取扱いの条項に同意します
            </label>
            <div className="vendor-form__actions">
              <button
                className="vendor-shell__button vendor-shell__button--primary"
                disabled={!governance?.agreementUrl || !governance?.agreementDocumentHashConfigured}
                type="submit"
              >
                契約に同意する
              </button>
            </div>
          </Form>
        ) : null}
      </section>

      <div className="vendor-grid">
        <section className="vendor-card">
          <h2 className="vendor-section-title">公開ストア連携</h2>
          <p className="vendor-section-subtitle">
            商品公開や注文表示に使う接続状態です。通常は運営側で確認します。
          </p>
          <div className="vendor-description-list">
            <div className="vendor-description-row">
              <div className="vendor-description-term">連携状態</div>
              <div className="vendor-description-value">準備中 / 未設定</div>
            </div>
            <div className="vendor-description-row">
              <div className="vendor-description-term">再接続</div>
              <div className="vendor-description-value">必要な場合は運営側で対応します。</div>
            </div>
          </div>
        </section>

        <section className="vendor-card">
          <h2 className="vendor-section-title">PDF設定</h2>
          <p className="vendor-section-subtitle">
            PDF 用の保存設定はまだありません。月次PDF出力ページで対象月を選んで出力できます。
          </p>
          <div className="vendor-actions-row">
            <Link
              className="vendor-shell__button"
              to={monthlyReportPath}
            >
              月次PDF出力へ
            </Link>
          </div>
        </section>
      </div>

      <section className="vendor-card">
        <h2 className="vendor-section-title">通知設定</h2>
        <p className="vendor-section-subtitle">
          通知の細かな設定は現在準備中です。重要な連絡は管理メール宛に送信されます。
        </p>
        <div className="vendor-placeholder">
          通知設定を変更できるようになったら、この画面から更新できます。
        </div>
      </section>
    </VendorManagementShell>
  );
}

function GovernanceInput({ label, name, value = "", required = false, maxLength }) {
  return (
    <div className="vendor-form__field">
      <label className="vendor-form__label" htmlFor={name}>{label}</label>
      <input
        className="vendor-form__input"
        defaultValue={value || ""}
        id={name}
        maxLength={maxLength}
        name={name}
        required={required}
        type="text"
      />
    </div>
  );
}

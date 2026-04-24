import { json, redirect } from "@remix-run/node";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";
import VendorManagementShell from "../components/vendor/VendorManagementShell";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function badgeClass(label) {
  const dangerLabels = ["要確認", "差し戻し", "停止中", "制限あり"];
  const warningLabels = ["審査中", "申請中", "公開準備中", "確認中"];
  const successLabels = ["承認済み", "稼働中", "Shopify連携済み"];
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
  const url = new URL(request.url);

  return json({
    ...getVendorPublicContext(vendor, store),
    saved: url.searchParams.get("saved") === "1",
  });
};

export const action = async ({ request }) => {
  const { requireVendorContext, updateVendorSettings } = await import(
    "../services/vendorManagement.server"
  );
  const { vendor, store } = await requireVendorContext(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "save");

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

  return redirect("/vendor/settings?saved=1");
};

export default function VendorSettingsPage() {
  const actionData = useActionData();
  const navigation = useNavigation();
  const { vendor, store, saved } = useLoaderData();
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
          Phase 4 では、店舗名と管理メールだけを保存できます。handle は route
          衝突と予約語の確認が必要なため、今回は表示のみです。
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
                  route 衝突と予約語の確認が必要なため、handle の編集は今回は未対応です。
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

      <div className="vendor-grid">
        <section className="vendor-card">
          <h2 className="vendor-section-title">Shopify連携</h2>
          <p className="vendor-section-subtitle">
            現在の schema には store-level の shopDomain が無いため、店舗単位の接続状態は
            正確に判定できません。
          </p>
          <div className="vendor-description-list">
            <div className="vendor-description-row">
              <div className="vendor-description-term">連携状態</div>
              <div className="vendor-description-value">準備中 / 未設定</div>
            </div>
            <div className="vendor-description-row">
              <div className="vendor-description-term">再接続</div>
              <div className="vendor-description-value">Phase 4 では未対応です。</div>
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
              to="/vendor/reports/monthly"
            >
              月次PDF出力へ
            </Link>
          </div>
        </section>
      </div>

      <section className="vendor-card">
        <h2 className="vendor-section-title">通知設定</h2>
        <p className="vendor-section-subtitle">
          通知設定の保存先 schema はまだありません。Phase 4 では表示のみとし、保存機能は追加していません。
        </p>
        <div className="vendor-placeholder">
          メール通知や連携通知の細かな設定は、通知設定用の schema と送信フローが整ってから追加予定です。
        </div>
      </section>
    </VendorManagementShell>
  );
}

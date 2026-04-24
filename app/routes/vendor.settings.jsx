import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import VendorManagementShell from "../components/vendor/VendorManagementShell";

function badgeClass(label) {
  const dangerLabels = ["要確認", "差し戻し", "停止中", "制限あり"];
  const warningLabels = ["審査中", "申請中", "公開準備中"];
  const successLabels = ["承認済み", "稼働中", "Shopify連携済み"];
  let tone = "neutral";

  if (dangerLabels.includes(label)) tone = "danger";
  if (warningLabels.includes(label)) tone = "warning";
  if (successLabels.includes(label)) tone = "success";

  return `vendor-shell__badge vendor-shell__badge--${tone}`;
}

export const loader = async ({ request }) => {
  const { getVendorPublicContext, requireVendorContext } = await import(
    "../services/vendorManagement.server"
  );
  const { vendor, store } = await requireVendorContext(request);
  return json(getVendorPublicContext(vendor, store));
};

export default function VendorSettingsPage() {
  const { vendor, store } = useLoaderData();

  return (
    <VendorManagementShell activeItem="settings" storeName={store.storeName} title="設定">
      <section className="vendor-card">
        <h2 className="vendor-section-title">アカウント情報</h2>
        <div className="vendor-description-list">
          <div className="vendor-description-row">
            <div className="vendor-description-term">店舗名</div>
            <div className="vendor-description-value">{store.storeName}</div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">handle</div>
            <div className="vendor-description-value">{vendor.handle}</div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">管理メール</div>
            <div className="vendor-description-value">{vendor.managementEmail}</div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">ステータス</div>
            <div className="vendor-description-value">
              <span className={badgeClass(vendor.statusLabel)}>{vendor.statusLabel}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="vendor-card">
        <h2 className="vendor-section-title">店舗情報</h2>
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
        <h2 className="vendor-section-title">Shopify連携状態</h2>
        <p className="vendor-section-subtitle">
          store-level の shopDomain がまだ正規化されていないため、Phase 1 では準備中として表示します。
        </p>
        <div className="vendor-note">
          Shopify 連携状態: 準備中 / 未設定
        </div>
      </section>
    </VendorManagementShell>
  );
}

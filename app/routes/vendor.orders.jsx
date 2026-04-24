import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import VendorManagementShell from "../components/vendor/VendorManagementShell";

export const loader = async ({ request }) => {
  const { getVendorPublicContext, requireVendorContext } = await import(
    "../services/vendorManagement.server"
  );
  const { vendor, store } = await requireVendorContext(request);
  return json(getVendorPublicContext(vendor, store));
};

export default function VendorOrdersPage() {
  const { store } = useLoaderData();

  return (
    <VendorManagementShell activeItem="orders" storeName={store.storeName} title="注文管理">
      <section className="vendor-card">
        <h2 className="vendor-section-title">注文管理</h2>
        <p className="vendor-section-subtitle">
          注文連携は Phase 2 で追加予定です。Phase 1 では、404 や無反応をなくし、将来の一覧表示枠を先に用意しています。
        </p>

        <div className="vendor-placeholder">
          まだ注文データは連携されていません。Shopify 連携設定と注文同期が有効になると、この画面に注文一覧と発送状況が表示されます。
        </div>

        <div className="vendor-actions-row" style={{ marginTop: "16px" }}>
          <Link className="vendor-shell__button" to="/vendor/settings">
            Shopify連携設定を確認する
          </Link>
        </div>
      </section>

      <section className="vendor-card">
        <h2 className="vendor-section-title">今後ここに表示する項目</h2>
        <ul className="vendor-list">
          <li>注文番号</li>
          <li>注文日時</li>
          <li>商品数</li>
          <li>合計金額</li>
          <li>発送状況</li>
          <li>Shopify注文ID</li>
        </ul>
      </section>
    </VendorManagementShell>
  );
}

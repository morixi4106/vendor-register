import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import prisma from "../db.server";
import VendorManagementShell from "../components/vendor/VendorManagementShell";

export const loader = async ({ request }) => {
  const { getVendorPublicContext, requireVendorContext } = await import(
    "../services/vendorManagement.server"
  );
  const { vendor, store } = await requireVendorContext(request);
  const productCount = await prisma.product.count({
    where: {
      vendorStoreId: store.id,
    },
  });

  return json({
    ...getVendorPublicContext(vendor, store),
    productCount,
  });
};

export default function VendorInventoryPage() {
  const { store, productCount } = useLoaderData();

  return (
    <VendorManagementShell activeItem="inventory" storeName={store.storeName} title="在庫">
      <section className="vendor-card">
        <h2 className="vendor-section-title">在庫一覧</h2>
        <p className="vendor-section-subtitle">
          現在の schema では在庫数量を保持していないため、Phase 1 では read-only placeholder を表示しています。
        </p>

        <div className="vendor-placeholder">
          Shopify在庫連携後に表示されます。現在は登録商品数 {productCount} 件を在庫対象の候補として管理しています。
        </div>
      </section>

      <section className="vendor-card">
        <h2 className="vendor-section-title">今後ここに表示する項目</h2>
        <ul className="vendor-list">
          <li>商品名</li>
          <li>SKU</li>
          <li>現在庫</li>
          <li>在庫ステータス</li>
          <li>最終更新日</li>
        </ul>
      </section>
    </VendorManagementShell>
  );
}

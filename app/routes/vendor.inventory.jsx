import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import VendorManagementShell from "../components/vendor/VendorManagementShell";

export const loader = async ({ request }) => {
  const {
    getVendorPublicContext,
    listVendorProducts,
    requireVendorContext,
  } = await import(
    "../services/vendorManagement.server"
  );
  const { vendor, store } = await requireVendorContext(request);
  const products = await listVendorProducts(store.id, {});
  const publicCount = products.filter(
    (product) => product.statusLabel === "公開済み"
  ).length;
  const pendingCount = products.filter(
    (product) => product.approvalLabel === "申請中"
  ).length;

  return json({
    ...getVendorPublicContext(vendor, store),
    products,
    stats: {
      total: products.length,
      public: publicCount,
      pending: pendingCount,
    },
  });
};

export default function VendorInventoryPage() {
  const { store, products, stats } = useLoaderData();

  return (
    <VendorManagementShell activeItem="inventory" storeName={store.storeName} title="在庫">
      <section className="vendor-card">
        <h2 className="vendor-section-title">在庫一覧</h2>
        <p className="vendor-section-subtitle">
          登録済みの商品を在庫確認用に一覧表示しています。在庫数の入力・更新は、準備ができ次第この画面で行えるようになります。
        </p>

        <div className="vendor-description-list">
          <div className="vendor-description-row">
            <div className="vendor-description-term">登録商品</div>
            <div className="vendor-description-value">{stats.total}件</div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">公開済み</div>
            <div className="vendor-description-value">{stats.public}件</div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">確認中</div>
            <div className="vendor-description-value">{stats.pending}件</div>
          </div>
        </div>

        <div className="vendor-actions-row" style={{ marginTop: "16px" }}>
          <Link className="vendor-shell__button" to="/vendor/products">
            商品管理を開く
          </Link>
        </div>
      </section>

      <section className="vendor-card">
        <h2 className="vendor-section-title">商品別の在庫確認</h2>
        <p className="vendor-section-subtitle">
          在庫数の登録開始までは、商品ごとの公開状態、確認状況、最終更新日を確認できます。
        </p>

        <div className="vendor-table-wrap">
          <table className="vendor-table">
            <thead>
              <tr>
                <th>商品</th>
                <th>カテゴリ</th>
                <th>価格</th>
                <th>現在の在庫数</th>
                <th>公開状態</th>
                <th>確認状況</th>
                <th>最終更新</th>
              </tr>
            </thead>
            <tbody>
              {products.length === 0 ? (
                <tr>
                  <td colSpan="7" style={{ color: "#6b7280" }}>
                    まだ商品が登録されていません。商品を登録すると、ここに在庫確認対象として表示されます。
                  </td>
                </tr>
              ) : (
                products.map((product) => (
                  <tr key={product.id}>
                    <td className="vendor-table__name">{product.name}</td>
                    <td>{product.category}</td>
                    <td>{product.priceLabel}</td>
                    <td>{product.stockLabel}</td>
                    <td>
                      <span className={`vendor-shell__badge vendor-shell__badge--${product.statusTone}`}>
                        {product.statusLabel}
                      </span>
                    </td>
                    <td>
                      <span className={`vendor-shell__badge vendor-shell__badge--${product.approvalTone}`}>
                        {product.approvalLabel}
                      </span>
                    </td>
                    <td>{product.updatedAtLabel}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </VendorManagementShell>
  );
}

import { json, redirect } from "@remix-run/node";
import { Form, Link, Outlet, useActionData, useLoaderData, useOutlet } from "@remix-run/react";
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
  const { getVendorPublicContext, listVendorProducts, requireVendorContext } =
    await import("../services/vendorManagement.server");
  const { vendor, store } = await requireVendorContext(request);
  const url = new URL(request.url);
  const filters = {
    name: String(url.searchParams.get("name") || "").trim(),
    sku: String(url.searchParams.get("sku") || "").trim(),
    tracking: String(url.searchParams.get("tracking") || "").trim(),
  };

  const products = await listVendorProducts(store.id, filters);
  const linkedCount = products.filter(
    (product) => product.statusLabel === "Shopify連携済み"
  ).length;
  const pendingCount = products.filter(
    (product) => product.approvalLabel === "申請中"
  ).length;

  return json({
    ...getVendorPublicContext(vendor, store),
    filters,
    products,
    stats: {
      total: products.length,
      pending: pendingCount,
      linked: linkedCount,
    },
  });
};

export const action = async ({ request }) => {
  const { deleteVendorProductForStore, requireVendorContext } = await import(
    "../services/vendorManagement.server"
  );
  const { store } = await requireVendorContext(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent !== "delete") {
    return json(
      { ok: false, error: "未対応の操作です。" },
      { status: 400 }
    );
  }

  const deletion = await deleteVendorProductForStore({
    storeId: store.id,
    productId: formData.get("productId"),
  });

  if (!deletion.ok) {
    return json(
      {
        ok: false,
        error: deletion.publicError,
        needsReconnect: deletion.needsReconnect,
      },
      { status: deletion.status }
    );
  }

  const url = new URL(request.url);
  return redirect(`/vendor/products${url.search}`);
};

export default function VendorProductsPage() {
  const outlet = useOutlet();
  const actionData = useActionData();
  const { store, filters, products, stats } = useLoaderData();
  const hasFilters = Boolean(filters.name || filters.sku || filters.tracking);

  if (outlet) {
    return <Outlet />;
  }

  const search = (
    <Form method="get" className="vendor-shell__search-form">
      <input
        type="text"
        name="name"
        defaultValue={filters.name}
        placeholder="商品名で検索"
      />
      <input
        type="text"
        name="sku"
        defaultValue={filters.sku}
        placeholder="SKU (Phase 2)"
      />
      <input
        type="text"
        name="tracking"
        defaultValue={filters.tracking}
        placeholder="追跡番号 (Phase 2)"
      />
      <button className="vendor-shell__button" type="submit">
        検索
      </button>
      {hasFilters ? (
        <Link className="vendor-shell__button" to="/vendor/products">
          クリア
        </Link>
      ) : null}
    </Form>
  );

  return (
    <VendorManagementShell
      activeItem="products"
      storeName={store.storeName}
      title="商品管理"
      search={search}
    >
      {actionData?.error ? (
        <section className="vendor-card">
          <div className="vendor-note" style={{ borderColor: "#fecaca", background: "#fef2f2", color: "#b91c1c" }}>
            {actionData.error}
          </div>
        </section>
      ) : null}

      <section className="vendor-card-grid">
        <div className="vendor-card">
          <p className="vendor-stat-title">表示中の商品数</p>
          <p className="vendor-stat-value">{stats.total}</p>
          <p className="vendor-stat-sub">現在の店舗に紐づく商品だけを表示</p>
        </div>
        <div className="vendor-card">
          <p className="vendor-stat-title">申請中</p>
          <p className="vendor-stat-value">{stats.pending}</p>
          <p className="vendor-stat-sub">審査中の商品数</p>
        </div>
        <div className="vendor-card">
          <p className="vendor-stat-title">Shopify連携済み</p>
          <p className="vendor-stat-value">{stats.linked}</p>
          <p className="vendor-stat-sub">shopifyProductId を持つ商品</p>
        </div>
        <div className="vendor-card">
          <p className="vendor-stat-title">新規登録</p>
          <p className="vendor-stat-value">/vendor/products/new</p>
          <p className="vendor-stat-sub">右上ボタンから新規商品登録へ進めます</p>
        </div>
      </section>

      <section className="vendor-card">
        <h2 className="vendor-section-title">商品一覧</h2>
        <p className="vendor-section-subtitle">
          dashboard 下部の商品一覧と同等の情報を表示しています。SKU / 追跡番号は現在 schema にないため、Phase 1 では商品名検索を主に利用してください。
        </p>

        <div className="vendor-table-wrap">
          <table className="vendor-table">
            <thead>
              <tr>
                <th>商品</th>
                <th>SKU</th>
                <th>在庫</th>
                <th>価格</th>
                <th>月販売数</th>
                <th>状態</th>
                <th>申請</th>
                <th>追跡番号</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {products.length === 0 ? (
                <tr>
                  <td colSpan="9" style={{ color: "#6b7280" }}>
                    条件に一致する商品はありません。
                  </td>
                </tr>
              ) : (
                products.map((product) => (
                  <tr key={product.id}>
                    <td className="vendor-table__name">
                      {product.name}
                      <span className="vendor-table__meta">
                        最終更新: {product.updatedAtLabel}
                      </span>
                    </td>
                    <td>{product.sku}</td>
                    <td>{product.stockLabel}</td>
                    <td>{product.priceLabel}</td>
                    <td>{product.salesLabel}</td>
                    <td>
                      <span className={badgeClass(product.statusLabel)}>
                        {product.statusLabel}
                      </span>
                    </td>
                    <td>
                      <span className={badgeClass(product.approvalLabel)}>
                        {product.approvalLabel}
                      </span>
                    </td>
                    <td>{product.trackingLabel}</td>
                    <td>
                      <div className="vendor-table-actions">
                        <Link className="vendor-shell__button" to={`/vendor/products/${product.id}/edit`}>
                          編集
                        </Link>

                        <Form method="post" className="vendor-inline-form">
                          <input type="hidden" name="intent" value="delete" />
                          <input type="hidden" name="productId" value={product.id} />
                          <button
                            className="vendor-shell__button vendor-shell__button--danger"
                            type="submit"
                            onClick={(event) => {
                              if (!window.confirm("この商品を削除しますか？")) {
                                event.preventDefault();
                              }
                            }}
                          >
                            削除
                          </button>
                        </Form>
                      </div>
                    </td>
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

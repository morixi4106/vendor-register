import { json, redirect } from "@remix-run/node";
import {
  Form,
  Link,
  Outlet,
  useActionData,
  useLoaderData,
  useOutlet,
} from "@remix-run/react";
import VendorManagementShell from "../components/vendor/VendorManagementShell";

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

export const loader = async ({ request }) => {
  const {
    getVendorPublicContext,
    listVendorProducts,
    PRODUCT_STATUS_FILTER_OPTIONS,
    requireVendorContext,
  } = await import("../services/vendorManagement.server");
  const { vendor, store } = await requireVendorContext(request);
  const url = new URL(request.url);
  const filters = {
    name: String(url.searchParams.get("name") || "").trim(),
    sku: String(url.searchParams.get("sku") || "").trim(),
    tracking: String(url.searchParams.get("tracking") || "").trim(),
    status: String(url.searchParams.get("status") || "all").trim() || "all",
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
    statusOptions: PRODUCT_STATUS_FILTER_OPTIONS,
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
  const { store, filters, products, stats, statusOptions } = useLoaderData();
  const hasFilters = Boolean(
    filters.name || filters.sku || filters.tracking || filters.status !== "all"
  );

  if (outlet) {
    return <Outlet />;
  }

  const search = (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <Form method="get" className="vendor-shell__search-form">
        <input
          aria-label="商品名"
          defaultValue={filters.name}
          name="name"
          placeholder="商品名で検索"
          type="text"
        />
        <input
          aria-label="Shopify商品ID"
          defaultValue={filters.sku}
          name="sku"
          placeholder="Shopify商品IDで検索"
          type="text"
        />
        <input
          aria-label="商品URL"
          defaultValue={filters.tracking}
          name="tracking"
          placeholder="商品URLで検索"
          type="text"
        />
        <select aria-label="ステータス" defaultValue={filters.status} name="status">
          {statusOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button className="vendor-shell__button" type="submit">
          検索
        </button>
        {hasFilters ? (
          <Link className="vendor-shell__button" to="/vendor/products">
            クリア
          </Link>
        ) : null}
      </Form>
      <p
        style={{
          margin: 0,
          fontSize: "0.85rem",
          color: "rgba(55, 65, 81, 0.82)",
        }}
      >
        現在は Shopify商品ID と商品URL を検索できます。SKU / 追跡番号の専用検索は、
        在庫・配送連携後に追加予定です。
      </p>
    </div>
  );

  return (
    <VendorManagementShell
      activeItem="products"
      search={search}
      storeName={store.storeName}
      title="商品管理"
    >
      {actionData?.error ? (
        <section className="vendor-card">
          <div className="vendor-note vendor-note--danger">{actionData.error}</div>
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
          <p className="vendor-stat-sub">審査中の商品の件数</p>
        </div>
        <div className="vendor-card">
          <p className="vendor-stat-title">Shopify連携済み</p>
          <p className="vendor-stat-value">{stats.linked}</p>
          <p className="vendor-stat-sub">shopifyProductId を持つ商品</p>
        </div>
        <div className="vendor-card">
          <p className="vendor-stat-title">新規登録</p>
          <p className="vendor-stat-value">/vendor/products/new</p>
          <p className="vendor-stat-sub">
            右上ボタンから新規商品登録へ進めます
          </p>
        </div>
      </section>

      <section className="vendor-card">
        <h2 className="vendor-section-title">商品一覧</h2>
        <p className="vendor-section-subtitle">
          商品名に加えて、現在の Product schema で保持している
          Shopify商品ID と商品URLでも検索できます。専用の SKU /
          追跡番号 field は未実装のため、Phase 3 では実在 field を代替検索軸として使っています。
        </p>

        <div className="vendor-table-wrap">
          <table className="vendor-table">
            <thead>
              <tr>
                <th>商品</th>
                <th>Shopify商品ID</th>
                <th>商品URL</th>
                <th>価格</th>
                <th>売上見込</th>
                <th>状態</th>
                <th>申請</th>
                <th>更新日</th>
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
                        カテゴリー: {product.category}
                      </span>
                    </td>
                    <td>{product.sku}</td>
                    <td>
                      {product.url ? (
                        <a href={product.url} rel="noreferrer" target="_blank">
                          {product.trackingLabel}
                        </a>
                      ) : (
                        product.trackingLabel
                      )}
                    </td>
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
                    <td>{product.updatedAtLabel}</td>
                    <td>
                      <div className="vendor-table-actions">
                        <Link
                          className="vendor-shell__button"
                          to={`/vendor/products/${product.id}/edit`}
                        >
                          編集
                        </Link>

                        <Form method="post" className="vendor-inline-form">
                          <input type="hidden" name="intent" value="delete" />
                          <input type="hidden" name="productId" value={product.id} />
                          <button
                            className="vendor-shell__button vendor-shell__button--danger"
                            onClick={(event) => {
                              if (!window.confirm("この商品を削除しますか？")) {
                                event.preventDefault();
                              }
                            }}
                            type="submit"
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

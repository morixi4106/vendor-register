import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData } from "@remix-run/react";
import { useMemo, useState } from "react";
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
  const {
    formatMoney,
    getVendorPublicContext,
    requireVendorContext,
    serializeVendorProduct,
  } = await import("../services/vendorManagement.server");
  const { vendor, store } = await requireVendorContext(request, {
    includeProducts: true,
  });

  const rawProducts = Array.isArray(store.products) ? store.products : [];
  const products = rawProducts.map(serializeVendorProduct);
  const pendingCount = products.filter(
    (product) => product.approvalLabel === "申請中"
  ).length;
  const linkedCount = products.filter(
    (product) => product.statusLabel === "Shopify連携済み"
  ).length;

  const summaryCards = [
    {
      title: "本日の売上",
      value: formatMoney(0, "JPY"),
      sub: "注文連携後に反映されます",
    },
    {
      title: "今月の売上",
      value: formatMoney(0, "JPY"),
      sub: "注文連携後に反映されます",
    },
    {
      title: "未対応注文",
      value: "0件",
      sub: "注文連携後に反映されます",
    },
    {
      title: "登録商品数",
      value: `${products.length}件`,
      sub: "現在の店舗に紐づく商品数",
    },
  ];

  const healthRows = [
    {
      label: "登録商品数",
      value: `${products.length}件`,
      percent: products.length > 0 ? 100 : 0,
    },
    {
      label: "申請中商品",
      value: `${pendingCount}件`,
      percent: products.length > 0 ? Math.round((pendingCount / products.length) * 100) : 0,
    },
    {
      label: "Shopify連携済み",
      value: `${linkedCount}件`,
      percent: products.length > 0 ? Math.round((linkedCount / products.length) * 100) : 0,
    },
  ];

  const chartData = [
    { label: "7日前", amount: 0 },
    { label: "6日前", amount: 0 },
    { label: "5日前", amount: 0 },
    { label: "4日前", amount: 0 },
    { label: "3日前", amount: 0 },
    { label: "2日前", amount: 0 },
    { label: "本日", amount: 0 },
  ];

  const monthlyPreview = products.slice(0, 5).map((product) => ({
    id: product.id,
    name: product.name,
    quantity: 0,
  }));

  return json({
    ...getVendorPublicContext(vendor, store),
    summaryCards,
    healthRows,
    chartData,
    monthlyPreview,
    products,
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

  return redirect("/vendor/dashboard");
};

export default function VendorDashboard() {
  const actionData = useActionData();
  const { store, summaryCards, healthRows, chartData, monthlyPreview, products } =
    useLoaderData();

  const [query, setQuery] = useState("");

  const filteredProducts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return products;

    return products.filter((product) => {
      return (
        String(product.name || "").toLowerCase().includes(normalizedQuery) ||
        String(product.sku || "").toLowerCase().includes(normalizedQuery) ||
        String(product.trackingLabel || "").toLowerCase().includes(normalizedQuery)
      );
    });
  }, [products, query]);

  const search = (
    <input
      className="vendor-shell__search-input"
      type="text"
      placeholder="商品名・SKU・追跡番号で検索"
      value={query}
      onChange={(event) => setQuery(event.target.value)}
    />
  );

  const chartMax = Math.max(...chartData.map((item) => item.amount), 1);

  return (
    <VendorManagementShell
      activeItem="dashboard"
      storeName={store.storeName}
      title="店舗管理ダッシュボード"
      search={search}
    >
      {actionData?.error ? (
        <section className="vendor-card">
          <div
            className="vendor-note"
            style={{
              borderColor: actionData?.needsReconnect ? "#f59e0b" : "#fecaca",
              background: actionData?.needsReconnect ? "#fffbeb" : "#fef2f2",
              color: actionData?.needsReconnect ? "#92400e" : "#b91c1c",
            }}
          >
            {actionData.error}
          </div>
        </section>
      ) : null}

      <section className="vendor-card-grid">
        {summaryCards.map((card) => (
          <div className="vendor-card" key={card.title}>
            <p className="vendor-stat-title">{card.title}</p>
            <p className="vendor-stat-value">{card.value}</p>
            <p className="vendor-stat-sub">{card.sub}</p>
          </div>
        ))}
      </section>

      <section className="vendor-grid">
        <div className="vendor-card">
          <h2 className="vendor-section-title">売上推移</h2>
          <p className="vendor-section-subtitle">注文連携後にここへ反映されます</p>

          <div
            style={{
              height: "240px",
              display: "flex",
              alignItems: "flex-end",
              gap: "14px",
              paddingTop: "10px",
            }}
          >
            {chartData.map((item) => {
              const height = Math.max(20, Math.round((item.amount / chartMax) * 200));

              return (
                <div
                  key={item.label}
                  style={{ flex: 1, textAlign: "center" }}
                >
                  <div
                    style={{
                      width: "100%",
                      height: `${height}px`,
                      borderRadius: "10px 10px 0 0",
                      background: "#111827",
                    }}
                  />
                  <div
                    style={{
                      marginTop: "8px",
                      fontSize: "12px",
                      color: "#6b7280",
                    }}
                  >
                    {item.label}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="vendor-card">
          <h2 className="vendor-section-title">アカウント健全性</h2>
          <p className="vendor-section-subtitle">商品登録ベースで表示中</p>

          <div className="vendor-stack" style={{ gap: "14px" }}>
            {healthRows.map((row) => (
              <div key={row.label}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "14px",
                    marginBottom: "6px",
                  }}
                >
                  <span>{row.label}</span>
                  <span>{row.value}</span>
                </div>
                <div
                  style={{
                    width: "100%",
                    height: "10px",
                    background: "#e5e7eb",
                    borderRadius: "999px",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${row.percent}%`,
                      background: "#111827",
                    }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="vendor-note" style={{ marginTop: "18px" }}>
            この画面は vendor メール認証で表示しています。注文・売上・在庫の Shopify 連携は次段階で追加します。
          </div>
        </div>
      </section>

      <section className="vendor-grid">
        <div className="vendor-card">
          <h2 className="vendor-section-title">注文管理</h2>
          <p className="vendor-section-subtitle">注文連携前のため、まだ表示はありません</p>

          <div className="vendor-placeholder">
            まだ注文データは連携されていません。Phase 1 では /vendor/orders ページから将来の注文管理導線を確認できます。
          </div>

          <div className="vendor-actions-row" style={{ marginTop: "16px" }}>
            <Link className="vendor-shell__button" to="/vendor/orders">
              注文管理ページを開く
            </Link>
          </div>
        </div>

        <div className="vendor-card">
          <h2 className="vendor-section-title">月次PDF出力</h2>
          <p className="vendor-section-subtitle">現時点では登録商品一覧ベースで出力</p>

          <div className="vendor-note">
            <div><strong>出力内容</strong></div>
            <div>・登録商品一覧</div>
            <div>・画面表示中のダッシュボード</div>
            <div>・注文 / 売上情報は注文連携後に追加</div>
          </div>

          <div className="vendor-stack" style={{ gap: "8px", marginTop: "14px" }}>
            {monthlyPreview.length === 0 ? (
              <div className="vendor-placeholder">まだ登録商品がありません。</div>
            ) : (
              monthlyPreview.map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "12px",
                    padding: "8px 0",
                    borderBottom: "1px solid #f1f5f9",
                    fontSize: "14px",
                  }}
                >
                  <span>{item.name}</span>
                  <strong>{item.quantity}件</strong>
                </div>
              ))
            )}
          </div>

          <div className="vendor-actions-row" style={{ marginTop: "16px" }}>
            <Link
              className="vendor-shell__button vendor-shell__button--primary"
              to="/vendor/reports/monthly"
            >
              月次PDF出力ページへ
            </Link>
          </div>
        </div>
      </section>

      <section className="vendor-card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: "16px",
            flexWrap: "wrap",
            marginBottom: "18px",
          }}
        >
          <div>
            <h2 className="vendor-section-title">商品管理</h2>
            <p className="vendor-section-subtitle" style={{ marginBottom: 0 }}>
              今は DB に保存されている vendor 商品を表示しています。
            </p>
          </div>

          <div className="vendor-actions-row">
            <Link className="vendor-shell__button" to="/vendor/products">
              商品管理ページを開く
            </Link>
          </div>
        </div>

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
              {filteredProducts.length === 0 ? (
                <tr>
                  <td colSpan="9" style={{ color: "#6b7280" }}>
                    まだ商品がありません。
                  </td>
                </tr>
              ) : (
                filteredProducts.map((product) => (
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

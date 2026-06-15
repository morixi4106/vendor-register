import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData } from "@remix-run/react";
import { useMemo, useState } from "react";
import VendorManagementShell from "../components/vendor/VendorManagementShell";

function badgeClass(label) {
  const dangerLabels = ["要確認", "差し戻し", "停止中", "制限あり"];
  const warningLabels = ["審査中", "申請中", "公開準備中"];
  const successLabels = ["承認済み", "稼働中", "公開済み"];
  let tone = "neutral";

  if (dangerLabels.includes(label)) tone = "danger";
  if (warningLabels.includes(label)) tone = "warning";
  if (successLabels.includes(label)) tone = "success";

  return `vendor-shell__badge vendor-shell__badge--${tone}`;
}

export const loader = async ({ request }) => {
  const {
    getVendorPublicContext,
    requireVendorContext,
    serializeVendorProduct,
  } = await import("../services/vendorManagement.server");
  const { getSellerSalesCreditSummary } = await import(
    "../services/sellerPayments.server"
  );
  const { vendor, store } = await requireVendorContext(request, {
    includeProducts: true,
  });
  const salesCreditSummary = await getSellerSalesCreditSummary({
    vendorId: vendor.id,
    currencyCode: "jpy",
  });

  const rawProducts = Array.isArray(store.products) ? store.products : [];
  const products = rawProducts.map(serializeVendorProduct);

  const summaryCards = [
    {
      title: "使える売上金",
      value: salesCreditSummary.availableAmountLabel,
      sub: "購入に使える金額",
    },
    {
      title: "確認中の売上金",
      value: salesCreditSummary.pendingSalesAmountLabel,
      sub: "返金期間中の売上金",
    },
    {
      title: "精算台帳の合計",
      value: salesCreditSummary.totalLedgerBalanceLabel,
      sub: "売上・返金・精算の合計",
    },
    {
      title: "登録商品数",
      value: `${products.length}件`,
      sub: "現在の店舗に紐づく商品数",
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
    chartData,
    monthlyPreview,
    products,
    salesCreditSummary,
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

function formatChartMoney(amount, currencyCode = "JPY") {
  const value = Number(amount || 0);

  try {
    return new Intl.NumberFormat("ja-JP", {
      style: "currency",
      currency: currencyCode,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `¥${Math.round(value).toLocaleString("ja-JP")}`;
  }
}

function buildSalesTrendChart(data) {
  const rows = Array.isArray(data) && data.length > 0 ? data : [];
  const width = 100;
  const height = 100;
  const padding = { top: 9, right: 2, bottom: 18, left: 5 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const amounts = rows.map((item) => Math.max(0, Number(item.amount || 0)));
  const maxAmount = Math.max(...amounts, 0);
  const chartMax = maxAmount > 0 ? maxAmount : 1;
  const xStep = rows.length > 1 ? plotWidth / (rows.length - 1) : 0;

  const points = rows.map((item, index) => {
    const amount = Math.max(0, Number(item.amount || 0));
    const x = padding.left + xStep * index;
    const y = padding.top + plotHeight - (amount / chartMax) * plotHeight;

    return {
      ...item,
      amount,
      amountLabel: formatChartMoney(amount),
      x,
      y,
    };
  });

  const linePath = points
    .map((point, index) => {
      const command = index === 0 ? "M" : "L";
      return `${command} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    })
    .join(" ");
  const lastPoint = points[points.length - 1];
  const firstPoint = points[0];
  const baselineY = padding.top + plotHeight;
  const areaPath =
    points.length > 0
      ? `${linePath} L ${lastPoint.x.toFixed(2)} ${baselineY} L ${firstPoint.x.toFixed(2)} ${baselineY} Z`
      : "";
  const totalAmount = amounts.reduce((sum, amount) => sum + amount, 0);
  const peakAmount = Math.max(...amounts, 0);
  const hasSales = totalAmount > 0;
  const peakPoint = hasSales
    ? points.find((point) => point.amount === peakAmount)
    : null;
  const grid = [1, 0.66, 0.33, 0].map((ratio) => {
    const y = padding.top + plotHeight - ratio * plotHeight;
    const value = hasSales ? Math.round(chartMax * ratio) : 0;

    return {
      y,
      label: ratio === 0 || hasSales ? formatChartMoney(value) : "",
    };
  });

  return {
    width,
    height,
    padding,
    plotWidth,
    baselineY,
    points,
    linePath,
    areaPath,
    grid,
    hasSales,
    totalLabel: formatChartMoney(totalAmount),
    peakLabel: peakPoint ? `${peakPoint.label} ${peakPoint.amountLabel}` : "なし",
  };
}

function SalesTrendChart({ data }) {
  const chart = buildSalesTrendChart(data);

  return (
    <div className="vendor-sales-chart">
      <div className="vendor-sales-chart__summary">
        <div>
          <p className="vendor-sales-chart__eyebrow">直近7日</p>
          <p className="vendor-sales-chart__value">{chart.totalLabel}</p>
        </div>
        <span
          className={`vendor-shell__badge vendor-shell__badge--${
            chart.hasSales ? "success" : "neutral"
          }`}
        >
          {chart.hasSales ? "反映中" : "注文待ち"}
        </span>
      </div>

      <div className="vendor-sales-chart__plot">
        <svg
          className="vendor-sales-chart__svg"
          viewBox={`0 0 ${chart.width} ${chart.height}`}
          role="img"
          aria-label="直近7日の売上推移"
          preserveAspectRatio="none"
        >
          <rect
            x="0"
            y="0"
            width={chart.width}
            height={chart.height}
            rx="16"
            fill="#f8fafc"
          />
          {chart.grid.map((tick, index) => (
            <g key={`${tick.y}-${index}`}>
              <line
                x1={chart.padding.left}
                x2={chart.padding.left + chart.plotWidth}
                y1={tick.y}
                y2={tick.y}
                stroke="#e5e7eb"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
          <line
            x1={chart.padding.left}
            x2={chart.padding.left + chart.plotWidth}
            y1={chart.baselineY}
            y2={chart.baselineY}
            stroke="#9ca3af"
            strokeWidth="1.2"
            vectorEffect="non-scaling-stroke"
          />
          {chart.areaPath ? (
            <path d={chart.areaPath} fill="#111827" opacity="0.06" />
          ) : null}
          {chart.linePath ? (
            <path
              d={chart.linePath}
              fill="none"
              stroke="#111827"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>

        <div className="vendor-sales-chart__zero-label">¥0</div>
        <div className="vendor-sales-chart__points" aria-hidden="true">
          {chart.points.map((point) => (
            <span
              key={point.label}
              className="vendor-sales-chart__point"
              style={{ left: `${point.x}%`, top: `${point.y}%` }}
              title={`${point.label}: ${point.amountLabel}`}
            />
          ))}
        </div>
        <div className="vendor-sales-chart__x-labels" aria-hidden="true">
          {chart.points.map((point) => (
            <span key={`${point.label}-label`}>{point.label}</span>
          ))}
        </div>

        {!chart.hasSales ? (
          <div className="vendor-sales-chart__empty">
            注文が入ると売上推移を表示します
          </div>
        ) : null}
      </div>

      <div className="vendor-sales-chart__footer">
        <span>7日合計 {chart.totalLabel}</span>
        <span>最高日 {chart.peakLabel}</span>
      </div>
    </div>
  );
}

export default function VendorDashboard() {
  const actionData = useActionData();
  const { store, summaryCards, chartData, monthlyPreview, products } =
    useLoaderData();

  const [query, setQuery] = useState("");

  const filteredProducts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return products;

    return products.filter((product) => {
      return (
        String(product.name || "").toLowerCase().includes(normalizedQuery) ||
        String(product.sku || "").toLowerCase().includes(normalizedQuery) ||
        String(product.trackingLabel || "").toLowerCase().includes(normalizedQuery) ||
        String(product.deliveryPolicyLabel || "").toLowerCase().includes(normalizedQuery) ||
        String(product.deliveryPolicyDetail || "").toLowerCase().includes(normalizedQuery)
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

  return (
    <VendorManagementShell
      activeItem="dashboard"
      storeName={store.storeName}
      title="店舗管理ダッシュボード"
      search={search}
    >
      <style>{`
        .vendor-sales-chart{
          display:grid;
          gap:14px;
        }
        .vendor-sales-chart__summary{
          display:flex;
          justify-content:space-between;
          align-items:flex-start;
          gap:16px;
        }
        .vendor-sales-chart__eyebrow{
          margin:0 0 4px;
          color:#6b7280;
          font-size:12px;
          font-weight:700;
        }
        .vendor-sales-chart__value{
          margin:0;
          color:#111827;
          font-size:30px;
          font-weight:800;
          line-height:1.1;
        }
        .vendor-sales-chart__plot{
          position:relative;
          overflow:hidden;
          min-height:320px;
          border:1px solid #e5e7eb;
          border-radius:16px;
          background:#f8fafc;
        }
        .vendor-sales-chart__svg{
          display:block;
          position:absolute;
          inset:0;
          width:100%;
          height:100%;
        }
        .vendor-sales-chart__zero-label{
          position:absolute;
          left:18px;
          bottom:52px;
          color:#6b7280;
          font-size:12px;
        }
        .vendor-sales-chart__points{
          position:absolute;
          inset:0;
          pointer-events:none;
        }
        .vendor-sales-chart__point{
          position:absolute;
          width:14px;
          height:14px;
          transform:translate(-50%, -50%);
          border:3px solid #111827;
          border-radius:999px;
          background:#ffffff;
          box-sizing:border-box;
        }
        .vendor-sales-chart__x-labels{
          position:absolute;
          left:5%;
          right:2%;
          bottom:16px;
          display:flex;
          justify-content:space-between;
          gap:10px;
          color:#6b7280;
          font-size:13px;
          text-align:center;
          pointer-events:none;
        }
        .vendor-sales-chart__empty{
          position:absolute;
          left:50%;
          top:50%;
          transform:translate(-50%, -50%);
          max-width:calc(100% - 32px);
          padding:10px 14px;
          border:1px solid #e5e7eb;
          border-radius:999px;
          background:rgba(255,255,255,.92);
          color:#4b5563;
          font-size:13px;
          font-weight:700;
          text-align:center;
          box-shadow:0 8px 24px rgba(15,23,42,.08);
          white-space:normal;
        }
        .vendor-sales-chart__footer{
          display:flex;
          justify-content:space-between;
          gap:12px;
          flex-wrap:wrap;
          color:#6b7280;
          font-size:12px;
        }
        @media (max-width: 760px){
          .vendor-sales-chart__value{
            font-size:24px;
          }
          .vendor-sales-chart__plot{
            min-height:240px;
          }
          .vendor-sales-chart__zero-label{
            left:14px;
            bottom:46px;
          }
          .vendor-sales-chart__x-labels{
            font-size:12px;
            gap:6px;
          }
          .vendor-sales-chart__point{
            width:12px;
            height:12px;
            border-width:2px;
          }
        }
      `}</style>

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

      <section className="vendor-card">
        <h2 className="vendor-section-title">売上推移</h2>
        <p className="vendor-section-subtitle">注文連携後にここへ反映されます</p>

        <SalesTrendChart data={chartData} />
      </section>

      <section className="vendor-grid">
        <div className="vendor-card">
          <h2 className="vendor-section-title">注文管理</h2>
          <p className="vendor-section-subtitle">注文連携前のため、まだ表示はありません</p>

          <div className="vendor-placeholder">
            まだ注文データはありません。注文が入ると、注文管理ページで確認できます。
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
            <div><strong>PDFに含まれる内容</strong></div>
            <div>・登録商品一覧</div>
            <div>・現在のダッシュボード概要</div>
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
              登録済みの商品を表示しています。
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
                <th>配送先</th>
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
                  <td colSpan="10" style={{ color: "#6b7280" }}>
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
                    <td>
                      <span
                        className={`vendor-shell__badge vendor-shell__badge--${product.deliveryPolicyTone}`}
                      >
                        {product.deliveryPolicyLabel}
                      </span>
                      <span className="vendor-table__meta">
                        {product.deliveryPolicyDetail}
                      </span>
                    </td>
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

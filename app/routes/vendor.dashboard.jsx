import { createCookie, json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { useMemo, useState } from "react";
import prisma from "../db.server";

const vendorAdminSessionCookie = createCookie("vendor_admin_session", {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 8,
});

function formatMoney(amount, currencyCode = "JPY") {
  const num = Number(amount || 0);
  try {
    return new Intl.NumberFormat("ja-JP", {
      style: "currency",
      currency: currencyCode,
      maximumFractionDigits: 0,
    }).format(num);
  } catch {
    return `¥${Math.round(num).toLocaleString("ja-JP")}`;
  }
}

function mapApproval(value) {
  if (!value) return "未設定";
  if (value === "approved") return "承認済み";
  if (value === "pending") return "申請中";
  if (value === "rejected") return "却下";
  if (value === "review") return "要確認";
  return value;
}

function badgeClass(text) {
  if (
    text === "対応要" ||
    text === "在庫切れ" ||
    text === "却下" ||
    text === "保留"
  ) {
    return "dash-badge dash-badge-red";
  }

  if (
    text === "発送待ち" ||
    text === "一部発送" ||
    text === "在庫少" ||
    text === "申請中" ||
    text === "対応中"
  ) {
    return "dash-badge dash-badge-yellow";
  }

  if (
    text === "承認済み" ||
    text === "販売中" ||
    text === "発送済み"
  ) {
    return "dash-badge dash-badge-green";
  }

  return "dash-badge dash-badge-gray";
}

export const loader = async ({ request }) => {
  const cookieHeader = request.headers.get("Cookie");
  const sessionToken = await vendorAdminSessionCookie.parse(cookieHeader);

  if (!sessionToken) {
    throw redirect("https://vendor-register-pbjl.onrender.com/vendor/verify");
  }

  const vendorSession = await prisma.vendorAdminSession.findUnique({
    where: { sessionToken },
    include: {
      vendor: {
        include: {
          vendorStore: {
            include: {
              products: {
                orderBy: {
                  createdAt: "desc",
                },
              },
            },
          },
        },
      },
    },
  });

  if (!vendorSession || vendorSession.expiresAt < new Date()) {
    throw redirect("https://vendor-register-pbjl.onrender.com/vendor/verify", {
      headers: {
        "Set-Cookie": await vendorAdminSessionCookie.serialize("", {
          maxAge: 0,
        }),
      },
    });
  }

  const vendor = vendorSession.vendor;
  const store = vendor?.vendorStore;

  if (!vendor || !store) {
    throw new Response("店舗情報が見つかりません。", { status: 404 });
  }

  const rawProducts = Array.isArray(store.products) ? store.products : [];

  const products = rawProducts.map((product) => {
    const stock = 0;
    const sales = 0;

    return {
      id: product.id,
      name: product.name || "商品名なし",
      vendor: store.storeName || vendor.storeName || "-",
      sku: "-",
      stock,
      price: formatMoney(product.price || 0, "JPY"),
      sales,
      status: "未連携",
      approval: mapApproval("pending"),
      tracking: "-",
    };
  });

  const summaryCards = [
    {
      title: "本日の売上",
      value: formatMoney(0, "JPY"),
      sub: "注文連携前",
    },
    {
      title: "月の売上",
      value: formatMoney(0, "JPY"),
      sub: "注文連携前",
    },
    {
      title: "未発送注文",
      value: "0",
      sub: "注文連携前",
    },
    {
      title: "登録商品数",
      value: String(products.length),
      sub: `店舗登録済み商品`,
    },
  ];

  const priorityOrders = [];

  const monthlySales = products.map((product) => ({
    name: product.name,
    sku: product.sku,
    quantity: 0,
  }));

  const chartData = [
    { label: "7日前", amount: 0 },
    { label: "6日前", amount: 0 },
    { label: "5日前", amount: 0 },
    { label: "4日前", amount: 0 },
    { label: "3日前", amount: 0 },
    { label: "2日前", amount: 0 },
    { label: "今日", amount: 0 },
  ];

  return json({
    vendor: {
      id: vendor.id,
      storeName: vendor.storeName,
      managementEmail: vendor.managementEmail,
      status: vendor.status,
    },
    store: {
      id: store.id,
      storeName: store.storeName,
      ownerName: store.ownerName,
      email: store.email,
      phone: store.phone,
      address: store.address,
      country: store.country,
      category: store.category,
    },
    summaryCards,
    priorityOrders,
    products,
    monthlySales,
    chartData,
  });
};

export default function VendorDashboard() {
  const { summaryCards, priorityOrders, products, monthlySales, chartData, store } =
    useLoaderData();

  const [query, setQuery] = useState("");

  const filteredProducts = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;

    return products.filter((product) => {
      return (
        String(product.name || "").toLowerCase().includes(q) ||
        String(product.sku || "").toLowerCase().includes(q) ||
        String(product.tracking || "").toLowerCase().includes(q)
      );
    });
  }, [query, products]);

  function exportMonthlyPdf() {
    window.print();
  }

  const chartMax = Math.max(...chartData.map((item) => item.amount), 1);

  return (
    <div className="vendor-dashboard">
      <style>{`
        .vendor-dashboard{
          min-height:100vh;
          background:#f3f4f6;
          color:#111827;
          font-family:Arial, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
        }
        .dash-topbar{
          background:#ffffff;
          border-bottom:1px solid #e5e7eb;
          padding:16px 24px;
        }
        .dash-topbar-inner{
          max-width:1400px;
          margin:0 auto;
          display:flex;
          align-items:center;
          gap:16px;
          flex-wrap:wrap;
        }
        .dash-brand{ min-width:260px; }
        .dash-brand-sub{
          font-size:12px;
          color:#6b7280;
          margin:0 0 4px;
        }
        .dash-brand-title{
          font-size:24px;
          font-weight:700;
          margin:0;
        }
        .dash-search{
          flex:1;
          min-width:260px;
        }
        .dash-search input{
          width:100%;
          height:44px;
          border:1px solid #d1d5db;
          border-radius:8px;
          padding:0 14px;
          font-size:14px;
          background:#f9fafb;
          box-sizing:border-box;
        }
        .dash-top-actions{
          display:flex;
          gap:10px;
          flex-wrap:wrap;
        }
        .dash-btn{
          height:44px;
          padding:0 16px;
          border-radius:8px;
          border:1px solid #d1d5db;
          background:#fff;
          font-size:14px;
          font-weight:700;
          cursor:pointer;
          text-decoration:none;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          box-sizing:border-box;
          color:#111827;
        }
        .dash-btn:hover{ background:#f9fafb; }
        .dash-btn-primary{
          background:#111827;
          color:#fff;
          border-color:#111827;
        }
        .dash-btn-primary:hover{ background:#1f2937; }
        .dash-layout{
          max-width:1400px;
          margin:0 auto;
          padding:24px;
          display:grid;
          grid-template-columns:260px 1fr;
          gap:24px;
        }
        .dash-sidebar{
          background:#fff;
          border:1px solid #e5e7eb;
          border-radius:14px;
          padding:14px;
          height:fit-content;
        }
        .dash-menu{
          display:grid;
          gap:8px;
        }
        .dash-menu-item{
          display:block;
          width:100%;
          text-align:left;
          padding:12px 14px;
          border:none;
          border-radius:10px;
          background:#fff;
          font-size:14px;
          font-weight:700;
          cursor:pointer;
          text-decoration:none;
          color:#111827;
          box-sizing:border-box;
        }
        .dash-menu-item:hover{ background:#f9fafb; }
        .dash-menu-item-active{
          background:#111827;
          color:#fff;
        }
        .dash-menu-item-active:hover{ background:#111827; }
        .dash-main{
          display:grid;
          gap:24px;
        }
        .dash-cards{
          display:grid;
          grid-template-columns:repeat(4, minmax(0, 1fr));
          gap:16px;
        }
        .dash-card{
          background:#fff;
          border:1px solid #e5e7eb;
          border-radius:14px;
          padding:18px;
          box-sizing:border-box;
        }
        .dash-card-title{
          font-size:13px;
          color:#6b7280;
          margin:0 0 10px;
        }
        .dash-card-value{
          font-size:30px;
          font-weight:700;
          margin:0 0 8px;
        }
        .dash-card-sub{
          font-size:13px;
          color:#6b7280;
          margin:0;
        }
        .dash-grid-2{
          display:grid;
          grid-template-columns:2fr 1fr;
          gap:24px;
        }
        .dash-grid-3{
          display:grid;
          grid-template-columns:2fr 1fr;
          gap:24px;
        }
        .dash-section-title{
          font-size:20px;
          font-weight:700;
          margin:0 0 8px;
        }
        .dash-section-sub{
          font-size:13px;
          color:#6b7280;
          margin:0 0 18px;
        }
        .dash-chart{
          height:260px;
          display:flex;
          align-items:end;
          gap:14px;
          padding-top:10px;
        }
        .dash-bar-wrap{
          flex:1;
          text-align:center;
        }
        .dash-bar{
          width:100%;
          border-radius:10px 10px 0 0;
          background:#111827;
          min-height:20px;
        }
        .dash-bar-label{
          font-size:12px;
          color:#6b7280;
          margin-top:8px;
        }
        .dash-health-list{
          display:grid;
          gap:14px;
        }
        .dash-health-row{
          display:grid;
          gap:6px;
        }
        .dash-health-head{
          display:flex;
          justify-content:space-between;
          font-size:14px;
        }
        .dash-progress{
          width:100%;
          height:10px;
          background:#e5e7eb;
          border-radius:999px;
          overflow:hidden;
        }
        .dash-progress-fill{
          height:100%;
          background:#111827;
        }
        .dash-alert{
          margin-top:18px;
          border:1px solid #f59e0b;
          background:#fffbeb;
          color:#92400e;
          border-radius:12px;
          padding:14px;
          font-size:14px;
          line-height:1.7;
        }
        .dash-order-list{
          display:grid;
          gap:12px;
        }
        .dash-order-empty{
          border:1px dashed #d1d5db;
          border-radius:12px;
          padding:20px;
          font-size:14px;
          color:#6b7280;
          background:#f9fafb;
        }
        .dash-pdf-box{
          border:1px solid #e5e7eb;
          background:#f9fafb;
          border-radius:12px;
          padding:14px;
          font-size:14px;
          line-height:1.8;
        }
        .dash-monthly-list{
          margin-top:14px;
          border-top:1px solid #e5e7eb;
          padding-top:14px;
        }
        .dash-monthly-row{
          display:flex;
          justify-content:space-between;
          gap:12px;
          padding:8px 0;
          font-size:14px;
          border-bottom:1px solid #f1f5f9;
        }
        .dash-table-wrap{ overflow-x:auto; }
        .dash-table{
          width:100%;
          min-width:980px;
          border-collapse:collapse;
        }
        .dash-table th{
          text-align:left;
          font-size:13px;
          color:#6b7280;
          border-bottom:1px solid #e5e7eb;
          padding:12px 10px;
          white-space:nowrap;
        }
        .dash-table td{
          padding:16px 10px;
          border-bottom:1px solid #f1f5f9;
          font-size:14px;
          vertical-align:middle;
        }
        .dash-product-name{ font-weight:700; }
        .dash-badge{
          display:inline-block;
          padding:5px 10px;
          border-radius:999px;
          font-size:12px;
          font-weight:700;
          line-height:1;
          border:1px solid transparent;
          white-space:nowrap;
        }
        .dash-badge-red{
          background:#fef2f2;
          color:#b91c1c;
          border-color:#fecaca;
        }
        .dash-badge-yellow{
          background:#fffbeb;
          color:#92400e;
          border-color:#fde68a;
        }
        .dash-badge-green{
          background:#ecfdf5;
          color:#047857;
          border-color:#a7f3d0;
        }
        .dash-badge-gray{
          background:#f3f4f6;
          color:#374151;
          border-color:#d1d5db;
        }

        @media print{
          .dash-sidebar,
          .dash-top-actions,
          .dash-search,
          .dash-btn{
            display:none !important;
          }
          .dash-layout{
            grid-template-columns:1fr;
            padding:0;
          }
          .dash-topbar{
            padding:0 0 20px;
            border-bottom:none;
          }
          .vendor-dashboard{ background:#fff; }
          .dash-card{ break-inside:avoid; }
        }

        @media (max-width: 1100px){
          .dash-layout{ grid-template-columns:1fr; }
          .dash-cards{
            grid-template-columns:repeat(2, minmax(0, 1fr));
          }
          .dash-grid-2,
          .dash-grid-3{
            grid-template-columns:1fr;
          }
        }

        @media (max-width: 700px){
          .dash-cards{ grid-template-columns:1fr; }
          .dash-topbar,
          .dash-layout{
            padding:16px;
          }
          .dash-brand-title{ font-size:20px; }
        }
      `}</style>

      <div className="dash-topbar">
        <div className="dash-topbar-inner">
          <div className="dash-brand">
            <p className="dash-brand-sub">店舗管理</p>
            <h1 className="dash-brand-title">
              {store?.storeName || "Oja Immanuel Bacchus Seller Center"}
            </h1>
          </div>

          <div className="dash-search">
            <input
              type="text"
              placeholder="商品名・SKU・追跡番号で検索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="dash-top-actions">
            <a
              className="dash-btn"
              href="https://vendor-register-pbjl.onrender.com/vendor/products/new"
            >
              新規商品登録
            </a>
            <button className="dash-btn dash-btn-primary" onClick={exportMonthlyPdf}>
              月次PDF出力
            </button>
          </div>
        </div>
      </div>

      <div className="dash-layout">
        <aside className="dash-sidebar">
          <div className="dash-menu">
            <a
              className="dash-menu-item dash-menu-item-active"
              href="https://vendor-register-pbjl.onrender.com/vendor/dashboard"
            >
              ダッシュボード
            </a>
            <button className="dash-menu-item" type="button">
              注文管理
            </button>
            <button className="dash-menu-item" type="button">
              商品管理
            </button>
            <button className="dash-menu-item" type="button">
              在庫
            </button>
            <button className="dash-menu-item" type="button">
              設定
            </button>
          </div>
        </aside>

        <main className="dash-main">
          <section className="dash-cards">
            {summaryCards.map((card) => (
              <div className="dash-card" key={card.title}>
                <p className="dash-card-title">{card.title}</p>
                <p className="dash-card-value">{card.value}</p>
                <p className="dash-card-sub">{card.sub}</p>
              </div>
            ))}
          </section>

          <section className="dash-grid-2">
            <div className="dash-card">
              <h2 className="dash-section-title">売上推移</h2>
              <p className="dash-section-sub">注文連携後にここへ反映されます</p>

              <div className="dash-chart">
                {chartData.map((item) => {
                  const h = Math.max(20, Math.round((item.amount / chartMax) * 220));
                  return (
                    <div className="dash-bar-wrap" key={item.label}>
                      <div className="dash-bar" style={{ height: `${h}px` }} />
                      <div className="dash-bar-label">{item.label}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="dash-card">
              <h2 className="dash-section-title">アカウント健全性</h2>
              <p className="dash-section-sub">今は商品登録ベースで表示中</p>

              <div className="dash-health-list">
                <div className="dash-health-row">
                  <div className="dash-health-head">
                    <span>登録商品数</span>
                    <span>{products.length}件</span>
                  </div>
                  <div className="dash-progress">
                    <div
                      className="dash-progress-fill"
                      style={{ width: `${products.length > 0 ? 100 : 0}%` }}
                    />
                  </div>
                </div>

                <div className="dash-health-row">
                  <div className="dash-health-head">
                    <span>申請中商品</span>
                    <span>{products.filter((p) => p.approval === "申請中").length}件</span>
                  </div>
                  <div className="dash-progress">
                    <div
                      className="dash-progress-fill"
                      style={{
                        width: `${Math.min(
                          100,
                          products.length === 0
                            ? 0
                            : (products.filter((p) => p.approval === "申請中").length /
                                products.length) *
                                100
                        )}%`,
                      }}
                    />
                  </div>
                </div>

                <div className="dash-health-row">
                  <div className="dash-health-head">
                    <span>承認済み商品</span>
                    <span>{products.filter((p) => p.approval === "承認済み").length}件</span>
                  </div>
                  <div className="dash-progress">
                    <div
                      className="dash-progress-fill"
                      style={{
                        width: `${Math.min(
                          100,
                          products.length === 0
                            ? 0
                            : (products.filter((p) => p.approval === "承認済み").length /
                                products.length) *
                                100
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              </div>

              <div className="dash-alert">
                この画面は vendor メール認証だけで表示しています。注文・売上・在庫の Shopify 連携は次段階で追加します。
              </div>
            </div>
          </section>

          <section className="dash-grid-3">
            <div className="dash-card">
              <h2 className="dash-section-title">優先対応の商品・注文</h2>
              <p className="dash-section-sub">注文連携前のため、まだ表示はありません</p>

              <div className="dash-order-list">
                {priorityOrders.length === 0 ? (
                  <div className="dash-order-empty">
                    まだ注文データは連携されていません。
                  </div>
                ) : null}
              </div>
            </div>

            <div className="dash-card">
              <h2 className="dash-section-title">月次PDF出力</h2>
              <p className="dash-section-sub">現時点では登録商品一覧ベースで出力</p>

              <div className="dash-pdf-box">
                <div><strong>出力内容</strong></div>
                <div>・登録商品一覧</div>
                <div>・画面表示中のダッシュボード</div>
              </div>

              <div className="dash-monthly-list">
                {monthlySales.map((item) => (
                  <div className="dash-monthly-row" key={`${item.sku}-${item.name}`}>
                    <span>{item.name}</span>
                    <strong>{item.quantity}個</strong>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: "14px" }}>
                <button className="dash-btn dash-btn-primary" onClick={exportMonthlyPdf}>
                  月次売上PDFを出力
                </button>
              </div>
            </div>
          </section>

          <section className="dash-card">
            <h2 className="dash-section-title">商品管理</h2>
            <p className="dash-section-sub">
              今はDBに保存されている vendor 商品を表示しています。
            </p>

            <div className="dash-table-wrap">
              <table className="dash-table">
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
                        <td className="dash-product-name">{product.name}</td>
                        <td>{product.sku}</td>
                        <td>{product.stock}</td>
                        <td>{product.price}</td>
                        <td>{product.sales}</td>
                        <td>
                          <span className={badgeClass(product.status)}>{product.status}</span>
                        </td>
                        <td>
                          <span className={badgeClass(product.approval)}>{product.approval}</span>
                        </td>
                        <td>{product.tracking}</td>
                        <td>
                          <button className="dash-btn" type="button">
                            詳細
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
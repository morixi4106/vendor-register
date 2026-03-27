import { createCookie, json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { useMemo, useState } from "react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

const vendorAdminSessionCookie = createCookie("vendor_admin_session", {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
});

function formatYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

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

function mapProductStatus(value) {
  if (value === "ACTIVE") return "販売中";
  if (value === "DRAFT") return "下書き";
  if (value === "ARCHIVED") return "アーカイブ";
  return value || "未設定";
}

function mapFulfillmentStatus(value) {
  if (!value) return "未発送";
  if (value === "FULFILLED") return "発送済み";
  if (value === "PARTIALLY_FULFILLED") return "一部発送";
  if (value === "UNFULFILLED") return "発送待ち";
  if (value === "IN_PROGRESS") return "対応中";
  if (value === "ON_HOLD") return "保留";
  if (value === "OPEN") return "対応要";
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

function formatCountdown(hours) {
  if (hours <= 0) return "期限処理済み";
  const whole = Math.floor(hours);
  const days = Math.floor(whole / 24);
  const rest = whole % 24;
  return `${days}日 ${rest}時間`;
}

function escapeShopifySearchValue(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .trim();
}

export const loader = async ({ request }) => {
  try {
    const { admin, session } = await authenticate.admin(request);

    console.log("=== vendor-dashboard loader start ===");
    console.log("session shop:", session?.shop);
    console.log("request url:", request.url);

    const cookieHeader = request.headers.get("Cookie");
    const sessionToken = await vendorAdminSessionCookie.parse(cookieHeader);

    if (!sessionToken) {
      throw redirect("/apps/vendors/verify");
    }

    const vendorSession = await prisma.vendorAdminSession.findUnique({
      where: { sessionToken },
      include: {
        vendor: {
          include: {
            vendorStore: true,
          },
        },
      },
    });

    if (!vendorSession || vendorSession.expiresAt < new Date()) {
      throw redirect("/apps/vendors/verify", {
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

    const vendorName = store.storeName || vendor.storeName || "";
    const escapedVendorName = escapeShopifySearchValue(vendorName);

    if (!escapedVendorName) {
      throw new Response("店舗名が見つかりません。", { status: 400 });
    }

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const vendorFilter = `vendor:"${escapedVendorName}"`;
    const ordersQueryString = `created_at:>=${formatYmd(monthStart)} status:any ${vendorFilter}`;
    const productsQueryString = vendorFilter;

    const productsQuery = `
      query VendorDashboardProducts($query: String!) {
        products(first: 50, sortKey: UPDATED_AT, reverse: true, query: $query) {
          nodes {
            id
            title
            vendor
            status
            totalInventory
            metafield(namespace: "custom", key: "approval_status") {
              value
            }
            variants(first: 1) {
              nodes {
                sku
                price
              }
            }
          }
        }
      }
    `;

    const ordersQuery = `
      query VendorDashboardOrders($query: String!) {
        orders(first: 50, sortKey: CREATED_AT, reverse: true, query: $query) {
          nodes {
            id
            name
            createdAt
            displayFulfillmentStatus
            currentTotalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            customer {
              displayName
            }
            lineItems(first: 20) {
              nodes {
                name
                quantity
                variant {
                  sku
                }
              }
            }
            fulfillments {
              trackingInfo {
                number
              }
            }
          }
        }
      }
    `;

    const [productsRes, ordersRes] = await Promise.all([
      admin.graphql(productsQuery, {
        variables: { query: productsQueryString },
      }),
      admin.graphql(ordersQuery, {
        variables: { query: ordersQueryString },
      }),
    ]);

    const productsJson = await productsRes.json();
    const ordersJson = await ordersRes.json();

    console.log("vendorName:", vendorName);
    console.log("productsQueryString:", productsQueryString);
    console.log("ordersQueryString:", ordersQueryString);
    console.log("productsJson:", JSON.stringify(productsJson, null, 2));
    console.log("ordersJson:", JSON.stringify(ordersJson, null, 2));

    if (productsJson.errors || ordersJson.errors) {
      console.error("products errors raw:", JSON.stringify(productsJson.errors, null, 2));
      console.error("orders errors raw:", JSON.stringify(ordersJson.errors, null, 2));
      console.error("products full raw:", JSON.stringify(productsJson, null, 2));
      console.error("orders full raw:", JSON.stringify(ordersJson, null, 2));
      throw new Error("GraphQL errors detected");
    }

    const rawProducts = productsJson?.data?.products?.nodes || [];
    const rawOrders = ordersJson?.data?.orders?.nodes || [];

    const monthlySalesMap = new Map();
    let monthSalesAmount = 0;
    let todaySalesAmount = 0;
    let monthUnits = 0;

    for (const order of rawOrders) {
      const money = order?.currentTotalPriceSet?.shopMoney;
      const amount = Number(money?.amount || 0);
      const createdAt = new Date(order.createdAt);

      monthSalesAmount += amount;

      if (createdAt >= todayStart) {
        todaySalesAmount += amount;
      }

      for (const line of order?.lineItems?.nodes || []) {
        const key = line?.variant?.sku || line?.name || "UNKNOWN";
        const current = monthlySalesMap.get(key) || {
          name: line?.name || "商品名なし",
          sku: line?.variant?.sku || "-",
          quantity: 0,
        };
        current.quantity += Number(line?.quantity || 0);
        monthUnits += Number(line?.quantity || 0);
        monthlySalesMap.set(key, current);
      }
    }

    const monthlySales = Array.from(monthlySalesMap.values())
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 20);

    const monthlySalesBySku = new Map(
      monthlySales.map((item) => [item.sku, item.quantity])
    );

    const products = rawProducts.map((product) => {
      const variant = product?.variants?.nodes?.[0];
      const stock = Number(product?.totalInventory ?? 0);
      const sku = variant?.sku || "-";
      const sales = monthlySalesBySku.get(sku) || 0;

      return {
        id: product.id,
        name: product.title,
        vendor: product.vendor || vendorName,
        sku,
        stock,
        price: formatMoney(variant?.price || 0, "JPY"),
        sales,
        status:
          stock <= 0
            ? "在庫切れ"
            : stock <= 20
              ? "在庫少"
              : mapProductStatus(product.status),
        approval: mapApproval(product?.metafield?.value),
        tracking: "-",
      };
    });

    const priorityOrders = rawOrders
      .map((order) => {
        const createdAt = new Date(order.createdAt);
        const diffMs = Date.now() - createdAt.getTime();
        const elapsedHours = diffMs / (1000 * 60 * 60);
        const remainingHours = Math.max(0, 72 - elapsedHours);

        const firstLine = order?.lineItems?.nodes?.[0];
        const trackingNumbers = [];

        for (const fulfillment of order?.fulfillments || []) {
          for (const info of fulfillment?.trackingInfo || []) {
            if (info?.number) trackingNumbers.push(info.number);
          }
        }

        return {
          id: order.name,
          customer: order?.customer?.displayName || "購入者なし",
          product: firstLine?.name || "商品なし",
          quantity: firstLine?.quantity || 0,
          total: formatMoney(
            order?.currentTotalPriceSet?.shopMoney?.amount || 0,
            order?.currentTotalPriceSet?.shopMoney?.currencyCode || "JPY"
          ),
          status: mapFulfillmentStatus(order?.displayFulfillmentStatus),
          age: new Intl.DateTimeFormat("ja-JP", {
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }).format(createdAt),
          tracking:
            trackingNumbers.length > 0 ? trackingNumbers.join(", ") : "-",
          countdownHours: remainingHours,
        };
      })
      .sort((a, b) => a.countdownHours - b.countdownHours)
      .slice(0, 10);

    const summaryCards = [
      {
        title: "本日の売上",
        value: formatMoney(todaySalesAmount, "JPY"),
        sub: "本日分の注文合計",
      },
      {
        title: "月の売上",
        value: formatMoney(monthSalesAmount, "JPY"),
        sub: `今月 ${monthUnits.toLocaleString("ja-JP")}点`,
      },
      {
        title: "未発送注文",
        value: String(
          priorityOrders.filter(
            (o) => o.status === "発送待ち" || o.status === "一部発送" || o.status === "対応要"
          ).length
        ),
        sub: "72時間対応対象を優先表示",
      },
      {
        title: "公開中商品",
        value: String(products.filter((p) => p.status === "販売中").length),
        sub: `全${products.length}商品`,
      },
    ];

    const chartData = [];
    for (let i = 6; i >= 0; i -= 1) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
      const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);

      let amount = 0;
      for (const order of rawOrders) {
        const createdAt = new Date(order.createdAt);
        if (createdAt >= start && createdAt < end) {
          amount += Number(order?.currentTotalPriceSet?.shopMoney?.amount || 0);
        }
      }

      chartData.push({
        label: `${day.getMonth() + 1}/${day.getDate()}`,
        amount,
      });
    }

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
  } catch (error) {
    console.error("vendor-dashboard loader error full:", error);

    if (error?.body) {
      console.error("error.body:", JSON.stringify(error.body, null, 2));
    }

    if (error?.graphQLErrors) {
      console.error("error.graphQLErrors:", JSON.stringify(error.graphQLErrors, null, 2));
    }

    if (error?.response) {
      console.error("error.response:", JSON.stringify(error.response, null, 2));
    }

    throw error;
  }
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
        .dash-order-item{
          border:1px solid #e5e7eb;
          border-radius:12px;
          padding:14px;
          display:flex;
          justify-content:space-between;
          gap:16px;
          align-items:center;
          flex-wrap:wrap;
        }
        .dash-order-main{
          display:grid;
          gap:6px;
          flex:1;
          min-width:260px;
        }
        .dash-order-title{
          font-size:15px;
          font-weight:700;
          margin:0;
        }
        .dash-order-sub{
          font-size:13px;
          color:#6b7280;
          margin:0;
        }
        .dash-order-right{
          min-width:170px;
          text-align:right;
        }
        .dash-countdown-label{
          font-size:12px;
          color:#6b7280;
        }
        .dash-countdown-box{
          display:inline-block;
          margin-top:6px;
          padding:8px 12px;
          border-radius:12px;
          font-size:14px;
          font-weight:700;
          background:#f3f4f6;
          color:#374151;
        }
        .dash-countdown-box.is-danger{
          background:#fef2f2;
          color:#b91c1c;
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
          .dash-btn,
          .dash-order-right .dash-order-sub{
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
          .dash-order-right{
            width:100%;
            text-align:left;
          }
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
            <button className="dash-btn dash-btn-primary" onClick={exportMonthlyPdf}>
              月次PDF出力
            </button>
          </div>
        </div>
      </div>

      <div className="dash-layout">
        <aside className="dash-sidebar">
          <div className="dash-menu">
            <button className="dash-menu-item dash-menu-item-active">ダッシュボード</button>
            <button className="dash-menu-item">注文管理</button>
            <button className="dash-menu-item">商品管理</button>
            <button className="dash-menu-item">在庫</button>
            <button className="dash-menu-item">設定</button>
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
              <p className="dash-section-sub">過去7日間の注文売上</p>

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
              <p className="dash-section-sub">警告が出る前に確認</p>

              <div className="dash-health-list">
                <div className="dash-health-row">
                  <div className="dash-health-head">
                    <span>72時間超過リスク注文</span>
                    <span>
                      {
                        priorityOrders.filter(
                          (order) => order.countdownHours > 0 && order.countdownHours <= 24
                        ).length
                      }件
                    </span>
                  </div>
                  <div className="dash-progress">
                    <div
                      className="dash-progress-fill"
                      style={{
                        width: `${Math.min(
                          100,
                          priorityOrders.length === 0
                            ? 0
                            : (priorityOrders.filter(
                                (order) =>
                                  order.countdownHours > 0 && order.countdownHours <= 24
                              ).length /
                                priorityOrders.length) *
                                100
                        )}%`,
                      }}
                    />
                  </div>
                </div>

                <div className="dash-health-row">
                  <div className="dash-health-head">
                    <span>在庫少商品</span>
                    <span>{products.filter((p) => p.status === "在庫少").length}件</span>
                  </div>
                  <div className="dash-progress">
                    <div
                      className="dash-progress-fill"
                      style={{
                        width: `${Math.min(
                          100,
                          products.length === 0
                            ? 0
                            : (products.filter((p) => p.status === "在庫少").length /
                                products.length) *
                                100
                        )}%`,
                      }}
                    />
                  </div>
                </div>

                <div className="dash-health-row">
                  <div className="dash-health-head">
                    <span>在庫切れ商品</span>
                    <span>{products.filter((p) => p.status === "在庫切れ").length}件</span>
                  </div>
                  <div className="dash-progress">
                    <div
                      className="dash-progress-fill"
                      style={{
                        width: `${Math.min(
                          100,
                          products.length === 0
                            ? 0
                            : (products.filter((p) => p.status === "在庫切れ").length /
                                products.length) *
                                100
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              </div>

              <div className="dash-alert">
                注文・在庫・月次売上は Shopify 実データから表示中です。
              </div>
            </div>
          </section>

          <section className="dash-grid-3">
            <div className="dash-card">
              <h2 className="dash-section-title">優先対応の商品・注文</h2>
              <p className="dash-section-sub">72時間以内に対応したい注文を上に表示</p>

              <div className="dash-order-list">
                {priorityOrders.map((order) => (
                  <div className="dash-order-item" key={order.id}>
                    <div className="dash-order-main">
                      <p className="dash-order-title">
                        {order.id} <span className={badgeClass(order.status)}>{order.status}</span>
                      </p>
                      <p className="dash-order-sub">
                        {order.customer} ・ {order.product} ・ {order.quantity}点 ・ {order.total}
                      </p>
                      <p className="dash-order-sub">追跡番号: {order.tracking}</p>
                    </div>

                    <div className="dash-order-right">
                      <div className="dash-countdown-label">72時間カウントダウン</div>
                      <div
                        className={`dash-countdown-box ${
                          order.countdownHours <= 24 && order.countdownHours > 0
                            ? "is-danger"
                            : ""
                        }`}
                      >
                        {formatCountdown(order.countdownHours)}
                      </div>
                      <p className="dash-order-sub" style={{ marginTop: "8px" }}>
                        {order.age}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="dash-card">
              <h2 className="dash-section-title">月次PDF出力</h2>
              <p className="dash-section-sub">月の売れた商品名と個数をワンボタンで出力</p>

              <div className="dash-pdf-box">
                <div><strong>出力内容</strong></div>
                <div>・月の売上合計</div>
                <div>・商品名ごとの販売数</div>
                <div>・注文ごとの追跡番号</div>
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
              Shopify 商品データから表示。月間販売数も同じ画面で確認。
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
                  {filteredProducts.map((product) => (
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
                        <button className="dash-btn">詳細</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
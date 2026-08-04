import { createCookie, json, redirect } from "@remix-run/node";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
const vendorAdminSessionCookie = createCookie("vendor_admin_session", {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production"
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
      maximumFractionDigits: 0
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
function escapeShopifySearchValue(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').trim();
}
export const loader = async ({
  request
}) => {
  try {
    const {
      admin,
      session
    } = await authenticate.admin(request);
    console.log("=== vendor-dashboard loader start ===");
    console.log("session shop:", session?.shop);
    console.log("request url:", request.url);
    const cookieHeader = request.headers.get("Cookie");
    const sessionToken = await vendorAdminSessionCookie.parse(cookieHeader);
    if (!sessionToken) {
      throw redirect("/apps/vendors/verify");
    }
    const vendorSession = await prisma.vendorAdminSession.findUnique({
      where: {
        sessionToken
      },
      include: {
        vendor: {
          include: {
            vendorStore: true
          }
        }
      }
    });
    if (!vendorSession || vendorSession.expiresAt < new Date()) {
      throw redirect("/apps/vendorverify", {
        headers: {
          "Set-Cookie": await vendorAdminSessionCookie.serialize("", {
            maxAge: 0
          })
        }
      });
    }
    const vendor = vendorSession.vendor;
    const store = vendor?.vendorStore;
    if (!vendor || !store) {
      throw new Response("店舗情報が見つかりません。", {
        status: 404
      });
    }
    const vendorName = store.storeName || vendor.storeName || "";
    const escapedVendorName = escapeShopifySearchValue(vendorName);
    if (!escapedVendorName) {
      throw new Response("店舗名が見つかりません。", {
        status: 400
      });
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
    const [productsRes, ordersRes] = await Promise.all([admin.graphql(productsQuery, {
      variables: {
        query: productsQueryString
      }
    }), admin.graphql(ordersQuery, {
      variables: {
        query: ordersQueryString
      }
    })]);
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
          quantity: 0
        };
        current.quantity += Number(line?.quantity || 0);
        monthUnits += Number(line?.quantity || 0);
        monthlySalesMap.set(key, current);
      }
    }
    const monthlySales = Array.from(monthlySalesMap.values()).sort((a, b) => b.quantity - a.quantity).slice(0, 20);
    const monthlySalesBySku = new Map(monthlySales.map(item => [item.sku, item.quantity]));
    const products = rawProducts.map(product => {
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
        status: stock <= 0 ? "在庫切れ" : stock <= 20 ? "在庫少" : mapProductStatus(product.status),
        approval: mapApproval(product?.metafield?.value),
        tracking: "-"
      };
    });
    const priorityOrders = rawOrders.map(order => {
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
        total: formatMoney(order?.currentTotalPriceSet?.shopMoney?.amount || 0, order?.currentTotalPriceSet?.shopMoney?.currencyCode || "JPY"),
        status: mapFulfillmentStatus(order?.displayFulfillmentStatus),
        age: new Intl.DateTimeFormat("ja-JP", {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        }).format(createdAt),
        tracking: trackingNumbers.length > 0 ? trackingNumbers.join(", ") : "-",
        countdownHours: remainingHours
      };
    }).sort((a, b) => a.countdownHours - b.countdownHours).slice(0, 10);
    const summaryCards = [{
      title: "本日の売上",
      value: formatMoney(todaySalesAmount, "JPY"),
      sub: "本日分の注文合計"
    }, {
      title: "月の売上",
      value: formatMoney(monthSalesAmount, "JPY"),
      sub: `今月 ${monthUnits.toLocaleString("ja-JP")}点`
    }, {
      title: "未発送注文",
      value: String(priorityOrders.filter(o => o.status === "発送待ち" || o.status === "一部発送" || o.status === "対応要").length),
      sub: "72時間対応対象を優先表示"
    }, {
      title: "公開中商品",
      value: String(products.filter(p => p.status === "販売中").length),
      sub: `全${products.length}商品`
    }];
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
        amount
      });
    }
    return json({
      vendor: {
        id: vendor.id,
        storeName: vendor.storeName,
        managementEmail: vendor.managementEmail,
        status: vendor.status
      },
      store: {
        id: store.id,
        storeName: store.storeName,
        ownerName: store.ownerName,
        email: store.email,
        phone: store.phone,
        address: store.address,
        country: store.country,
        category: store.category
      },
      summaryCards,
      priorityOrders,
      products,
      monthlySales,
      chartData
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
export { default } from "../components/vendors/AdminVendorDashboardPage.jsx";

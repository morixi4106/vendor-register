import prisma from "../../db.server.js";
import { shopifyGraphQLWithOfflineSession } from "../../utils/shopifyAdmin.server.js";
import { SHOPIFY_API_VERSION } from "../../utils/shopifyApiVersion.js";
import { createOrderSettlementSummary, createSellerOrderSettlementSummary, createVendorWithdrawalSummary, formatDateTime, formatMoney, formatPublicResourceId, getLedgerMetadata, isReconnectableShopifyError, listGrantedAppAccessScopes, listVendorStoreShopDomains, listVendorWithdrawalRequestsForSellerOrders } from "./common.js";
export const READ_ORDERS_SCOPE = "read_orders";
export const READ_DRAFT_ORDERS_SCOPE = "read_draft_orders";
export const READ_MERCHANT_FULFILLMENT_ORDERS_SCOPE = "read_merchant_managed_fulfillment_orders";
export const WRITE_MERCHANT_FULFILLMENT_ORDERS_SCOPE = "write_merchant_managed_fulfillment_orders";
export const VENDOR_DRAFT_ORDERS_PAGE_SIZE = 50;
function normalizeBooleanInput(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value == null) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}
function normalizeLowercase(value) {
  return String(value || "").trim().toLowerCase();
}
function shouldUseSellerOrderVendorOrdersRead(env = process.env) {
  return normalizeBooleanInput(env.VENDOR_ORDERS_USE_SELLER_ORDERS);
}
export async function getVendorOrdersAccessState({
  storeId
}, {
  listVendorStoreShopDomainsImpl = listVendorStoreShopDomains,
  listGrantedAppAccessScopesImpl = listGrantedAppAccessScopes
} = {}) {
  try {
    const shopDomains = await listVendorStoreShopDomainsImpl(storeId);
    if (shopDomains.length === 0) {
      return {
        status: "missing_shop",
        hasReadDraftOrders: false,
        grantedScopes: [],
        shopDomain: null,
        shopDomains: []
      };
    }
    if (shopDomains.length > 1) {
      return {
        status: "ambiguous_shop",
        hasReadDraftOrders: false,
        grantedScopes: [],
        shopDomain: null,
        shopDomains
      };
    }
    const shopDomain = shopDomains[0];
    const grantedScopes = await listGrantedAppAccessScopesImpl(shopDomain);
    const hasReadOrders = grantedScopes.includes(READ_ORDERS_SCOPE);
    const hasReadDraftOrders = grantedScopes.includes(READ_DRAFT_ORDERS_SCOPE);
    return {
      status: hasReadOrders ? "ready" : "missing_scope",
      hasReadOrders,
      hasReadDraftOrders,
      grantedScopes,
      shopDomain,
      shopDomains
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("vendor orders access state error:", error);
    if (isReconnectableShopifyError(message)) {
      return {
        status: "missing_connection",
        hasReadDraftOrders: false,
        grantedScopes: [],
        shopDomain: null,
        shopDomains: []
      };
    }
    return {
      status: "error",
      hasReadDraftOrders: false,
      grantedScopes: [],
      shopDomain: null,
      shopDomains: []
    };
  }
}
const VENDOR_DRAFT_ORDERS_QUERY = `
  query VendorDraftOrders($first: Int!, $query: String!) {
    draftOrders(first: $first, query: $query) {
      nodes {
        id
        name
        createdAt
        completedAt
        order {
          id
          name
          createdAt
          email
          displayFinancialStatus
          displayFulfillmentStatus
          customer {
            displayName
          }
          shippingAddress {
            name
            address1
            address2
            city
            province
            zip
            country
            countryCodeV2
          }
          currentTotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          fulfillments {
            trackingInfo {
              company
              number
              url
            }
          }
        }
      }
    }
  }
`;
const VENDOR_LEDGER_ORDERS_QUERY = `
  query VendorLedgerOrders($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
        name
        createdAt
        email
        displayFinancialStatus
        displayFulfillmentStatus
        customer {
          displayName
        }
        shippingAddress {
          name
          address1
          address2
          city
          province
          zip
          country
          countryCodeV2
        }
        currentTotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        fulfillments {
          trackingInfo {
            company
            number
            url
          }
        }
      }
    }
  }
`;
function escapeShopifySearchValue(value = "") {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').trim();
}
export function buildVendorDraftOrdersSearchQuery(vendorHandle) {
  const normalizedHandle = escapeShopifySearchValue(vendorHandle);
  if (!normalizedHandle) {
    throw new Error("VENDOR_HANDLE_REQUIRED");
  }
  return `tag:vendor-storefront tag:"vendor:${normalizedHandle}" status:completed`;
}
function mapDisplayFinancialStatusLabel(value) {
  switch (value) {
    case "PAID":
      return "支払い済み";
    case "PENDING":
      return "支払い待ち";
    case "AUTHORIZED":
      return "オーソリ済み";
    case "PARTIALLY_PAID":
      return "一部支払い済み";
    case "PARTIALLY_REFUNDED":
      return "一部返金済み";
    case "REFUNDED":
      return "返金済み";
    case "VOIDED":
      return "無効";
    default:
      return value || "未設定";
  }
}
function mapDisplayFinancialStatusTone(value) {
  switch (value) {
    case "PAID":
      return "success";
    case "PENDING":
    case "AUTHORIZED":
    case "PARTIALLY_PAID":
      return "warning";
    case "REFUNDED":
    case "PARTIALLY_REFUNDED":
    case "VOIDED":
      return "neutral";
    default:
      return "neutral";
  }
}
function mapDisplayFulfillmentStatusLabel(value) {
  switch (value) {
    case "FULFILLED":
      return "発送済み";
    case "PARTIALLY_FULFILLED":
      return "一部発送";
    case "UNFULFILLED":
      return "未発送";
    case "IN_PROGRESS":
      return "発送処理中";
    case "ON_HOLD":
      return "保留";
    case "OPEN":
      return "対応中";
    case "SCHEDULED":
      return "発送予定";
    case "RESTOCKED":
      return "返品済み";
    default:
      return value || "未設定";
  }
}
function mapDisplayFulfillmentStatusTone(value) {
  switch (value) {
    case "FULFILLED":
      return "success";
    case "PARTIALLY_FULFILLED":
    case "IN_PROGRESS":
    case "OPEN":
    case "SCHEDULED":
      return "warning";
    case "ON_HOLD":
      return "danger";
    default:
      return "neutral";
  }
}
function formatShippingAddress(address) {
  const parts = formatShippingAddressLines(address);
  return parts.length > 0 ? parts.join(" ") : "未設定";
}
const JAPAN_PROVINCE_LABELS = new Map([["hokkaido", "北海道"], ["aomori", "青森県"], ["iwate", "岩手県"], ["miyagi", "宮城県"], ["akita", "秋田県"], ["yamagata", "山形県"], ["fukushima", "福島県"], ["ibaraki", "茨城県"], ["tochigi", "栃木県"], ["gunma", "群馬県"], ["saitama", "埼玉県"], ["chiba", "千葉県"], ["tokyo", "東京都"], ["tōkyō", "東京都"], ["kanagawa", "神奈川県"], ["niigata", "新潟県"], ["toyama", "富山県"], ["ishikawa", "石川県"], ["fukui", "福井県"], ["yamanashi", "山梨県"], ["nagano", "長野県"], ["gifu", "岐阜県"], ["shizuoka", "静岡県"], ["aichi", "愛知県"], ["mie", "三重県"], ["shiga", "滋賀県"], ["kyoto", "京都府"], ["ōsaka", "大阪府"], ["osaka", "大阪府"], ["hyogo", "兵庫県"], ["hyōgo", "兵庫県"], ["nara", "奈良県"], ["wakayama", "和歌山県"], ["tottori", "鳥取県"], ["shimane", "島根県"], ["okayama", "岡山県"], ["hiroshima", "広島県"], ["yamaguchi", "山口県"], ["tokushima", "徳島県"], ["kagawa", "香川県"], ["ehime", "愛媛県"], ["kochi", "高知県"], ["kōchi", "高知県"], ["fukuoka", "福岡県"], ["saga", "佐賀県"], ["nagasaki", "長崎県"], ["kumamoto", "熊本県"], ["oita", "大分県"], ["ōita", "大分県"], ["miyazaki", "宮崎県"], ["kagoshima", "鹿児島県"], ["okinawa", "沖縄県"]].flatMap(([key, label]) => [[key, label], [label.toLowerCase(), label]]));
function compactSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
function getShippingCountryLabel(address) {
  const countryCode = String(address?.countryCodeV2 || "").trim().toUpperCase();
  const country = compactSpaces(address?.country);
  if (countryCode === "JP" || ["Japan", "日本"].includes(country)) {
    return "日本";
  }
  return country || countryCode || "";
}
function getShippingProvinceLabel(address) {
  const countryCode = String(address?.countryCodeV2 || "").trim().toUpperCase();
  const province = compactSpaces(address?.province);
  if (countryCode === "JP" || getShippingCountryLabel(address) === "日本") {
    return JAPAN_PROVINCE_LABELS.get(province.toLowerCase()) || province;
  }
  return province;
}
function formatRecipientName(address) {
  const name = compactSpaces(address?.name);
  if (!name) return "";
  return getShippingCountryLabel(address) === "日本" ? `${name} 様` : name;
}
function formatShippingAddressLines(address) {
  if (!address) return [];
  const country = getShippingCountryLabel(address);
  const province = getShippingProvinceLabel(address);
  const city = compactSpaces(address.city);
  const zip = compactSpaces(address.zip);
  const address1 = compactSpaces(address.address1);
  const address2 = compactSpaces(address.address2);
  const recipientName = formatRecipientName(address);
  if (country === "日本") {
    return [zip ? `〒${zip}` : "", [province, city].filter(Boolean).join(""), [address1, address2].filter(Boolean).join(" "), recipientName].filter(Boolean);
  }
  return [recipientName, [address1, address2].filter(Boolean).join(" "), [city, province, zip].filter(Boolean).join(" "), country].filter(Boolean);
}
function formatShippingAddressSummary(address) {
  if (!address) return "未設定";
  const cityParts = [getShippingProvinceLabel(address), address.city].map(compactSpaces).filter(Boolean);
  if (cityParts.length > 0) {
    return getShippingCountryLabel(address) === "日本" ? cityParts.join("") : cityParts.join(" ");
  }
  const fallback = getShippingCountryLabel(address);
  return fallback || "未設定";
}
function formatShippingAddressRows(address) {
  if (!address) return [];
  const rows = [["宛名", formatRecipientName(address)], ["郵便番号", compactSpaces(address.zip)], ["国/地域", getShippingCountryLabel(address)], ["都道府県", getShippingProvinceLabel(address)], ["市区町村", compactSpaces(address.city)], ["住所1", compactSpaces(address.address1)], ["住所2", compactSpaces(address.address2)]];
  return rows.filter(([, value]) => Boolean(value)).map(([label, value]) => ({
    label,
    value
  }));
}
function summarizeTrackingInfo(fulfillments = []) {
  const trackingItems = [];
  for (const fulfillment of Array.isArray(fulfillments) ? fulfillments : []) {
    for (const info of Array.isArray(fulfillment?.trackingInfo) ? fulfillment.trackingInfo : []) {
      const number = String(info?.number || "").trim();
      if (!number) continue;
      trackingItems.push({
        company: String(info?.company || "").trim(),
        number,
        url: String(info?.url || "").trim()
      });
    }
  }
  if (trackingItems.length === 0) {
    return {
      trackingLabel: "-",
      trackingUrl: null
    };
  }
  return {
    trackingLabel: trackingItems.map(item => item.company ? `${item.company}: ${item.number}` : item.number).join(", "),
    trackingUrl: trackingItems.find(item => item.url)?.url || null
  };
}
function summarizeSellerOrderTrackingInfo(sellerOrder) {
  const shipmentTrackingItems = [];
  for (const shipment of Array.isArray(sellerOrder?.shipments) ? sellerOrder.shipments : []) {
    const number = String(shipment?.trackingNumber || "").trim();
    if (!number) continue;
    shipmentTrackingItems.push({
      company: String(shipment?.trackingCompany || "").trim(),
      number,
      url: String(shipment?.trackingUrl || "").trim()
    });
  }
  if (shipmentTrackingItems.length > 0) {
    return {
      trackingLabel: shipmentTrackingItems.map(item => item.company ? `${item.company}: ${item.number}` : item.number).join(", "),
      trackingUrl: shipmentTrackingItems.find(item => item.url)?.url || null
    };
  }
  const metadata = sellerOrder?.metadataJson && typeof sellerOrder.metadataJson === "object" && !Array.isArray(sellerOrder.metadataJson) ? sellerOrder.metadataJson : {};
  const shipment = metadata.lastShipment;
  if (!shipment || typeof shipment !== "object") {
    return null;
  }
  const number = String(shipment.trackingNumber || "").trim();
  if (!number) return null;
  const company = String(shipment.trackingCompany || "").trim();
  return {
    trackingLabel: company ? `${company}: ${number}` : number,
    trackingUrl: String(shipment.trackingUrl || "").trim() || null
  };
}
function createOrderSettlementSummaryMap(entries = [], orderIds = []) {
  const entryList = Array.isArray(entries) ? entries : [];
  return new Map(orderIds.map(orderId => [orderId, createOrderSettlementSummary(orderId, entryList)]));
}
function mapSellerOrderFulfillmentStatusToDisplay(value) {
  switch (normalizeLowercase(value)) {
    case "fulfilled":
      return "FULFILLED";
    case "partially_fulfilled":
    case "partial":
      return "PARTIALLY_FULFILLED";
    case "unfulfilled":
    case "open":
      return "UNFULFILLED";
    default:
      return "";
  }
}
async function listVendorOrderRefundLedgerReferences({
  storeId,
  orderIds
}, {
  prismaClient = prisma
} = {}) {
  const orderIdSet = new Set((Array.isArray(orderIds) ? orderIds : []).map(orderId => String(orderId || "").trim()).filter(Boolean));
  if (orderIdSet.size === 0) {
    return [];
  }
  const entries = await prismaClient.ledgerEntry.findMany({
    where: {
      entryType: "refund",
      seller: {
        is: {
          vendorStoreId: storeId
        }
      }
    },
    orderBy: [{
      occurredAt: "desc"
    }, {
      createdAt: "desc"
    }],
    take: Math.max(200, orderIdSet.size * 10),
    select: {
      id: true,
      entryType: true,
      stripeObjectId: true,
      amount: true,
      currencyCode: true,
      metadataJson: true,
      occurredAt: true,
      createdAt: true
    }
  });
  return entries.filter(entry => orderIdSet.has(String(getLedgerMetadata(entry).shopifyOrderId || "").trim()));
}
function serializeVendorOrderRow(orderRecord) {
  const order = orderRecord?.order || orderRecord;
  const ledgerEntry = orderRecord?.ledgerEntry || null;
  const sellerOrder = orderRecord?.sellerOrder || null;
  const ledgerSummary = orderRecord?.ledgerSummary || createOrderSettlementSummary(order?.id, ledgerEntry ? [ledgerEntry] : []);
  if (!order?.id || !order?.name) {
    return null;
  }
  const shopMoney = order?.currentTotalPriceSet?.shopMoney;
  const createdAt = order?.createdAt || orderRecord?.completedAt || orderRecord?.createdAt || sellerOrder?.createdAt || ledgerEntry?.occurredAt || ledgerEntry?.createdAt;
  const financialStatus = String(order?.displayFinancialStatus || "").trim();
  const appFinancialStatus = ledgerSummary.fullyRefunded ? "REFUNDED" : ledgerSummary.partiallyRefunded ? "PARTIALLY_REFUNDED" : financialStatus;
  const fulfillmentStatus = mapSellerOrderFulfillmentStatusToDisplay(sellerOrder?.fulfillmentStatus) || String(order?.displayFulfillmentStatus || "").trim();
  const currencyCode = shopMoney?.currencyCode || "JPY";
  const tracking = summarizeSellerOrderTrackingInfo(sellerOrder) || summarizeTrackingInfo(order?.fulfillments);
  return {
    id: order.id,
    orderId: order.id,
    sellerOrderId: sellerOrder?.id || null,
    publicOrderIdLabel: formatPublicResourceId(order.id),
    orderName: order.name,
    shopifyOrderNumber: order.name,
    createdAt: createdAt || null,
    createdAtLabel: formatDateTime(createdAt),
    customerName: order?.customer?.displayName || "未設定",
    email: order?.email || "未設定",
    shippingAddressLabel: formatShippingAddress(order?.shippingAddress),
    shippingAddressLines: formatShippingAddressLines(order?.shippingAddress),
    shippingAddressRows: formatShippingAddressRows(order?.shippingAddress),
    shippingAddressSummary: formatShippingAddressSummary(order?.shippingAddress),
    shippingCountryCode: order?.shippingAddress?.countryCodeV2 || null,
    totalAmount: Number(shopMoney?.amount || 0),
    totalCurrencyCode: currencyCode,
    totalLabel: formatMoney(shopMoney?.amount || 0, currencyCode),
    financialStatus: appFinancialStatus,
    financialStatusLabel: mapDisplayFinancialStatusLabel(appFinancialStatus),
    financialStatusTone: mapDisplayFinancialStatusTone(appFinancialStatus),
    ledgerPaidAmount: ledgerSummary.paidAmount,
    ledgerRefundAmount: ledgerSummary.refundAmount,
    ledgerNetAmount: ledgerSummary.netAmount,
    isFullyRefundedByLedger: ledgerSummary.fullyRefunded,
    fulfillmentStatus,
    fulfillmentStatusLabel: mapDisplayFulfillmentStatusLabel(fulfillmentStatus),
    fulfillmentStatusTone: mapDisplayFulfillmentStatusTone(fulfillmentStatus),
    trackingLabel: tracking.trackingLabel,
    trackingUrl: tracking.trackingUrl,
    canRegisterShipment: financialStatus === "PAID" && !ledgerSummary.fullyRefunded && !["FULFILLED", "RESTOCKED"].includes(fulfillmentStatus)
  };
}
export async function listVendorDraftOrderOrders({
  shopDomain,
  vendorHandle,
  first = VENDOR_DRAFT_ORDERS_PAGE_SIZE
}, {
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession
} = {}) {
  const queryString = buildVendorDraftOrdersSearchQuery(vendorHandle);
  const response = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: VENDOR_DRAFT_ORDERS_QUERY,
    variables: {
      first,
      query: queryString
    }
  });
  const data = response?.data;
  if (Array.isArray(response?.errors) && response.errors.length > 0) {
    throw new Error("VENDOR_DRAFT_ORDERS_QUERY_FAILED");
  }
  const nodes = data?.draftOrders?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error("VENDOR_DRAFT_ORDERS_QUERY_UNAVAILABLE");
  }
  const orders = nodes.map(serializeVendorOrderRow).filter(Boolean).sort((left, right) => {
    const leftTime = left?.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right?.createdAt ? new Date(right.createdAt).getTime() : 0;
    return rightTime - leftTime;
  });
  return {
    queryString,
    orders
  };
}
export async function listVendorShopifyOrderLedgerReferences({
  storeId,
  first = VENDOR_DRAFT_ORDERS_PAGE_SIZE
}, {
  prismaClient = prisma
} = {}) {
  const entries = await prismaClient.ledgerEntry.findMany({
    where: {
      entryType: "shopify_order_paid",
      stripeObjectId: {
        not: null
      },
      seller: {
        is: {
          vendorStoreId: storeId
        }
      }
    },
    orderBy: [{
      occurredAt: "desc"
    }, {
      createdAt: "desc"
    }],
    take: first,
    select: {
      id: true,
      entryType: true,
      stripeObjectId: true,
      amount: true,
      currencyCode: true,
      metadataJson: true,
      occurredAt: true,
      createdAt: true
    }
  });
  const seenOrderIds = new Set();
  return entries.map(entry => ({
    ...entry,
    shopifyOrderId: String(entry?.stripeObjectId || "").trim()
  })).filter(entry => {
    if (!entry.shopifyOrderId.startsWith("gid://shopify/Order/")) {
      return false;
    }
    if (seenOrderIds.has(entry.shopifyOrderId)) {
      return false;
    }
    seenOrderIds.add(entry.shopifyOrderId);
    return true;
  });
}
export async function listVendorShopifyOrderSellerOrderReferences({
  storeId,
  first = VENDOR_DRAFT_ORDERS_PAGE_SIZE
}, {
  prismaClient = prisma
} = {}) {
  if (!prismaClient?.sellerOrder?.findMany) {
    return [];
  }
  const sellerOrders = await prismaClient.sellerOrder.findMany({
    where: {
      vendorStoreId: storeId
    },
    orderBy: [{
      createdAt: "desc"
    }],
    take: first,
    select: {
      id: true,
      marketplaceOrderId: true,
      shopifyOrderId: true,
      shopifyOrderName: true,
      sellerRefundAmount: true,
      sellerNetAmount: true,
      sellerPayableAmount: true,
      currencyCode: true,
      paymentStatus: true,
      fulfillmentStatus: true,
      metadataJson: true,
      createdAt: true,
      updatedAt: true,
      lines: {
        select: {
          id: true,
          shopifyLineItemId: true,
          shopifyProductId: true,
          shopifyVariantId: true,
          productId: true,
          title: true,
          quantity: true
        }
      },
      shipments: {
        orderBy: {
          createdAt: "desc"
        },
        take: 5,
        select: {
          id: true,
          shopifyFulfillmentId: true,
          trackingNumber: true,
          trackingCompany: true,
          trackingUrl: true,
          status: true,
          shippedAt: true,
          createdAt: true
        }
      }
    }
  });
  const seenOrderIds = new Set();
  return sellerOrders.map(sellerOrder => ({
    ...sellerOrder,
    shopifyOrderId: String(sellerOrder?.shopifyOrderId || "").trim()
  })).filter(sellerOrder => {
    if (!sellerOrder.shopifyOrderId.startsWith("gid://shopify/Order/")) {
      return false;
    }
    if (seenOrderIds.has(sellerOrder.shopifyOrderId)) {
      return false;
    }
    seenOrderIds.add(sellerOrder.shopifyOrderId);
    return true;
  });
}
function groupVendorWithdrawalRequestsByOrderId(withdrawalRequests = []) {
  const grouped = new Map();
  for (const withdrawalRequest of Array.isArray(withdrawalRequests) ? withdrawalRequests : []) {
    const orderId = String(withdrawalRequest.shopifyOrderId || "").trim();
    if (!orderId) continue;
    const current = grouped.get(orderId) || [];
    current.push(withdrawalRequest);
    grouped.set(orderId, current);
  }
  return grouped;
}
export async function listVendorShopifyOrdersFromLedger({
  storeId,
  shopDomain,
  first = VENDOR_DRAFT_ORDERS_PAGE_SIZE
}, {
  prismaClient = prisma,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession
} = {}) {
  const queryString = "ledger:shopify_order_paid";
  const ledgerEntries = await listVendorShopifyOrderLedgerReferences({
    storeId,
    first
  }, {
    prismaClient
  });
  const orderIds = ledgerEntries.map(entry => entry.shopifyOrderId);
  if (orderIds.length === 0) {
    return {
      queryString,
      orders: []
    };
  }
  const response = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: VENDOR_LEDGER_ORDERS_QUERY,
    variables: {
      ids: orderIds
    }
  });
  const data = response?.data;
  if (Array.isArray(response?.errors) && response.errors.length > 0) {
    throw new Error("VENDOR_LEDGER_ORDERS_QUERY_FAILED");
  }
  const nodes = data?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error("VENDOR_LEDGER_ORDERS_QUERY_UNAVAILABLE");
  }
  const orderById = new Map(nodes.filter(node => node?.id).map(node => [String(node.id), node]));
  const refundEntries = await listVendorOrderRefundLedgerReferences({
    storeId,
    orderIds
  }, {
    prismaClient
  });
  const ledgerSummaryByOrderId = createOrderSettlementSummaryMap([...ledgerEntries, ...refundEntries], orderIds);
  const orders = ledgerEntries.map(ledgerEntry => serializeVendorOrderRow({
    order: orderById.get(ledgerEntry.shopifyOrderId),
    ledgerEntry,
    ledgerSummary: ledgerSummaryByOrderId.get(ledgerEntry.shopifyOrderId)
  })).filter(Boolean);
  return {
    queryString,
    orders
  };
}
export async function listVendorShopifyOrdersFromSellerOrders({
  storeId,
  shopDomain,
  first = VENDOR_DRAFT_ORDERS_PAGE_SIZE
}, {
  prismaClient = prisma,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession
} = {}) {
  const queryString = "seller_order:shadow";
  const sellerOrders = await listVendorShopifyOrderSellerOrderReferences({
    storeId,
    first
  }, {
    prismaClient
  });
  const orderIds = sellerOrders.map(sellerOrder => sellerOrder.shopifyOrderId);
  if (orderIds.length === 0) {
    return {
      queryString,
      orders: []
    };
  }
  const response = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: VENDOR_LEDGER_ORDERS_QUERY,
    variables: {
      ids: orderIds
    }
  });
  const data = response?.data;
  if (Array.isArray(response?.errors) && response.errors.length > 0) {
    throw new Error("VENDOR_SELLER_ORDERS_QUERY_FAILED");
  }
  const nodes = data?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error("VENDOR_SELLER_ORDERS_QUERY_UNAVAILABLE");
  }
  const orderById = new Map(nodes.filter(node => node?.id).map(node => [String(node.id), node]));
  const withdrawalRequests = await listVendorWithdrawalRequestsForSellerOrders({
    sellerOrders,
    first: Math.max(100, sellerOrders.length * 5)
  }, {
    prismaClient
  });
  const withdrawalsByOrderId = groupVendorWithdrawalRequestsByOrderId(withdrawalRequests);
  const orders = sellerOrders.map(sellerOrder => {
    const order = serializeVendorOrderRow({
      order: orderById.get(sellerOrder.shopifyOrderId),
      sellerOrder,
      ledgerSummary: createSellerOrderSettlementSummary(sellerOrder)
    });
    if (!order) return null;
    const withdrawals = withdrawalsByOrderId.get(order.orderId) || [];
    return {
      ...order,
      withdrawals,
      withdrawalSummary: createVendorWithdrawalSummary(withdrawals)
    };
  }).filter(Boolean);
  return {
    queryString,
    orders
  };
}
export async function getVendorOrdersPageData({
  storeId
}, {
  listVendorStoreShopDomainsImpl = listVendorStoreShopDomains,
  listGrantedAppAccessScopesImpl = listGrantedAppAccessScopes,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
  prismaClient = prisma,
  useSellerOrderRead = shouldUseSellerOrderVendorOrdersRead()
} = {}) {
  const accessState = await getVendorOrdersAccessState({
    storeId
  }, {
    listVendorStoreShopDomainsImpl,
    listGrantedAppAccessScopesImpl
  });
  if (accessState.status !== "ready") {
    return {
      accessState,
      orders: [],
      queryString: null,
      pageSize: VENDOR_DRAFT_ORDERS_PAGE_SIZE
    };
  }
  if (useSellerOrderRead && prismaClient?.sellerOrder?.findMany) {
    try {
      const result = await listVendorShopifyOrdersFromSellerOrders({
        storeId,
        shopDomain: accessState.shopDomain
      }, {
        prismaClient,
        shopifyGraphQLWithOfflineSessionImpl
      });
      return {
        accessState,
        orders: result.orders,
        queryString: result.queryString,
        pageSize: VENDOR_DRAFT_ORDERS_PAGE_SIZE
      };
    } catch (error) {
      console.error("vendor seller orders list error:", error);
    }
  }
  try {
    const result = await listVendorShopifyOrdersFromLedger({
      storeId,
      shopDomain: accessState.shopDomain
    }, {
      prismaClient,
      shopifyGraphQLWithOfflineSessionImpl
    });
    return {
      accessState,
      orders: result.orders,
      queryString: result.queryString,
      pageSize: VENDOR_DRAFT_ORDERS_PAGE_SIZE
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("vendor orders list error:", error);
    return {
      accessState: {
        ...accessState,
        status: isReconnectableShopifyError(message) ? "missing_connection" : "error"
      },
      orders: [],
      queryString: null,
      pageSize: VENDOR_DRAFT_ORDERS_PAGE_SIZE
    };
  }
}

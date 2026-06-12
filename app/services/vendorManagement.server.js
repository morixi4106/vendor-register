import { randomUUID } from "node:crypto";
import { createCookie, redirect } from "@remix-run/node";
import prisma from "../db.server.js";
import {
  normalizeShopDomain,
  shopifyGraphQLWithOfflineSession,
} from "../utils/shopifyAdmin.server.js";
import { formatMoney as formatCurrencyMoney } from "../utils/money.js";
import { summarizeVendorDeliveryPolicy } from "../utils/productCountryPolicy.js";

const SHOPIFY_API_VERSION = "2026-01";
export const READ_DRAFT_ORDERS_SCOPE = "read_draft_orders";
export const VENDOR_DRAFT_ORDERS_PAGE_SIZE = 50;

const CURRENT_APP_INSTALLATION_ACCESS_SCOPES_QUERY = `
  query CurrentAppInstallationAccessScopes {
    currentAppInstallation {
      accessScopes {
        handle
      }
    }
  }
`;

const PRODUCT_INVENTORY_SYNC_TARGET_QUERY = `
  query ProductInventorySyncTarget($productId: ID!) {
    product(id: $productId) {
      id
      variants(first: 1) {
        nodes {
          id
          inventoryItem {
            id
            tracked
          }
        }
      }
    }
    locations(first: 1) {
      nodes {
        id
        name
      }
    }
  }
`;

const INVENTORY_ITEM_TRACKING_UPDATE_MUTATION = `
  mutation InventoryItemTrackingUpdate($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem {
        id
        tracked
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const INVENTORY_SET_QUANTITIES_MUTATION = `
  mutation InventorySetQuantities($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup {
        createdAt
        reason
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const vendorAdminSessionCookie = createCookie("vendor_admin_session", {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 8,
});

export function sanitizeVendorReturnTo(value, fallback = "/vendor/dashboard") {
  const returnTo = String(value || "").trim();

  if (!returnTo || returnTo.startsWith("//")) {
    return fallback;
  }

  if (!returnTo.startsWith("/")) {
    return fallback;
  }

  if (
    returnTo.startsWith("/vendor/verify") ||
    returnTo.startsWith("/apps/vendors/verify")
  ) {
    return fallback;
  }

  return returnTo;
}

export function getVendorReturnTo(request, fallback = "/vendor/dashboard") {
  const url = new URL(request.url);
  return sanitizeVendorReturnTo(url.searchParams.get("returnTo"), fallback);
}

export function getVendorVerifyRedirectPath(request) {
  const url = new URL(request.url);
  const returnTo = sanitizeVendorReturnTo(`${url.pathname}${url.search}`);
  return `/vendor/verify?returnTo=${encodeURIComponent(returnTo)}`;
}

export function getConfiguredAdminEmails(env = process.env) {
  return Array.from(
    new Set(
      [
        env.ADMIN_EMAIL,
        env.ADMIN_EMAILS,
        env.VENDOR_ADMIN_EMAILS,
      ]
        .flatMap((value) => String(value || "").split(","))
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

export function isConfiguredAdminEmail(email, env = process.env) {
  const normalizedEmail = String(email || "").trim().toLowerCase();

  if (!normalizedEmail) {
    return false;
  }

  return getConfiguredAdminEmails(env).includes(normalizedEmail);
}

export function formatMoney(amount, currencyCode = "JPY") {
  return formatCurrencyMoney(amount, currencyCode);
}

export function formatDateTime(value) {
  if (!value) return "未設定";

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "未設定";

  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function mapApprovalLabel(value) {
  switch (value) {
    case "approved":
      return "承認済み";
    case "pending":
      return "申請中";
    case "rejected":
      return "差し戻し";
    case "review":
      return "確認中";
    default:
      return "未設定";
  }
}

export function mapVendorStatusLabel(value) {
  switch (value) {
    case "active":
      return "稼働中";
    case "applied":
      return "申請中";
    case "kyb_pending":
      return "審査中";
    case "restricted":
      return "制限あり";
    case "suspended":
      return "停止中";
    default:
      return value || "未設定";
  }
}

export function mapProductStatus(product) {
  if (product?.shopifyProductId) return "公開済み";
  if (product?.approvalStatus === "approved") return "公開準備中";
  if (product?.approvalStatus === "pending") return "審査中";
  if (product?.approvalStatus === "rejected") return "要確認";
  return "未公開";
}

function normalizeInventoryQuantity(value) {
  const numericValue = Number(value);

  if (!Number.isInteger(numericValue) || numericValue < 0) {
    return null;
  }

  return numericValue;
}

export function parseInventoryQuantityInput(value) {
  const normalizedValue = String(value ?? "").trim();

  if (normalizedValue === "") {
    return {
      ok: true,
      quantity: null,
    };
  }

  const numericValue = Number(normalizedValue);

  if (!Number.isInteger(numericValue) || numericValue < 0) {
    return {
      ok: false,
      error: "在庫数は0以上の整数で入力してください。",
    };
  }

  if (numericValue > 999999) {
    return {
      ok: false,
      error: "在庫数は999999以下で入力してください。",
    };
  }

  return {
    ok: true,
    quantity: numericValue,
  };
}

export function buildInventoryDisplay(value) {
  const quantity = normalizeInventoryQuantity(value);

  if (quantity === null) {
    return {
      quantity: null,
      inputValue: "",
      stockLabel: "未設定",
      stockStatusLabel: "在庫入力待ち",
      stockStatusTone: "warning",
    };
  }

  if (quantity === 0) {
    return {
      quantity,
      inputValue: "0",
      stockLabel: "0点",
      stockStatusLabel: "在庫切れ",
      stockStatusTone: "danger",
    };
  }

  return {
    quantity,
    inputValue: String(quantity),
    stockLabel: `${quantity.toLocaleString("ja-JP")}点`,
    stockStatusLabel: "販売可能",
    stockStatusTone: "success",
  };
}

function buildInventorySyncDisplay(product) {
  if (!product?.shopifyProductId) {
    return {
      syncLabel: "公開後に同期",
      syncTone: "neutral",
      syncDetail: "商品公開後に在庫数が公開ストアへ反映されます。",
    };
  }

  if (product.inventorySyncError) {
    return {
      syncLabel: "同期要確認",
      syncTone: "warning",
      syncDetail: product.inventorySyncError,
    };
  }

  if (product.inventorySyncedAt) {
    return {
      syncLabel: "同期済み",
      syncTone: "success",
      syncDetail: `最終同期: ${formatDateTime(product.inventorySyncedAt)}`,
    };
  }

  return {
    syncLabel: "未同期",
    syncTone: "warning",
    syncDetail: "在庫数を保存すると公開ストアへ反映されます。",
  };
}

function formatPublicResourceId(value) {
  const normalizedValue = String(value || "").trim();

  if (!normalizedValue) {
    return "-";
  }

  const parts = normalizedValue.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalizedValue;
}

export function getBadgeTone(label) {
  if (["要確認", "差し戻し", "停止中", "制限あり"].includes(label)) {
    return "danger";
  }

  if (["審査中", "申請中", "公開準備中"].includes(label)) {
    return "warning";
  }

  if (["承認済み", "稼働中", "公開済み"].includes(label)) {
    return "success";
  }

  return "neutral";
}

export const PRODUCT_STATUS_FILTER_OPTIONS = [
  { value: "all", label: "全て" },
  { value: "pending", label: "申請中" },
  { value: "review", label: "確認中" },
  { value: "approved", label: "承認済み（公開準備中）" },
  { value: "linked", label: "公開済み" },
  { value: "rejected", label: "差し戻し" },
];

export function serializeVendorProduct(product) {
  const currencyCode = product.costCurrency || "JPY";
  const deliveryPolicy = summarizeVendorDeliveryPolicy(product);
  const statusLabel = mapProductStatus(product);
  const approvalLabel = mapApprovalLabel(product.approvalStatus);
  const inventoryDisplay = buildInventoryDisplay(product.inventoryQuantity);
  const inventorySyncDisplay = buildInventorySyncDisplay(product);

  return {
    id: product.id,
    name: product.name || "名称未設定",
    category: product.category || "未設定",
    sku: formatPublicResourceId(product.shopifyProductId),
    inventoryQuantity: inventoryDisplay.quantity,
    inventoryInputValue: inventoryDisplay.inputValue,
    stockLabel: inventoryDisplay.stockLabel,
    stockStatusLabel: inventoryDisplay.stockStatusLabel,
    stockStatusTone: inventoryDisplay.stockStatusTone,
    inventorySyncLabel: inventorySyncDisplay.syncLabel,
    inventorySyncTone: inventorySyncDisplay.syncTone,
    inventorySyncDetail: inventorySyncDisplay.syncDetail,
    trackingLabel: product.url || "-",
    salesLabel: "0",
    priceLabel: formatMoney(product.price || 0, currencyCode),
    currencyCode,
    statusLabel,
    statusTone: getBadgeTone(statusLabel),
    approvalLabel,
    approvalTone: getBadgeTone(approvalLabel),
    deliveryPolicyLabel: deliveryPolicy.label,
    deliveryPolicyTone: deliveryPolicy.tone,
    deliveryPolicyDetail: deliveryPolicy.detail,
    shopifyProductId: product.shopifyProductId || null,
    url: product.url || null,
    updatedAtLabel: formatDateTime(product.updatedAt),
  };
}

export function getVendorPublicContext(vendor, store) {
  return {
    vendor: {
      id: vendor.id,
      storeName: vendor.storeName,
      handle: vendor.handle,
      managementEmail: vendor.managementEmail,
      status: vendor.status,
      statusLabel: mapVendorStatusLabel(vendor.status),
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
  };
}

export async function listVendorStoreShopDomains(
  storeId,
  { prismaClient = prisma } = {},
) {
  const products = await prismaClient.product.findMany({
    where: {
      vendorStoreId: storeId,
      shopDomain: {
        not: null,
      },
    },
    select: {
      shopDomain: true,
    },
  });

  return Array.from(
    new Set(
      products
        .map((product) => normalizeShopDomain(product.shopDomain))
        .filter(Boolean),
    ),
  ).sort();
}

export async function listGrantedAppAccessScopes(
  shopDomain,
  {
    shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
  } = {},
) {
  const { data } = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: CURRENT_APP_INSTALLATION_ACCESS_SCOPES_QUERY,
  });
  const accessScopes = data?.currentAppInstallation?.accessScopes;

  if (!Array.isArray(accessScopes)) {
    throw new Error("CURRENT_APP_INSTALLATION_ACCESS_SCOPES_UNAVAILABLE");
  }

  return Array.from(
    new Set(
      accessScopes
        .map((scope) => String(scope?.handle || "").trim())
        .filter(Boolean),
    ),
  ).sort();
}

export async function getVendorOrdersAccessState(
  { storeId },
  {
    listVendorStoreShopDomainsImpl = listVendorStoreShopDomains,
    listGrantedAppAccessScopesImpl = listGrantedAppAccessScopes,
  } = {},
) {
  try {
    const shopDomains = await listVendorStoreShopDomainsImpl(storeId);

    if (shopDomains.length === 0) {
      return {
        status: "missing_shop",
        hasReadDraftOrders: false,
        grantedScopes: [],
        shopDomain: null,
        shopDomains: [],
      };
    }

    if (shopDomains.length > 1) {
      return {
        status: "ambiguous_shop",
        hasReadDraftOrders: false,
        grantedScopes: [],
        shopDomain: null,
        shopDomains,
      };
    }

    const shopDomain = shopDomains[0];
    const grantedScopes = await listGrantedAppAccessScopesImpl(shopDomain);
    const hasReadDraftOrders = grantedScopes.includes(READ_DRAFT_ORDERS_SCOPE);

    return {
      status: hasReadDraftOrders ? "ready" : "missing_scope",
      hasReadDraftOrders,
      grantedScopes,
      shopDomain,
      shopDomains,
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
        shopDomains: [],
      };
    }

    return {
      status: "error",
      hasReadDraftOrders: false,
      grantedScopes: [],
      shopDomain: null,
      shopDomains: [],
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
          currentTotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
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

function serializeVendorOrderRow(draftOrder) {
  const order = draftOrder?.order;

  if (!order?.id || !order?.name) {
    return null;
  }

  const shopMoney = order?.currentTotalPriceSet?.shopMoney;
  const createdAt = order?.createdAt || draftOrder?.completedAt || draftOrder?.createdAt;
  const financialStatus = String(order?.displayFinancialStatus || "").trim();
  const fulfillmentStatus = String(order?.displayFulfillmentStatus || "").trim();
  const currencyCode = shopMoney?.currencyCode || "JPY";

  return {
    id: order.id,
    orderId: order.id,
    publicOrderIdLabel: formatPublicResourceId(order.id),
    orderName: order.name,
    shopifyOrderNumber: order.name,
    createdAt: createdAt || null,
    createdAtLabel: formatDateTime(createdAt),
    customerName: order?.customer?.displayName || "未設定",
    email: order?.email || "未設定",
    totalAmount: Number(shopMoney?.amount || 0),
    totalCurrencyCode: currencyCode,
    totalLabel: formatMoney(shopMoney?.amount || 0, currencyCode),
    financialStatus,
    financialStatusLabel: mapDisplayFinancialStatusLabel(financialStatus),
    financialStatusTone: mapDisplayFinancialStatusTone(financialStatus),
    fulfillmentStatus,
    fulfillmentStatusLabel: mapDisplayFulfillmentStatusLabel(fulfillmentStatus),
    fulfillmentStatusTone: mapDisplayFulfillmentStatusTone(fulfillmentStatus),
  };
}

export async function listVendorDraftOrderOrders(
  { shopDomain, vendorHandle, first = VENDOR_DRAFT_ORDERS_PAGE_SIZE },
  {
    shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
  } = {},
) {
  const queryString = buildVendorDraftOrdersSearchQuery(vendorHandle);
  const response = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: VENDOR_DRAFT_ORDERS_QUERY,
    variables: {
      first,
      query: queryString,
    },
  });
  const data = response?.data;

  if (Array.isArray(response?.errors) && response.errors.length > 0) {
    throw new Error("VENDOR_DRAFT_ORDERS_QUERY_FAILED");
  }

  const nodes = data?.draftOrders?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error("VENDOR_DRAFT_ORDERS_QUERY_UNAVAILABLE");
  }

  const orders = nodes
    .map(serializeVendorOrderRow)
    .filter(Boolean)
    .sort((left, right) => {
      const leftTime = left?.createdAt ? new Date(left.createdAt).getTime() : 0;
      const rightTime = right?.createdAt ? new Date(right.createdAt).getTime() : 0;
      return rightTime - leftTime;
    });

  return {
    queryString,
    orders,
  };
}

export async function getVendorOrdersPageData(
  { storeId, vendorHandle },
  {
    listVendorStoreShopDomainsImpl = listVendorStoreShopDomains,
    listGrantedAppAccessScopesImpl = listGrantedAppAccessScopes,
    shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
  } = {},
) {
  const accessState = await getVendorOrdersAccessState(
    { storeId },
    {
      listVendorStoreShopDomainsImpl,
      listGrantedAppAccessScopesImpl,
    },
  );

  if (accessState.status !== "ready") {
    return {
      accessState,
      orders: [],
      queryString: null,
      pageSize: VENDOR_DRAFT_ORDERS_PAGE_SIZE,
    };
  }

  try {
    const result = await listVendorDraftOrderOrders(
      {
        shopDomain: accessState.shopDomain,
        vendorHandle,
      },
      {
        shopifyGraphQLWithOfflineSessionImpl,
      },
    );

    return {
      accessState,
      orders: result.orders,
      queryString: result.queryString,
      pageSize: VENDOR_DRAFT_ORDERS_PAGE_SIZE,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error("vendor orders list error:", error);

    return {
      accessState: {
        ...accessState,
        status: isReconnectableShopifyError(message)
          ? "missing_connection"
          : "error",
      },
      orders: [],
      queryString: null,
      pageSize: VENDOR_DRAFT_ORDERS_PAGE_SIZE,
    };
  }
}

function createMonthlyReportRange(month) {
  const normalizedMonth = String(month || "").trim();
  const match = /^(\d{4})-(\d{2})$/.exec(normalizedMonth);

  if (!match) {
    throw new Error("INVALID_REPORT_MONTH");
  }

  const year = Number(match[1]);
  const monthIndex = Number(match[2]);

  if (monthIndex < 1 || monthIndex > 12) {
    throw new Error("INVALID_REPORT_MONTH");
  }

  return {
    start: new Date(year, monthIndex - 1, 1),
    end: new Date(year, monthIndex, 1),
  };
}

function serializeVendorMonthlyReportProduct(product) {
  const currencyCode = product.costCurrency || "JPY";

  return {
    id: product.id,
    name: product.name || "名称未設定",
    priceLabel: formatMoney(product.price || 0, currencyCode),
    currencyCode,
    approvalLabel: mapApprovalLabel(product.approvalStatus),
    shopifyStatusLabel: product.shopifyProductId ? "公開済み" : "未公開",
    url: product.url || null,
    shopifyProductId: product.shopifyProductId || null,
    publicProductIdLabel: formatPublicResourceId(product.shopifyProductId),
  };
}

export async function getVendorMonthlyReport({ storeId, month }) {
  const { start, end } = createMonthlyReportRange(month);
  const products = await prisma.product.findMany({
    where: {
      vendorStoreId: storeId,
      createdAt: {
        gte: start,
        lt: end,
      },
    },
    orderBy: [{ createdAt: "desc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      name: true,
      price: true,
      costCurrency: true,
      approvalStatus: true,
      url: true,
      shopifyProductId: true,
    },
  });

  const summary = {
    total: products.length,
    pending: 0,
    approved: 0,
    rejected: 0,
    linked: 0,
  };

  for (const product of products) {
    if (product.approvalStatus === "approved") {
      summary.approved += 1;
    }

    if (product.approvalStatus === "rejected") {
      summary.rejected += 1;
    }

    if (product.approvalStatus === "pending" || product.approvalStatus === "review") {
      summary.pending += 1;
    }

    if (product.shopifyProductId) {
      summary.linked += 1;
    }
  }

  return {
    summary,
    products: products.map(serializeVendorMonthlyReportProduct),
  };
}

export async function updateVendorSettings({
  vendorId,
  storeId,
  storeName,
  managementEmail,
}) {
  const normalizedStoreName = String(storeName || "").trim();
  const normalizedManagementEmail = String(managementEmail || "").trim();

  try {
    await prisma.$transaction(async (tx) => {
      const vendorResult = await tx.vendor.updateMany({
        where: {
          id: vendorId,
          vendorStoreId: storeId,
        },
        data: {
          storeName: normalizedStoreName,
          managementEmail: normalizedManagementEmail,
        },
      });

      if (vendorResult.count !== 1) {
        throw new Error("VENDOR_SETTINGS_NOT_FOUND");
      }

      const storeResult = await tx.vendorStore.updateMany({
        where: {
          id: storeId,
        },
        data: {
          storeName: normalizedStoreName,
        },
      });

      if (storeResult.count !== 1) {
        throw new Error("VENDOR_SETTINGS_NOT_FOUND");
      }
    });

    return { ok: true };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "VENDOR_SETTINGS_NOT_FOUND"
    ) {
      return {
        ok: false,
        status: 404,
        publicError: "店舗情報が見つかりません。",
      };
    }

    console.error("vendor settings update error:", error);

    return {
      ok: false,
      status: 500,
      publicError: "設定の保存に失敗しました。時間を置いて再度お試しください。",
    };
  }
}

export async function requireVendorSession(request, { includeProducts = false } = {}) {
  const cookieHeader = request.headers.get("Cookie");
  const sessionToken = await vendorAdminSessionCookie.parse(cookieHeader);

  if (!sessionToken) {
    throw redirect(getVendorVerifyRedirectPath(request));
  }

  const vendorSession = await prisma.vendorAdminSession.findUnique({
    where: { sessionToken },
    include: {
      vendor: {
        include: {
          vendorStore: includeProducts
            ? {
                include: {
                  products: {
                    include: {
                      countryPolicy: true,
                    },
                    orderBy: {
                      updatedAt: "desc",
                    },
                  },
                },
              }
            : true,
        },
      },
    },
  });

  if (!vendorSession || vendorSession.expiresAt < new Date()) {
    throw redirect(getVendorVerifyRedirectPath(request), {
      headers: {
        "Set-Cookie": await vendorAdminSessionCookie.serialize("", {
          maxAge: 0,
        }),
      },
    });
  }

  return vendorSession;
}

export async function requireVendorContext(request, options = {}) {
  const vendorSession = await requireVendorSession(request, options);
  const vendor = vendorSession.vendor;
  const store = vendor?.vendorStore;

  if (!vendor || !store) {
    throw new Response("店舗情報が見つかりません。", { status: 404 });
  }

  return { vendorSession, vendor, store };
}

export async function listVendorProducts(storeId, filters = {}) {
  const name = String(filters.name || "").trim();
  const sku = String(filters.sku || "").trim();
  const tracking = String(filters.tracking || "").trim();
  const status = String(filters.status || "all").trim();
  const and = [{ vendorStoreId: storeId }];

  if (name) {
    and.push({
      name: {
        contains: name,
        mode: "insensitive",
      },
    });
  }

  if (sku) {
    and.push({
      shopifyProductId: {
        contains: sku,
        mode: "insensitive",
      },
    });
  }

  if (tracking) {
    and.push({
      url: {
        contains: tracking,
        mode: "insensitive",
      },
    });
  }

  switch (status) {
    case "pending":
      and.push({ approvalStatus: "pending" });
      break;
    case "review":
      and.push({ approvalStatus: "review" });
      break;
    case "approved":
      and.push({ approvalStatus: "approved" });
      and.push({ shopifyProductId: null });
      break;
    case "linked":
      and.push({
        shopifyProductId: {
          not: null,
        },
      });
      break;
    case "rejected":
      and.push({ approvalStatus: "rejected" });
      break;
    default:
      break;
  }

  const where = {
    AND: and,
  };

  const products = await prisma.product.findMany({
    where,
    include: {
      countryPolicy: true,
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });

  return products.map(serializeVendorProduct);
}

function getFirstUserErrorMessage(userErrors, fallback) {
  if (Array.isArray(userErrors) && userErrors.length > 0) {
    return userErrors
      .map((error) => String(error?.message || "").trim())
      .filter(Boolean)
      .join("; ");
  }

  return fallback;
}

function toPublicInventorySyncError(error) {
  const message = error instanceof Error ? error.message : String(error || "");

  if (isReconnectableShopifyError(message)) {
    return "公開ストアとの接続確認が必要です。管理者に連絡してください。";
  }

  if (
    message.includes("ACCESS_DENIED") ||
    message.includes("access denied") ||
    message.includes("read_inventory") ||
    message.includes("write_inventory") ||
    message.includes("read_locations")
  ) {
    return "在庫同期に必要な権限が不足しています。管理者に連絡してください。";
  }

  return "公開ストアへの在庫反映に失敗しました。管理者に連絡してください。";
}

export async function syncShopifyInventoryQuantity({
  shopDomain,
  shopifyProductId,
  quantity,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
}) {
  const normalizedQuantity = Number(quantity);

  if (!shopDomain || !shopifyProductId) {
    throw new Error("SHOPIFY_INVENTORY_TARGET_MISSING");
  }

  if (!Number.isInteger(normalizedQuantity) || normalizedQuantity < 0) {
    throw new Error("SHOPIFY_INVENTORY_QUANTITY_INVALID");
  }

  const { data: targetData } = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: PRODUCT_INVENTORY_SYNC_TARGET_QUERY,
    variables: {
      productId: shopifyProductId,
    },
  });

  const product = targetData?.product;
  const variant = product?.variants?.nodes?.[0];
  const inventoryItem = variant?.inventoryItem;
  const location = targetData?.locations?.nodes?.[0];

  if (!product?.id || !variant?.id) {
    throw new Error("SHOPIFY_PRODUCT_VARIANT_NOT_FOUND");
  }

  if (!inventoryItem?.id) {
    throw new Error("SHOPIFY_INVENTORY_ITEM_NOT_FOUND");
  }

  if (!location?.id) {
    throw new Error("SHOPIFY_LOCATION_NOT_FOUND");
  }

  if (inventoryItem.tracked === false) {
    const { data: trackingData } = await shopifyGraphQLWithOfflineSessionImpl({
      shopDomain,
      apiVersion: SHOPIFY_API_VERSION,
      query: INVENTORY_ITEM_TRACKING_UPDATE_MUTATION,
      variables: {
        id: inventoryItem.id,
        input: {
          tracked: true,
        },
      },
    });

    const trackingPayload = trackingData?.inventoryItemUpdate;
    const trackingError = getFirstUserErrorMessage(
      trackingPayload?.userErrors,
      null,
    );

    if (!trackingPayload || trackingError) {
      throw new Error(trackingError || "SHOPIFY_INVENTORY_TRACKING_UPDATE_FAILED");
    }
  }

  const { data: setData } = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: INVENTORY_SET_QUANTITIES_MUTATION,
    variables: {
      idempotencyKey: `vendor-register-inventory-${randomUUID()}`,
      input: {
        ignoreCompareQuantity: true,
        name: "available",
        reason: "correction",
        referenceDocumentUri: `vendor-register://inventory/${encodeURIComponent(
          shopifyProductId,
        )}`,
        quantities: [
          {
            inventoryItemId: inventoryItem.id,
            locationId: location.id,
            quantity: normalizedQuantity,
            compareQuantity: null,
          },
        ],
      },
    },
  });

  const setPayload = setData?.inventorySetQuantities;
  const setError = getFirstUserErrorMessage(setPayload?.userErrors, null);

  if (!setPayload || setError) {
    throw new Error(setError || "SHOPIFY_INVENTORY_SET_QUANTITIES_FAILED");
  }

  return {
    ok: true,
    inventoryItemId: inventoryItem.id,
    locationId: location.id,
    locationName: location.name || null,
    quantity: normalizedQuantity,
  };
}

export async function updateVendorProductInventory({
  storeId,
  productId,
  inventoryQuantity,
  prismaClient = prisma,
  syncShopifyInventoryQuantityImpl = syncShopifyInventoryQuantity,
  now = () => new Date(),
}) {
  const parsedQuantity = parseInventoryQuantityInput(inventoryQuantity);

  if (!parsedQuantity.ok) {
    return {
      ok: false,
      status: 400,
      error: parsedQuantity.error,
    };
  }

  const product = await prismaClient.product.findFirst({
    where: {
      id: String(productId || ""),
      vendorStoreId: storeId,
    },
    select: {
      id: true,
      shopDomain: true,
      shopifyProductId: true,
    },
  });

  if (!product) {
    return {
      ok: false,
      status: 404,
      error: "商品が見つかりません。",
    };
  }

  let updatedProduct = await prismaClient.product.update({
    where: {
      id: product.id,
    },
    data: {
      inventoryQuantity: parsedQuantity.quantity,
      inventorySyncedAt: null,
      inventorySyncError: null,
    },
  });

  let warning = null;

  if (updatedProduct.shopifyProductId && updatedProduct.shopDomain) {
    try {
      await syncShopifyInventoryQuantityImpl({
        shopDomain: updatedProduct.shopDomain,
        shopifyProductId: updatedProduct.shopifyProductId,
        quantity: parsedQuantity.quantity ?? 0,
      });

      updatedProduct = await prismaClient.product.update({
        where: {
          id: updatedProduct.id,
        },
        data: {
          inventorySyncedAt: now(),
          inventorySyncError: null,
        },
      });
    } catch (error) {
      const publicError = toPublicInventorySyncError(error);
      console.error("vendor inventory sync error:", error);

      updatedProduct = await prismaClient.product.update({
        where: {
          id: updatedProduct.id,
        },
        data: {
          inventorySyncedAt: null,
          inventorySyncError: publicError,
        },
      });

      warning = publicError;
    }
  }

  return {
    ok: true,
    product: serializeVendorProduct(updatedProduct),
    warning,
  };
}

function isReconnectableShopifyError(message = "") {
  return (
    message.includes("Shopify authentication is required") ||
    message.includes("Invalid API key or access token") ||
    message.includes("401") ||
    message.includes("Offline session not found")
  );
}

async function shopifyGraphQL(shopDomain, query, variables = {}) {
  return shopifyGraphQLWithOfflineSession({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query,
    variables,
  });
}

async function deleteShopifyProduct(shopDomain, shopifyProductId) {
  const mutation = `
    mutation DeleteProduct($input: ProductDeleteInput!) {
      productDelete(input: $input) {
        deletedProductId
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    const { data } = await shopifyGraphQL(shopDomain, mutation, {
      input: { id: shopifyProductId },
    });

    const payload = data?.productDelete;
    const userErrors = Array.isArray(payload?.userErrors) ? payload.userErrors : [];

    if (userErrors.length > 0) {
      const message =
        userErrors[0]?.message || "公開ストアで商品の削除に失敗しました。";

      if (
        message.includes("does not exist") ||
        message.includes("Product does not exist")
      ) {
        return { ok: true, alreadyDeleted: true };
      }

      return {
        ok: false,
        error: message,
        needsReconnect: isReconnectableShopifyError(message),
      };
    }

    return {
      ok: true,
      deletedProductId: payload?.deletedProductId || null,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "公開ストアで商品の削除に失敗しました。";

    return {
      ok: false,
      error: message,
      needsReconnect: isReconnectableShopifyError(message),
    };
  }
}

export async function deleteVendorProductForStore({ storeId, productId }) {
  const normalizedProductId = String(productId || "").trim();

  if (!normalizedProductId) {
    return {
      ok: false,
      status: 400,
      publicError: "商品IDがありません。",
      needsReconnect: false,
    };
  }

  const product = await prisma.product.findUnique({
    where: { id: normalizedProductId },
  });

  if (!product || product.vendorStoreId !== storeId) {
    return {
      ok: false,
      status: 404,
      publicError: "商品が見つかりません。",
      needsReconnect: false,
    };
  }

  if (product.shopifyProductId) {
    if (!product.shopDomain) {
      return {
        ok: false,
        status: 500,
        publicError:
          "公開ストアとの接続設定を確認してから、もう一度お試しください。",
        needsReconnect: true,
      };
    }

    const shopifyDelete = await deleteShopifyProduct(
      product.shopDomain,
      product.shopifyProductId
    );

    if (!shopifyDelete.ok) {
      console.error("vendor product delete error:", shopifyDelete.error);
      return {
        ok: false,
        status: 500,
        publicError: shopifyDelete.needsReconnect
          ? "公開ストアとの接続を確認してから、もう一度お試しください。"
          : "商品の削除に失敗しました。時間を置いて再度お試しください。",
        needsReconnect: shopifyDelete.needsReconnect || false,
      };
    }
  }

  await prisma.product.delete({
    where: { id: normalizedProductId },
  });

  return { ok: true };
}

import { createCookie, redirect } from "@remix-run/node";
import prisma from "../db.server.js";
import {
  normalizeShopDomain,
  shopifyGraphQLWithOfflineSession,
} from "../utils/shopifyAdmin.server.js";

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

export const vendorAdminSessionCookie = createCookie("vendor_admin_session", {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 8,
});

export function formatMoney(amount, currencyCode = "JPY") {
  const numericAmount = Number(amount || 0);

  try {
    return new Intl.NumberFormat("ja-JP", {
      style: "currency",
      currency: currencyCode,
      maximumFractionDigits: 0,
    }).format(numericAmount);
  } catch {
    return `${Math.round(numericAmount).toLocaleString("ja-JP")} ${currencyCode}`;
  }
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
  if (product?.shopifyProductId) return "Shopify連携済み";
  if (product?.approvalStatus === "approved") return "公開準備中";
  if (product?.approvalStatus === "pending") return "審査中";
  if (product?.approvalStatus === "rejected") return "要確認";
  return "未連携";
}

export function getBadgeTone(label) {
  if (["要確認", "差し戻し", "停止中", "制限あり"].includes(label)) {
    return "danger";
  }

  if (["審査中", "申請中", "公開準備中"].includes(label)) {
    return "warning";
  }

  if (["承認済み", "稼働中", "Shopify連携済み"].includes(label)) {
    return "success";
  }

  return "neutral";
}

export const PRODUCT_STATUS_FILTER_OPTIONS = [
  { value: "all", label: "全て" },
  { value: "pending", label: "申請中" },
  { value: "review", label: "確認中" },
  { value: "approved", label: "承認済み（未連携）" },
  { value: "linked", label: "Shopify連携済み" },
  { value: "rejected", label: "差し戻し" },
];

export function serializeVendorProduct(product) {
  return {
    id: product.id,
    name: product.name || "名称未設定",
    category: product.category || "未設定",
    sku: product.shopifyProductId || "-",
    stockLabel: "未連携",
    trackingLabel: product.url || "-",
    salesLabel: "0",
    priceLabel: formatMoney(product.price || 0, "JPY"),
    statusLabel: mapProductStatus(product),
    approvalLabel: mapApprovalLabel(product.approvalStatus),
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
    shopifyStatusLabel: product.shopifyProductId ? "Shopify連携済み" : "未連携",
    url: product.url || null,
    shopifyProductId: product.shopifyProductId || null,
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
    throw redirect("/vendor/verify");
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
    throw redirect("/vendor/verify", {
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
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });

  return products.map(serializeVendorProduct);
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
      const message = userErrors[0]?.message || "Shopifyで商品の削除に失敗しました。";

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
      error instanceof Error ? error.message : "Shopifyで商品の削除に失敗しました。";

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
          "Shopifyとの接続設定を確認してから、もう一度お試しください。",
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
          ? "Shopifyとの接続を確認してから、もう一度お試しください。"
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

import prisma from "../../db.server.js";
import { normalizeShopDomain, shopifyGraphQLWithOfflineSession } from "../../utils/shopifyAdmin.server.js";
import { formatMoney as formatCurrencyMoney } from "../../utils/money.js";
import { WITHDRAWAL_STATUSES, getWithdrawalEligibilityLabel, getWithdrawalEligibilityTone, getWithdrawalStatusLabel, getWithdrawalStatusTone } from "../../utils/withdrawalStatus.js";
import { SHOPIFY_API_VERSION } from "../../utils/shopifyApiVersion.js";
export const CLOSED_WITHDRAWAL_STATUSES = new Set([WITHDRAWAL_STATUSES.REFUNDED, WITHDRAWAL_STATUSES.CANCELLED, WITHDRAWAL_STATUSES.REJECTED, WITHDRAWAL_STATUSES.EXPIRED]);
export const CURRENT_APP_INSTALLATION_ACCESS_SCOPES_QUERY = `
  query CurrentAppInstallationAccessScopes {
    currentAppInstallation {
      accessScopes {
        handle
      }
    }
  }
`;
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
    minute: "2-digit"
  }).format(date);
}
export function formatDate(value) {
  if (!value) return "未設定";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "未設定";
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}
export function normalizeIdSet(values = []) {
  return new Set((Array.isArray(values) ? values : []).map(value => String(value || "").trim()).filter(Boolean));
}
export function getJsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
export function getJsonArray(value) {
  return Array.isArray(value) ? value : [];
}
export function isClosedWithdrawalStatus(status) {
  return CLOSED_WITHDRAWAL_STATUSES.has(String(status || "").trim());
}
export function isReturnReviewNeeded(withdrawalRequest) {
  const returnRequirementStatus = String(withdrawalRequest?.returnRequirementStatus || "UNDECIDED").toUpperCase();
  const returnConditionStatus = String(withdrawalRequest?.returnConditionStatus || "UNDECIDED").toUpperCase();
  if (isClosedWithdrawalStatus(withdrawalRequest?.status)) {
    return false;
  }
  if (["IN_TRANSIT", "RECEIVED"].includes(returnRequirementStatus)) {
    return true;
  }
  return returnRequirementStatus === "CONDITION_CHECKED" && returnConditionStatus === "UNDECIDED";
}
export function getVendorWithdrawalActionLabel(withdrawalRequest) {
  const returnRequirementStatus = String(withdrawalRequest?.returnRequirementStatus || "UNDECIDED").toUpperCase();
  if (isClosedWithdrawalStatus(withdrawalRequest?.status)) {
    return "対応完了";
  }
  if (returnRequirementStatus === "RECEIVED") {
    return "商品状態を確認";
  }
  if (returnRequirementStatus === "IN_TRANSIT") {
    return "返送到着を確認";
  }
  if (returnRequirementStatus === "WAITING") {
    return "返送待ち";
  }
  return "管理者確認中";
}
export function getVendorWithdrawalTone(withdrawalRequest) {
  if (isClosedWithdrawalStatus(withdrawalRequest?.status)) {
    return "success";
  }
  if (isReturnReviewNeeded(withdrawalRequest)) {
    return "warning";
  }
  return getWithdrawalStatusTone(withdrawalRequest?.status);
}
export function getSelectedLineItemValues(withdrawalRequest) {
  const data = getJsonObject(withdrawalRequest?.selectedLineItemsJson);
  const submitted = getJsonObject(withdrawalRequest?.submittedPayloadJson);
  const values = [...getJsonArray(data.selectedLineItems), ...getJsonArray(submitted.selectedLineItems)];
  return normalizeIdSet(values);
}
export function lineMatchesSelectedWithdrawalValues(line, selectedValues) {
  if (!line || !selectedValues?.size) {
    return false;
  }
  const candidates = [line.shopifyLineItemId, line.shopifyProductId, line.shopifyVariantId, line.productId, line.title].map(value => String(value || "").trim()).filter(Boolean);
  return candidates.some(candidate => selectedValues.has(candidate));
}
export function sellerOrderTouchesWithdrawal(sellerOrder, withdrawalRequest) {
  if (!sellerOrder || !withdrawalRequest) {
    return false;
  }
  const requestMarketplaceOrderId = String(withdrawalRequest.marketplaceOrderId || "").trim();
  const requestShopifyOrderId = String(withdrawalRequest.shopifyOrderId || "").trim();
  const sellerMarketplaceOrderId = String(sellerOrder.marketplaceOrderId || "").trim();
  const sellerShopifyOrderId = String(sellerOrder.shopifyOrderId || "").trim();
  const sameOrder = requestMarketplaceOrderId && sellerMarketplaceOrderId && requestMarketplaceOrderId === sellerMarketplaceOrderId || requestShopifyOrderId && sellerShopifyOrderId && requestShopifyOrderId === sellerShopifyOrderId;
  if (!sameOrder) {
    return false;
  }
  if (String(withdrawalRequest.withdrawalScope || "FULL").toUpperCase() !== "PARTIAL") {
    return true;
  }
  const selectedValues = getSelectedLineItemValues(withdrawalRequest);

  // If the buyer described a partial withdrawal as free text, show it to every
  // seller on the order so the vendor does not miss a manual-review case.
  if (selectedValues.size === 0) {
    return true;
  }
  for (const line of Array.isArray(sellerOrder.lines) ? sellerOrder.lines : []) {
    if (lineMatchesSelectedWithdrawalValues(line, selectedValues)) {
      return true;
    }
  }
  return false;
}
export function serializeVendorWithdrawalRequest(withdrawalRequest) {
  const orderSnapshot = getJsonObject(withdrawalRequest?.orderSnapshotJson);
  const selectedLineItemsJson = getJsonObject(withdrawalRequest?.selectedLineItemsJson);
  const submittedPayload = getJsonObject(withdrawalRequest?.submittedPayloadJson);
  const statusTone = getVendorWithdrawalTone(withdrawalRequest);
  return {
    id: withdrawalRequest.id,
    workflowVersion: Number(withdrawalRequest.workflowVersion || 1),
    returnMode: withdrawalRequest.returnMode || "OPERATOR_REVIEW",
    shopDomain: withdrawalRequest.shopDomain || "",
    marketplaceOrderId: withdrawalRequest.marketplaceOrderId || null,
    shopifyOrderId: withdrawalRequest.shopifyOrderId || null,
    shopifyOrderName: withdrawalRequest.shopifyOrderName || withdrawalRequest.shopifyOrderNumber || submittedPayload.orderNumber || "-",
    customerName: withdrawalRequest.customerName || "-",
    customerEmail: withdrawalRequest.customerEmail || "-",
    withdrawalScope: withdrawalRequest.withdrawalScope || "FULL",
    withdrawalScopeLabel: String(withdrawalRequest.withdrawalScope || "FULL").toUpperCase() === "PARTIAL" ? "一部の商品" : "注文全体",
    itemText: submittedPayload.itemText || "",
    itemCondition: withdrawalRequest.itemCondition || submittedPayload.itemCondition || "",
    reason: withdrawalRequest.reason || submittedPayload.reason || "",
    status: withdrawalRequest.status,
    statusLabel: getWithdrawalStatusLabel(withdrawalRequest?.status),
    statusTone,
    eligibilityStatus: withdrawalRequest.eligibilityStatus,
    eligibilityLabel: getWithdrawalEligibilityLabel(withdrawalRequest.eligibilityStatus),
    eligibilityTone: getWithdrawalEligibilityTone(withdrawalRequest.eligibilityStatus),
    returnRequirementStatus: withdrawalRequest.returnRequirementStatus,
    returnConditionStatus: withdrawalRequest.returnConditionStatus,
    returnTrackingCompany: withdrawalRequest.returnTrackingCompany || "",
    returnTrackingNumber: withdrawalRequest.returnTrackingNumber || "",
    returnTrackingUrl: withdrawalRequest.returnTrackingUrl || "",
    returnReceivedAt: withdrawalRequest.returnReceivedAt || null,
    returnReceivedAtLabel: formatDate(withdrawalRequest.returnReceivedAt),
    returnConditionNotes: withdrawalRequest.returnConditionNotes || "",
    refundDecisionStatus: withdrawalRequest.refundDecisionStatus,
    completionStatus: withdrawalRequest.completionStatus,
    createdAt: withdrawalRequest.createdAt || null,
    createdAtLabel: formatDateTime(withdrawalRequest.createdAt),
    updatedAt: withdrawalRequest.updatedAt || null,
    updatedAtLabel: formatDateTime(withdrawalRequest.updatedAt),
    deadlineAt: withdrawalRequest.deadlineAt || null,
    deadlineAtLabel: formatDate(withdrawalRequest.deadlineAt),
    receivedDate: withdrawalRequest.receivedDate || null,
    receivedDateLabel: formatDate(withdrawalRequest.receivedDate),
    needsVendorAction: isReturnReviewNeeded(withdrawalRequest),
    vendorActionLabel: getVendorWithdrawalActionLabel(withdrawalRequest),
    orderLineItems: getJsonArray(selectedLineItemsJson.orderLineItems),
    selectedLineItemsJson,
    orderSnapshot
  };
}
export function createVendorWithdrawalSummary(withdrawalRequests = []) {
  const items = Array.isArray(withdrawalRequests) ? withdrawalRequests : [];
  const openItems = items.filter(item => !isClosedWithdrawalStatus(item.status));
  const actionItems = items.filter(item => item.needsVendorAction);
  return {
    totalCount: items.length,
    openCount: openItems.length,
    actionCount: actionItems.length,
    latest: items[0] || null
  };
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
export function formatPublicResourceId(value) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) {
    return "-";
  }
  const parts = normalizedValue.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalizedValue;
}
export async function listVendorStoreShopDomains(storeId, {
  prismaClient = prisma
} = {}) {
  const products = await prismaClient.product.findMany({
    where: {
      vendorStoreId: storeId,
      shopDomain: {
        not: null
      }
    },
    select: {
      shopDomain: true
    }
  });
  return Array.from(new Set(products.map(product => normalizeShopDomain(product.shopDomain)).filter(Boolean))).sort();
}
export async function listGrantedAppAccessScopes(shopDomain, {
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession
} = {}) {
  const {
    data
  } = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: CURRENT_APP_INSTALLATION_ACCESS_SCOPES_QUERY
  });
  const accessScopes = data?.currentAppInstallation?.accessScopes;
  if (!Array.isArray(accessScopes)) {
    throw new Error("CURRENT_APP_INSTALLATION_ACCESS_SCOPES_UNAVAILABLE");
  }
  return Array.from(new Set(accessScopes.map(scope => String(scope?.handle || "").trim()).filter(Boolean))).sort();
}
export function getLedgerMetadata(entry) {
  const metadata = entry?.metadataJson;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
}
export function createOrderSettlementSummary(orderId, entries = []) {
  let paidAmount = 0;
  let refundAmount = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const entryType = String(entry?.entryType || (String(entry?.stripeObjectId || "").trim() === orderId ? "shopify_order_paid" : "")).trim();
    const amount = Number(entry?.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      continue;
    }
    if (entryType === "shopify_order_paid" && String(entry?.stripeObjectId || "").trim() === orderId) {
      paidAmount += amount;
      continue;
    }
    if (entryType === "refund" && String(getLedgerMetadata(entry).shopifyOrderId || "").trim() === orderId) {
      refundAmount += amount;
    }
  }
  return {
    paidAmount,
    refundAmount,
    netAmount: Math.max(0, paidAmount - refundAmount),
    hasPaidLedger: paidAmount > 0,
    hasRefundLedger: refundAmount > 0,
    fullyRefunded: paidAmount > 0 && refundAmount >= paidAmount,
    partiallyRefunded: paidAmount > 0 && refundAmount > 0 && refundAmount < paidAmount
  };
}
export function createSellerOrderSettlementSummary(sellerOrder) {
  const paidAmount = Number(sellerOrder?.sellerPayableAmount ?? sellerOrder?.sellerNetAmount ?? 0);
  const refundAmount = Number(sellerOrder?.sellerRefundAmount ?? 0);
  const normalizedPaidAmount = Number.isFinite(paidAmount) ? Math.max(0, paidAmount) : 0;
  const normalizedRefundAmount = Number.isFinite(refundAmount) ? Math.max(0, refundAmount) : 0;
  return {
    paidAmount: normalizedPaidAmount,
    refundAmount: normalizedRefundAmount,
    netAmount: Math.max(0, normalizedPaidAmount - normalizedRefundAmount),
    hasPaidLedger: normalizedPaidAmount > 0,
    hasRefundLedger: normalizedRefundAmount > 0,
    fullyRefunded: normalizedPaidAmount > 0 && normalizedRefundAmount >= normalizedPaidAmount,
    partiallyRefunded: normalizedPaidAmount > 0 && normalizedRefundAmount > 0 && normalizedRefundAmount < normalizedPaidAmount
  };
}
export async function listVendorWithdrawalRequestsForSellerOrders({
  sellerOrders,
  first = 100
}, {
  prismaClient = prisma
} = {}) {
  const orders = Array.isArray(sellerOrders) ? sellerOrders : [];
  const shopifyOrderIds = Array.from(new Set(orders.map(sellerOrder => String(sellerOrder?.shopifyOrderId || "").trim()).filter(Boolean)));
  const marketplaceOrderIds = Array.from(new Set(orders.map(sellerOrder => String(sellerOrder?.marketplaceOrderId || "").trim()).filter(Boolean)));
  if (!prismaClient?.withdrawalRequest?.findMany || shopifyOrderIds.length === 0 && marketplaceOrderIds.length === 0) {
    return [];
  }
  const withdrawalRequests = await prismaClient.withdrawalRequest.findMany({
    where: {
      OR: [...(shopifyOrderIds.length > 0 ? [{
        shopifyOrderId: {
          in: shopifyOrderIds
        }
      }] : []), ...(marketplaceOrderIds.length > 0 ? [{
        marketplaceOrderId: {
          in: marketplaceOrderIds
        }
      }] : [])]
    },
    orderBy: [{
      createdAt: "desc"
    }],
    take: first
  });
  return withdrawalRequests.filter(withdrawalRequest => orders.some(sellerOrder => sellerOrderTouchesWithdrawal(sellerOrder, withdrawalRequest))).map(serializeVendorWithdrawalRequest);
}
export function getFirstUserErrorMessage(userErrors, fallback) {
  if (Array.isArray(userErrors) && userErrors.length > 0) {
    return userErrors.map(error => String(error?.message || "").trim()).filter(Boolean).join("; ");
  }
  return fallback;
}
export function isReconnectableShopifyError(message = "") {
  return message.includes("Shopify authentication is required") || message.includes("Invalid API key or access token") || message.includes("401") || message.includes("Offline session not found");
}

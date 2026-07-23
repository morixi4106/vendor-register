import { randomUUID } from "node:crypto";
import { createCookie, redirect } from "@remix-run/node";
import prisma from "../db.server.js";
import {
  normalizeShopDomain,
  shopifyGraphQLWithOfflineSession,
} from "../utils/shopifyAdmin.server.js";
import { formatMoney as formatCurrencyMoney } from "../utils/money.js";
import { summarizeVendorDeliveryPolicy } from "../utils/productCountryPolicy.js";
import { getProductShippingMethodLabel } from "../utils/productShippingProfile.js";
import {
  buildCarrierTrackingUrl,
  getShippingCarrierById,
} from "../utils/shippingCarriers.js";
import { updateWithdrawalReturnInfo } from "./withdrawals.server.js";
import { updateWithdrawalGroupReview } from "./withdrawalDirectReturns.server.js";
import {
  WITHDRAWAL_STATUSES,
  getWithdrawalEligibilityLabel,
  getWithdrawalEligibilityTone,
  getWithdrawalStatusLabel,
  getWithdrawalStatusTone,
} from "../utils/withdrawalStatus.js";

import { SHOPIFY_API_VERSION } from "../utils/shopifyApiVersion.js";
export const READ_ORDERS_SCOPE = "read_orders";
export const READ_DRAFT_ORDERS_SCOPE = "read_draft_orders";
export const READ_MERCHANT_FULFILLMENT_ORDERS_SCOPE =
  "read_merchant_managed_fulfillment_orders";
export const WRITE_MERCHANT_FULFILLMENT_ORDERS_SCOPE =
  "write_merchant_managed_fulfillment_orders";
export const VENDOR_DRAFT_ORDERS_PAGE_SIZE = 50;

const CLOSED_WITHDRAWAL_STATUSES = new Set([
  WITHDRAWAL_STATUSES.REFUNDED,
  WITHDRAWAL_STATUSES.CANCELLED,
  WITHDRAWAL_STATUSES.REJECTED,
  WITHDRAWAL_STATUSES.EXPIRED,
]);

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

export const vendorAdminSessionsCookie = createCookie("vendor_admin_sessions", {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 8,
});

export const vendorRegistrationTargetCookie = createCookie(
  "vendor_registration_target",
  {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 30,
  },
);

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

export function appendVendorIdToPath(path, vendorId) {
  const normalizedVendorId = String(vendorId || "").trim();
  const target = String(path || "").trim();

  if (!normalizedVendorId || !target || target.startsWith("//")) {
    return target;
  }

  if (!target.startsWith("/")) {
    return target;
  }

  try {
    const url = new URL(target, "https://vendor.local");
    url.searchParams.set("vendorId", normalizedVendorId);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch (_) {
    return target;
  }
}

export function getRequestVendorId(request) {
  const url = new URL(request.url);
  return String(url.searchParams.get("vendorId") || "").trim();
}

export function getVendorVerifyRedirectPath(request) {
  const url = new URL(request.url);
  const returnTo = sanitizeVendorReturnTo(`${url.pathname}${url.search}`);
  const vendorId = getRequestVendorId(request);
  const verifyUrl = new URL("/vendor/verify", "https://vendor.local");
  verifyUrl.searchParams.set("returnTo", returnTo);

  if (vendorId) {
    verifyUrl.searchParams.set("vendorId", vendorId);
  }

  return `${verifyUrl.pathname}${verifyUrl.search}`;
}

function normalizeVendorSessionMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const source =
    value.sessions && typeof value.sessions === "object" && !Array.isArray(value.sessions)
      ? value.sessions
      : value;
  const entries = Object.entries(source)
    .map(([vendorId, sessionToken]) => [
      String(vendorId || "").trim(),
      String(sessionToken || "").trim(),
    ])
    .filter(([vendorId, sessionToken]) => vendorId && sessionToken);

  return Object.fromEntries(entries);
}

async function parseVendorSessionMap(cookieHeader) {
  const value = await vendorAdminSessionsCookie.parse(cookieHeader);
  return normalizeVendorSessionMap(value);
}

export async function createVendorAdminSessionCookieHeaders(
  request,
  { vendorId, sessionToken },
) {
  const cookieHeader = request.headers.get("Cookie");
  const normalizedVendorId = String(vendorId || "").trim();
  const normalizedSessionToken = String(sessionToken || "").trim();
  const sessionMap = await parseVendorSessionMap(cookieHeader);

  if (normalizedVendorId && normalizedSessionToken) {
    sessionMap[normalizedVendorId] = normalizedSessionToken;
  }

  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    await vendorAdminSessionCookie.serialize(normalizedSessionToken),
  );
  headers.append(
    "Set-Cookie",
    await vendorAdminSessionsCookie.serialize({ sessions: sessionMap }),
  );

  return headers;
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

function normalizeBooleanInput(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (value == null) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(
    String(value).trim().toLowerCase(),
  );
}

function normalizeLowercase(value) {
  return String(value || "").trim().toLowerCase();
}

function shouldUseSellerOrderVendorOrdersRead(env = process.env) {
  return normalizeBooleanInput(env.VENDOR_ORDERS_USE_SELLER_ORDERS);
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

function formatDate(value) {
  if (!value) return "未設定";

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "未設定";

  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function normalizeIdSet(values = []) {
  return new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );
}

function getJsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function getJsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function isClosedWithdrawalStatus(status) {
  return CLOSED_WITHDRAWAL_STATUSES.has(String(status || "").trim());
}

function isReturnReviewNeeded(withdrawalRequest) {
  const returnRequirementStatus = String(
    withdrawalRequest?.returnRequirementStatus || "UNDECIDED",
  ).toUpperCase();
  const returnConditionStatus = String(
    withdrawalRequest?.returnConditionStatus || "UNDECIDED",
  ).toUpperCase();

  if (isClosedWithdrawalStatus(withdrawalRequest?.status)) {
    return false;
  }

  if (["IN_TRANSIT", "RECEIVED"].includes(returnRequirementStatus)) {
    return true;
  }

  return (
    returnRequirementStatus === "CONDITION_CHECKED" &&
    returnConditionStatus === "UNDECIDED"
  );
}

function getVendorWithdrawalActionLabel(withdrawalRequest) {
  const returnRequirementStatus = String(
    withdrawalRequest?.returnRequirementStatus || "UNDECIDED",
  ).toUpperCase();

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

function getVendorWithdrawalTone(withdrawalRequest) {
  if (isClosedWithdrawalStatus(withdrawalRequest?.status)) {
    return "success";
  }

  if (isReturnReviewNeeded(withdrawalRequest)) {
    return "warning";
  }

  return getWithdrawalStatusTone(withdrawalRequest?.status);
}

function getSelectedLineItemValues(withdrawalRequest) {
  const data = getJsonObject(withdrawalRequest?.selectedLineItemsJson);
  const submitted = getJsonObject(withdrawalRequest?.submittedPayloadJson);
  const values = [
    ...getJsonArray(data.selectedLineItems),
    ...getJsonArray(submitted.selectedLineItems),
  ];

  return normalizeIdSet(values);
}

function lineMatchesSelectedWithdrawalValues(line, selectedValues) {
  if (!line || !selectedValues?.size) {
    return false;
  }

  const candidates = [
    line.shopifyLineItemId,
    line.shopifyProductId,
    line.shopifyVariantId,
    line.productId,
    line.title,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return candidates.some((candidate) => selectedValues.has(candidate));
}

function sellerOrderTouchesWithdrawal(sellerOrder, withdrawalRequest) {
  if (!sellerOrder || !withdrawalRequest) {
    return false;
  }

  const requestMarketplaceOrderId = String(
    withdrawalRequest.marketplaceOrderId || "",
  ).trim();
  const requestShopifyOrderId = String(withdrawalRequest.shopifyOrderId || "").trim();
  const sellerMarketplaceOrderId = String(
    sellerOrder.marketplaceOrderId || "",
  ).trim();
  const sellerShopifyOrderId = String(sellerOrder.shopifyOrderId || "").trim();

  const sameOrder =
    (requestMarketplaceOrderId &&
      sellerMarketplaceOrderId &&
      requestMarketplaceOrderId === sellerMarketplaceOrderId) ||
    (requestShopifyOrderId &&
      sellerShopifyOrderId &&
      requestShopifyOrderId === sellerShopifyOrderId);

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

function filterSellerOrderLinesForWithdrawal(sellerOrder, withdrawalRequest) {
  if (
    String(withdrawalRequest?.withdrawalScope || "FULL").toUpperCase() !==
    "PARTIAL"
  ) {
    return sellerOrder;
  }

  const selectedValues = getSelectedLineItemValues(withdrawalRequest);

  if (selectedValues.size === 0) {
    return sellerOrder;
  }

  return {
    ...sellerOrder,
    lines: (Array.isArray(sellerOrder.lines) ? sellerOrder.lines : []).filter(
      (line) => lineMatchesSelectedWithdrawalValues(line, selectedValues),
    ),
  };
}

/* Legacy serializer was corrupted by an earlier encoding conversion.
function serializeVendorWithdrawalRequest(withdrawalRequest) {
  const orderSnapshot = getJsonObject(withdrawalRequest?.orderSnapshotJson);
  const selectedLineItemsJson = getJsonObject(
    withdrawalRequest?.selectedLineItemsJson,
  );
  const orderLineItems = getJsonArray(selectedLineItemsJson.orderLineItems);
  const submittedPayload = getJsonObject(withdrawalRequest?.submittedPayloadJson);
  const statusTone = getVendorWithdrawalTone(withdrawalRequest);
  const statusLabel = getWithdrawalStatusLabel(withdrawalRequest?.status);
  const needsVendorAction = isReturnReviewNeeded(withdrawalRequest);

  return {
    id: withdrawalRequest.id,
    shopDomain: withdrawalRequest.shopDomain || "",
    marketplaceOrderId: withdrawalRequest.marketplaceOrderId || null,
    shopifyOrderId: withdrawalRequest.shopifyOrderId || null,
    shopifyOrderName:
      withdrawalRequest.shopifyOrderName ||
      withdrawalRequest.shopifyOrderNumber ||
      submittedPayload.orderNumber ||
      "-",
    customerName: withdrawalRequest.customerName || "-",
    customerEmail: withdrawalRequest.customerEmail || "-",
    withdrawalScope: withdrawalRequest.withdrawalScope || "FULL",
    withdrawalScopeLabel:
      String(withdrawalRequest.withdrawalScope || "FULL").toUpperCase() === "PARTIAL"
        ? "一部の商品"
        : "注文全体",
    itemText: submittedPayload.itemText || "",
    itemCondition: withdrawalRequest.itemCondition || submittedPayload.itemCondition || "",
    reason: withdrawalRequest.reason || submittedPayload.reason || "",
    status: withdrawalRequest.status,
    statusLabel,
    statusTone,
    eligibilityStatus: withdrawalRequest.eligibilityStatus,
    eligibilityLabel: getWithdrawalEligibilityLabel(
      withdrawalRequest.eligibilityStatus,
    ),
    eligibilityTone: getWithdrawalEligibilityTone(
      withdrawalRequest.eligibilityStatus,
    ),
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
    needsVendorAction,
    vendorActionLabel: getVendorWithdrawalActionLabel(withdrawalRequest),
    orderLineItems,
    selectedLineItemsJson,
    orderSnapshot,
  };
}

*/

function serializeVendorWithdrawalRequest(withdrawalRequest) {
  const orderSnapshot = getJsonObject(withdrawalRequest?.orderSnapshotJson);
  const selectedLineItemsJson = getJsonObject(
    withdrawalRequest?.selectedLineItemsJson,
  );
  const submittedPayload = getJsonObject(withdrawalRequest?.submittedPayloadJson);
  const statusTone = getVendorWithdrawalTone(withdrawalRequest);

  return {
    id: withdrawalRequest.id,
    workflowVersion: Number(withdrawalRequest.workflowVersion || 1),
    returnMode: withdrawalRequest.returnMode || "OPERATOR_REVIEW",
    shopDomain: withdrawalRequest.shopDomain || "",
    marketplaceOrderId: withdrawalRequest.marketplaceOrderId || null,
    shopifyOrderId: withdrawalRequest.shopifyOrderId || null,
    shopifyOrderName:
      withdrawalRequest.shopifyOrderName ||
      withdrawalRequest.shopifyOrderNumber ||
      submittedPayload.orderNumber ||
      "-",
    customerName: withdrawalRequest.customerName || "-",
    customerEmail: withdrawalRequest.customerEmail || "-",
    withdrawalScope: withdrawalRequest.withdrawalScope || "FULL",
    withdrawalScopeLabel:
      String(withdrawalRequest.withdrawalScope || "FULL").toUpperCase() === "PARTIAL"
        ? "一部の商品"
        : "注文全体",
    itemText: submittedPayload.itemText || "",
    itemCondition:
      withdrawalRequest.itemCondition || submittedPayload.itemCondition || "",
    reason: withdrawalRequest.reason || submittedPayload.reason || "",
    status: withdrawalRequest.status,
    statusLabel: getWithdrawalStatusLabel(withdrawalRequest?.status),
    statusTone,
    eligibilityStatus: withdrawalRequest.eligibilityStatus,
    eligibilityLabel: getWithdrawalEligibilityLabel(
      withdrawalRequest.eligibilityStatus,
    ),
    eligibilityTone: getWithdrawalEligibilityTone(
      withdrawalRequest.eligibilityStatus,
    ),
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
    orderSnapshot,
  };
}

function getVendorReturnGroupPresentation(group) {
  if (group.instructionStatus !== "SENT") {
    return {
      label:
        group.blockedReason === "RETURN_ADDRESS_MISSING"
          ? "返送先の設定が必要"
          : "返送案内待ち",
      tone: group.blockedReason ? "warning" : "neutral",
      action:
        group.blockedReason === "RETURN_ADDRESS_MISSING"
          ? "返送先を設定"
          : "運営の案内待ち",
      needsAction: group.blockedReason === "RETURN_ADDRESS_MISSING",
    };
  }
  if (group.evidenceStatus === "NOT_SUBMITTED") {
    return {
      label: "購入者の返送待ち",
      tone: "neutral",
      action: "返送待ち",
      needsAction: false,
    };
  }
  if (group.receiptStatus !== "RECEIVED") {
    return {
      label: "返送中",
      tone: "warning",
      action: "到着を確認",
      needsAction: true,
    };
  }
  if (!["INSPECTED", "VALUE_REDUCTION_REVIEW"].includes(group.inspectionStatus)) {
    return {
      label: "到着済み",
      tone: "warning",
      action: "商品状態を確認",
      needsAction: true,
    };
  }
  if (group.refundDecisionStatus === "UNDECIDED") {
    return {
      label: "検品済み",
      tone: "success",
      action: "運営の返金判断待ち",
      needsAction: false,
    };
  }
  return {
    label: group.progressStatus === "COMPLETED" ? "処理完了" : "返金処理中",
    tone: group.progressStatus === "COMPLETED" ? "success" : "neutral",
    action: group.progressStatus === "COMPLETED" ? "対応完了" : "運営処理中",
    needsAction: false,
  };
}

function serializeVendorWithdrawalV2Group(group) {
  const presentation = getVendorReturnGroupPresentation(group);
  const base = serializeVendorWithdrawalRequest(group.withdrawalRequest);
  const receivedShipment = (group.shipments || []).find(
    (shipment) => shipment.receivedAt,
  );

  return {
    ...base,
    returnGroupId: group.id,
    storeName: group.storeNameSnapshot || group.vendorStore?.storeName || "-",
    status: group.progressStatus,
    statusLabel: presentation.label,
    statusTone: presentation.tone,
    needsVendorAction: presentation.needsAction,
    vendorActionLabel: presentation.action,
    instructionStatus: group.instructionStatus,
    evidenceStatus: group.evidenceStatus,
    receiptStatus: group.receiptStatus,
    inspectionStatus: group.inspectionStatus,
    refundDecisionStatus: group.refundDecisionStatus,
    returnTrackingCompany: group.shipments?.[0]?.trackingCompany || "",
    returnTrackingNumber: group.shipments?.[0]?.trackingNumber || "",
    returnTrackingUrl: group.shipments?.[0]?.trackingUrl || "",
    returnReceivedAt: receivedShipment?.receivedAt || null,
    returnReceivedAtLabel: formatDate(receivedShipment?.receivedAt),
    lines: (group.lines || []).map((line) => ({
      id: line.id,
      requestedLineId: line.requestedLineId,
      title: line.requestedLine?.titleSnapshot || "-",
      sku: line.requestedLine?.skuSnapshot || "",
      instructedQuantity: line.instructedQuantity,
      submittedQuantity: line.submittedQuantity,
      receivedQuantity: line.receivedQuantity,
      missingQuantity: line.missingQuantity,
      conditionStatus: line.conditionStatus,
      conditionNotes: line.conditionNotes || "",
      amount:
        line.requestedLine?.itemRefundBaseAmount ||
        line.requestedLine?.paidAmountSnapshot ||
        0,
      currencyCode:
        line.requestedLine?.currencyCode || group.currencyCode || "JPY",
    })),
    shipments: group.shipments || [],
    instructions: group.instructions || [],
  };
}

function createVendorWithdrawalSummary(withdrawalRequests = []) {
  const items = Array.isArray(withdrawalRequests) ? withdrawalRequests : [];
  const openItems = items.filter((item) => !isClosedWithdrawalStatus(item.status));
  const actionItems = items.filter((item) => item.needsVendorAction);

  return {
    totalCount: items.length,
    openCount: openItems.length,
    actionCount: actionItems.length,
    latest: items[0] || null,
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
  { value: "all", label: "すべて" },
  { value: "pending", label: "申請中" },
  { value: "review", label: "確認中" },
  { value: "approved", label: "承認済み・公開準備中" },
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
    shippingMethodLabel: getProductShippingMethodLabel(
      product.internationalShippingMethod,
    ),
    shippingWeightLabel: product.shippingWeightGrams
      ? `${product.shippingWeightGrams}g`
      : "重量未設定",
    shippingSizeLabel:
      product.shippingLengthMm &&
      product.shippingWidthMm &&
      product.shippingHeightMm
        ? `${product.shippingLengthMm / 10} × ${product.shippingWidthMm / 10} × ${product.shippingHeightMm / 10}cm`
        : null,
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
    const hasReadOrders = grantedScopes.includes(READ_ORDERS_SCOPE);
    const hasReadDraftOrders = grantedScopes.includes(READ_DRAFT_ORDERS_SCOPE);

    return {
      status: hasReadOrders ? "ready" : "missing_scope",
      hasReadOrders,
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

const VENDOR_ORDER_FULFILLMENT_TARGET_QUERY = `
  query VendorOrderFulfillmentTarget($orderId: ID!) {
    order(id: $orderId) {
      id
      name
      tags
      displayFinancialStatus
      displayFulfillmentStatus
      fulfillmentOrders(first: 20) {
        nodes {
          id
          status
          requestStatus
          lineItems(first: 100) {
            nodes {
              id
              remainingQuantity
              totalQuantity
              lineItem {
                id
              }
            }
          }
          assignedLocation {
            name
            location {
              id
              name
            }
          }
        }
      }
    }
  }
`;

const VENDOR_ORDER_FULFILLMENT_CREATE_MUTATION = `
  mutation VendorOrderFulfillmentCreate($fulfillment: FulfillmentInput!, $message: String) {
    fulfillmentCreate(fulfillment: $fulfillment, message: $message) {
      fulfillment {
        id
      }
      userErrors {
        field
        message
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

const JAPAN_PROVINCE_LABELS = new Map(
  [
    ["hokkaido", "北海道"],
    ["aomori", "青森県"],
    ["iwate", "岩手県"],
    ["miyagi", "宮城県"],
    ["akita", "秋田県"],
    ["yamagata", "山形県"],
    ["fukushima", "福島県"],
    ["ibaraki", "茨城県"],
    ["tochigi", "栃木県"],
    ["gunma", "群馬県"],
    ["saitama", "埼玉県"],
    ["chiba", "千葉県"],
    ["tokyo", "東京都"],
    ["tōkyō", "東京都"],
    ["kanagawa", "神奈川県"],
    ["niigata", "新潟県"],
    ["toyama", "富山県"],
    ["ishikawa", "石川県"],
    ["fukui", "福井県"],
    ["yamanashi", "山梨県"],
    ["nagano", "長野県"],
    ["gifu", "岐阜県"],
    ["shizuoka", "静岡県"],
    ["aichi", "愛知県"],
    ["mie", "三重県"],
    ["shiga", "滋賀県"],
    ["kyoto", "京都府"],
    ["ōsaka", "大阪府"],
    ["osaka", "大阪府"],
    ["hyogo", "兵庫県"],
    ["hyōgo", "兵庫県"],
    ["nara", "奈良県"],
    ["wakayama", "和歌山県"],
    ["tottori", "鳥取県"],
    ["shimane", "島根県"],
    ["okayama", "岡山県"],
    ["hiroshima", "広島県"],
    ["yamaguchi", "山口県"],
    ["tokushima", "徳島県"],
    ["kagawa", "香川県"],
    ["ehime", "愛媛県"],
    ["kochi", "高知県"],
    ["kōchi", "高知県"],
    ["fukuoka", "福岡県"],
    ["saga", "佐賀県"],
    ["nagasaki", "長崎県"],
    ["kumamoto", "熊本県"],
    ["oita", "大分県"],
    ["ōita", "大分県"],
    ["miyazaki", "宮崎県"],
    ["kagoshima", "鹿児島県"],
    ["okinawa", "沖縄県"],
  ].flatMap(([key, label]) => [
    [key, label],
    [label.toLowerCase(), label],
  ]),
);

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
    return [
      zip ? `〒${zip}` : "",
      [province, city].filter(Boolean).join(""),
      [address1, address2].filter(Boolean).join(" "),
      recipientName,
    ].filter(Boolean);
  }

  return [
    recipientName,
    [address1, address2].filter(Boolean).join(" "),
    [city, province, zip].filter(Boolean).join(" "),
    country,
  ].filter(Boolean);
}

function formatShippingAddressSummary(address) {
  if (!address) return "未設定";

  const cityParts = [getShippingProvinceLabel(address), address.city]
    .map(compactSpaces)
    .filter(Boolean);

  if (cityParts.length > 0) {
    return getShippingCountryLabel(address) === "日本"
      ? cityParts.join("")
      : cityParts.join(" ");
  }

  const fallback = getShippingCountryLabel(address);
  return fallback || "未設定";
}

function formatShippingAddressRows(address) {
  if (!address) return [];

  const rows = [
    ["宛名", formatRecipientName(address)],
    ["郵便番号", compactSpaces(address.zip)],
    ["国/地域", getShippingCountryLabel(address)],
    ["都道府県", getShippingProvinceLabel(address)],
    ["市区町村", compactSpaces(address.city)],
    ["住所1", compactSpaces(address.address1)],
    ["住所2", compactSpaces(address.address2)],
  ];

  return rows
    .filter(([, value]) => Boolean(value))
    .map(([label, value]) => ({ label, value }));
}

function summarizeTrackingInfo(fulfillments = []) {
  const trackingItems = [];

  for (const fulfillment of Array.isArray(fulfillments) ? fulfillments : []) {
    for (const info of Array.isArray(fulfillment?.trackingInfo)
      ? fulfillment.trackingInfo
      : []) {
      const number = String(info?.number || "").trim();
      if (!number) continue;

      trackingItems.push({
        company: String(info?.company || "").trim(),
        number,
        url: String(info?.url || "").trim(),
      });
    }
  }

  if (trackingItems.length === 0) {
    return {
      trackingLabel: "-",
      trackingUrl: null,
    };
  }

  return {
    trackingLabel: trackingItems
      .map((item) => (item.company ? `${item.company}: ${item.number}` : item.number))
      .join(", "),
    trackingUrl: trackingItems.find((item) => item.url)?.url || null,
  };
}

function summarizeSellerOrderTrackingInfo(sellerOrder) {
  const shipmentTrackingItems = [];

  for (const shipment of Array.isArray(sellerOrder?.shipments)
    ? sellerOrder.shipments
    : []) {
    const number = String(shipment?.trackingNumber || "").trim();
    if (!number) continue;

    shipmentTrackingItems.push({
      company: String(shipment?.trackingCompany || "").trim(),
      number,
      url: String(shipment?.trackingUrl || "").trim(),
    });
  }

  if (shipmentTrackingItems.length > 0) {
    return {
      trackingLabel: shipmentTrackingItems
        .map((item) => (item.company ? `${item.company}: ${item.number}` : item.number))
        .join(", "),
      trackingUrl:
        shipmentTrackingItems.find((item) => item.url)?.url || null,
    };
  }

  const metadata =
    sellerOrder?.metadataJson &&
    typeof sellerOrder.metadataJson === "object" &&
    !Array.isArray(sellerOrder.metadataJson)
      ? sellerOrder.metadataJson
      : {};
  const shipment = metadata.lastShipment;

  if (!shipment || typeof shipment !== "object") {
    return null;
  }

  const number = String(shipment.trackingNumber || "").trim();
  if (!number) return null;

  const company = String(shipment.trackingCompany || "").trim();

  return {
    trackingLabel: company ? `${company}: ${number}` : number,
    trackingUrl: String(shipment.trackingUrl || "").trim() || null,
  };
}

function getLedgerMetadata(entry) {
  const metadata = entry?.metadataJson;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata
    : {};
}

function createOrderSettlementSummary(orderId, entries = []) {
  let paidAmount = 0;
  let refundAmount = 0;

  for (const entry of Array.isArray(entries) ? entries : []) {
    const entryType = String(
      entry?.entryType ||
        (String(entry?.stripeObjectId || "").trim() === orderId
          ? "shopify_order_paid"
          : ""),
    ).trim();
    const amount = Number(entry?.amount || 0);

    if (!Number.isFinite(amount) || amount <= 0) {
      continue;
    }

    if (
      entryType === "shopify_order_paid" &&
      String(entry?.stripeObjectId || "").trim() === orderId
    ) {
      paidAmount += amount;
      continue;
    }

    if (
      entryType === "refund" &&
      String(getLedgerMetadata(entry).shopifyOrderId || "").trim() === orderId
    ) {
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
    partiallyRefunded: paidAmount > 0 && refundAmount > 0 && refundAmount < paidAmount,
  };
}

function createOrderSettlementSummaryMap(entries = [], orderIds = []) {
  const entryList = Array.isArray(entries) ? entries : [];

  return new Map(
    orderIds.map((orderId) => [
      orderId,
      createOrderSettlementSummary(orderId, entryList),
    ]),
  );
}

function createSellerOrderSettlementSummary(sellerOrder) {
  const paidAmount = Number(
    sellerOrder?.sellerPayableAmount ?? sellerOrder?.sellerNetAmount ?? 0,
  );
  const refundAmount = Number(sellerOrder?.sellerRefundAmount ?? 0);
  const normalizedPaidAmount = Number.isFinite(paidAmount)
    ? Math.max(0, paidAmount)
    : 0;
  const normalizedRefundAmount = Number.isFinite(refundAmount)
    ? Math.max(0, refundAmount)
    : 0;

  return {
    paidAmount: normalizedPaidAmount,
    refundAmount: normalizedRefundAmount,
    netAmount: Math.max(0, normalizedPaidAmount - normalizedRefundAmount),
    hasPaidLedger: normalizedPaidAmount > 0,
    hasRefundLedger: normalizedRefundAmount > 0,
    fullyRefunded:
      normalizedPaidAmount > 0 &&
      normalizedRefundAmount >= normalizedPaidAmount,
    partiallyRefunded:
      normalizedPaidAmount > 0 &&
      normalizedRefundAmount > 0 &&
      normalizedRefundAmount < normalizedPaidAmount,
  };
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

async function listVendorOrderRefundLedgerReferences(
  { storeId, orderIds },
  { prismaClient = prisma } = {},
) {
  const orderIdSet = new Set(
    (Array.isArray(orderIds) ? orderIds : [])
      .map((orderId) => String(orderId || "").trim())
      .filter(Boolean),
  );

  if (orderIdSet.size === 0) {
    return [];
  }

  const entries = await prismaClient.ledgerEntry.findMany({
    where: {
      entryType: "refund",
      seller: {
        is: {
          vendorStoreId: storeId,
        },
      },
    },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    take: Math.max(200, orderIdSet.size * 10),
    select: {
      id: true,
      entryType: true,
      stripeObjectId: true,
      amount: true,
      currencyCode: true,
      metadataJson: true,
      occurredAt: true,
      createdAt: true,
    },
  });

  return entries.filter((entry) =>
    orderIdSet.has(String(getLedgerMetadata(entry).shopifyOrderId || "").trim()),
  );
}

async function listVendorOrderSettlementLedgerEntries(
  { storeId, orderId },
  { prismaClient = prisma } = {},
) {
  const normalizedOrderId = String(orderId || "").trim();

  if (!normalizedOrderId) {
    return [];
  }

  const entries = await prismaClient.ledgerEntry.findMany({
    where: {
      seller: {
        is: {
          vendorStoreId: storeId,
        },
      },
      OR: [
        {
          entryType: "shopify_order_paid",
          stripeObjectId: normalizedOrderId,
        },
        {
          entryType: "refund",
        },
      ],
    },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    take: 200,
    select: {
      id: true,
      entryType: true,
      stripeObjectId: true,
      amount: true,
      currencyCode: true,
      metadataJson: true,
      occurredAt: true,
      createdAt: true,
    },
  });

  return entries.filter((entry) => {
    if (entry.entryType === "shopify_order_paid") {
      return String(entry.stripeObjectId || "").trim() === normalizedOrderId;
    }

    if (entry.entryType === "refund") {
      return (
        String(getLedgerMetadata(entry).shopifyOrderId || "").trim() ===
        normalizedOrderId
      );
    }

    return false;
  });
}

function serializeVendorOrderRow(orderRecord) {
  const order = orderRecord?.order || orderRecord;
  const ledgerEntry = orderRecord?.ledgerEntry || null;
  const sellerOrder = orderRecord?.sellerOrder || null;
  const ledgerSummary =
    orderRecord?.ledgerSummary ||
    createOrderSettlementSummary(order?.id, ledgerEntry ? [ledgerEntry] : []);

  if (!order?.id || !order?.name) {
    return null;
  }

  const shopMoney = order?.currentTotalPriceSet?.shopMoney;
  const createdAt =
    order?.createdAt ||
    orderRecord?.completedAt ||
      orderRecord?.createdAt ||
      sellerOrder?.createdAt ||
      ledgerEntry?.occurredAt ||
      ledgerEntry?.createdAt;
  const financialStatus = String(order?.displayFinancialStatus || "").trim();
  const appFinancialStatus = ledgerSummary.fullyRefunded
    ? "REFUNDED"
    : ledgerSummary.partiallyRefunded
      ? "PARTIALLY_REFUNDED"
      : financialStatus;
  const fulfillmentStatus =
    mapSellerOrderFulfillmentStatusToDisplay(sellerOrder?.fulfillmentStatus) ||
    String(order?.displayFulfillmentStatus || "").trim();
  const currencyCode = shopMoney?.currencyCode || "JPY";
  const tracking =
    summarizeSellerOrderTrackingInfo(sellerOrder) ||
    summarizeTrackingInfo(order?.fulfillments);

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
    canRegisterShipment:
      financialStatus === "PAID" &&
      !ledgerSummary.fullyRefunded &&
      !["FULFILLED", "RESTOCKED"].includes(fulfillmentStatus),
  };
}

function parseTrackingUrl(value) {
  const normalizedValue = String(value || "").trim();

  if (!normalizedValue) return null;

  try {
    const url = new URL(normalizedValue);
    if (!["http:", "https:"].includes(url.protocol)) {
      return false;
    }
    return url.toString();
  } catch {
    return false;
  }
}

export function parseShipmentRegistrationInput(formLike) {
  const getValue =
    typeof formLike?.get === "function"
      ? (key) => formLike.get(key)
      : (key) => formLike?.[key];

  const orderId = String(getValue("orderId") || "").trim();
  const sellerOrderId = String(getValue("sellerOrderId") || "").trim();
  const trackingNumber = String(getValue("trackingNumber") || "").trim();
  const trackingCarrierId = String(getValue("trackingCarrierId") || "").trim();
  const carrier = getShippingCarrierById(trackingCarrierId);
  const trackingUrlOverride = parseTrackingUrl(getValue("trackingUrl"));
  const notifyCustomer = String(getValue("notifyCustomer") || "") === "on";

  if (!orderId.startsWith("gid://shopify/Order/")) {
    return {
      ok: false,
      status: 400,
      error: "注文情報が不正です。",
    };
  }

  if (!trackingNumber) {
    return {
      ok: false,
      status: 400,
      error: "追跡番号を入力してください。",
    };
  }

  if (!carrier) {
    return {
      ok: false,
      status: 400,
      error: "配送会社を選択してください。",
    };
  }

  if (trackingNumber.length > 120) {
    return {
      ok: false,
      status: 400,
      error: "追跡番号は120文字以内で入力してください。",
    };
  }

  if (trackingUrlOverride === false) {
    return {
      ok: false,
      status: 400,
      error: "追跡URLは https:// から始まるURLで入力してください。",
    };
  }

  const trackingUrl =
    trackingUrlOverride || buildCarrierTrackingUrl(carrier, trackingNumber);

  return {
    ok: true,
    orderId,
    sellerOrderId: sellerOrderId || null,
    trackingNumber,
    trackingCarrierId: carrier.id,
    trackingCompany: carrier.shopifyCompany,
    trackingCompanyLabel: carrier.label,
    trackingUrl,
    notifyCustomer,
  };
}

function toPublicFulfillmentError(error) {
  const message = error instanceof Error ? error.message : String(error || "");

  if (isReconnectableShopifyError(message)) {
    return "公開ストアとの接続確認が必要です。管理者に連絡してください。";
  }

  if (
    message.includes("ACCESS_DENIED") ||
    message.includes("access denied") ||
    message.includes("merchant_managed_fulfillment_orders") ||
    message.includes("fulfill_and_ship_orders")
  ) {
    return "発送登録に必要な権限が不足しています。管理者に連絡してください。";
  }

  return "発送登録に失敗しました。時間を置いて再度お試しください。";
}

function getFulfillableFulfillmentOrders(order) {
  const nodes = order?.fulfillmentOrders?.nodes;

  if (!Array.isArray(nodes)) return [];

  return nodes.filter((fulfillmentOrder) => {
    const status = String(fulfillmentOrder?.status || "").trim();
    const requestStatus = String(fulfillmentOrder?.requestStatus || "").trim();

    if (!["OPEN", "IN_PROGRESS", "SCHEDULED"].includes(status)) {
      return false;
    }

    if (
      [
        "SUBMITTED",
        "ACCEPTED",
        "CANCELLATION_REQUESTED",
        "CANCELLATION_REJECTED",
      ].includes(requestStatus)
    ) {
      return false;
    }

    return Boolean(fulfillmentOrder?.id);
  });
}

function toFulfillmentQuantity(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.max(0, Math.floor(numberValue));
}

function getFulfillmentOrderLineItemNodes(fulfillmentOrder) {
  const nodes = fulfillmentOrder?.lineItems?.nodes;
  return Array.isArray(nodes) ? nodes : [];
}

function buildSellerOrderFulfillmentGroups({ fulfillmentOrders, sellerOrder }) {
  const sellerLines = Array.isArray(sellerOrder?.lines) ? sellerOrder.lines : [];
  const remainingByShopifyLineItemId = new Map();

  for (const line of sellerLines) {
    const shopifyLineItemId = String(line?.shopifyLineItemId || "").trim();
    if (!shopifyLineItemId) continue;

    const quantity = toFulfillmentQuantity(line?.quantity);
    const fulfilledQuantity = toFulfillmentQuantity(line?.fulfilledQuantity);
    const refundedQuantity = toFulfillmentQuantity(line?.refundedQuantity);
    const remainingQuantity = Math.max(
      0,
      quantity - fulfilledQuantity - refundedQuantity,
    );

    if (remainingQuantity > 0) {
      remainingByShopifyLineItemId.set(shopifyLineItemId, remainingQuantity);
    }
  }

  const groups = [];

  for (const fulfillmentOrder of fulfillmentOrders) {
    const fulfillmentOrderLineItems = [];

    for (const fulfillmentOrderLineItem of getFulfillmentOrderLineItemNodes(
      fulfillmentOrder,
    )) {
      const shopifyLineItemId = String(
        fulfillmentOrderLineItem?.lineItem?.id || "",
      ).trim();
      const sellerRemainingQuantity =
        remainingByShopifyLineItemId.get(shopifyLineItemId) || 0;

      if (sellerRemainingQuantity <= 0) continue;

      const fulfillmentRemainingQuantity = toFulfillmentQuantity(
        fulfillmentOrderLineItem?.remainingQuantity,
      );
      const fallbackTotalQuantity = toFulfillmentQuantity(
        fulfillmentOrderLineItem?.totalQuantity,
      );
      const maxFulfillableQuantity =
        fulfillmentRemainingQuantity > 0
          ? fulfillmentRemainingQuantity
          : fallbackTotalQuantity;
      const quantity = Math.min(
        sellerRemainingQuantity,
        maxFulfillableQuantity,
      );

      if (quantity <= 0) continue;

      fulfillmentOrderLineItems.push({
        id: fulfillmentOrderLineItem.id,
        quantity,
        shopifyLineItemId,
      });
      remainingByShopifyLineItemId.set(
        shopifyLineItemId,
        sellerRemainingQuantity - quantity,
      );
    }

    if (fulfillmentOrderLineItems.length > 0) {
      groups.push({
        fulfillmentOrder,
        fulfillmentOrderId: fulfillmentOrder.id,
        fulfillmentOrderLineItems,
      });
    }
  }

  return groups;
}

function buildFulfillmentInput({
  fulfillmentOrders,
  shipment,
  sellerFulfillmentGroups = null,
}) {
  const trackingInfo = {
    number: shipment.trackingNumber,
  };

  if (shipment.trackingCompany) {
    trackingInfo.company = shipment.trackingCompany;
  }

  if (shipment.trackingUrl) {
    trackingInfo.url = shipment.trackingUrl;
  }

  const lineItemsByFulfillmentOrder = Array.isArray(sellerFulfillmentGroups)
    ? sellerFulfillmentGroups.map((group) => ({
        fulfillmentOrderId: group.fulfillmentOrderId,
        fulfillmentOrderLineItems: group.fulfillmentOrderLineItems.map((line) => ({
          id: line.id,
          quantity: line.quantity,
        })),
      }))
    : fulfillmentOrders.map((fulfillmentOrder) => ({
        fulfillmentOrderId: fulfillmentOrder.id,
      }));

  return {
    lineItemsByFulfillmentOrder,
    notifyCustomer: shipment.notifyCustomer,
    trackingInfo,
  };
}

async function findVendorSellerOrderForShipment({
  prismaClient,
  storeId,
  shipment,
}) {
  const sellerOrderId = String(shipment?.sellerOrderId || "").trim();
  if (!sellerOrderId || !prismaClient?.sellerOrder?.findFirst) {
    return null;
  }

  return prismaClient.sellerOrder.findFirst({
    where: {
      id: sellerOrderId,
      vendorStoreId: storeId,
      shopifyOrderId: shipment.orderId,
    },
    select: {
      id: true,
      shopifyOrderId: true,
      sellerRefundAmount: true,
      sellerNetAmount: true,
      sellerPayableAmount: true,
      currencyCode: true,
      paymentStatus: true,
      fulfillmentStatus: true,
      settlementStatus: true,
      riskStatus: true,
      metadataJson: true,
      lines: {
        select: {
          id: true,
          shopifyLineItemId: true,
          quantity: true,
          fulfilledQuantity: true,
          refundedQuantity: true,
        },
      },
    },
  });
}

async function markSellerOrderShipmentRegistered({
  prismaClient,
  sellerOrder,
  sellerFulfillmentGroups,
  fulfillmentId,
  shipment,
}) {
  if (
    !sellerOrder?.id ||
    !prismaClient?.sellerOrder?.update ||
    !prismaClient?.sellerOrderLine?.update
  ) {
    return;
  }

  const fulfilledByShopifyLineItemId = new Map();
  const sellerLineByShopifyLineItemId = new Map();
  const sellerShipmentLines = [];

  for (const line of Array.isArray(sellerOrder.lines) ? sellerOrder.lines : []) {
    const shopifyLineItemId = String(line?.shopifyLineItemId || "").trim();
    if (shopifyLineItemId) {
      sellerLineByShopifyLineItemId.set(shopifyLineItemId, line);
    }
  }

  for (const group of Array.isArray(sellerFulfillmentGroups)
    ? sellerFulfillmentGroups
    : []) {
    for (const line of group.fulfillmentOrderLineItems || []) {
      fulfilledByShopifyLineItemId.set(
        line.shopifyLineItemId,
        (fulfilledByShopifyLineItemId.get(line.shopifyLineItemId) || 0) +
          line.quantity,
      );

      const sellerOrderLine = sellerLineByShopifyLineItemId.get(
        line.shopifyLineItemId,
      );

      if (sellerOrderLine?.id && line?.id && group?.fulfillmentOrderId) {
        sellerShipmentLines.push({
          sellerOrderLineId: sellerOrderLine.id,
          shopifyLineItemId: line.shopifyLineItemId || null,
          shopifyFulfillmentOrderId: group.fulfillmentOrderId,
          shopifyFulfillmentOrderLineItemId: line.id,
          quantity: toFulfillmentQuantity(line.quantity),
        });
      }
    }
  }

  let fulfilledLineCount = 0;
  for (const line of Array.isArray(sellerOrder.lines) ? sellerOrder.lines : []) {
    const fulfilledQuantity =
      fulfilledByShopifyLineItemId.get(line.shopifyLineItemId) || 0;
    if (fulfilledQuantity <= 0) continue;

    fulfilledLineCount += 1;
    await prismaClient.sellerOrderLine.update({
      where: {
        id: line.id,
      },
      data: {
        fulfilledQuantity: Math.min(
          toFulfillmentQuantity(line.quantity),
          toFulfillmentQuantity(line.fulfilledQuantity) + fulfilledQuantity,
        ),
      },
    });
  }

  if (fulfilledLineCount === 0) return;

  const shippedAt = new Date();
  let sellerShipment = null;

  if (
    prismaClient?.sellerShipment?.create &&
    sellerShipmentLines.length > 0
  ) {
    sellerShipment = await prismaClient.sellerShipment.create({
      data: {
        sellerOrderId: sellerOrder.id,
        shopifyFulfillmentId: fulfillmentId || null,
        trackingNumber: shipment.trackingNumber || null,
        trackingCompany: shipment.trackingCompany || null,
        trackingUrl: shipment.trackingUrl || null,
        status: "registered",
        shippedAt,
        metadataJson: {
          source: "vendor_portal",
        },
        lines: {
          create: sellerShipmentLines,
        },
      },
      select: {
        id: true,
      },
    });
  }

  const existingMetadata =
    sellerOrder.metadataJson &&
    typeof sellerOrder.metadataJson === "object" &&
    !Array.isArray(sellerOrder.metadataJson)
      ? sellerOrder.metadataJson
      : {};

  await prismaClient.sellerOrder.update({
    where: {
      id: sellerOrder.id,
    },
    data: {
      fulfillmentStatus: "fulfilled",
      metadataJson: {
        ...existingMetadata,
        lastShipment: {
          fulfillmentId: fulfillmentId || null,
          sellerShipmentId: sellerShipment?.id || null,
          trackingNumber: shipment.trackingNumber,
          trackingCompany: shipment.trackingCompany || null,
          trackingUrl: shipment.trackingUrl || null,
          shippedAt: shippedAt.toISOString(),
        },
      },
    },
  });
}

export async function createVendorOrderFulfillment({
  storeId,
  vendorHandle,
  shipment,
  listVendorStoreShopDomainsImpl = listVendorStoreShopDomains,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
  prismaClient = prisma,
}) {
  const shopDomains = await listVendorStoreShopDomainsImpl(storeId);

  if (shopDomains.length !== 1) {
    return {
      ok: false,
      status: 400,
      error:
        shopDomains.length === 0
          ? "公開ストアとの接続情報を確認中です。"
          : "公開ストアの接続先を確認中です。",
    };
  }

  try {
    const shopDomain = shopDomains[0];
    const { data: targetData } = await shopifyGraphQLWithOfflineSessionImpl({
      shopDomain,
      apiVersion: SHOPIFY_API_VERSION,
      query: VENDOR_ORDER_FULFILLMENT_TARGET_QUERY,
      variables: {
        orderId: shipment.orderId,
      },
    });

    const order = targetData?.order;

    if (!order?.id) {
      return {
        ok: false,
        status: 404,
        error: "注文が見つかりません。",
      };
    }

    const tags = Array.isArray(order.tags) ? order.tags : [];
    const hasVendorStorefrontTag = tags.includes("vendor-storefront");
    const hasMatchingVendorTag = tags.includes(`vendor:${vendorHandle}`);

    if (hasVendorStorefrontTag && !hasMatchingVendorTag) {
      return {
        ok: false,
        status: 403,
        error: "この注文は現在の店舗では発送登録できません。",
      };
    }

    const sellerOrder = await findVendorSellerOrderForShipment({
      prismaClient,
      storeId,
      shipment,
    });

    if (shipment.sellerOrderId && !sellerOrder) {
      return {
        ok: false,
        status: 404,
        error: "この注文は現在の店舗では発送登録できません。",
      };
    }

    if (
      sellerOrder &&
      (sellerOrder.riskStatus !== "normal" ||
        ["held", "review", "quarantined"].includes(
          String(sellerOrder.settlementStatus || "").toLowerCase(),
        ))
    ) {
      return {
        ok: false,
        status: 409,
        error:
          "この注文は確認中のため発送できません。運営の確認完了をお待ちください。",
      };
    }

    const settlementSummary = sellerOrder
      ? createSellerOrderSettlementSummary(sellerOrder)
      : createOrderSettlementSummary(
          shipment.orderId,
          await listVendorOrderSettlementLedgerEntries(
            {
              storeId,
              orderId: shipment.orderId,
            },
            { prismaClient },
          ),
        );

    if (!sellerOrder && !hasVendorStorefrontTag) {
      if (!settlementSummary.hasPaidLedger) {
        return {
          ok: false,
          status: 403,
          error: "この注文は現在の店舗では発送登録できません。",
        };
      }
    }

    if (settlementSummary.fullyRefunded) {
      return {
        ok: false,
        status: 400,
        error: "返金済みの注文は発送登録できません。",
      };
    }

    if (order.displayFinancialStatus !== "PAID") {
      return {
        ok: false,
        status: 400,
        error: "支払い確認後に発送登録できます。",
      };
    }

    if (order.displayFulfillmentStatus === "FULFILLED") {
      return {
        ok: false,
        status: 400,
        error: "この注文はすでに発送済みです。",
      };
    }

    const fulfillmentOrders = getFulfillableFulfillmentOrders(order);

    if (fulfillmentOrders.length === 0) {
      return {
        ok: false,
        status: 400,
        error: "発送できる注文行がありません。",
      };
    }

    const sellerFulfillmentGroups = sellerOrder
      ? buildSellerOrderFulfillmentGroups({
          fulfillmentOrders,
          sellerOrder,
        })
      : null;
    const fulfillmentOrdersForShipment = sellerFulfillmentGroups
      ? sellerFulfillmentGroups.map((group) => group.fulfillmentOrder)
      : fulfillmentOrders;

    if (sellerOrder && sellerFulfillmentGroups.length === 0) {
      return {
        ok: false,
        status: 400,
        error: "この店舗で発送できる未発送の商品がありません。",
      };
    }

    const locationKeys = Array.from(
      new Set(
        fulfillmentOrdersForShipment.map(
          (fulfillmentOrder) =>
            fulfillmentOrder?.assignedLocation?.location?.id ||
            fulfillmentOrder?.assignedLocation?.name ||
            "unknown",
        ),
      ),
    );

    if (locationKeys.length > 1) {
      return {
        ok: false,
        status: 400,
        error: "複数の発送元に分かれた注文です。管理者側で発送登録してください。",
      };
    }

    const { data: createData } = await shopifyGraphQLWithOfflineSessionImpl({
      shopDomain,
      apiVersion: SHOPIFY_API_VERSION,
      query: VENDOR_ORDER_FULFILLMENT_CREATE_MUTATION,
      variables: {
        fulfillment: buildFulfillmentInput({
          fulfillmentOrders,
          shipment,
          sellerFulfillmentGroups,
        }),
        message: "Shipment registered from vendor portal.",
      },
    });

    const payload = createData?.fulfillmentCreate;
    const userError = getFirstUserErrorMessage(payload?.userErrors, null);

    if (!payload || userError) {
      return {
        ok: false,
        status: 400,
        error: userError || "発送登録に失敗しました。",
      };
    }

    await markSellerOrderShipmentRegistered({
      prismaClient,
      sellerOrder,
      sellerFulfillmentGroups,
      fulfillmentId: payload.fulfillment?.id || null,
      shipment,
    });

    return {
      ok: true,
      orderId: order.id,
      orderName: order.name,
      fulfillmentId: payload.fulfillment?.id || null,
      message: `${order.name || "注文"}を発送済みにしました。`,
    };
  } catch (error) {
    console.error("vendor fulfillment create error:", error);

    return {
      ok: false,
      status: 500,
      error: toPublicFulfillmentError(error),
    };
  }
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

export async function listVendorShopifyOrderLedgerReferences(
  { storeId, first = VENDOR_DRAFT_ORDERS_PAGE_SIZE },
  { prismaClient = prisma } = {},
) {
  const entries = await prismaClient.ledgerEntry.findMany({
    where: {
      entryType: "shopify_order_paid",
      stripeObjectId: {
        not: null,
      },
      seller: {
        is: {
          vendorStoreId: storeId,
        },
      },
    },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    take: first,
    select: {
      id: true,
      entryType: true,
      stripeObjectId: true,
      amount: true,
      currencyCode: true,
      metadataJson: true,
      occurredAt: true,
      createdAt: true,
    },
  });

  const seenOrderIds = new Set();
  return entries
    .map((entry) => ({
      ...entry,
      shopifyOrderId: String(entry?.stripeObjectId || "").trim(),
    }))
    .filter((entry) => {
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

export async function listVendorShopifyOrderSellerOrderReferences(
  { storeId, first = VENDOR_DRAFT_ORDERS_PAGE_SIZE },
  { prismaClient = prisma } = {},
) {
  if (!prismaClient?.sellerOrder?.findMany) {
    return [];
  }

  const sellerOrders = await prismaClient.sellerOrder.findMany({
    where: {
      vendorStoreId: storeId,
    },
    orderBy: [{ createdAt: "desc" }],
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
          quantity: true,
        },
      },
      shipments: {
        orderBy: {
          createdAt: "desc",
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
          createdAt: true,
        },
      },
    },
  });

  const seenOrderIds = new Set();
  return sellerOrders
    .map((sellerOrder) => ({
      ...sellerOrder,
      shopifyOrderId: String(sellerOrder?.shopifyOrderId || "").trim(),
    }))
    .filter((sellerOrder) => {
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

async function listVendorWithdrawalRequestsForSellerOrders(
  { sellerOrders, first = 100 },
  { prismaClient = prisma } = {},
) {
  const orders = Array.isArray(sellerOrders) ? sellerOrders : [];
  const shopifyOrderIds = Array.from(
    new Set(
      orders
        .map((sellerOrder) => String(sellerOrder?.shopifyOrderId || "").trim())
        .filter(Boolean),
    ),
  );
  const marketplaceOrderIds = Array.from(
    new Set(
      orders
        .map((sellerOrder) =>
          String(sellerOrder?.marketplaceOrderId || "").trim(),
        )
        .filter(Boolean),
    ),
  );

  if (
    !prismaClient?.withdrawalRequest?.findMany ||
    (shopifyOrderIds.length === 0 && marketplaceOrderIds.length === 0)
  ) {
    return [];
  }

  const withdrawalRequests = await prismaClient.withdrawalRequest.findMany({
    where: {
      OR: [
        ...(shopifyOrderIds.length > 0
          ? [{ shopifyOrderId: { in: shopifyOrderIds } }]
          : []),
        ...(marketplaceOrderIds.length > 0
          ? [{ marketplaceOrderId: { in: marketplaceOrderIds } }]
          : []),
      ],
    },
    orderBy: [{ createdAt: "desc" }],
    take: first,
  });

  return withdrawalRequests
    .filter((withdrawalRequest) =>
      orders.some((sellerOrder) =>
        sellerOrderTouchesWithdrawal(sellerOrder, withdrawalRequest),
      ),
    )
    .map(serializeVendorWithdrawalRequest);
}

function groupVendorWithdrawalRequestsByOrderId(withdrawalRequests = []) {
  const grouped = new Map();

  for (const withdrawalRequest of Array.isArray(withdrawalRequests)
    ? withdrawalRequests
    : []) {
    const orderId = String(withdrawalRequest.shopifyOrderId || "").trim();
    if (!orderId) continue;

    const current = grouped.get(orderId) || [];
    current.push(withdrawalRequest);
    grouped.set(orderId, current);
  }

  return grouped;
}

function attachWithdrawalSummaryToOrders(orders = [], withdrawalRequests = []) {
  const byOrderId = groupVendorWithdrawalRequestsByOrderId(withdrawalRequests);

  return (Array.isArray(orders) ? orders : []).map((order) => {
    const withdrawals = byOrderId.get(order.orderId) || [];
    return {
      ...order,
      withdrawals,
      withdrawalSummary: createVendorWithdrawalSummary(withdrawals),
    };
  });
}

export async function listVendorWithdrawalRequests(
  { storeId, first = 50 },
  { prismaClient = prisma } = {},
) {
  if (!prismaClient?.sellerOrder?.findMany) {
    return [];
  }

  const sellerOrders = await prismaClient.sellerOrder.findMany({
    where: {
      vendorStoreId: storeId,
    },
    orderBy: [{ createdAt: "desc" }],
    take: Math.max(first, 100),
    select: {
      id: true,
      marketplaceOrderId: true,
      shopifyOrderId: true,
      lines: {
        select: {
          id: true,
          shopifyLineItemId: true,
          shopifyProductId: true,
          shopifyVariantId: true,
          productId: true,
          title: true,
          quantity: true,
        },
      },
    },
  });

  const legacyRequests = await listVendorWithdrawalRequestsForSellerOrders(
    { sellerOrders, first },
    { prismaClient },
  );

  if (!prismaClient?.withdrawalReturnGroup?.findMany) {
    return legacyRequests;
  }

  const v2Groups = await prismaClient.withdrawalReturnGroup.findMany({
    where: { vendorStoreId: storeId },
    orderBy: [{ createdAt: "desc" }],
    take: first,
    include: {
      withdrawalRequest: true,
      vendorStore: { select: { storeName: true } },
      lines: {
        include: { requestedLine: true },
        orderBy: { createdAt: "asc" },
      },
      instructions: { orderBy: { version: "desc" }, take: 1 },
      shipments: {
        include: { lines: true },
        orderBy: { packageNumber: "asc" },
      },
    },
  });
  const v2Items = v2Groups.map(serializeVendorWithdrawalV2Group);
  const v2RequestIds = new Set(v2Items.map((item) => item.id));

  return [...v2Items, ...legacyRequests.filter((item) => !v2RequestIds.has(item.id))]
    .sort(
      (left, right) =>
        new Date(right.createdAt || 0).getTime() -
        new Date(left.createdAt || 0).getTime(),
    )
    .slice(0, first);
}

export async function getVendorWithdrawalSummary(
  { storeId },
  { prismaClient = prisma } = {},
) {
  const withdrawalRequests = await listVendorWithdrawalRequests(
    { storeId, first: 100 },
    { prismaClient },
  );

  return createVendorWithdrawalSummary(withdrawalRequests);
}

export async function getVendorWithdrawalRequestDetail(
  { storeId, withdrawalRequestId },
  { prismaClient = prisma } = {},
) {
  const withdrawalRequestIdValue = String(withdrawalRequestId || "").trim();

  if (!withdrawalRequestIdValue) {
    return null;
  }

  const withdrawalRequest = await prismaClient.withdrawalRequest.findUnique({
    where: { id: withdrawalRequestIdValue },
    include: {
      statusHistory: { orderBy: { createdAt: "desc" }, take: 20 },
      emailLogs: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });

  if (!withdrawalRequest) {
    return null;
  }

  if (
    Number(withdrawalRequest.workflowVersion || 1) === 2 &&
    prismaClient?.withdrawalReturnGroup?.findFirst
  ) {
    const returnGroup = await prismaClient.withdrawalReturnGroup.findFirst({
      where: {
        withdrawalRequestId: withdrawalRequest.id,
        vendorStoreId: storeId,
      },
      include: {
        vendorStore: { select: { storeName: true } },
        returnAddress: true,
        lines: {
          include: { requestedLine: true },
          orderBy: { createdAt: "asc" },
        },
        instructions: { orderBy: { version: "desc" } },
        shipments: {
          include: {
            lines: { include: { returnGroupLine: true } },
          },
          orderBy: { packageNumber: "asc" },
        },
      },
    });
    if (!returnGroup) return null;

    return {
      withdrawalRequest: {
        ...serializeVendorWithdrawalRequest(withdrawalRequest),
        statusHistory: withdrawalRequest.statusHistory.map((item) => ({
          ...item,
          createdAtLabel: formatDateTime(item.createdAt),
        })),
        emailLogs: [],
      },
      returnGroup: serializeVendorWithdrawalV2Group({
        ...returnGroup,
        withdrawalRequest,
      }),
      sellerOrders: [],
    };
  }

  const orderWhere = [
    ...(withdrawalRequest.shopifyOrderId
      ? [{ shopifyOrderId: withdrawalRequest.shopifyOrderId }]
      : []),
    ...(withdrawalRequest.marketplaceOrderId
      ? [{ marketplaceOrderId: withdrawalRequest.marketplaceOrderId }]
      : []),
  ];

  if (orderWhere.length === 0) {
    return null;
  }

  const sellerOrders = await prismaClient.sellerOrder.findMany({
    where: {
      vendorStoreId: storeId,
      OR: orderWhere,
    },
    select: {
      id: true,
      marketplaceOrderId: true,
      shopifyOrderId: true,
      sellerPayableAmount: true,
      sellerRefundAmount: true,
      currencyCode: true,
      fulfillmentStatus: true,
      lines: {
        select: {
          id: true,
          shopifyLineItemId: true,
          shopifyProductId: true,
          shopifyVariantId: true,
          productId: true,
          title: true,
          quantity: true,
          netAmount: true,
          currencyCode: true,
        },
      },
    },
  });

  const matchingSellerOrders = sellerOrders
    .filter((sellerOrder) =>
      sellerOrderTouchesWithdrawal(sellerOrder, withdrawalRequest),
    )
    .map((sellerOrder) =>
      filterSellerOrderLinesForWithdrawal(sellerOrder, withdrawalRequest),
    )
    .filter((sellerOrder) => (sellerOrder.lines || []).length > 0);

  if (matchingSellerOrders.length === 0) {
    return null;
  }

  return {
    withdrawalRequest: {
      ...serializeVendorWithdrawalRequest(withdrawalRequest),
      statusHistory: withdrawalRequest.statusHistory.map((item) => ({
        ...item,
        createdAtLabel: formatDateTime(item.createdAt),
      })),
      emailLogs: withdrawalRequest.emailLogs.map((item) => ({
        ...item,
        sentAtLabel: formatDateTime(item.sentAt || item.createdAt),
      })),
    },
    sellerOrders: matchingSellerOrders,
  };
}

export async function updateVendorWithdrawalReturnInfo(
  { storeId, withdrawalRequestId, formData },
  { prismaClient = prisma } = {},
) {
  const access = await getVendorWithdrawalRequestDetail(
    { storeId, withdrawalRequestId },
    { prismaClient },
  );

  if (!access) {
    return {
      ok: false,
      status: 404,
      error: "撤回申請が見つかりません。",
    };
  }

  if (Number(access.withdrawalRequest.workflowVersion || 1) === 2) {
    const group = access.returnGroup;
    if (!group) {
      return { ok: false, status: 404, error: "返送グループが見つかりません。" };
    }
    const lineReviews = (group.lines || []).map((line) => ({
      id: line.id,
      receivedQuantity: formData.get(`receivedQuantity_${line.id}`),
      conditionStatus: formData.get(`conditionStatus_${line.id}`),
      conditionNotes: formData.get(`conditionNotes_${line.id}`),
    }));
    const result = await updateWithdrawalGroupReview({
      returnGroupId: group.returnGroupId,
      vendorStoreId: storeId,
      allowFinancialDecision: false,
      changedBy: `vendor:${storeId}`,
      values: {
        evidenceStatus: formData.get("evidenceStatus"),
        receiptStatus: formData.get("receiptStatus"),
        inspectionStatus: formData.get("inspectionStatus"),
        reviewNotes: formData.get("reviewNotes"),
        lineReviews,
      },
      prismaClient,
    });
    return result.ok
      ? { ok: true, message: "到着・検品情報を保存しました。" }
      : {
          ok: false,
          status: result.status || 400,
          error: "到着・検品情報を保存できませんでした。",
          errors: result.errors || {},
        };
  }

  const result = await updateWithdrawalReturnInfo({
    id: withdrawalRequestId,
    formData,
    changedBy: `vendor:${storeId}`,
    prismaClient,
  });

  if (!result.ok) {
    return {
      ok: false,
      status: result.status || 400,
      error: "返送情報を保存できませんでした。",
      errors: result.errors || {},
    };
  }

  return {
    ok: true,
    message: "返送・商品状態を保存しました。",
    withdrawalRequest: result.withdrawalRequest,
  };
}

export async function listVendorShopifyOrdersFromLedger(
  { storeId, shopDomain, first = VENDOR_DRAFT_ORDERS_PAGE_SIZE },
  {
    prismaClient = prisma,
    shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
  } = {},
) {
  const queryString = "ledger:shopify_order_paid";
  const ledgerEntries = await listVendorShopifyOrderLedgerReferences(
    { storeId, first },
    { prismaClient },
  );
  const orderIds = ledgerEntries.map((entry) => entry.shopifyOrderId);

  if (orderIds.length === 0) {
    return {
      queryString,
      orders: [],
    };
  }

  const response = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: VENDOR_LEDGER_ORDERS_QUERY,
    variables: {
      ids: orderIds,
    },
  });
  const data = response?.data;

  if (Array.isArray(response?.errors) && response.errors.length > 0) {
    throw new Error("VENDOR_LEDGER_ORDERS_QUERY_FAILED");
  }

  const nodes = data?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error("VENDOR_LEDGER_ORDERS_QUERY_UNAVAILABLE");
  }

  const orderById = new Map(
    nodes
      .filter((node) => node?.id)
      .map((node) => [String(node.id), node]),
  );
  const refundEntries = await listVendorOrderRefundLedgerReferences(
    { storeId, orderIds },
    { prismaClient },
  );
  const ledgerSummaryByOrderId = createOrderSettlementSummaryMap(
    [...ledgerEntries, ...refundEntries],
    orderIds,
  );

  const orders = ledgerEntries
    .map((ledgerEntry) =>
      serializeVendorOrderRow({
        order: orderById.get(ledgerEntry.shopifyOrderId),
        ledgerEntry,
        ledgerSummary: ledgerSummaryByOrderId.get(ledgerEntry.shopifyOrderId),
      }),
    )
    .filter(Boolean);

  return {
    queryString,
    orders,
  };
}

export async function listVendorShopifyOrdersFromSellerOrders(
  { storeId, shopDomain, first = VENDOR_DRAFT_ORDERS_PAGE_SIZE },
  {
    prismaClient = prisma,
    shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
  } = {},
) {
  const queryString = "seller_order:shadow";
  const sellerOrders = await listVendorShopifyOrderSellerOrderReferences(
    { storeId, first },
    { prismaClient },
  );
  const orderIds = sellerOrders.map((sellerOrder) => sellerOrder.shopifyOrderId);

  if (orderIds.length === 0) {
    return {
      queryString,
      orders: [],
    };
  }

  const response = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: VENDOR_LEDGER_ORDERS_QUERY,
    variables: {
      ids: orderIds,
    },
  });
  const data = response?.data;

  if (Array.isArray(response?.errors) && response.errors.length > 0) {
    throw new Error("VENDOR_SELLER_ORDERS_QUERY_FAILED");
  }

  const nodes = data?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error("VENDOR_SELLER_ORDERS_QUERY_UNAVAILABLE");
  }

  const orderById = new Map(
    nodes
      .filter((node) => node?.id)
      .map((node) => [String(node.id), node]),
  );
  const withdrawalRequests = await listVendorWithdrawalRequestsForSellerOrders(
    { sellerOrders, first: Math.max(100, sellerOrders.length * 5) },
    { prismaClient },
  );
  const withdrawalsByOrderId =
    groupVendorWithdrawalRequestsByOrderId(withdrawalRequests);

  const orders = sellerOrders
    .map((sellerOrder) => {
      const order = serializeVendorOrderRow({
        order: orderById.get(sellerOrder.shopifyOrderId),
        sellerOrder,
        ledgerSummary: createSellerOrderSettlementSummary(sellerOrder),
      });

      if (!order) return null;

      const withdrawals = withdrawalsByOrderId.get(order.orderId) || [];
      return {
        ...order,
        withdrawals,
        withdrawalSummary: createVendorWithdrawalSummary(withdrawals),
      };
    })
    .filter(Boolean);

  return {
    queryString,
    orders,
  };
}

export async function getVendorOrdersPageData(
  { storeId },
  {
    listVendorStoreShopDomainsImpl = listVendorStoreShopDomains,
    listGrantedAppAccessScopesImpl = listGrantedAppAccessScopes,
    shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
    prismaClient = prisma,
    useSellerOrderRead = shouldUseSellerOrderVendorOrdersRead(),
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

  if (useSellerOrderRead && prismaClient?.sellerOrder?.findMany) {
    try {
      const result = await listVendorShopifyOrdersFromSellerOrders(
        {
          storeId,
          shopDomain: accessState.shopDomain,
        },
        {
          prismaClient,
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
      console.error("vendor seller orders list error:", error);
    }
  }

  try {
    const result = await listVendorShopifyOrdersFromLedger(
      {
        storeId,
        shopDomain: accessState.shopDomain,
      },
      {
        prismaClient,
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
  const requestedVendorId = getRequestVendorId(request);
  const currentSessionToken = await vendorAdminSessionCookie.parse(cookieHeader);
  const sessionMap = requestedVendorId
    ? await parseVendorSessionMap(cookieHeader)
    : {};
  const sessionToken = requestedVendorId
    ? sessionMap[requestedVendorId] || currentSessionToken
    : currentSessionToken;

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

  if (
    !vendorSession ||
    vendorSession.expiresAt < new Date() ||
    (requestedVendorId && vendorSession.vendorId !== requestedVendorId)
  ) {
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

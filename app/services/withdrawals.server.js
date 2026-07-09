import crypto from "node:crypto";
import { Resend } from "resend";

import prisma from "../db.server.js";
import {
  formatPublicCountryLabel,
  isEuCountry,
  normalizeCountryCode,
} from "../utils/deliveryEligibility.js";
import { normalizeShopDomain } from "../utils/shopifyAdmin.server.js";
import {
  WITHDRAWAL_ELIGIBILITY_STATUSES,
  WITHDRAWAL_STATUSES,
  getWithdrawalEligibilityLabel,
  getWithdrawalStatusLabel,
} from "../utils/withdrawalStatus.js";

const ONE_HOUR_MS = 60 * 60 * 1000;
const EMAIL_RATE_LIMIT_PER_HOUR = 5;
const IP_RATE_LIMIT_PER_HOUR = 20;
const REFUND_DECISION_STATUSES = new Set([
  "UNDECIDED",
  "FULL_REFUND",
  "PARTIAL_REFUND",
  "NO_REFUND",
  "RETURN_PENDING",
]);
const RETURN_SHIPPING_PAYERS = new Set([
  "UNDECIDED",
  "CUSTOMER",
  "STORE",
  "LEGAL_STORE",
]);
const RETURN_REQUIREMENT_STATUSES = new Set([
  "UNDECIDED",
  "NOT_REQUIRED",
  "REQUIRED",
  "WAITING",
  "IN_TRANSIT",
  "RECEIVED",
  "CONDITION_CHECKED",
]);
const RETURN_CONDITION_STATUSES = new Set([
  "UNDECIDED",
  "NOT_APPLICABLE",
  "UNUSED_OK",
  "OPENED_OK",
  "USED_REVIEW",
  "DIRTY_REVIEW",
  "DAMAGED_REVIEW",
  "EXEMPT_REVIEW",
]);

export function normalizeWithdrawalFormData(formData) {
  const customerName = normalizeText(formData.get("customerName"));
  const customerEmail = normalizeEmail(formData.get("customerEmail"));
  const customerPhone = normalizeText(formData.get("customerPhone"));
  const orderNumber = normalizeOrderNumber(formData.get("orderNumber"));
  const countryCode = normalizeCountryCode(formData.get("countryCode"));
  const countryLabel =
    normalizeText(formData.get("countryLabel")) ||
    formatPublicCountryLabel(countryCode) ||
    countryCode;
  const withdrawalScope =
    String(formData.get("withdrawalScope") || "FULL").toUpperCase() === "PARTIAL"
      ? "PARTIAL"
      : "FULL";
  const itemText = normalizeText(formData.get("itemText"));
  const itemCondition = normalizeText(formData.get("itemCondition"));
  const reason = normalizeText(formData.get("reason"));
  const receivedDate = parseDateInput(formData.get("receivedDate"));

  const selectedLineItems = formData
    .getAll("selectedLineItems")
    .map((value) => normalizeText(value))
    .filter(Boolean);

  const errors = {};

  if (!customerName) errors.customerName = "氏名を入力してください。";
  if (!customerEmail) errors.customerEmail = "メールアドレスを入力してください。";
  if (!orderNumber) errors.orderNumber = "注文番号を入力してください。";
  if (!countryCode) errors.countryCode = "国を選択してください。";
  if (withdrawalScope === "PARTIAL" && !itemText && selectedLineItems.length === 0) {
    errors.itemText = "撤回したい商品を入力してください。";
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    values: {
      customerName,
      customerEmail,
      customerPhone,
      orderNumber,
      countryCode,
      countryLabel,
      receivedDate,
      withdrawalScope,
      itemText,
      itemCondition,
      reason,
      selectedLineItems,
    },
  };
}

export async function createWithdrawalRequestFromForm({
  request,
  formData,
  shopDomain,
  prismaClient = prisma,
} = {}) {
  const normalized = normalizeWithdrawalFormData(formData);

  if (!normalized.ok) {
    return {
      ok: false,
      status: 400,
      errors: normalized.errors,
      values: normalized.values,
    };
  }

  const values = normalized.values;
  const normalizedShopDomain =
    normalizeShopDomain(shopDomain) || getShopDomainFromRequest(request);
  const ipAddress = getClientIp(request);
  const userAgent = request?.headers?.get("user-agent") || null;

  const rateLimitResult = await checkWithdrawalRateLimit({
    prismaClient,
    email: values.customerEmail,
    ipAddress,
  });

  if (!rateLimitResult.ok) {
    return {
      ok: false,
      status: 429,
      errors: {
        form: "短時間に送信できる件数を超えています。時間をおいて再度お試しください。",
      },
      values,
    };
  }

  const orderLookup = await findOrderForWithdrawal({
    prismaClient,
    shopDomain: normalizedShopDomain,
    orderNumber: values.orderNumber,
  });
  const eligibility = evaluateWithdrawalEligibility({
    values,
    orderSnapshot: orderLookup.orderSnapshot,
  });
  const selectedLineItemsJson = buildSelectedLineItemsJson(values, orderLookup);
  const submittedPayloadJson = buildSubmittedPayloadJson(values);
  const idempotencyKey = buildWithdrawalIdempotencyKey({
    shopDomain: normalizedShopDomain,
    orderNumber: values.orderNumber,
    email: values.customerEmail,
    withdrawalScope: values.withdrawalScope,
    itemText: values.itemText,
    selectedLineItems: values.selectedLineItems,
  });

  const existing = await prismaClient.withdrawalRequest.findUnique({
    where: { idempotencyKey },
    include: {
      emailLogs: { orderBy: { createdAt: "desc" }, take: 5 },
      statusHistory: { orderBy: { createdAt: "desc" }, take: 5 },
    },
  });

  if (existing) {
    const hasSentAcknowledgement = existing.emailLogs.some(
      (log) => log.emailType === "acknowledgement" && log.status === "sent",
    );

    if (!hasSentAcknowledgement) {
      await sendWithdrawalAcknowledgementEmail({
        withdrawalRequestId: existing.id,
        prismaClient,
      });
    }

    return {
      ok: true,
      duplicate: true,
      withdrawalRequest: existing,
    };
  }

  const withdrawalRequest = await prismaClient.$transaction(async (tx) => {
    const created = await tx.withdrawalRequest.create({
      data: {
        shopDomain: normalizedShopDomain,
        marketplaceOrderId: orderLookup.marketplaceOrder?.id || null,
        shopifyOrderId: orderLookup.orderSnapshot?.shopifyOrderId || null,
        shopifyOrderName: orderLookup.orderSnapshot?.shopifyOrderName || values.orderNumber,
        shopifyOrderNumber:
          orderLookup.orderSnapshot?.shopifyOrderNumber ||
          values.orderNumber.replace(/^#/, ""),
        customerName: values.customerName,
        customerEmail: values.customerEmail,
        customerPhone: values.customerPhone,
        countryCode: values.countryCode,
        countryLabel: values.countryLabel,
        receivedDate: values.receivedDate,
        withdrawalScope: values.withdrawalScope,
        itemCondition: values.itemCondition,
        reason: values.reason,
        status: WITHDRAWAL_STATUSES.REQUESTED,
        eligibilityStatus: eligibility.status,
        deadlineAt: eligibility.deadlineAt,
        deadlineSource: eligibility.deadlineSource,
        selectedLineItemsJson,
        submittedPayloadJson,
        orderSnapshotJson: orderLookup.orderSnapshot,
        eligibilityJson: serializeEligibilityForJson(eligibility),
        source: "app_proxy",
        ipAddress,
        userAgent,
        idempotencyKey,
      },
    });

    await tx.withdrawalRequestStatusHistory.create({
      data: {
        withdrawalRequestId: created.id,
        fromStatus: null,
        toStatus: WITHDRAWAL_STATUSES.REQUESTED,
        changedBy: "buyer",
        reason: "submitted",
          metadataJson: {
            eligibilityStatus: eligibility.status,
            eligibilityLabel: getWithdrawalEligibilityLabel(eligibility.status),
          },
      },
    });

    return created;
  });

  const emailResult = await sendWithdrawalAcknowledgementEmail({
    withdrawalRequestId: withdrawalRequest.id,
    prismaClient,
  });

  const reloaded = await prismaClient.withdrawalRequest.findUnique({
    where: { id: withdrawalRequest.id },
    include: {
      emailLogs: { orderBy: { createdAt: "desc" }, take: 5 },
      statusHistory: { orderBy: { createdAt: "desc" }, take: 5 },
    },
  });

  return {
    ok: true,
    duplicate: false,
    withdrawalRequest: reloaded || withdrawalRequest,
    emailResult,
  };
}

export async function findOrderForWithdrawal({
  prismaClient = prisma,
  shopDomain,
  orderNumber,
} = {}) {
  const normalizedOrderNumber = normalizeOrderNumber(orderNumber);
  const orderNumberWithoutHash = normalizedOrderNumber.replace(/^#/, "");
  const orderNameWithHash = normalizedOrderNumber.startsWith("#")
    ? normalizedOrderNumber
    : `#${normalizedOrderNumber}`;
  const normalizedShopDomain = normalizeShopDomain(shopDomain);

  const where = {
    OR: [
      { shopifyOrderName: normalizedOrderNumber },
      { shopifyOrderName: orderNameWithHash },
      { shopifyOrderNumber: orderNumberWithoutHash },
      { shopifyOrderId: normalizedOrderNumber },
    ],
  };

  if (normalizedShopDomain) {
    where.shopDomain = normalizedShopDomain;
  }

  const marketplaceOrder = await prismaClient.marketplaceOrder.findFirst({
    where,
    orderBy: { createdAt: "desc" },
  });

  return {
    marketplaceOrder,
    orderSnapshot: marketplaceOrder ? serializeMarketplaceOrder(marketplaceOrder) : null,
  };
}

export function evaluateWithdrawalEligibility({ values, orderSnapshot } = {}) {
  const countryCode =
    normalizeCountryCode(values?.countryCode) ||
    normalizeCountryCode(orderSnapshot?.shippingCountryCode);
  const deadlineSource = values?.receivedDate
    ? "buyer_received_date"
    : orderSnapshot?.processedAt
      ? "order_processed_at"
      : orderSnapshot?.createdAt
        ? "order_created_at"
        : null;
  const baseDate =
    values?.receivedDate ||
    parseDateInput(orderSnapshot?.processedAt) ||
    parseDateInput(orderSnapshot?.createdAt);
  const deadlineAt = baseDate ? addDays(baseDate, 14) : null;
  const now = new Date();
  const warnings = [];

  let status = WITHDRAWAL_ELIGIBILITY_STATUSES.PENDING_REVIEW;

  if (!orderSnapshot) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.ORDER_NOT_FOUND_REVIEW;
    warnings.push("注文を自動照合できませんでした。");
  } else if (
    values?.customerEmail &&
    orderSnapshot.buyerEmail &&
    normalizeEmail(values.customerEmail) !== normalizeEmail(orderSnapshot.buyerEmail)
  ) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.EMAIL_MISMATCH_REVIEW;
    warnings.push("注文メールと入力メールが一致しません。");
  } else if (!isEuCountry(countryCode)) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.NON_EU_REVIEW;
    warnings.push("EU向け撤回権の対象国ではない可能性があります。");
  } else if (deadlineAt && deadlineAt.getTime() < now.getTime()) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.DEADLINE_EXPIRED;
    warnings.push("14日を超過している可能性があります。");
  } else if (!deadlineAt) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.DEADLINE_REVIEW;
    warnings.push("受領日または期限を自動判定できません。");
  } else if (hasValueReductionSignal(values?.itemCondition)) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.VALUE_REDUCTION_REVIEW;
    warnings.push("商品状態により減額確認が必要です。");
  } else {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.ELIGIBLE;
  }

  return {
    status,
    label: getWithdrawalEligibilityLabel(status),
    countryCode,
    isEuCountry: isEuCountry(countryCode),
    deadlineAt,
    deadlineSource,
    orderFound: Boolean(orderSnapshot),
    orderEmailMatched:
      !orderSnapshot?.buyerEmail ||
      normalizeEmail(values?.customerEmail) === normalizeEmail(orderSnapshot.buyerEmail),
    warnings,
    evaluatedAt: new Date().toISOString(),
  };
}

export async function sendWithdrawalAcknowledgementEmail({
  withdrawalRequestId,
  prismaClient = prisma,
} = {}) {
  const withdrawalRequest = await prismaClient.withdrawalRequest.findUnique({
    where: { id: withdrawalRequestId },
  });

  if (!withdrawalRequest) {
    return { ok: false, error: "withdrawal_request_not_found" };
  }

  const email = buildAcknowledgementEmail(withdrawalRequest);
  const result = await sendWithdrawalEmail({
    prismaClient,
    withdrawalRequest,
    emailType: "acknowledgement",
    subject: email.subject,
    bodyText: email.text,
    bodyHtml: email.html,
  });

  if (!result.ok) {
    return result;
  }

  await prismaClient.$transaction(async (tx) => {
    const current = await tx.withdrawalRequest.findUnique({
      where: { id: withdrawalRequest.id },
      select: { status: true },
    });

    await tx.withdrawalRequest.update({
      where: { id: withdrawalRequest.id },
      data: {
        status: WITHDRAWAL_STATUSES.ACKNOWLEDGED,
        confirmationSentAt: result.sentAt,
        confirmationEmailMessageId: result.providerMessageId,
        durableMediumEmailJson: {
          emailType: "acknowledgement",
          toEmail: withdrawalRequest.customerEmail,
          subject: email.subject,
          bodyText: email.text,
          sentAt: result.sentAt?.toISOString?.() || new Date().toISOString(),
          providerMessageId: result.providerMessageId,
        },
      },
    });

    if (current?.status !== WITHDRAWAL_STATUSES.ACKNOWLEDGED) {
      await tx.withdrawalRequestStatusHistory.create({
        data: {
          withdrawalRequestId: withdrawalRequest.id,
          fromStatus: current?.status || WITHDRAWAL_STATUSES.REQUESTED,
          toStatus: WITHDRAWAL_STATUSES.ACKNOWLEDGED,
          changedBy: "system",
          reason: "acknowledgement_email_sent",
        },
      });
    }
  });

  return result;
}

export async function sendWithdrawalStatusEmail({
  withdrawalRequestId,
  emailType = "status_update",
  prismaClient = prisma,
} = {}) {
  const withdrawalRequest = await prismaClient.withdrawalRequest.findUnique({
    where: { id: withdrawalRequestId },
  });

  if (!withdrawalRequest) {
    return { ok: false, error: "withdrawal_request_not_found" };
  }

  const email = buildStatusEmail(withdrawalRequest);

  return sendWithdrawalEmail({
    prismaClient,
    withdrawalRequest,
    emailType,
    subject: email.subject,
    bodyText: email.text,
    bodyHtml: email.html,
  });
}

export async function updateWithdrawalStatus({
  id,
  toStatus,
  changedBy = "admin",
  reason = null,
  metadataJson = null,
  adminNotes = null,
  rejectionReason = null,
  prismaClient = prisma,
} = {}) {
  const nextStatus = String(toStatus || "").trim().toUpperCase();

  if (!Object.values(WITHDRAWAL_STATUSES).includes(nextStatus)) {
    return { ok: false, status: 400, error: "invalid_status" };
  }

  const current = await prismaClient.withdrawalRequest.findUnique({
    where: { id },
  });

  if (!current) {
    return { ok: false, status: 404, error: "not_found" };
  }

  const now = new Date();
  const data = {
    status: nextStatus,
  };

  if (typeof adminNotes === "string") {
    data.adminNotes = adminNotes;
  }

  if (nextStatus === WITHDRAWAL_STATUSES.REJECTED) {
    data.rejectedAt = now;
    data.rejectionReason = rejectionReason || reason || current.rejectionReason;
    data.decisionSentAt = now;
  }

  if (
    nextStatus === WITHDRAWAL_STATUSES.APPROVED ||
    nextStatus === WITHDRAWAL_STATUSES.REFUND_PENDING
  ) {
    data.decisionSentAt = now;
  }

  if (
    nextStatus === WITHDRAWAL_STATUSES.REFUNDED ||
    nextStatus === WITHDRAWAL_STATUSES.CANCELLED
  ) {
    data.completedAt = now;
  }

  const updated = await prismaClient.$transaction(async (tx) => {
    const next = await tx.withdrawalRequest.update({
      where: { id },
      data,
    });

    await tx.withdrawalRequestStatusHistory.create({
      data: {
        withdrawalRequestId: id,
        fromStatus: current.status,
        toStatus: nextStatus,
        changedBy,
        reason,
        metadataJson,
      },
    });

    return next;
  });

  return { ok: true, withdrawalRequest: updated };
}

export function normalizeWithdrawalReturnInfoFormData(formData) {
  const returnRequirementStatus = String(
    formData.get("returnRequirementStatus") || "UNDECIDED",
  )
    .trim()
    .toUpperCase();
  const returnConditionStatus = String(
    formData.get("returnConditionStatus") || "UNDECIDED",
  )
    .trim()
    .toUpperCase();
  const returnTrackingCompany = normalizeText(
    formData.get("returnTrackingCompany"),
  );
  const returnTrackingNumber = normalizeText(
    formData.get("returnTrackingNumber"),
  );
  const returnTrackingUrl = normalizeText(formData.get("returnTrackingUrl"));
  const returnReceivedAt = parseDateInput(formData.get("returnReceivedAt"));
  const returnConditionNotes = normalizeText(
    formData.get("returnConditionNotes"),
  );
  const errors = {};

  if (!RETURN_REQUIREMENT_STATUSES.has(returnRequirementStatus)) {
    errors.returnRequirementStatus = "invalid_return_requirement_status";
  }

  if (!RETURN_CONDITION_STATUSES.has(returnConditionStatus)) {
    errors.returnConditionStatus = "invalid_return_condition_status";
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    values: {
      returnRequirementStatus,
      returnTrackingCompany,
      returnTrackingNumber,
      returnTrackingUrl,
      returnReceivedAt,
      returnConditionStatus,
      returnConditionNotes,
      returnProofJson: buildReturnProofJson({
        returnTrackingCompany,
        returnTrackingNumber,
        returnTrackingUrl,
        returnReceivedAt,
      }),
    },
  };
}

export async function updateWithdrawalReturnInfo({
  id,
  formData,
  changedBy = "admin",
  prismaClient = prisma,
} = {}) {
  const normalized = normalizeWithdrawalReturnInfoFormData(formData);

  if (!normalized.ok) {
    return {
      ok: false,
      status: 400,
      error: "invalid_return_info",
      errors: normalized.errors,
    };
  }

  const current = await prismaClient.withdrawalRequest.findUnique({
    where: { id },
  });

  if (!current) {
    return { ok: false, status: 404, error: "not_found" };
  }

  const values = normalized.values;
  const now = new Date();
  const updated = await prismaClient.$transaction(async (tx) => {
    const next = await tx.withdrawalRequest.update({
      where: { id },
      data: {
        ...values,
        returnInfoUpdatedAt: now,
        returnInfoUpdatedBy: changedBy,
      },
    });

    await tx.withdrawalRequestStatusHistory.create({
      data: {
        withdrawalRequestId: id,
        fromStatus: current.status,
        toStatus: current.status,
        changedBy,
        reason: "return_info_updated",
        metadataJson: {
          returnInfo: values,
        },
      },
    });

    return next;
  });

  return { ok: true, withdrawalRequest: updated };
}

export function normalizeWithdrawalRefundDecisionFormData(formData) {
  const refundDecisionStatus = String(
    formData.get("refundDecisionStatus") || "UNDECIDED",
  )
    .trim()
    .toUpperCase();
  const returnShippingPayer = String(
    formData.get("returnShippingPayer") || "UNDECIDED",
  )
    .trim()
    .toUpperCase();
  const refundItemAmount = parseOptionalNonNegativeInteger(
    formData.get("refundItemAmount"),
  );
  const refundInitialShippingAmount = parseOptionalNonNegativeInteger(
    formData.get("refundInitialShippingAmount"),
  );
  const refundDeductionAmount = parseOptionalNonNegativeInteger(
    formData.get("refundDeductionAmount"),
  );
  const refundCurrencyCode = normalizeCurrencyCode(
    formData.get("refundCurrencyCode"),
  );
  const refundDecisionReason = normalizeText(
    formData.get("refundDecisionReason"),
  );
  const refundDecisionNotes = normalizeText(formData.get("refundDecisionNotes"));
  const errors = {};

  if (!REFUND_DECISION_STATUSES.has(refundDecisionStatus)) {
    errors.refundDecisionStatus = "invalid_refund_decision_status";
  }

  if (!RETURN_SHIPPING_PAYERS.has(returnShippingPayer)) {
    errors.returnShippingPayer = "invalid_return_shipping_payer";
  }

  if (refundItemAmount.invalid) {
    errors.refundItemAmount = "invalid_amount";
  }

  if (refundInitialShippingAmount.invalid) {
    errors.refundInitialShippingAmount = "invalid_amount";
  }

  if (refundDeductionAmount.invalid) {
    errors.refundDeductionAmount = "invalid_amount";
  }

  const itemAmount = refundItemAmount.value;
  const initialShippingAmount = refundInitialShippingAmount.value;
  const deductionAmount = refundDeductionAmount.value;
  const hasAnyAmount =
    itemAmount !== null || initialShippingAmount !== null || deductionAmount !== null;
  let refundTotalAmount = null;

  if (refundDecisionStatus === "NO_REFUND") {
    refundTotalAmount = 0;
  } else if (hasAnyAmount) {
    refundTotalAmount = Math.max(
      0,
      (itemAmount || 0) + (initialShippingAmount || 0) - (deductionAmount || 0),
    );
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    values: {
      refundDecisionStatus,
      refundItemAmount: itemAmount,
      refundInitialShippingAmount: initialShippingAmount,
      refundDeductionAmount: deductionAmount,
      refundTotalAmount,
      refundCurrencyCode,
      returnShippingPayer,
      refundDecisionReason,
      refundDecisionNotes,
    },
  };
}

export async function updateWithdrawalRefundDecision({
  id,
  formData,
  changedBy = "admin",
  prismaClient = prisma,
} = {}) {
  const normalized = normalizeWithdrawalRefundDecisionFormData(formData);

  if (!normalized.ok) {
    return {
      ok: false,
      status: 400,
      error: "invalid_refund_decision",
      errors: normalized.errors,
    };
  }

  const current = await prismaClient.withdrawalRequest.findUnique({
    where: { id },
  });

  if (!current) {
    return { ok: false, status: 404, error: "not_found" };
  }

  const values = normalized.values;
  const now = new Date();
  const updated = await prismaClient.$transaction(async (tx) => {
    const next = await tx.withdrawalRequest.update({
      where: { id },
      data: {
        ...values,
        refundDecisionUpdatedAt: now,
        refundDecisionUpdatedBy: changedBy,
      },
    });

    await tx.withdrawalRequestStatusHistory.create({
      data: {
        withdrawalRequestId: id,
        fromStatus: current.status,
        toStatus: current.status,
        changedBy,
        reason: "refund_decision_updated",
        metadataJson: {
          refundDecision: values,
        },
      },
    });

    return next;
  });

  return { ok: true, withdrawalRequest: updated };
}

export function buildWithdrawalIdempotencyKey({
  shopDomain,
  orderNumber,
  email,
  withdrawalScope,
  itemText,
  selectedLineItems,
} = {}) {
  const source = JSON.stringify({
    shopDomain: normalizeShopDomain(shopDomain) || "",
    orderNumber: normalizeOrderNumber(orderNumber),
    email: normalizeEmail(email),
    withdrawalScope: String(withdrawalScope || "FULL").toUpperCase(),
    itemText: normalizeText(itemText) || "",
    selectedLineItems: Array.isArray(selectedLineItems)
      ? selectedLineItems.map((value) => normalizeText(value)).filter(Boolean).sort()
      : [],
  });

  return crypto.createHash("sha256").update(source).digest("hex");
}

export function getShopDomainFromRequest(request) {
  if (!request?.url) {
    return normalizeShopDomain(
      process.env.SHOPIFY_PRIMARY_SHOP_DOMAIN || process.env.SHOPIFY_SHOP,
    );
  }

  const url = new URL(request.url);

  return normalizeShopDomain(
    url.searchParams.get("shop") ||
      process.env.SHOPIFY_PRIMARY_SHOP_DOMAIN ||
      process.env.SHOPIFY_SHOP,
  );
}

function normalizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeCurrencyCode(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toUpperCase() : null;
}

function parseOptionalNonNegativeInteger(value) {
  const text = String(value ?? "").replace(/,/g, "").trim();

  if (!text) {
    return { value: null, invalid: false };
  }

  if (!/^\d+$/.test(text)) {
    return { value: null, invalid: true };
  }

  const numeric = Number(text);

  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    return { value: null, invalid: true };
  }

  return { value: numeric, invalid: false };
}

function normalizeEmail(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeOrderNumber(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.replace(/\s+/g, "") : null;
}

function parseDateInput(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getClientIp(request) {
  const header =
    request?.headers?.get("x-forwarded-for") ||
    request?.headers?.get("cf-connecting-ip") ||
    request?.headers?.get("x-real-ip") ||
    "";

  return normalizeText(header.split(",")[0]) || null;
}

async function checkWithdrawalRateLimit({ prismaClient, email, ipAddress }) {
  const since = new Date(Date.now() - ONE_HOUR_MS);
  const conditions = [];

  if (email) {
    conditions.push({
      label: "email",
      limit: EMAIL_RATE_LIMIT_PER_HOUR,
      where: {
        customerEmail: email,
        createdAt: { gte: since },
      },
    });
  }

  if (ipAddress) {
    conditions.push({
      label: "ip",
      limit: IP_RATE_LIMIT_PER_HOUR,
      where: {
        ipAddress,
        createdAt: { gte: since },
      },
    });
  }

  for (const condition of conditions) {
    const count = await prismaClient.withdrawalRequest.count({
      where: condition.where,
    });

    if (count >= condition.limit) {
      return { ok: false, reason: `${condition.label}_rate_limited` };
    }
  }

  return { ok: true };
}

function serializeMarketplaceOrder(order) {
  const metadata =
    order.metadataJson && typeof order.metadataJson === "object"
      ? order.metadataJson
      : {};
  const shippingAddress = metadata.shippingAddress || metadata.shipping_address || null;
  const shippingCountryCode =
    shippingAddress?.countryCodeV2 ||
    shippingAddress?.countryCode ||
    shippingAddress?.country_code ||
    metadata.shippingCountryCode ||
    null;

  return {
    marketplaceOrderId: order.id,
    shopDomain: order.shopDomain,
    shopifyOrderId: order.shopifyOrderId,
    shopifyOrderName: order.shopifyOrderName,
    shopifyOrderNumber: order.shopifyOrderNumber,
    buyerEmail: order.buyerEmail,
    buyerName: order.buyerName,
    totalAmount: order.totalAmount,
    subtotalAmount: order.subtotalAmount,
    shippingAmount: order.shippingAmount,
    discountAmount: order.discountAmount,
    taxAmount: order.taxAmount,
    currencyCode: order.currencyCode,
    financialStatus: order.financialStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    createdAt: order.createdAt?.toISOString?.() || null,
    updatedAt: order.updatedAt?.toISOString?.() || null,
    processedAt: order.processedAt?.toISOString?.() || null,
    cancelledAt: order.cancelledAt?.toISOString?.() || null,
    shippingCountryCode,
    shippingAddress,
  };
}

function serializeEligibilityForJson(eligibility) {
  return {
    ...eligibility,
    deadlineAt: eligibility.deadlineAt?.toISOString?.() || null,
  };
}

function buildSubmittedPayloadJson(values) {
  return {
    customerName: values.customerName,
    customerEmail: values.customerEmail,
    customerPhone: values.customerPhone,
    orderNumber: values.orderNumber,
    countryCode: values.countryCode,
    countryLabel: values.countryLabel,
    receivedDate: values.receivedDate?.toISOString?.() || null,
    withdrawalScope: values.withdrawalScope,
    itemText: values.itemText,
    itemCondition: values.itemCondition,
    reason: values.reason,
    selectedLineItems: values.selectedLineItems,
    submittedAt: new Date().toISOString(),
  };
}

function buildSelectedLineItemsJson(values, orderLookup) {
  return {
    scope: values.withdrawalScope,
    freeText: values.itemText,
    selectedLineItems: values.selectedLineItems,
    orderLineItems: orderLookup.orderSnapshot?.lineItems || [],
  };
}

function buildReturnProofJson({
  returnTrackingCompany,
  returnTrackingNumber,
  returnTrackingUrl,
  returnReceivedAt,
}) {
  const hasProof =
    returnTrackingCompany ||
    returnTrackingNumber ||
    returnTrackingUrl ||
    returnReceivedAt;

  if (!hasProof) {
    return null;
  }

  return {
    trackingCompany: returnTrackingCompany,
    trackingNumber: returnTrackingNumber,
    trackingUrl: returnTrackingUrl,
    receivedAt: returnReceivedAt?.toISOString?.() || null,
    recordedAt: new Date().toISOString(),
  };
}

function hasValueReductionSignal(itemCondition) {
  const text = String(itemCondition || "").toLowerCase();
  return [
    "破損",
    "汚",
    "使用",
    "開封済",
    "damaged",
    "dirty",
    "used",
    "opened",
  ].some((keyword) => text.includes(keyword));
}

function getWithdrawalFromEmail() {
  return (
    process.env.WITHDRAWAL_FROM_EMAIL ||
    process.env.MAIL_FROM ||
    process.env.ADMIN_EMAIL ||
    null
  );
}

function getWithdrawalSupportEmail() {
  return (
    process.env.WITHDRAWAL_SUPPORT_EMAIL ||
    process.env.ADMIN_EMAIL ||
    process.env.MAIL_FROM ||
    null
  );
}

async function sendWithdrawalEmail({
  prismaClient,
  withdrawalRequest,
  emailType,
  subject,
  bodyText,
  bodyHtml,
}) {
  const fromEmail = getWithdrawalFromEmail();
  const sentAt = new Date();

  if (!process.env.RESEND_API_KEY || !fromEmail) {
    await prismaClient.withdrawalEmailLog.create({
      data: {
        withdrawalRequestId: withdrawalRequest.id,
        emailType,
        toEmail: withdrawalRequest.customerEmail,
        fromEmail,
        subject,
        bodyText,
        bodyHtml,
        status: "failed",
        errorMessage: "RESEND_API_KEY or sender email is not configured.",
      },
    });

    return {
      ok: false,
      error: "email_not_configured",
    };
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const response = await resend.emails.send({
      from: fromEmail,
      to: withdrawalRequest.customerEmail,
      subject,
      text: bodyText,
      html: bodyHtml,
    });
    const providerMessageId =
      response?.data?.id || response?.id || response?.messageId || null;

    await prismaClient.withdrawalEmailLog.create({
      data: {
        withdrawalRequestId: withdrawalRequest.id,
        emailType,
        toEmail: withdrawalRequest.customerEmail,
        fromEmail,
        subject,
        bodyText,
        bodyHtml,
        providerMessageId,
        status: "sent",
        sentAt,
      },
    });

    return {
      ok: true,
      providerMessageId,
      sentAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await prismaClient.withdrawalEmailLog.create({
      data: {
        withdrawalRequestId: withdrawalRequest.id,
        emailType,
        toEmail: withdrawalRequest.customerEmail,
        fromEmail,
        subject,
        bodyText,
        bodyHtml,
        status: "failed",
        errorMessage: message,
      },
    });

    return {
      ok: false,
      error: message,
    };
  }
}

function buildAcknowledgementEmail(withdrawalRequest) {
  const supportEmail = getWithdrawalSupportEmail();
  const subject = "撤回申請を受け付けました";
  const bodyLines = [
    `${withdrawalRequest.customerName} 様`,
    "",
    "撤回申請を受け付けました。",
    "内容を確認のうえ、今後の手続きをメールでご案内します。",
    "",
    `受付番号: ${withdrawalRequest.id}`,
    `注文番号: ${withdrawalRequest.shopifyOrderName || withdrawalRequest.shopifyOrderNumber || "-"}`,
    `撤回対象: ${withdrawalRequest.withdrawalScope === "PARTIAL" ? "一部商品" : "注文全体"}`,
    `受付日時: ${formatDateTime(new Date())}`,
    "",
    "商品が発送済みの場合、返送または返送証明の確認後に返金処理を行う場合があります。",
    "商品の確認に必要な範囲を超えて使用、汚損、破損された場合、返金額が減額される場合があります。",
    "撤回が認められる場合、商品代金および通常配送方法に相当する初回送料を返金対象として確認します。",
    "通常配送より高い配送方法を選択された場合、その追加費用は返金対象外となる場合があります。",
    "商品の返送にかかる送料は、当店が別途負担すると案内した場合、または法令により当店負担となる場合を除き、お客様負担となる場合があります。",
    "",
    supportEmail ? `お問い合わせ: ${supportEmail}` : "",
  ].filter((line) => line !== "");
  const text = bodyLines.join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;line-height:1.8;color:#111">${bodyLines
    .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<br>"))
    .join("")}</div>`;

  return { subject, text, html };
}

function buildStatusEmail(withdrawalRequest) {
  const statusLabel = getWithdrawalStatusLabel(withdrawalRequest.status);
  const subject = `撤回申請の状況: ${statusLabel}`;
  const statusMessage = getStatusCustomerMessage(withdrawalRequest.status);
  const bodyLines = [
    `${withdrawalRequest.customerName} 様`,
    "",
    `撤回申請の状況が「${statusLabel}」に更新されました。`,
    statusMessage,
    "",
    `受付番号: ${withdrawalRequest.id}`,
    `注文番号: ${withdrawalRequest.shopifyOrderName || withdrawalRequest.shopifyOrderNumber || "-"}`,
    "",
    getWithdrawalSupportEmail()
      ? `お問い合わせ: ${getWithdrawalSupportEmail()}`
      : "",
  ].filter((line) => line !== "");
  const text = bodyLines.join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;line-height:1.8;color:#111">${bodyLines
    .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<br>"))
    .join("")}</div>`;

  return { subject, text, html };
}

function getStatusCustomerMessage(status) {
  switch (status) {
    case WITHDRAWAL_STATUSES.UNDER_REVIEW:
      return "注文内容、返送状況、商品状態を確認しています。確認が終わり次第、次の手続きをご案内します。";
    case WITHDRAWAL_STATUSES.APPROVED:
      return "撤回申請を確認しました。返送や返金に必要な手続きがある場合は、続けてご案内します。";
    case WITHDRAWAL_STATUSES.RETURN_REQUESTED:
      return "商品の返送または返送証明の確認が必要です。返送方法についての案内をご確認ください。";
    case WITHDRAWAL_STATUSES.RETURN_RECEIVED:
      return "返送品または返送証明を確認しました。商品状態を確認したうえで返金手続きへ進みます。";
    case WITHDRAWAL_STATUSES.REFUND_PENDING:
      return "返金手続きの準備中です。返金額と処理状況を確認しています。";
    case WITHDRAWAL_STATUSES.REFUNDED:
      return "返金処理が完了しました。反映時期は決済方法やカード会社により異なる場合があります。";
    case WITHDRAWAL_STATUSES.CANCELLED:
      return "対象注文のキャンセル処理が完了しました。";
    case WITHDRAWAL_STATUSES.REJECTED:
      return "確認の結果、今回の申請は撤回対象外として処理されました。詳細は別途ご案内内容をご確認ください。";
    case WITHDRAWAL_STATUSES.EXPIRED:
      return "確認の結果、申請期限を過ぎている可能性があるため、期限切れとして処理されました。";
    case WITHDRAWAL_STATUSES.ERROR:
      return "確認が必要な状態です。内容を確認のうえ、必要に応じてご連絡します。";
    case WITHDRAWAL_STATUSES.ACKNOWLEDGED:
    case WITHDRAWAL_STATUSES.REQUESTED:
    default:
      return "申請内容を確認しています。確認が終わり次第、次の手続きをご案内します。";
  }
}

function formatDateTime(value) {
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Tokyo",
    }).format(value);
  } catch (_error) {
    return value?.toISOString?.() || String(value);
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

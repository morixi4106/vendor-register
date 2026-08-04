import crypto from "node:crypto";
import { Resend } from "resend";
import prisma from "../../db.server.js";
import { isEuCountry, normalizeCountryCode } from "../../utils/deliveryEligibility.js";
import { normalizeShopDomain, shopifyGraphQLWithOfflineSession } from "../../utils/shopifyAdmin.server.js";
import { WITHDRAWAL_ELIGIBILITY_STATUSES, WITHDRAWAL_STATUSES, getWithdrawalEligibilityLabel } from "../../utils/withdrawalStatus.js";
import { buildWithdrawalAcknowledgementSnapshot } from "../withdrawalEmailTemplates.js";
import { holdWithdrawalEmailSnapshot } from "../withdrawalEmailOutbox.server.js";
import { EMAIL_MESSAGE_CLASS, getEmailClassHoldStatus } from "../operationalReadiness.server.js";
export const RETURN_PROOF_TOKEN_BYTES = 32;
export const RETURN_PROOF_TOKEN_TTL_DAYS = 45;
export const URL_PATTERN = /^https?:\/\//i;
export const ZERO_DECIMAL_CURRENCIES = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
export const TERMINAL_WITHDRAWAL_STATUSES = new Set([WITHDRAWAL_STATUSES.REFUNDED, WITHDRAWAL_STATUSES.CANCELLED, WITHDRAWAL_STATUSES.REJECTED, WITHDRAWAL_STATUSES.EXPIRED]);
export const WITHDRAWAL_IDENTITY_REVIEW_STATUSES = new Set([WITHDRAWAL_ELIGIBILITY_STATUSES.ORDER_NOT_FOUND_REVIEW, WITHDRAWAL_ELIGIBILITY_STATUSES.EMAIL_MISMATCH_REVIEW]);
export const ALLOWED_WITHDRAWAL_STATUS_TRANSITIONS = {
  [WITHDRAWAL_STATUSES.REQUESTED]: new Set([WITHDRAWAL_STATUSES.ACKNOWLEDGED, WITHDRAWAL_STATUSES.UNDER_REVIEW, WITHDRAWAL_STATUSES.APPROVED, WITHDRAWAL_STATUSES.RETURN_REQUESTED, WITHDRAWAL_STATUSES.REFUNDED, WITHDRAWAL_STATUSES.CANCELLED, WITHDRAWAL_STATUSES.REJECTED, WITHDRAWAL_STATUSES.EXPIRED, WITHDRAWAL_STATUSES.ERROR]),
  [WITHDRAWAL_STATUSES.ACKNOWLEDGED]: new Set([WITHDRAWAL_STATUSES.UNDER_REVIEW, WITHDRAWAL_STATUSES.APPROVED, WITHDRAWAL_STATUSES.RETURN_REQUESTED, WITHDRAWAL_STATUSES.RETURN_RECEIVED, WITHDRAWAL_STATUSES.REFUND_PENDING, WITHDRAWAL_STATUSES.REFUNDED, WITHDRAWAL_STATUSES.CANCELLED, WITHDRAWAL_STATUSES.REJECTED, WITHDRAWAL_STATUSES.EXPIRED, WITHDRAWAL_STATUSES.ERROR]),
  [WITHDRAWAL_STATUSES.UNDER_REVIEW]: new Set([WITHDRAWAL_STATUSES.APPROVED, WITHDRAWAL_STATUSES.RETURN_REQUESTED, WITHDRAWAL_STATUSES.RETURN_RECEIVED, WITHDRAWAL_STATUSES.REFUND_PENDING, WITHDRAWAL_STATUSES.REFUNDED, WITHDRAWAL_STATUSES.CANCELLED, WITHDRAWAL_STATUSES.REJECTED, WITHDRAWAL_STATUSES.EXPIRED, WITHDRAWAL_STATUSES.ERROR]),
  [WITHDRAWAL_STATUSES.APPROVED]: new Set([WITHDRAWAL_STATUSES.RETURN_REQUESTED, WITHDRAWAL_STATUSES.RETURN_RECEIVED, WITHDRAWAL_STATUSES.REFUND_PENDING, WITHDRAWAL_STATUSES.REFUNDED, WITHDRAWAL_STATUSES.CANCELLED, WITHDRAWAL_STATUSES.REJECTED, WITHDRAWAL_STATUSES.ERROR]),
  [WITHDRAWAL_STATUSES.RETURN_REQUESTED]: new Set([WITHDRAWAL_STATUSES.RETURN_RECEIVED, WITHDRAWAL_STATUSES.REFUND_PENDING, WITHDRAWAL_STATUSES.REFUNDED, WITHDRAWAL_STATUSES.REJECTED, WITHDRAWAL_STATUSES.ERROR]),
  [WITHDRAWAL_STATUSES.RETURN_RECEIVED]: new Set([WITHDRAWAL_STATUSES.REFUND_PENDING, WITHDRAWAL_STATUSES.REFUNDED, WITHDRAWAL_STATUSES.REJECTED, WITHDRAWAL_STATUSES.ERROR]),
  [WITHDRAWAL_STATUSES.REFUND_PENDING]: new Set([WITHDRAWAL_STATUSES.REFUNDED, WITHDRAWAL_STATUSES.CANCELLED, WITHDRAWAL_STATUSES.REJECTED, WITHDRAWAL_STATUSES.ERROR]),
  [WITHDRAWAL_STATUSES.ERROR]: new Set([WITHDRAWAL_STATUSES.UNDER_REVIEW, WITHDRAWAL_STATUSES.REJECTED, WITHDRAWAL_STATUSES.EXPIRED])
};
export const WITHDRAWAL_ORDER_LOOKUP_QUERY = `#graphql
  query WithdrawalOrderLookup($query: String!) {
    orders(first: 5, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        email
        createdAt
        processedAt
        cancelledAt
        displayFinancialStatus
        displayFulfillmentStatus
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        currentTotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        totalRefundedSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        shippingAddress {
          name
          address1
          address2
          city
          province
          provinceCode
          zip
          country
          countryCodeV2
          phone
        }
        lineItems(first: 100) {
          nodes {
            id
            title
            name
            quantity
            sku
            vendor
            product {
              id
              title
              productType
              vendor
            }
            variant {
              id
              title
              sku
            }
            originalTotalSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            discountedTotalSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
        }
      }
    }
  }
`;
export function isWithdrawalIdentityReviewStatus(status) {
  return WITHDRAWAL_IDENTITY_REVIEW_STATUSES.has(String(status || ""));
}
export async function findOrderForWithdrawal({
  prismaClient = prisma,
  shopDomain,
  orderNumber,
  customerEmail = null,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession
} = {}) {
  const normalizedOrderNumber = normalizeOrderNumber(orderNumber);
  const orderNumberWithoutHash = normalizedOrderNumber.replace(/^#/, "");
  const orderNameWithHash = normalizedOrderNumber.startsWith("#") ? normalizedOrderNumber : `#${normalizedOrderNumber}`;
  const normalizedShopDomain = normalizeShopDomain(shopDomain);
  const where = {
    OR: [{
      shopifyOrderName: normalizedOrderNumber
    }, {
      shopifyOrderName: orderNameWithHash
    }, {
      shopifyOrderNumber: orderNumberWithoutHash
    }, {
      shopifyOrderId: normalizedOrderNumber
    }]
  };
  if (normalizedShopDomain) {
    where.shopDomain = normalizedShopDomain;
  }
  const marketplaceOrder = await prismaClient.marketplaceOrder.findFirst({
    where,
    orderBy: {
      createdAt: "desc"
    }
  });
  if (!marketplaceOrder && normalizedShopDomain) {
    const shopifyOrderSnapshot = await findShopifyOrderSnapshotForWithdrawal({
      shopDomain: normalizedShopDomain,
      orderNumber: normalizedOrderNumber,
      customerEmail,
      shopifyGraphQLWithOfflineSessionImpl
    });
    if (shopifyOrderSnapshot) {
      return {
        marketplaceOrder: null,
        orderSnapshot: shopifyOrderSnapshot,
        source: "shopify_admin"
      };
    }
  }
  return {
    marketplaceOrder,
    orderSnapshot: marketplaceOrder ? serializeMarketplaceOrder(marketplaceOrder) : null,
    source: marketplaceOrder ? "marketplace_order" : "not_found"
  };
}
export async function findShopifyOrderSnapshotForWithdrawal({
  shopDomain,
  orderNumber,
  customerEmail,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession
} = {}) {
  const normalizedShopDomain = normalizeShopDomain(shopDomain);
  const normalizedOrderNumber = normalizeOrderNumber(orderNumber);
  if (!normalizedShopDomain || !normalizedOrderNumber) {
    return null;
  }
  const queryParts = [`name:${escapeShopifySearchValue(normalizedOrderNumber.startsWith("#") ? normalizedOrderNumber : `#${normalizedOrderNumber}`)}`];
  const normalizedEmail = normalizeEmail(customerEmail);
  if (normalizedEmail) {
    queryParts.push(`email:${escapeShopifySearchValue(normalizedEmail)}`);
  }
  try {
    const {
      data
    } = await shopifyGraphQLWithOfflineSessionImpl({
      shopDomain: normalizedShopDomain,
      query: WITHDRAWAL_ORDER_LOOKUP_QUERY,
      variables: {
        query: queryParts.join(" ")
      }
    });
    const orders = Array.isArray(data?.orders?.nodes) ? data.orders.nodes : [];
    const order = orders.find(candidate => normalizedEmail ? normalizeEmail(candidate?.email) === normalizedEmail : true) || null;
    return order ? serializeShopifyOrderSnapshot(order, normalizedShopDomain) : null;
  } catch (error) {
    console.warn("withdrawal Shopify order lookup failed", {
      shopDomain: normalizedShopDomain,
      orderNumber: normalizedOrderNumber,
      error: sanitizeShopifyLiveStatusError(error)
    });
    return null;
  }
}
export function evaluateWithdrawalEligibility(options = {}) {
  return evaluateWithdrawalEligibilityV3(options);
}
export function evaluateWithdrawalEligibilityV3({
  values,
  orderSnapshot
} = {}) {
  const countryCode = normalizeCountryCode(values?.countryCode) || normalizeCountryCode(orderSnapshot?.shippingCountryCode);
  const buyerReceivedDate = parseDateInput(values?.receivedDate);
  const confirmedDeliveredDate = parseDateInput(orderSnapshot?.deliveredAt || orderSnapshot?.delivered_at || orderSnapshot?.deliveryConfirmedAt || orderSnapshot?.delivery_confirmed_at);
  const baseDate = buyerReceivedDate || confirmedDeliveredDate;
  const deadlineSource = buyerReceivedDate ? "buyer_received_date" : confirmedDeliveredDate ? "delivery_confirmed_at" : null;
  const deadlineAt = baseDate ? getWithdrawalDeadlineAt(baseDate) : null;
  const warnings = [];
  let status = WITHDRAWAL_ELIGIBILITY_STATUSES.PENDING_REVIEW;
  const orderStateReview = getOrderStateReview(orderSnapshot);
  if (!orderSnapshot) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.ORDER_NOT_FOUND_REVIEW;
    warnings.push("注文を自動照合できませんでした。管理画面で確認してください。");
  } else if (values?.customerEmail && orderSnapshot.buyerEmail && normalizeEmail(values.customerEmail) !== normalizeEmail(orderSnapshot.buyerEmail)) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.EMAIL_MISMATCH_REVIEW;
    warnings.push("注文メールと入力メールが一致しません。本人確認が必要です。");
  } else if (!isEuCountry(countryCode)) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.NON_EU_REVIEW;
    warnings.push("EU向け撤回権の対象国ではない可能性があります。");
  } else if (buyerReceivedDate && isFutureDate(buyerReceivedDate)) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.DEADLINE_REVIEW;
    warnings.push("受取日が未来の日付になっているため確認が必要です。");
  } else if (deadlineAt && deadlineAt.getTime() < Date.now()) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.DEADLINE_EXPIRED;
    warnings.push("商品受取日から14日を超えている可能性があります。");
  } else if (!deadlineAt) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.DEADLINE_REVIEW;
    warnings.push("商品受取日を確認できないため、14日以内か手動確認が必要です。");
  } else if (orderStateReview) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.PENDING_REVIEW;
    warnings.push(orderStateReview);
  } else if (hasWithdrawalExemptionSignal(values, orderSnapshot)) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.EXEMPTION_REVIEW;
    warnings.push("対象外商品に該当する可能性があります。商品内容と事前表示を確認してください。");
  } else if (hasValueReductionSignal(values?.itemCondition)) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.VALUE_REDUCTION_REVIEW;
    warnings.push("商品の状態により返金額の確認が必要です。");
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
    orderEmailMatched: !orderSnapshot?.buyerEmail || normalizeEmail(values?.customerEmail) === normalizeEmail(orderSnapshot.buyerEmail),
    warnings,
    evaluatedAt: new Date().toISOString()
  };
}
export async function sendWithdrawalAcknowledgementEmail({
  withdrawalRequestId,
  prismaClient = prisma
} = {}) {
  const withdrawalRequest = await prismaClient.withdrawalRequest.findUnique({
    where: {
      id: withdrawalRequestId
    }
  });
  if (!withdrawalRequest) {
    return {
      ok: false,
      error: "withdrawal_request_not_found"
    };
  }
  const email = buildWithdrawalAcknowledgementSnapshot(withdrawalRequest);
  const result = await sendWithdrawalEmail({
    prismaClient,
    withdrawalRequest,
    emailType: "acknowledgement",
    subject: email.subject,
    bodyText: email.text,
    bodyHtml: email.html
  });
  if (!result.ok) {
    return result;
  }
  await prismaClient.$transaction(async tx => {
    const current = await tx.withdrawalRequest.findUnique({
      where: {
        id: withdrawalRequest.id
      },
      select: {
        status: true
      }
    });
    await tx.withdrawalRequest.update({
      where: {
        id: withdrawalRequest.id
      },
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
          providerMessageId: result.providerMessageId
        }
      }
    });
    if (current?.status !== WITHDRAWAL_STATUSES.ACKNOWLEDGED) {
      await tx.withdrawalRequestStatusHistory.create({
        data: {
          withdrawalRequestId: withdrawalRequest.id,
          fromStatus: current?.status || WITHDRAWAL_STATUSES.REQUESTED,
          toStatus: WITHDRAWAL_STATUSES.ACKNOWLEDGED,
          changedBy: "system",
          reason: "acknowledgement_email_sent"
        }
      });
    }
  });
  return result;
}
export async function sendWithdrawalVendorNotificationEmails({
  withdrawalRequestId,
  prismaClient = prisma
} = {}) {
  const withdrawalRequest = await prismaClient.withdrawalRequest.findUnique({
    where: {
      id: withdrawalRequestId
    }
  });
  if (!withdrawalRequest) {
    return {
      ok: false,
      error: "withdrawal_request_not_found"
    };
  }
  const recipients = await resolveWithdrawalVendorNotificationRecipients({
    withdrawalRequest,
    prismaClient
  });
  if (recipients.length === 0) {
    return {
      ok: true,
      skipped: true,
      sentCount: 0,
      failedCount: 0,
      results: []
    };
  }
  const results = [];
  for (const recipient of recipients) {
    const existingSentLog = prismaClient.withdrawalEmailLog?.findFirst ? await prismaClient.withdrawalEmailLog.findFirst({
      where: {
        withdrawalRequestId: withdrawalRequest.id,
        emailType: "vendor_notification",
        toEmail: recipient.email,
        status: "sent"
      },
      orderBy: {
        createdAt: "desc"
      }
    }) : null;
    if (existingSentLog) {
      results.push({
        ok: true,
        skipped: true,
        recipient,
        reason: "already_sent"
      });
      continue;
    }
    const email = buildVendorNotificationEmail({
      withdrawalRequest,
      recipient
    });
    const result = await sendWithdrawalEmail({
      prismaClient,
      withdrawalRequest,
      emailType: "vendor_notification",
      subject: email.subject,
      bodyText: email.text,
      bodyHtml: email.html,
      toEmail: recipient.email
    });
    results.push({
      ...result,
      recipient
    });
  }
  const sentCount = results.filter(result => result.ok && !result.skipped).length;
  const skippedCount = results.filter(result => result.skipped).length;
  const failedCount = results.filter(result => !result.ok).length;
  return {
    ok: failedCount === 0,
    sentCount,
    skippedCount,
    failedCount,
    results
  };
}
export async function ensureWithdrawalReturnProofToken({
  withdrawalRequestId,
  request = null,
  prismaClient = prisma
} = {}) {
  const withdrawalRequest = await prismaClient.withdrawalRequest.findUnique({
    where: {
      id: withdrawalRequestId
    }
  });
  if (!withdrawalRequest) {
    return {
      ok: false,
      status: 404,
      error: "withdrawal_request_not_found"
    };
  }
  const token = crypto.randomBytes(RETURN_PROOF_TOKEN_BYTES).toString("base64url");
  const expiresAt = addDays(new Date(), RETURN_PROOF_TOKEN_TTL_DAYS);
  const tokenHash = hashReturnProofToken(token);
  const updated = await prismaClient.withdrawalRequest.update({
    where: {
      id: withdrawalRequest.id
    },
    data: {
      returnProofTokenHash: tokenHash,
      returnProofTokenExpiresAt: expiresAt
    }
  });
  return {
    ok: true,
    withdrawalRequest: updated,
    token,
    expiresAt,
    url: buildReturnProofUrl({
      request,
      withdrawalRequestId: withdrawalRequest.id,
      token
    })
  };
}
export function isAllowedWithdrawalStatusTransition(fromStatus, toStatus) {
  const from = String(fromStatus || "").trim().toUpperCase();
  const to = String(toStatus || "").trim().toUpperCase();
  if (!from || from === to) {
    return true;
  }
  if (TERMINAL_WITHDRAWAL_STATUSES.has(from)) {
    return false;
  }
  const allowed = ALLOWED_WITHDRAWAL_STATUS_TRANSITIONS[from];
  return allowed ? allowed.has(to) : true;
}
export function hashReturnProofToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}
export function buildReturnProofUrl({
  request,
  withdrawalRequestId,
  token
}) {
  const baseUrl = process.env.WITHDRAWAL_PUBLIC_BASE_URL || process.env.APP_URL || (request?.url ? new URL(request.url).origin : "http://localhost:3000");
  const url = new URL("/apps/vendors/withdrawal/return-proof", baseUrl);
  url.searchParams.set("request", withdrawalRequestId);
  url.searchParams.set("token", token);
  return url.toString();
}
export function normalizeText(value, maxLength = null) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  const limit = Number(maxLength);
  return Number.isSafeInteger(limit) && limit > 0 ? normalized.slice(0, limit) : normalized;
}
export function normalizeCurrencyCode(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toUpperCase() : null;
}
export function parseOptionalMoneyAmount(value, currencyCode) {
  const text = String(value ?? "").replace(/,/g, "").trim();
  if (!text) {
    return {
      value: null,
      invalid: false
    };
  }
  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    return {
      value: null,
      invalid: true
    };
  }
  const digits = getCurrencyMinorUnitDigits(currencyCode);
  const [wholePart, decimalPart = ""] = text.split(".");
  if (decimalPart.length > digits) {
    return {
      value: null,
      invalid: true
    };
  }
  if (digits === 0 && decimalPart && Number(decimalPart) !== 0) {
    return {
      value: null,
      invalid: true
    };
  }
  const whole = Number(wholePart);
  if (!Number.isSafeInteger(whole) || whole < 0) {
    return {
      value: null,
      invalid: true
    };
  }
  const multiplier = 10 ** digits;
  const paddedDecimal = digits ? decimalPart.padEnd(digits, "0").slice(0, digits) : "";
  const decimal = paddedDecimal ? Number(paddedDecimal) : 0;
  const amount = whole * multiplier + decimal;
  if (!Number.isSafeInteger(amount) || amount < 0) {
    return {
      value: null,
      invalid: true
    };
  }
  return {
    value: amount,
    invalid: false
  };
}
export function getCurrencyMinorUnitDigits(currencyCode) {
  const normalized = String(currencyCode || "JPY").trim().toUpperCase();
  return ZERO_DECIMAL_CURRENCIES.has(normalized) ? 0 : 2;
}
export function normalizeEmail(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toLowerCase() : null;
}
export function normalizeOrderNumber(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.replace(/\s+/g, "") : null;
}
export function parseDateInput(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
export function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}
export function isFutureDate(value) {
  const date = parseDateInput(value);
  if (!date) return false;
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  return date.getTime() > today.getTime();
}
export function getWithdrawalDeadlineAt(baseDate) {
  const deadline = addDays(baseDate, 14);
  deadline.setHours(23, 59, 59, 999);
  while (deadline.getDay() === 0 || deadline.getDay() === 6) {
    deadline.setDate(deadline.getDate() + 1);
    deadline.setHours(23, 59, 59, 999);
  }
  return deadline;
}
export function getClientIp(request) {
  const header = request?.headers?.get("x-forwarded-for") || request?.headers?.get("cf-connecting-ip") || request?.headers?.get("x-real-ip") || "";
  return normalizeText(header.split(",")[0]) || null;
}
export function serializeMarketplaceOrder(order) {
  const metadata = order.metadataJson && typeof order.metadataJson === "object" ? order.metadataJson : {};
  const shippingAddress = metadata.shippingAddress || metadata.shipping_address || null;
  const lineItems = getJsonArray(metadata.lineItems).length > 0 ? getJsonArray(metadata.lineItems) : getJsonArray(metadata.line_items);
  const shippingCountryCode = shippingAddress?.countryCodeV2 || shippingAddress?.countryCode || shippingAddress?.country_code || metadata.shippingCountryCode || null;
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
    lineItems
  };
}
export function serializeShopifyOrderSnapshot(order, shopDomain) {
  const totalPrice = serializeShopifyMoneySetAsMinorUnits(order.totalPriceSet);
  const currentTotalPrice = serializeShopifyMoneySetAsMinorUnits(order.currentTotalPriceSet);
  const totalRefunded = serializeShopifyMoneySetAsMinorUnits(order.totalRefundedSet);
  const currencyCode = currentTotalPrice.currencyCode || totalPrice.currencyCode || totalRefunded.currencyCode || "JPY";
  const shippingAddress = order.shippingAddress || null;
  return {
    marketplaceOrderId: null,
    source: "shopify_admin",
    shopDomain,
    shopifyOrderId: order.id,
    shopifyOrderName: order.name,
    shopifyOrderNumber: String(order.name || "").replace(/^#/, "") || null,
    buyerEmail: order.email || null,
    buyerName: shippingAddress?.name || null,
    totalAmount: currentTotalPrice.amount ?? totalPrice.amount,
    subtotalAmount: null,
    shippingAmount: null,
    discountAmount: null,
    taxAmount: null,
    currencyCode,
    financialStatus: order.displayFinancialStatus || null,
    fulfillmentStatus: order.displayFulfillmentStatus || null,
    totalRefundedAmount: totalRefunded.amount,
    currentTotalAmount: currentTotalPrice.amount,
    createdAt: order.createdAt || null,
    updatedAt: null,
    processedAt: order.processedAt || null,
    cancelledAt: order.cancelledAt || null,
    shippingCountryCode: shippingAddress?.countryCodeV2 || shippingAddress?.countryCode || shippingAddress?.country_code || null,
    shippingAddress,
    lineItems: getJsonArray(order.lineItems?.nodes).map(line => serializeShopifyOrderLineSnapshot(line, currencyCode))
  };
}
export function serializeShopifyOrderLineSnapshot(line, fallbackCurrencyCode) {
  const originalTotal = serializeShopifyMoneySetAsMinorUnits(line?.originalTotalSet, fallbackCurrencyCode);
  const discountedTotal = serializeShopifyMoneySetAsMinorUnits(line?.discountedTotalSet, fallbackCurrencyCode);
  return {
    id: line?.id || null,
    shopifyLineItemId: line?.id || null,
    shopifyProductId: line?.product?.id || null,
    shopifyVariantId: line?.variant?.id || null,
    title: line?.title || line?.name || null,
    name: line?.name || line?.title || null,
    quantity: Number(line?.quantity || 1),
    sku: line?.sku || line?.variant?.sku || null,
    vendor: line?.vendor || line?.product?.vendor || null,
    productType: line?.product?.productType || null,
    originalTotalAmount: originalTotal.amount,
    discountedTotalAmount: discountedTotal.amount,
    currencyCode: discountedTotal.currencyCode || originalTotal.currencyCode || fallbackCurrencyCode || "JPY"
  };
}
export function serializeShopifyMoneySetAsMinorUnits(value, fallbackCurrencyCode = "JPY") {
  const money = value?.shopMoney || value?.presentmentMoney || null;
  const currencyCode = money?.currencyCode || fallbackCurrencyCode || "JPY";
  const amount = Number(money?.amount);
  if (!Number.isFinite(amount)) {
    return {
      amount: null,
      currencyCode
    };
  }
  const multiplier = 10 ** getCurrencyMinorUnitDigits(currencyCode);
  const minorUnits = Math.round(amount * multiplier);
  return {
    amount: Number.isSafeInteger(minorUnits) ? minorUnits : null,
    currencyCode
  };
}
export function escapeShopifySearchValue(value) {
  const raw = normalizeText(value) || "";
  return `"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
export function sanitizeShopifyLiveStatusError(error) {
  const raw = error instanceof Error ? error.message : String(error || "");
  if (!raw) return "shopify_live_status_failed";
  if (raw.includes("Offline session not found")) return "offline_session_not_found";
  if (raw.includes("authentication failed")) return "shopify_authentication_failed";
  if (raw.includes("Shopify GraphQL errors")) return "shopify_graphql_error";
  return raw.slice(0, 180);
}
export function hasValueReductionSignal(itemCondition) {
  const text = String(itemCondition || "").toLowerCase();
  return ["破損", "汚れ", "汚損", "使用", "使用済み", "開封", "開封済み", "破損", "汚れ", "汚損", "使用", "使用済み", "開封", "開封済み", "damaged", "dirty", "used", "opened", "破損", "汚れ", "汚損", "使用", "使用済み", "着用", "開封", "開封済み", "傷", "欠品"].some(keyword => text.includes(keyword));
}
export function getOrderStateReview(orderSnapshot) {
  if (!orderSnapshot) return null;
  const financialStatus = String(orderSnapshot.financialStatus || "").trim().toUpperCase();
  const fulfillmentStatus = String(orderSnapshot.fulfillmentStatus || "").trim().toUpperCase();
  const totalRefundedAmount = Number(orderSnapshot.totalRefundedAmount || 0);
  const currentTotalAmount = Number(orderSnapshot.currentTotalAmount ?? NaN);
  if (orderSnapshot.cancelledAt || financialStatus.includes("VOIDED")) {
    return "注文がすでにキャンセル済みの可能性があります。撤回申請として扱うか確認してください。";
  }
  if (financialStatus.includes("REFUNDED") || totalRefundedAmount > 0 || currentTotalAmount === 0) {
    return "注文がすでに全額または一部返金済みの可能性があります。二重返金にならないよう確認してください。";
  }
  if (fulfillmentStatus.includes("UNFULFILLED")) {
    return null;
  }
  return null;
}
export function hasWithdrawalExemptionSignal(values, orderSnapshot) {
  const selectedValues = new Set([...getJsonArray(values?.selectedLineItems), values?.itemText, values?.itemCondition, values?.reason].map(value => normalizeText(value)).filter(Boolean));
  const lines = getJsonArray(orderSnapshot?.lineItems);
  const lineText = lines.filter(line => {
    if (selectedValues.size === 0) return true;
    const candidates = [line.id, line.shopifyLineItemId, line.shopifyProductId, line.shopifyVariantId, line.productId, line.title, line.name].map(value => normalizeText(value)).filter(Boolean);
    return candidates.some(candidate => selectedValues.has(candidate));
  }).map(line => [line.title, line.name, line.productType, line.vendor, line.sku, line.category].map(value => normalizeText(value)).filter(Boolean).join(" ")).join(" ");
  const text = [values?.itemText, values?.itemCondition, values?.reason, lineText].map(value => String(value || "").toLowerCase()).join(" ");
  return ["custom", "personalized", "made to order", "digital", "download", "perishable", "hygiene", "sealed", "consumable", "bespoke", "カスタム", "オーダーメイド", "名入れ", "受注生産", "デジタル", "ダウンロード", "生鮮", "食品", "衛生", "封印", "開封", "消耗品"].some(keyword => text.includes(keyword));
}
export function getWithdrawalFromEmail() {
  return process.env.WITHDRAWAL_FROM_EMAIL || process.env.MAIL_FROM || process.env.ADMIN_EMAIL || null;
}
export function getWithdrawalSupportEmail() {
  return process.env.WITHDRAWAL_SUPPORT_EMAIL || process.env.ADMIN_EMAIL || process.env.MAIL_FROM || null;
}
export async function resolveWithdrawalVendorNotificationRecipients({
  withdrawalRequest,
  prismaClient
}) {
  if (!prismaClient?.sellerOrder?.findMany || !prismaClient?.seller?.findMany) {
    return [];
  }
  const sellerOrderWhere = {
    OR: []
  };
  const marketplaceOrderId = normalizeText(withdrawalRequest?.marketplaceOrderId);
  const shopifyOrderId = normalizeText(withdrawalRequest?.shopifyOrderId);
  if (marketplaceOrderId) {
    sellerOrderWhere.OR.push({
      marketplaceOrderId
    });
  }
  if (shopifyOrderId) {
    sellerOrderWhere.OR.push({
      shopifyOrderId
    });
  }
  if (sellerOrderWhere.OR.length === 0) {
    return [];
  }
  const sellerOrders = await prismaClient.sellerOrder.findMany({
    where: sellerOrderWhere,
    include: {
      lines: true
    },
    orderBy: {
      createdAt: "asc"
    }
  });
  const affectedSellerOrders = sellerOrders.filter(sellerOrder => sellerOrderTouchesWithdrawal(sellerOrder, withdrawalRequest));
  if (affectedSellerOrders.length === 0) {
    return [];
  }
  const sellerIds = [...new Set(affectedSellerOrders.map(sellerOrder => normalizeText(sellerOrder.sellerId)).filter(Boolean))];
  const vendorStoreIds = [...new Set(affectedSellerOrders.map(sellerOrder => normalizeText(sellerOrder.vendorStoreId)).filter(Boolean))];
  const sellerWhere = {
    OR: []
  };
  if (sellerIds.length > 0) {
    sellerWhere.OR.push({
      id: {
        in: sellerIds
      }
    });
  }
  if (vendorStoreIds.length > 0) {
    sellerWhere.OR.push({
      vendorStoreId: {
        in: vendorStoreIds
      }
    });
  }
  if (sellerWhere.OR.length === 0) {
    return [];
  }
  const sellers = await prismaClient.seller.findMany({
    where: sellerWhere,
    include: {
      vendor: true,
      vendorStore: true
    }
  });
  const sellerById = new Map(sellers.map(seller => [normalizeText(seller.id), seller]));
  const sellerByVendorStoreId = new Map(sellers.map(seller => [normalizeText(seller.vendorStoreId), seller]));
  const groupedByEmail = new Map();
  for (const sellerOrder of affectedSellerOrders) {
    const seller = sellerById.get(normalizeText(sellerOrder.sellerId)) || sellerByVendorStoreId.get(normalizeText(sellerOrder.vendorStoreId));
    const email = normalizeEmail(seller?.vendor?.managementEmail || seller?.vendorStore?.email);
    if (!email) {
      continue;
    }
    const existing = groupedByEmail.get(email) || {
      email,
      vendorIds: new Set(),
      sellerIds: new Set(),
      vendorStoreIds: new Set(),
      storeNames: new Set(),
      sellerOrderIds: new Set(),
      lineTitles: new Set()
    };
    if (seller?.vendorId) existing.vendorIds.add(seller.vendorId);
    if (seller?.id) existing.sellerIds.add(seller.id);
    if (seller?.vendorStoreId) existing.vendorStoreIds.add(seller.vendorStoreId);
    if (seller?.vendor?.storeName) existing.storeNames.add(seller.vendor.storeName);
    if (seller?.vendorStore?.storeName) {
      existing.storeNames.add(seller.vendorStore.storeName);
    }
    if (sellerOrder.id) existing.sellerOrderIds.add(sellerOrder.id);
    for (const line of Array.isArray(sellerOrder.lines) ? sellerOrder.lines : []) {
      if (!lineMatchesSelectedWithdrawalValues(line, getWithdrawalSelectedLineValues(withdrawalRequest))) {
        if (String(withdrawalRequest?.withdrawalScope || "FULL").toUpperCase() === "PARTIAL") {
          continue;
        }
      }
      const title = normalizeText(line.title);
      if (title) existing.lineTitles.add(title);
    }
    groupedByEmail.set(email, existing);
  }
  return Array.from(groupedByEmail.values()).map(recipient => ({
    email: recipient.email,
    vendorIds: Array.from(recipient.vendorIds),
    sellerIds: Array.from(recipient.sellerIds),
    vendorStoreIds: Array.from(recipient.vendorStoreIds),
    storeNames: Array.from(recipient.storeNames),
    sellerOrderIds: Array.from(recipient.sellerOrderIds),
    lineTitles: Array.from(recipient.lineTitles)
  }));
}
export function sellerOrderTouchesWithdrawal(sellerOrder, withdrawalRequest) {
  if (!sellerOrder || !withdrawalRequest) {
    return false;
  }
  const requestMarketplaceOrderId = normalizeText(withdrawalRequest.marketplaceOrderId);
  const requestShopifyOrderId = normalizeText(withdrawalRequest.shopifyOrderId);
  const sameOrder = requestMarketplaceOrderId && requestMarketplaceOrderId === normalizeText(sellerOrder.marketplaceOrderId) || requestShopifyOrderId && requestShopifyOrderId === normalizeText(sellerOrder.shopifyOrderId);
  if (!sameOrder) {
    return false;
  }
  if (String(withdrawalRequest.withdrawalScope || "FULL").toUpperCase() !== "PARTIAL") {
    return true;
  }
  const selectedValues = getWithdrawalSelectedLineValues(withdrawalRequest);
  if (selectedValues.size === 0) {
    return true;
  }
  return (Array.isArray(sellerOrder.lines) ? sellerOrder.lines : []).some(line => lineMatchesSelectedWithdrawalValues(line, selectedValues));
}
export function getWithdrawalSelectedLineValues(withdrawalRequest) {
  const selectedLineItemsJson = getJsonObject(withdrawalRequest?.selectedLineItemsJson);
  const submittedPayloadJson = getJsonObject(withdrawalRequest?.submittedPayloadJson);
  const values = [...getJsonArray(selectedLineItemsJson.selectedLineItems), ...getJsonArray(submittedPayloadJson.selectedLineItems)];
  return new Set(values.map(value => normalizeText(value)).filter(Boolean));
}
export function lineMatchesSelectedWithdrawalValues(line, selectedValues) {
  if (!line || !selectedValues?.size) {
    return false;
  }
  const candidates = [line.shopifyLineItemId, line.shopifyProductId, line.shopifyVariantId, line.productId, line.title].map(value => normalizeText(value)).filter(Boolean);
  return candidates.some(candidate => selectedValues.has(candidate));
}
export function getJsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
export function getJsonArray(value) {
  return Array.isArray(value) ? value : [];
}
export async function sendWithdrawalEmail({
  prismaClient,
  withdrawalRequest,
  emailType,
  subject,
  bodyText,
  bodyHtml,
  toEmail = null,
  returnGroupId = null,
  instructionId = null
}) {
  const fromEmail = getWithdrawalFromEmail();
  const recipientEmail = normalizeEmail(toEmail || withdrawalRequest.customerEmail);
  const sentAt = new Date();
  const legalEmailHold = await getEmailClassHoldStatus(EMAIL_MESSAGE_CLASS.LEGAL_TRANSACTIONAL, {
    prismaClient
  });
  if (!process.env.RESEND_API_KEY || !fromEmail || !recipientEmail) {
    await prismaClient.withdrawalEmailLog.create({
      data: {
        withdrawalRequestId: withdrawalRequest.id,
        returnGroupId,
        instructionId,
        emailType,
        toEmail: recipientEmail || "",
        fromEmail,
        subject,
        bodyText,
        bodyHtml,
        status: "failed",
        errorMessage: !recipientEmail ? "Recipient email is not configured." : "RESEND_API_KEY or sender email is not configured."
      }
    });
    return {
      ok: false,
      error: !recipientEmail ? "recipient_email_not_configured" : "email_not_configured"
    };
  }
  if (legalEmailHold.active) {
    return holdWithdrawalEmailSnapshot({
      prismaClient,
      withdrawalRequest,
      emailType,
      recipient: recipientEmail,
      sender: fromEmail,
      subject,
      text: bodyText,
      html: bodyHtml,
      holdStatus: legalEmailHold,
      now: sentAt
    });
  }
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const response = await resend.emails.send({
      from: fromEmail,
      to: recipientEmail,
      subject,
      text: bodyText,
      html: bodyHtml
    });
    if (response?.error) {
      const message = response.error?.message || response.error?.name || JSON.stringify(response.error);
      await prismaClient.withdrawalEmailLog.create({
        data: {
          withdrawalRequestId: withdrawalRequest.id,
          returnGroupId,
          instructionId,
          emailType,
          toEmail: recipientEmail,
          fromEmail,
          subject,
          bodyText,
          bodyHtml,
          status: "failed",
          errorMessage: message
        }
      });
      return {
        ok: false,
        error: message
      };
    }
    const providerMessageId = response?.data?.id || response?.id || response?.messageId || null;
    await prismaClient.withdrawalEmailLog.create({
      data: {
        withdrawalRequestId: withdrawalRequest.id,
        returnGroupId,
        instructionId,
        emailType,
        toEmail: recipientEmail,
        fromEmail,
        subject,
        bodyText,
        bodyHtml,
        providerMessageId,
        status: "sent",
        sentAt
      }
    });
    return {
      ok: true,
      providerMessageId,
      sentAt
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prismaClient.withdrawalEmailLog.create({
      data: {
        withdrawalRequestId: withdrawalRequest.id,
        returnGroupId,
        instructionId,
        emailType,
        toEmail: recipientEmail,
        fromEmail,
        subject,
        bodyText,
        bodyHtml,
        status: "failed",
        errorMessage: message
      }
    });
    return {
      ok: false,
      error: message
    };
  }
}
export function buildPlainAndHtmlEmail({
  subject,
  bodyLines
}) {
  const text = bodyLines.join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;line-height:1.8;color:#111">${bodyLines.map(line => line ? `<p>${escapeHtml(line)}</p>` : "<br>").join("")}</div>`;
  return {
    subject,
    text,
    html
  };
}
export function getWithdrawalOrderName(withdrawalRequest) {
  return withdrawalRequest?.shopifyOrderName || withdrawalRequest?.shopifyOrderNumber || withdrawalRequest?.submittedPayloadJson?.orderNumber || "-";
}
export function buildVendorNotificationEmailV3({
  withdrawalRequest,
  recipient
}) {
  const supportEmail = getWithdrawalSupportEmail();
  const storeNames = Array.isArray(recipient?.storeNames) && recipient.storeNames.length > 0 ? recipient.storeNames.join(" / ") : "販売店舗";
  const lineTitles = Array.isArray(recipient?.lineTitles) && recipient.lineTitles.length > 0 ? recipient.lineTitles.join(" / ") : getWithdrawalScopeLabel(withdrawalRequest);
  const vendorUrl = buildVendorWithdrawalUrl(withdrawalRequest, recipient);
  const bodyLines = [`${storeNames} ご担当者様`, "", "撤回申請が届きました。対象商品の発送状況と返送対応の確認をお願いします。", `受付番号: ${withdrawalRequest.id}`, `注文番号: ${getWithdrawalOrderName(withdrawalRequest)}`, `撤回対象: ${getWithdrawalScopeLabel(withdrawalRequest)}`, `対象商品: ${lineTitles}`, `申請日時: ${formatDateTime(withdrawalRequest.createdAt || new Date())}`, "", "返金判断は運営が行います。発送済みの場合は、店舗管理画面で返送品の到着と商品状態を記録してください。", vendorUrl ? `店舗側確認ページ: ${vendorUrl}` : "", supportEmail ? `問い合わせ先: ${supportEmail}` : ""].filter(line => line !== "");
  return buildPlainAndHtmlEmail({
    subject: `撤回申請の確認が必要です: ${getWithdrawalOrderName(withdrawalRequest)}`,
    bodyLines
  });
}
export function getWithdrawalScopeLabel(withdrawalRequest) {
  return withdrawalRequest?.withdrawalScope === "PARTIAL" ? "一部の商品" : "注文全体";
}
export function buildVendorNotificationEmail(options) {
  return buildVendorNotificationEmailV3(options);
}
export function buildVendorWithdrawalUrl(withdrawalRequest, recipient) {
  const appUrl = normalizeAppBaseUrl(process.env.APP_URL);
  if (!appUrl || !withdrawalRequest?.id) {
    return null;
  }
  const url = new URL(`/vendor/withdrawals/${withdrawalRequest.id}`, appUrl);
  const vendorIds = Array.isArray(recipient?.vendorIds) ? recipient.vendorIds : [];
  if (vendorIds.length === 1) {
    url.searchParams.set("vendorId", vendorIds[0]);
  }
  return url.toString();
}
export function normalizeAppBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch (_error) {
    return null;
  }
}
export function formatDateTime(value) {
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Tokyo"
    }).format(value);
  } catch (_error) {
    return value?.toISOString?.() || String(value);
  }
}
export function escapeHtml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

import crypto from "node:crypto";
import { Resend } from "resend";

import prisma from "../db.server.js";
import {
  formatPublicCountryLabel,
  isEuCountry,
  normalizeCountryCode,
} from "../utils/deliveryEligibility.js";
import {
  normalizeShopDomain,
  shopifyGraphQLWithOfflineSession,
} from "../utils/shopifyAdmin.server.js";
import {
  WITHDRAWAL_ELIGIBILITY_STATUSES,
  WITHDRAWAL_STATUSES,
  getWithdrawalEligibilityLabel,
  getWithdrawalStatusLabel,
} from "../utils/withdrawalStatus.js";
import {
  getWithdrawalDictionary,
  resolveWithdrawalLocale,
} from "../utils/withdrawalLocale.js";
import {
  buildWithdrawalSubmissionIdempotencyKey,
  hashWithdrawalValue,
  resolveWithdrawalConsumerLawContext,
  resolveWithdrawalLegalBundle,
  WITHDRAWAL_DEADLINE_RULE_VERSION,
  WITHDRAWAL_PAYLOAD_SCHEMA_VERSION,
} from "./withdrawalCompliance.server.js";
import {
  buildWithdrawalAcknowledgementSnapshot,
  buildWithdrawalCompletionSnapshot,
  buildWithdrawalStatusSnapshot,
} from "./withdrawalEmailTemplates.js";
import {
  buildWithdrawalOutboxRecord,
  processWithdrawalEmailOutbox,
} from "./withdrawalEmailOutbox.server.js";

const ONE_HOUR_MS = 60 * 60 * 1000;
const RETURN_PROOF_TOKEN_BYTES = 32;
const RETURN_PROOF_TOKEN_TTL_DAYS = 45;
const EMAIL_RATE_LIMIT_PER_HOUR = 5;
const IP_RATE_LIMIT_PER_HOUR = 20;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_PATTERN = /^https?:\/\//i;
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);
const RETURN_PROOF_OPEN_STATUSES = new Set([
  WITHDRAWAL_STATUSES.REQUESTED,
  WITHDRAWAL_STATUSES.ACKNOWLEDGED,
  WITHDRAWAL_STATUSES.UNDER_REVIEW,
  WITHDRAWAL_STATUSES.APPROVED,
  WITHDRAWAL_STATUSES.RETURN_REQUESTED,
  WITHDRAWAL_STATUSES.RETURN_RECEIVED,
  WITHDRAWAL_STATUSES.REFUND_PENDING,
]);
const REFUND_DECISION_STATUSES = new Set([
  "UNDECIDED",
  "FULL_REFUND",
  "PARTIAL_REFUND",
  "NO_REFUND",
  "RETURN_PENDING",
]);
const COMPLETION_STATUSES = new Set([
  "UNDECIDED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
  "CANCELLED",
  "NO_REFUND_CLOSED",
  "REJECTED_CLOSED",
  "MANUAL_CLOSED",
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
const TERMINAL_WITHDRAWAL_STATUSES = new Set([
  WITHDRAWAL_STATUSES.REFUNDED,
  WITHDRAWAL_STATUSES.CANCELLED,
  WITHDRAWAL_STATUSES.REJECTED,
  WITHDRAWAL_STATUSES.EXPIRED,
]);
const ALLOWED_WITHDRAWAL_STATUS_TRANSITIONS = {
  [WITHDRAWAL_STATUSES.REQUESTED]: new Set([
    WITHDRAWAL_STATUSES.ACKNOWLEDGED,
    WITHDRAWAL_STATUSES.UNDER_REVIEW,
    WITHDRAWAL_STATUSES.APPROVED,
    WITHDRAWAL_STATUSES.RETURN_REQUESTED,
    WITHDRAWAL_STATUSES.REFUNDED,
    WITHDRAWAL_STATUSES.CANCELLED,
    WITHDRAWAL_STATUSES.REJECTED,
    WITHDRAWAL_STATUSES.EXPIRED,
    WITHDRAWAL_STATUSES.ERROR,
  ]),
  [WITHDRAWAL_STATUSES.ACKNOWLEDGED]: new Set([
    WITHDRAWAL_STATUSES.UNDER_REVIEW,
    WITHDRAWAL_STATUSES.APPROVED,
    WITHDRAWAL_STATUSES.RETURN_REQUESTED,
    WITHDRAWAL_STATUSES.RETURN_RECEIVED,
    WITHDRAWAL_STATUSES.REFUND_PENDING,
    WITHDRAWAL_STATUSES.REFUNDED,
    WITHDRAWAL_STATUSES.CANCELLED,
    WITHDRAWAL_STATUSES.REJECTED,
    WITHDRAWAL_STATUSES.EXPIRED,
    WITHDRAWAL_STATUSES.ERROR,
  ]),
  [WITHDRAWAL_STATUSES.UNDER_REVIEW]: new Set([
    WITHDRAWAL_STATUSES.APPROVED,
    WITHDRAWAL_STATUSES.RETURN_REQUESTED,
    WITHDRAWAL_STATUSES.RETURN_RECEIVED,
    WITHDRAWAL_STATUSES.REFUND_PENDING,
    WITHDRAWAL_STATUSES.REFUNDED,
    WITHDRAWAL_STATUSES.CANCELLED,
    WITHDRAWAL_STATUSES.REJECTED,
    WITHDRAWAL_STATUSES.EXPIRED,
    WITHDRAWAL_STATUSES.ERROR,
  ]),
  [WITHDRAWAL_STATUSES.APPROVED]: new Set([
    WITHDRAWAL_STATUSES.RETURN_REQUESTED,
    WITHDRAWAL_STATUSES.RETURN_RECEIVED,
    WITHDRAWAL_STATUSES.REFUND_PENDING,
    WITHDRAWAL_STATUSES.REFUNDED,
    WITHDRAWAL_STATUSES.CANCELLED,
    WITHDRAWAL_STATUSES.REJECTED,
    WITHDRAWAL_STATUSES.ERROR,
  ]),
  [WITHDRAWAL_STATUSES.RETURN_REQUESTED]: new Set([
    WITHDRAWAL_STATUSES.RETURN_RECEIVED,
    WITHDRAWAL_STATUSES.REFUND_PENDING,
    WITHDRAWAL_STATUSES.REFUNDED,
    WITHDRAWAL_STATUSES.REJECTED,
    WITHDRAWAL_STATUSES.ERROR,
  ]),
  [WITHDRAWAL_STATUSES.RETURN_RECEIVED]: new Set([
    WITHDRAWAL_STATUSES.REFUND_PENDING,
    WITHDRAWAL_STATUSES.REFUNDED,
    WITHDRAWAL_STATUSES.REJECTED,
    WITHDRAWAL_STATUSES.ERROR,
  ]),
  [WITHDRAWAL_STATUSES.REFUND_PENDING]: new Set([
    WITHDRAWAL_STATUSES.REFUNDED,
    WITHDRAWAL_STATUSES.CANCELLED,
    WITHDRAWAL_STATUSES.REJECTED,
    WITHDRAWAL_STATUSES.ERROR,
  ]),
  [WITHDRAWAL_STATUSES.ERROR]: new Set([
    WITHDRAWAL_STATUSES.UNDER_REVIEW,
    WITHDRAWAL_STATUSES.REJECTED,
    WITHDRAWAL_STATUSES.EXPIRED,
  ]),
};

const WITHDRAWAL_ORDER_LIVE_STATUS_QUERY = `#graphql
  query WithdrawalOrderLiveStatus($id: ID!) {
    node(id: $id) {
      ... on Order {
        id
        name
        email
        createdAt
        processedAt
        cancelledAt
        cancelReason
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
      }
    }
  }
`;

const WITHDRAWAL_ORDER_LOOKUP_QUERY = `#graphql
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

export function normalizeWithdrawalFormData(formData, { locale = "en-GB" } = {}) {
  const dictionary = getWithdrawalDictionary(locale);
  const customerName = normalizeText(formData.get("customerName"), 120);
  const customerEmail = normalizeEmail(formData.get("customerEmail"));
  const customerPhone = normalizeText(formData.get("customerPhone"), 40);
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
  const itemText = normalizeText(formData.get("itemText"), 1000);
  const itemCondition = normalizeText(formData.get("itemCondition"), 1000);
  const reason = normalizeText(formData.get("reason"), 1000);
  const receivedDate = parseDateInput(formData.get("receivedDate"));

  const selectedLineItems = formData
    .getAll("selectedLineItems")
    .map((value) => normalizeText(value))
    .filter(Boolean);

  const errors = {};

  if (!customerName) errors.customerName = dictionary.errors.customerName;
  if (!customerEmail) errors.customerEmail = dictionary.errors.customerEmail;
  if (customerEmail && !EMAIL_PATTERN.test(customerEmail)) {
    errors.customerEmail = dictionary.errors.customerEmail;
  }
  if (!orderNumber) errors.orderNumber = dictionary.errors.orderNumber;
  if (orderNumber && orderNumber.length > 80) {
    errors.orderNumber = "注文番号が長すぎます。";
  }
  if (customerPhone && customerPhone.length > 40) {
    errors.customerPhone = "電話番号が長すぎます。";
  }
  if (receivedDate && isFutureDate(receivedDate)) {
    errors.receivedDate = dictionary.errors.receivedDate;
  }
  if (withdrawalScope === "PARTIAL" && !itemText && selectedLineItems.length === 0) {
    errors.itemText = dictionary.errors.itemText;
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

function buildReadableWithdrawalFormErrors(errors) {
  const readable = {};

  if (errors.customerName) readable.customerName = "氏名を入力してください。";
  if (errors.customerEmail) {
    readable.customerEmail = "有効なメールアドレスを入力してください。";
  }
  if (errors.orderNumber) readable.orderNumber = "注文番号を入力してください。";
  if (errors.countryCode) readable.countryCode = "国を選択してください。";
  if (errors.customerPhone) readable.customerPhone = "電話番号が長すぎます。";
  if (errors.receivedDate) readable.receivedDate = "未来の受取日は指定できません。";
  if (errors.itemText) readable.itemText = "撤回したい商品を入力してください。";

  return readable;
}

export async function createWithdrawalRequestFromForm({
  request,
  formData,
  shopDomain,
  prismaClient = prisma,
} = {}) {
  const localeResolution = resolveWithdrawalLocale({
    urlLocale: formData.get("correspondenceLocale") || formData.get("lang"),
    shopifyLocale: formData.get("shopifyLocale"),
    acceptLanguage: request?.headers?.get("accept-language"),
    userSelected: Boolean(formData.get("correspondenceLocale")),
  });
  const normalized = normalizeWithdrawalFormData(formData, {
    locale: localeResolution.locale,
  });

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
    const dictionary = getWithdrawalDictionary(localeResolution.locale);
    return {
      ok: false,
      status: 429,
      errors: {
        form: dictionary.errors.rateLimited,
      },
      values,
    };
  }

  const orderLookup = await findOrderForWithdrawal({
    prismaClient,
    shopDomain: normalizedShopDomain,
    orderNumber: values.orderNumber,
    customerEmail: values.customerEmail,
  });
  const eligibility = evaluateWithdrawalEligibility({
    values,
    orderSnapshot: orderLookup.orderSnapshot,
  });
  const selectedLineItemsJson = buildSelectedLineItemsJson(values, orderLookup);
  const submittedPayloadJson = buildSubmittedPayloadJson(values);
  const submittedAt = new Date();
  const submissionNonce = normalizeText(formData.get("submissionNonce"), 200);
  const idempotencyKey = submissionNonce
    ? buildWithdrawalSubmissionIdempotencyKey({
        shopDomain: normalizedShopDomain,
        submissionNonce,
        fallbackPayload: submittedPayloadJson,
      })
    : buildWithdrawalIdempotencyKey({
        shopDomain: normalizedShopDomain,
        orderNumber: values.orderNumber,
        email: values.customerEmail,
        withdrawalScope: values.withdrawalScope,
        itemText: values.itemText,
        selectedLineItems: values.selectedLineItems,
      });
  const lawContext = resolveWithdrawalConsumerLawContext({
    orderSnapshot: orderLookup.orderSnapshot,
    submittedCountryCode: values.countryCode,
    shopifyMarketCountry: formData.get("shopifyMarketCountry"),
  });
  const legalBundle = await resolveWithdrawalLegalBundle({
    prismaClient,
    consumerLawCountry: lawContext.consumerLawCountry,
    locale: localeResolution.locale,
  });
  const submittedPayloadHash = hashWithdrawalValue(submittedPayloadJson);

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

    if (Number(existing.workflowVersion || 1) === 1) {
      const { initializeWithdrawalDirectReturnWorkflow } = await import(
        "./withdrawalDirectReturns.server.js"
      );
      await initializeWithdrawalDirectReturnWorkflow({
        withdrawalRequestId: existing.id,
        prismaClient,
      });
    }

    if (!hasSentAcknowledgement && prismaClient.withdrawalEmailOutbox?.findFirst) {
      await processWithdrawalEmailOutbox({ prismaClient, limit: 1 });
    } else if (!hasSentAcknowledgement) {
      await sendWithdrawalAcknowledgementEmail({ withdrawalRequestId: existing.id, prismaClient });
    }

    await sendWithdrawalVendorNotificationEmails({
      withdrawalRequestId: existing.id,
      prismaClient,
    });

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
        submittedAt,
        submittedViewLocale: localeResolution.locale,
        correspondenceLocale: localeResolution.locale,
        localeSource: localeResolution.source,
        ...lawContext,
        withdrawalDeadlineRuleVersion: WITHDRAWAL_DEADLINE_RULE_VERSION,
        submissionLegalBundleVersion: legalBundle.version,
        submissionLegalBundleHash: legalBundle.hash,
        submittedPayloadSchemaVersion: WITHDRAWAL_PAYLOAD_SCHEMA_VERSION,
        submittedPayloadHash,
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

    if (tx.withdrawalEvent?.create && tx.withdrawalEmailOutbox?.create) {
      const event = await tx.withdrawalEvent.create({
        data: {
          withdrawalRequestId: created.id,
          type: "WITHDRAWAL_SUBMITTED",
          occurredAt: submittedAt,
          actorType: "BUYER",
          actorId: values.customerEmail,
          payloadJson: {
            schemaVersion: WITHDRAWAL_PAYLOAD_SCHEMA_VERSION,
            submittedPayloadHash,
            legalBundleVersion: legalBundle.version,
            legalReviewRequired: legalBundle.requiresLegalReview,
          },
          payloadHash: submittedPayloadHash,
          idempotencyKey: `withdrawal-submitted:${created.id}`,
        },
      });
      const email = buildWithdrawalAcknowledgementSnapshot(created);
      await tx.withdrawalEmailOutbox.create({
        data: buildWithdrawalOutboxRecord({
          withdrawalRequest: created,
          withdrawalEventId: event.id,
          email,
        }),
      });
    }

    return created;
  });

  const { initializeWithdrawalDirectReturnWorkflow } = await import(
    "./withdrawalDirectReturns.server.js"
  );
  const directReturnResult = await initializeWithdrawalDirectReturnWorkflow({
    withdrawalRequestId: withdrawalRequest.id,
    prismaClient,
  });

  const emailResult = prismaClient.withdrawalEmailOutbox?.findFirst
    ? await processWithdrawalEmailOutbox({ prismaClient, limit: 1 })
    : await sendWithdrawalAcknowledgementEmail({
        withdrawalRequestId: withdrawalRequest.id,
        prismaClient,
      });
  const vendorNotificationResult = await sendWithdrawalVendorNotificationEmails({
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
    vendorNotificationResult,
    directReturnResult,
  };
}

export async function findOrderForWithdrawal({
  prismaClient = prisma,
  shopDomain,
  orderNumber,
  customerEmail = null,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
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

  if (!marketplaceOrder && normalizedShopDomain) {
    const shopifyOrderSnapshot = await findShopifyOrderSnapshotForWithdrawal({
      shopDomain: normalizedShopDomain,
      orderNumber: normalizedOrderNumber,
      customerEmail,
      shopifyGraphQLWithOfflineSessionImpl,
    });

    if (shopifyOrderSnapshot) {
      return {
        marketplaceOrder: null,
        orderSnapshot: shopifyOrderSnapshot,
        source: "shopify_admin",
      };
    }
  }

  return {
    marketplaceOrder,
    orderSnapshot: marketplaceOrder ? serializeMarketplaceOrder(marketplaceOrder) : null,
    source: marketplaceOrder ? "marketplace_order" : "not_found",
  };
}

async function findShopifyOrderSnapshotForWithdrawal({
  shopDomain,
  orderNumber,
  customerEmail,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
} = {}) {
  const normalizedShopDomain = normalizeShopDomain(shopDomain);
  const normalizedOrderNumber = normalizeOrderNumber(orderNumber);

  if (!normalizedShopDomain || !normalizedOrderNumber) {
    return null;
  }

  const queryParts = [
    `name:${escapeShopifySearchValue(
      normalizedOrderNumber.startsWith("#")
        ? normalizedOrderNumber
        : `#${normalizedOrderNumber}`,
    )}`,
  ];
  const normalizedEmail = normalizeEmail(customerEmail);

  if (normalizedEmail) {
    queryParts.push(`email:${escapeShopifySearchValue(normalizedEmail)}`);
  }

  try {
    const { data } = await shopifyGraphQLWithOfflineSessionImpl({
      shopDomain: normalizedShopDomain,
      query: WITHDRAWAL_ORDER_LOOKUP_QUERY,
      variables: { query: queryParts.join(" ") },
    });
    const orders = Array.isArray(data?.orders?.nodes) ? data.orders.nodes : [];
    const order =
      orders.find((candidate) =>
        normalizedEmail
          ? normalizeEmail(candidate?.email) === normalizedEmail
          : true,
      ) || null;

    return order ? serializeShopifyOrderSnapshot(order, normalizedShopDomain) : null;
  } catch (error) {
    console.warn("withdrawal Shopify order lookup failed", {
      shopDomain: normalizedShopDomain,
      orderNumber: normalizedOrderNumber,
      error: sanitizeShopifyLiveStatusError(error),
    });
    return null;
  }
}

export async function getWithdrawalShopifyLiveOrderStatus({
  withdrawalRequest,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
} = {}) {
  const shopDomain = normalizeShopDomain(withdrawalRequest?.shopDomain);
  const shopifyOrderId = normalizeShopifyOrderGid(
    withdrawalRequest?.shopifyOrderId ||
      withdrawalRequest?.orderSnapshotJson?.shopifyOrderId ||
      withdrawalRequest?.orderSnapshotJson?.admin_graphql_api_id ||
      withdrawalRequest?.orderSnapshotJson?.id,
  );

  if (!shopDomain || !shopifyOrderId) {
    return {
      ok: false,
      error: !shopDomain ? "missing_shop_domain" : "missing_shopify_order_id",
      order: null,
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    const { data, shopDomain: resolvedShopDomain } =
      await shopifyGraphQLWithOfflineSessionImpl({
        shopDomain,
        query: WITHDRAWAL_ORDER_LIVE_STATUS_QUERY,
        variables: { id: shopifyOrderId },
      });

    const order = data?.node || null;

    if (!order) {
      return {
        ok: false,
        error: "shopify_order_not_found",
        shopDomain: resolvedShopDomain || shopDomain,
        shopifyOrderId,
        order: null,
        checkedAt: new Date().toISOString(),
      };
    }

    return {
      ok: true,
      error: null,
      shopDomain: resolvedShopDomain || shopDomain,
      shopifyOrderId,
      order: serializeLiveShopifyOrderStatus(order),
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      error: sanitizeShopifyLiveStatusError(error),
      shopDomain,
      shopifyOrderId,
      order: null,
      checkedAt: new Date().toISOString(),
    };
  }
}

export function evaluateWithdrawalEligibility({ values, orderSnapshot } = {}) {
  return evaluateWithdrawalEligibilityV3({ values, orderSnapshot });

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

function evaluateWithdrawalEligibilityV2({ values, orderSnapshot } = {}) {
  const countryCode =
    normalizeCountryCode(values?.countryCode) ||
    normalizeCountryCode(orderSnapshot?.shippingCountryCode);
  const buyerReceivedDate = parseDateInput(values?.receivedDate);
  const confirmedDeliveredDate = parseDateInput(
    orderSnapshot?.deliveredAt ||
      orderSnapshot?.delivered_at ||
      orderSnapshot?.deliveryConfirmedAt ||
      orderSnapshot?.delivery_confirmed_at,
  );
  const baseDate = buyerReceivedDate || confirmedDeliveredDate;
  const deadlineSource = buyerReceivedDate
    ? "buyer_received_date"
    : confirmedDeliveredDate
      ? "delivery_confirmed_at"
      : null;
  const deadlineAt = baseDate ? getWithdrawalDeadlineAt(baseDate) : null;
  const warnings = [];
  let status = WITHDRAWAL_ELIGIBILITY_STATUSES.PENDING_REVIEW;

  if (!orderSnapshot) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.ORDER_NOT_FOUND_REVIEW;
    warnings.push("注文を自動照合できませんでした。管理画面で確認してください。");
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
  } else if (buyerReceivedDate && isFutureDate(buyerReceivedDate)) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.DEADLINE_REVIEW;
    warnings.push("受取日が未来の日付になっているため、確認が必要です。");
  } else if (deadlineAt && deadlineAt.getTime() < Date.now()) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.DEADLINE_EXPIRED;
    warnings.push("商品受取日から14日を超えている可能性があります。");
  } else if (!deadlineAt) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.DEADLINE_REVIEW;
    warnings.push("商品受取日を確認できないため、14日以内か手動確認が必要です。");
  } else if (hasValueReductionSignal(values?.itemCondition)) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.VALUE_REDUCTION_REVIEW;
    warnings.push("商品状態により返金額の確認が必要です。");
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

function evaluateWithdrawalEligibilityV3({ values, orderSnapshot } = {}) {
  const countryCode =
    normalizeCountryCode(values?.countryCode) ||
    normalizeCountryCode(orderSnapshot?.shippingCountryCode);
  const buyerReceivedDate = parseDateInput(values?.receivedDate);
  const confirmedDeliveredDate = parseDateInput(
    orderSnapshot?.deliveredAt ||
      orderSnapshot?.delivered_at ||
      orderSnapshot?.deliveryConfirmedAt ||
      orderSnapshot?.delivery_confirmed_at,
  );
  const baseDate = buyerReceivedDate || confirmedDeliveredDate;
  const deadlineSource = buyerReceivedDate
    ? "buyer_received_date"
    : confirmedDeliveredDate
      ? "delivery_confirmed_at"
      : null;
  const deadlineAt = baseDate ? getWithdrawalDeadlineAt(baseDate) : null;
  const warnings = [];
  let status = WITHDRAWAL_ELIGIBILITY_STATUSES.PENDING_REVIEW;
  const orderStateReview = getOrderStateReview(orderSnapshot);

  if (!orderSnapshot) {
    status = WITHDRAWAL_ELIGIBILITY_STATUSES.ORDER_NOT_FOUND_REVIEW;
    warnings.push("注文を自動照合できませんでした。管理画面で確認してください。");
  } else if (
    values?.customerEmail &&
    orderSnapshot.buyerEmail &&
    normalizeEmail(values.customerEmail) !== normalizeEmail(orderSnapshot.buyerEmail)
  ) {
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

  const email = buildWithdrawalAcknowledgementSnapshot(withdrawalRequest);
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

export async function sendWithdrawalVendorNotificationEmails({
  withdrawalRequestId,
  prismaClient = prisma,
} = {}) {
  const withdrawalRequest = await prismaClient.withdrawalRequest.findUnique({
    where: { id: withdrawalRequestId },
  });

  if (!withdrawalRequest) {
    return { ok: false, error: "withdrawal_request_not_found" };
  }

  const recipients = await resolveWithdrawalVendorNotificationRecipients({
    withdrawalRequest,
    prismaClient,
  });

  if (recipients.length === 0) {
    return { ok: true, skipped: true, sentCount: 0, failedCount: 0, results: [] };
  }

  const results = [];

  for (const recipient of recipients) {
    const existingSentLog = prismaClient.withdrawalEmailLog?.findFirst
      ? await prismaClient.withdrawalEmailLog.findFirst({
          where: {
            withdrawalRequestId: withdrawalRequest.id,
            emailType: "vendor_notification",
            toEmail: recipient.email,
            status: "sent",
          },
          orderBy: { createdAt: "desc" },
        })
      : null;

    if (existingSentLog) {
      results.push({
        ok: true,
        skipped: true,
        recipient,
        reason: "already_sent",
      });
      continue;
    }

    const email = buildVendorNotificationEmail({
      withdrawalRequest,
      recipient,
    });
    const result = await sendWithdrawalEmail({
      prismaClient,
      withdrawalRequest,
      emailType: "vendor_notification",
      subject: email.subject,
      bodyText: email.text,
      bodyHtml: email.html,
      toEmail: recipient.email,
    });

    results.push({
      ...result,
      recipient,
    });
  }

  const sentCount = results.filter((result) => result.ok && !result.skipped).length;
  const skippedCount = results.filter((result) => result.skipped).length;
  const failedCount = results.filter((result) => !result.ok).length;

  return {
    ok: failedCount === 0,
    sentCount,
    skippedCount,
    failedCount,
    results,
  };
}

export async function ensureWithdrawalReturnProofToken({
  withdrawalRequestId,
  request = null,
  prismaClient = prisma,
} = {}) {
  const withdrawalRequest = await prismaClient.withdrawalRequest.findUnique({
    where: { id: withdrawalRequestId },
  });

  if (!withdrawalRequest) {
    return { ok: false, status: 404, error: "withdrawal_request_not_found" };
  }

  const token = crypto.randomBytes(RETURN_PROOF_TOKEN_BYTES).toString("base64url");
  const expiresAt = addDays(new Date(), RETURN_PROOF_TOKEN_TTL_DAYS);
  const tokenHash = hashReturnProofToken(token);
  const updated = await prismaClient.withdrawalRequest.update({
    where: { id: withdrawalRequest.id },
    data: {
      returnProofTokenHash: tokenHash,
      returnProofTokenExpiresAt: expiresAt,
    },
  });

  return {
    ok: true,
    withdrawalRequest: updated,
    token,
    expiresAt,
    url: buildReturnProofUrl({
      request,
      withdrawalRequestId: withdrawalRequest.id,
      token,
    }),
  };
}

export async function findWithdrawalReturnProofRequest({
  requestId,
  token,
  prismaClient = prisma,
} = {}) {
  const id = normalizeText(requestId);
  const rawToken = normalizeText(token);

  if (!id || !rawToken) {
    return { ok: false, status: 404, error: "invalid_return_proof_link" };
  }

  const withdrawalRequest = await prismaClient.withdrawalRequest.findFirst({
    where: {
      id,
      returnProofTokenHash: hashReturnProofToken(rawToken),
    },
  });

  if (!withdrawalRequest) {
    return { ok: false, status: 404, error: "invalid_return_proof_link" };
  }

  if (
    withdrawalRequest.returnProofTokenExpiresAt &&
    new Date(withdrawalRequest.returnProofTokenExpiresAt).getTime() < Date.now()
  ) {
    return {
      ok: false,
      status: 410,
      error: "return_proof_link_expired",
      withdrawalRequest,
    };
  }

  if (!RETURN_PROOF_OPEN_STATUSES.has(withdrawalRequest.status)) {
    return {
      ok: false,
      status: 410,
      error: "withdrawal_request_closed",
      withdrawalRequest,
    };
  }

  return { ok: true, withdrawalRequest };
}

export async function submitWithdrawalReturnProof({
  requestId,
  token,
  formData,
  request = null,
  prismaClient = prisma,
} = {}) {
  const lookup = await findWithdrawalReturnProofRequest({
    requestId,
    token,
    prismaClient,
  });

  if (!lookup.ok) {
    return lookup;
  }

  const current = lookup.withdrawalRequest;
  const returnTrackingCompany = normalizeText(
    formData.get("returnTrackingCompany"),
  );
  const returnTrackingNumber = normalizeText(
    formData.get("returnTrackingNumber"),
  );
  const returnTrackingUrl = normalizeText(formData.get("returnTrackingUrl"));
  const customerMemo = normalizeText(formData.get("customerMemo"));
  const errors = {};

  if (!returnTrackingNumber && !returnTrackingUrl) {
    errors.returnTrackingNumber = "tracking_required";
  }

  if (returnTrackingUrl && !URL_PATTERN.test(returnTrackingUrl)) {
    errors.returnTrackingUrl = "invalid_return_tracking_url";
  }

  if (Object.keys(errors).length > 0) {
    return {
      ok: false,
      status: 400,
      error: "invalid_return_proof",
      errors,
      withdrawalRequest: current,
    };
  }

  const now = new Date();
  const returnRequirementStatus = ["RECEIVED", "CONDITION_CHECKED"].includes(
    String(current.returnRequirementStatus || "").toUpperCase(),
  )
    ? current.returnRequirementStatus
    : "IN_TRANSIT";
  const previousProof =
    current.returnProofJson && typeof current.returnProofJson === "object"
      ? current.returnProofJson
      : {};
  const returnProofJson = {
    ...previousProof,
    trackingCompany: returnTrackingCompany,
    trackingNumber: returnTrackingNumber,
    trackingUrl: returnTrackingUrl,
    customerMemo,
    submittedBy: "customer",
    submittedAt: now.toISOString(),
    ipAddress: getClientIp(request),
    userAgent: request?.headers?.get("user-agent") || null,
  };

  const updated = await prismaClient.$transaction(async (tx) => {
    const next = await tx.withdrawalRequest.update({
      where: { id: current.id },
      data: {
        returnRequirementStatus,
        returnTrackingCompany,
        returnTrackingNumber,
        returnTrackingUrl,
        returnProofJson,
        returnProofSubmittedAt: now,
        returnInfoUpdatedAt: now,
        returnInfoUpdatedBy: "customer",
      },
    });

    await tx.withdrawalRequestStatusHistory.create({
      data: {
        withdrawalRequestId: current.id,
        fromStatus: current.status,
        toStatus: current.status,
        changedBy: "customer",
        reason: "return_proof_submitted",
        metadataJson: {
          returnProof: returnProofJson,
        },
      },
    });

    return next;
  });

  return { ok: true, withdrawalRequest: updated };
}

export async function sendWithdrawalReturnInstructionsEmail({
  withdrawalRequestId,
  request = null,
  prismaClient = prisma,
} = {}) {
  const tokenResult = await ensureWithdrawalReturnProofToken({
    withdrawalRequestId,
    request,
    prismaClient,
  });

  if (!tokenResult.ok) {
    return tokenResult;
  }

  const email = buildReturnInstructionsEmail({
    withdrawalRequest: tokenResult.withdrawalRequest,
    returnProofUrl: tokenResult.url,
    expiresAt: tokenResult.expiresAt,
  });

  return sendWithdrawalEmail({
    prismaClient,
    withdrawalRequest: tokenResult.withdrawalRequest,
    emailType: "return_instructions",
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

  if (!isAllowedWithdrawalStatusTransition(current.status, nextStatus)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_status_transition",
    };
  }

  if (
    [WITHDRAWAL_STATUSES.REJECTED, WITHDRAWAL_STATUSES.EXPIRED].includes(
      nextStatus,
    ) &&
    !reason &&
    !rejectionReason
  ) {
    return {
      ok: false,
      status: 400,
      error: "reason_required_for_closing_status",
    };
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

  if (
    nextStatus === WITHDRAWAL_STATUSES.RETURN_REQUESTED &&
    String(current.returnRequirementStatus || "UNDECIDED").toUpperCase() === "UNDECIDED"
  ) {
    data.returnRequirementStatus = "WAITING";
    data.returnInfoUpdatedAt = now;
    data.returnInfoUpdatedBy = changedBy;
  }

  if (
    nextStatus === WITHDRAWAL_STATUSES.RETURN_RECEIVED &&
    !["RECEIVED", "CONDITION_CHECKED"].includes(
      String(current.returnRequirementStatus || "UNDECIDED").toUpperCase(),
    )
  ) {
    data.returnRequirementStatus = "RECEIVED";
    data.returnReceivedAt = current.returnReceivedAt || now;
    data.returnInfoUpdatedAt = now;
    data.returnInfoUpdatedBy = changedBy;
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

function isAllowedWithdrawalStatusTransition(fromStatus, toStatus) {
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

  if (returnTrackingUrl && !URL_PATTERN.test(returnTrackingUrl)) {
    errors.returnTrackingUrl = "invalid_return_tracking_url";
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
  const refundCurrencyCode = normalizeCurrencyCode(
    formData.get("refundCurrencyCode"),
  );
  const refundItemAmount = parseOptionalMoneyAmount(
    formData.get("refundItemAmount"),
    refundCurrencyCode,
  );
  const refundInitialShippingAmount = parseOptionalMoneyAmount(
    formData.get("refundInitialShippingAmount"),
    refundCurrencyCode,
  );
  const refundDeductionAmount = parseOptionalMoneyAmount(
    formData.get("refundDeductionAmount"),
    refundCurrencyCode,
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

export function normalizeWithdrawalCompletionFormData(formData) {
  const completionStatus = String(
    formData.get("completionStatus") || "UNDECIDED",
  )
    .trim()
    .toUpperCase();
  const completionAction = normalizeText(formData.get("completionAction"));
  const completionShopifyRefundId = normalizeText(
    formData.get("completionShopifyRefundId"),
  );
  const completionShopifyCancelId = normalizeText(
    formData.get("completionShopifyCancelId"),
  );
  const completionCurrencyCode = normalizeCurrencyCode(
    formData.get("completionCurrencyCode"),
  );
  const completionRefundedAmount = parseOptionalMoneyAmount(
    formData.get("completionRefundedAmount"),
    completionCurrencyCode,
  );
  const completionRefundedShipping = parseOptionalMoneyAmount(
    formData.get("completionRefundedShipping"),
    completionCurrencyCode,
  );
  const completionNotes = normalizeText(formData.get("completionNotes"));
  const errors = {};

  if (!COMPLETION_STATUSES.has(completionStatus)) {
    errors.completionStatus = "invalid_completion_status";
  }

  if (completionRefundedAmount.invalid) {
    errors.completionRefundedAmount = "invalid_amount";
  }

  if (completionRefundedShipping.invalid) {
    errors.completionRefundedShipping = "invalid_amount";
  }

  if (
    ["REFUNDED", "PARTIALLY_REFUNDED"].includes(completionStatus) &&
    completionRefundedAmount.value === null
  ) {
    errors.completionRefundedAmount = "required_for_refunded_completion";
  }

  if (
    ["NO_REFUND_CLOSED", "REJECTED_CLOSED"].includes(completionStatus) &&
    !completionAction &&
    !completionNotes
  ) {
    errors.completionNotes = "reason_required_for_closed_completion";
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    values: {
      completionStatus,
      completionAction,
      completionShopifyRefundId,
      completionShopifyCancelId,
      completionRefundedAmount:
        ["NO_REFUND_CLOSED", "REJECTED_CLOSED"].includes(completionStatus) &&
        completionRefundedAmount.value === null
          ? 0
          : completionRefundedAmount.value,
      completionRefundedShipping: completionRefundedShipping.value,
      completionCurrencyCode,
      completionNotes,
    },
  };
}

export async function updateWithdrawalCompletionRecord({
  id,
  formData,
  changedBy = "admin",
  prismaClient = prisma,
} = {}) {
  const normalized = normalizeWithdrawalCompletionFormData(formData);

  if (!normalized.ok) {
    return {
      ok: false,
      status: 400,
      error: "invalid_completion_record",
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
  const currentCompletionStatus = String(
    current.completionStatus || "UNDECIDED",
  ).toUpperCase();

  if (
    currentCompletionStatus !== "UNDECIDED" &&
    values.completionStatus === "UNDECIDED"
  ) {
    return {
      ok: false,
      status: 400,
      error: "completion_reset_not_allowed",
    };
  }

  const now = new Date();
  const nextStatus = mapCompletionStatusToWithdrawalStatus(
    values.completionStatus,
    current.status,
  );
  if (!isAllowedWithdrawalStatusTransition(current.status, nextStatus)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_completion_status_transition",
    };
  }

  const shouldMarkCompleted = values.completionStatus !== "UNDECIDED";
  const updated = await prismaClient.$transaction(async (tx) => {
    const next = await tx.withdrawalRequest.update({
      where: { id },
      data: {
        ...values,
        status: nextStatus,
        completedAt: shouldMarkCompleted ? current.completedAt || now : null,
        completionRecordedAt: shouldMarkCompleted ? now : null,
        completionRecordedBy: shouldMarkCompleted ? changedBy : null,
      },
    });

    await tx.withdrawalRequestStatusHistory.create({
      data: {
        withdrawalRequestId: id,
        fromStatus: current.status,
        toStatus: nextStatus,
        changedBy,
        reason: "completion_recorded",
        metadataJson: {
          completion: values,
        },
      },
    });

    return next;
  });

  return { ok: true, withdrawalRequest: updated };
}

export async function sendWithdrawalCompletionEmail({
  withdrawalRequestId,
  prismaClient = prisma,
} = {}) {
  const withdrawalRequest = await prismaClient.withdrawalRequest.findUnique({
    where: { id: withdrawalRequestId },
  });

  if (!withdrawalRequest) {
    return { ok: false, error: "withdrawal_request_not_found" };
  }

  if (!withdrawalRequest.completedAt) {
    return { ok: false, error: "withdrawal_request_not_completed" };
  }

  const email = buildCompletionEmail(withdrawalRequest);
  const result = await sendWithdrawalEmail({
    prismaClient,
    withdrawalRequest,
    emailType: "completion",
    subject: email.subject,
    bodyText: email.text,
    bodyHtml: email.html,
  });

  if (!result.ok) {
    return result;
  }

  await prismaClient.withdrawalRequest.update({
    where: { id: withdrawalRequest.id },
    data: {
      completionNotifiedAt: result.sentAt,
      completionEmailMessageId: result.providerMessageId,
    },
  });

  return result;
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

function hashReturnProofToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token || ""))
    .digest("hex");
}

function buildReturnProofUrl({ request, withdrawalRequestId, token }) {
  const baseUrl =
    process.env.WITHDRAWAL_PUBLIC_BASE_URL ||
    process.env.APP_URL ||
    (request?.url ? new URL(request.url).origin : "http://localhost:3000");
  const url = new URL("/apps/vendors/withdrawal/return-proof", baseUrl);

  url.searchParams.set("request", withdrawalRequestId);
  url.searchParams.set("token", token);

  return url.toString();
}

function normalizeText(value, maxLength = null) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  const limit = Number(maxLength);
  return Number.isSafeInteger(limit) && limit > 0
    ? normalized.slice(0, limit)
    : normalized;
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

function parseOptionalMoneyAmount(value, currencyCode) {
  const text = String(value ?? "").replace(/,/g, "").trim();

  if (!text) {
    return { value: null, invalid: false };
  }

  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    return { value: null, invalid: true };
  }

  const digits = getCurrencyMinorUnitDigits(currencyCode);
  const [wholePart, decimalPart = ""] = text.split(".");

  if (decimalPart.length > digits) {
    return { value: null, invalid: true };
  }

  if (digits === 0 && decimalPart && Number(decimalPart) !== 0) {
    return { value: null, invalid: true };
  }

  const whole = Number(wholePart);

  if (!Number.isSafeInteger(whole) || whole < 0) {
    return { value: null, invalid: true };
  }

  const multiplier = 10 ** digits;
  const paddedDecimal = digits
    ? decimalPart.padEnd(digits, "0").slice(0, digits)
    : "";
  const decimal = paddedDecimal ? Number(paddedDecimal) : 0;
  const amount = whole * multiplier + decimal;

  if (!Number.isSafeInteger(amount) || amount < 0) {
    return { value: null, invalid: true };
  }

  return { value: amount, invalid: false };
}

function getCurrencyMinorUnitDigits(currencyCode) {
  const normalized = String(currencyCode || "JPY").trim().toUpperCase();
  return ZERO_DECIMAL_CURRENCIES.has(normalized) ? 0 : 2;
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

function isFutureDate(value) {
  const date = parseDateInput(value);
  if (!date) return false;

  const today = new Date();
  today.setHours(23, 59, 59, 999);

  return date.getTime() > today.getTime();
}

function getWithdrawalDeadlineAt(baseDate) {
  const deadline = addDays(baseDate, 14);
  deadline.setHours(23, 59, 59, 999);

  while (deadline.getDay() === 0 || deadline.getDay() === 6) {
    deadline.setDate(deadline.getDate() + 1);
    deadline.setHours(23, 59, 59, 999);
  }

  return deadline;
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
  const lineItems =
    getJsonArray(metadata.lineItems).length > 0
      ? getJsonArray(metadata.lineItems)
      : getJsonArray(metadata.line_items);
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
    lineItems,
  };
}

function serializeShopifyOrderSnapshot(order, shopDomain) {
  const totalPrice = serializeShopifyMoneySetAsMinorUnits(order.totalPriceSet);
  const currentTotalPrice = serializeShopifyMoneySetAsMinorUnits(
    order.currentTotalPriceSet,
  );
  const totalRefunded = serializeShopifyMoneySetAsMinorUnits(order.totalRefundedSet);
  const currencyCode =
    currentTotalPrice.currencyCode ||
    totalPrice.currencyCode ||
    totalRefunded.currencyCode ||
    "JPY";
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
    shippingCountryCode:
      shippingAddress?.countryCodeV2 ||
      shippingAddress?.countryCode ||
      shippingAddress?.country_code ||
      null,
    shippingAddress,
    lineItems: getJsonArray(order.lineItems?.nodes).map((line) =>
      serializeShopifyOrderLineSnapshot(line, currencyCode),
    ),
  };
}

function serializeShopifyOrderLineSnapshot(line, fallbackCurrencyCode) {
  const originalTotal = serializeShopifyMoneySetAsMinorUnits(
    line?.originalTotalSet,
    fallbackCurrencyCode,
  );
  const discountedTotal = serializeShopifyMoneySetAsMinorUnits(
    line?.discountedTotalSet,
    fallbackCurrencyCode,
  );

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
    currencyCode:
      discountedTotal.currencyCode ||
      originalTotal.currencyCode ||
      fallbackCurrencyCode ||
      "JPY",
  };
}

function normalizeShopifyOrderGid(value) {
  const raw = normalizeText(value);
  if (!raw) return null;
  if (raw.startsWith("gid://shopify/Order/")) return raw;

  const gidMatch = raw.match(/\/Order\/(\d+)/);
  if (gidMatch) return `gid://shopify/Order/${gidMatch[1]}`;

  const numericMatch = raw.match(/\d{6,}/);
  return numericMatch ? `gid://shopify/Order/${numericMatch[0]}` : null;
}

function serializeLiveShopifyOrderStatus(order) {
  const totalPrice = serializeShopifyMoneySet(order.totalPriceSet);
  const currentTotalPrice = serializeShopifyMoneySet(order.currentTotalPriceSet);
  const totalRefunded = serializeShopifyMoneySet(order.totalRefundedSet);

  return {
    id: order.id,
    name: order.name,
    email: order.email,
    createdAt: order.createdAt || null,
    processedAt: order.processedAt || null,
    cancelledAt: order.cancelledAt || null,
    cancelReason: order.cancelReason || null,
    financialStatus: order.displayFinancialStatus || null,
    fulfillmentStatus: order.displayFulfillmentStatus || null,
    totalAmount: totalPrice.amount,
    currentTotalAmount: currentTotalPrice.amount,
    totalRefundedAmount: totalRefunded.amount,
    currencyCode:
      currentTotalPrice.currencyCode ||
      totalPrice.currencyCode ||
      totalRefunded.currencyCode ||
      null,
  };
}

function serializeShopifyMoneySet(value) {
  const money = value?.shopMoney || value?.presentmentMoney || null;
  const amount = Number(money?.amount);

  return {
    amount: Number.isFinite(amount) ? amount : null,
    currencyCode: money?.currencyCode || null,
  };
}

function serializeShopifyMoneySetAsMinorUnits(value, fallbackCurrencyCode = "JPY") {
  const money = value?.shopMoney || value?.presentmentMoney || null;
  const currencyCode = money?.currencyCode || fallbackCurrencyCode || "JPY";
  const amount = Number(money?.amount);

  if (!Number.isFinite(amount)) {
    return { amount: null, currencyCode };
  }

  const multiplier = 10 ** getCurrencyMinorUnitDigits(currencyCode);
  const minorUnits = Math.round(amount * multiplier);

  return {
    amount: Number.isSafeInteger(minorUnits) ? minorUnits : null,
    currencyCode,
  };
}

function escapeShopifySearchValue(value) {
  const raw = normalizeText(value) || "";
  return `"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sanitizeShopifyLiveStatusError(error) {
  const raw = error instanceof Error ? error.message : String(error || "");

  if (!raw) return "shopify_live_status_failed";
  if (raw.includes("Offline session not found")) return "offline_session_not_found";
  if (raw.includes("authentication failed")) return "shopify_authentication_failed";
  if (raw.includes("Shopify GraphQL errors")) return "shopify_graphql_error";

  return raw.slice(0, 180);
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
    "汚れ",
    "汚損",
    "使用",
    "使用済み",
    "開封",
    "開封済み",
    "破損",
    "汚れ",
    "汚損",
    "使用",
    "使用済み",
    "開封",
    "開封済み",
    "damaged",
    "dirty",
    "used",
    "opened",
    "破損",
    "汚れ",
    "汚損",
    "使用",
    "使用済み",
    "着用",
    "開封",
    "開封済み",
    "傷",
    "欠品",
  ].some((keyword) => text.includes(keyword));
}

function getOrderStateReview(orderSnapshot) {
  if (!orderSnapshot) return null;

  const financialStatus = String(orderSnapshot.financialStatus || "")
    .trim()
    .toUpperCase();
  const fulfillmentStatus = String(orderSnapshot.fulfillmentStatus || "")
    .trim()
    .toUpperCase();
  const totalRefundedAmount = Number(orderSnapshot.totalRefundedAmount || 0);
  const currentTotalAmount = Number(orderSnapshot.currentTotalAmount ?? NaN);

  if (orderSnapshot.cancelledAt || financialStatus.includes("VOIDED")) {
    return "注文がすでにキャンセル済みの可能性があります。撤回申請として扱うか確認してください。";
  }

  if (
    financialStatus.includes("REFUNDED") ||
    totalRefundedAmount > 0 ||
    currentTotalAmount === 0
  ) {
    return "注文がすでに全額または一部返金済みの可能性があります。二重返金にならないよう確認してください。";
  }

  if (fulfillmentStatus.includes("UNFULFILLED")) {
    return null;
  }

  return null;
}

function hasWithdrawalExemptionSignal(values, orderSnapshot) {
  const selectedValues = new Set(
    [
      ...getJsonArray(values?.selectedLineItems),
      values?.itemText,
      values?.itemCondition,
      values?.reason,
    ]
      .map((value) => normalizeText(value))
      .filter(Boolean),
  );
  const lines = getJsonArray(orderSnapshot?.lineItems);
  const lineText = lines
    .filter((line) => {
      if (selectedValues.size === 0) return true;

      const candidates = [
        line.id,
        line.shopifyLineItemId,
        line.shopifyProductId,
        line.shopifyVariantId,
        line.productId,
        line.title,
        line.name,
      ]
        .map((value) => normalizeText(value))
        .filter(Boolean);

      return candidates.some((candidate) => selectedValues.has(candidate));
    })
    .map((line) =>
      [
        line.title,
        line.name,
        line.productType,
        line.vendor,
        line.sku,
        line.category,
      ]
        .map((value) => normalizeText(value))
        .filter(Boolean)
        .join(" "),
    )
    .join(" ");
  const text = [
    values?.itemText,
    values?.itemCondition,
    values?.reason,
    lineText,
  ]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");

  return [
    "custom",
    "personalized",
    "made to order",
    "digital",
    "download",
    "perishable",
    "hygiene",
    "sealed",
    "consumable",
    "bespoke",
    "カスタム",
    "オーダーメイド",
    "名入れ",
    "受注生産",
    "デジタル",
    "ダウンロード",
    "生鮮",
    "食品",
    "衛生",
    "封印",
    "開封",
    "消耗品",
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

async function resolveWithdrawalVendorNotificationRecipients({
  withdrawalRequest,
  prismaClient,
}) {
  if (!prismaClient?.sellerOrder?.findMany || !prismaClient?.seller?.findMany) {
    return [];
  }

  const sellerOrderWhere = { OR: [] };
  const marketplaceOrderId = normalizeText(withdrawalRequest?.marketplaceOrderId);
  const shopifyOrderId = normalizeText(withdrawalRequest?.shopifyOrderId);

  if (marketplaceOrderId) {
    sellerOrderWhere.OR.push({ marketplaceOrderId });
  }

  if (shopifyOrderId) {
    sellerOrderWhere.OR.push({ shopifyOrderId });
  }

  if (sellerOrderWhere.OR.length === 0) {
    return [];
  }

  const sellerOrders = await prismaClient.sellerOrder.findMany({
    where: sellerOrderWhere,
    include: {
      lines: true,
    },
    orderBy: {
      createdAt: "asc",
    },
  });
  const affectedSellerOrders = sellerOrders.filter((sellerOrder) =>
    sellerOrderTouchesWithdrawal(sellerOrder, withdrawalRequest),
  );

  if (affectedSellerOrders.length === 0) {
    return [];
  }

  const sellerIds = [
    ...new Set(
      affectedSellerOrders
        .map((sellerOrder) => normalizeText(sellerOrder.sellerId))
        .filter(Boolean),
    ),
  ];
  const vendorStoreIds = [
    ...new Set(
      affectedSellerOrders
        .map((sellerOrder) => normalizeText(sellerOrder.vendorStoreId))
        .filter(Boolean),
    ),
  ];
  const sellerWhere = { OR: [] };

  if (sellerIds.length > 0) {
    sellerWhere.OR.push({ id: { in: sellerIds } });
  }

  if (vendorStoreIds.length > 0) {
    sellerWhere.OR.push({ vendorStoreId: { in: vendorStoreIds } });
  }

  if (sellerWhere.OR.length === 0) {
    return [];
  }

  const sellers = await prismaClient.seller.findMany({
    where: sellerWhere,
    include: {
      vendor: true,
      vendorStore: true,
    },
  });
  const sellerById = new Map(
    sellers.map((seller) => [normalizeText(seller.id), seller]),
  );
  const sellerByVendorStoreId = new Map(
    sellers.map((seller) => [normalizeText(seller.vendorStoreId), seller]),
  );
  const groupedByEmail = new Map();

  for (const sellerOrder of affectedSellerOrders) {
    const seller =
      sellerById.get(normalizeText(sellerOrder.sellerId)) ||
      sellerByVendorStoreId.get(normalizeText(sellerOrder.vendorStoreId));
    const email = normalizeEmail(
      seller?.vendor?.managementEmail || seller?.vendorStore?.email,
    );

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
      lineTitles: new Set(),
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

  return Array.from(groupedByEmail.values()).map((recipient) => ({
    email: recipient.email,
    vendorIds: Array.from(recipient.vendorIds),
    sellerIds: Array.from(recipient.sellerIds),
    vendorStoreIds: Array.from(recipient.vendorStoreIds),
    storeNames: Array.from(recipient.storeNames),
    sellerOrderIds: Array.from(recipient.sellerOrderIds),
    lineTitles: Array.from(recipient.lineTitles),
  }));
}

function sellerOrderTouchesWithdrawal(sellerOrder, withdrawalRequest) {
  if (!sellerOrder || !withdrawalRequest) {
    return false;
  }

  const requestMarketplaceOrderId = normalizeText(withdrawalRequest.marketplaceOrderId);
  const requestShopifyOrderId = normalizeText(withdrawalRequest.shopifyOrderId);
  const sameOrder =
    (requestMarketplaceOrderId &&
      requestMarketplaceOrderId === normalizeText(sellerOrder.marketplaceOrderId)) ||
    (requestShopifyOrderId &&
      requestShopifyOrderId === normalizeText(sellerOrder.shopifyOrderId));

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

  return (Array.isArray(sellerOrder.lines) ? sellerOrder.lines : []).some((line) =>
    lineMatchesSelectedWithdrawalValues(line, selectedValues),
  );
}

function getWithdrawalSelectedLineValues(withdrawalRequest) {
  const selectedLineItemsJson = getJsonObject(withdrawalRequest?.selectedLineItemsJson);
  const submittedPayloadJson = getJsonObject(withdrawalRequest?.submittedPayloadJson);
  const values = [
    ...getJsonArray(selectedLineItemsJson.selectedLineItems),
    ...getJsonArray(submittedPayloadJson.selectedLineItems),
  ];

  return new Set(values.map((value) => normalizeText(value)).filter(Boolean));
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
    .map((value) => normalizeText(value))
    .filter(Boolean);

  return candidates.some((candidate) => selectedValues.has(candidate));
}

function getJsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function getJsonArray(value) {
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
  instructionId = null,
}) {
  const fromEmail = getWithdrawalFromEmail();
  const recipientEmail = normalizeEmail(toEmail || withdrawalRequest.customerEmail);
  const sentAt = new Date();

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
        errorMessage: !recipientEmail
          ? "Recipient email is not configured."
          : "RESEND_API_KEY or sender email is not configured.",
      },
    });

    return {
      ok: false,
      error: !recipientEmail ? "recipient_email_not_configured" : "email_not_configured",
    };
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const response = await resend.emails.send({
      from: fromEmail,
      to: recipientEmail,
      subject,
      text: bodyText,
      html: bodyHtml,
    });

    if (response?.error) {
      const message =
        response.error?.message ||
        response.error?.name ||
        JSON.stringify(response.error);

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
          errorMessage: message,
        },
      });

      return {
        ok: false,
        error: message,
      };
    }

    const providerMessageId =
      response?.data?.id || response?.id || response?.messageId || null;

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
        returnGroupId,
        instructionId,
        emailType,
        toEmail: recipientEmail,
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
  return buildAcknowledgementEmailV3(withdrawalRequest);

  const supportEmail = getWithdrawalSupportEmail();
  const customerName = withdrawalRequest.customerName || "お客様";
  const orderName =
    withdrawalRequest.shopifyOrderName || withdrawalRequest.shopifyOrderNumber || "-";
  const scopeLabel =
    withdrawalRequest.withdrawalScope === "PARTIAL" ? "一部商品" : "注文全体";
  const subject = "撤回申請を受け付けました";
  const bodyLines = [
    `${customerName} 様`,
    "",
    "撤回申請を受け付けました。申請内容を確認し、必要な手続きをメールでご案内します。",
    "",
    `受付番号: ${withdrawalRequest.id}`,
    `注文番号: ${orderName}`,
    `撤回対象: ${scopeLabel}`,
    `受付日時: ${formatDateTime(new Date())}`,
    "",
    "返金は自動実行されません。注文内容、返送状況、商品の状態を確認してから処理します。",
    "撤回が認められる場合、商品代金および通常配送方法に相当する初回送料を返金対象として確認します。",
    "通常配送より高い配送方法を選択された場合、その追加費用は返金対象外となる場合があります。",
    "商品の返送にかかる送料は、当店が別途負担すると案内した場合、または法令により当店負担となる場合を除き、お客様負担となる場合があります。",
    "商品の確認に必要な範囲を超えて使用、汚損、破損がある場合、返金額が減額されることがあります。",
    "",
    supportEmail ? `お問い合わせ: ${supportEmail}` : "",
  ].filter((line) => line !== "");
  const text = bodyLines.join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;line-height:1.8;color:#111">${bodyLines
    .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<br>"))
    .join("")}</div>`;

  return { subject, text, html };
}

function buildReturnInstructionsEmail({
  withdrawalRequest,
  returnProofUrl,
  expiresAt,
}) {
  return buildReturnInstructionsEmailV3({
    withdrawalRequest,
    returnProofUrl,
    expiresAt,
  });

  const supportEmail = getWithdrawalSupportEmail();
  const customerName = withdrawalRequest.customerName || "お客様";
  const orderName =
    withdrawalRequest.shopifyOrderName || withdrawalRequest.shopifyOrderNumber || "-";
  const subject = "返送証明の提出をお願いします";
  const bodyLines = [
    `${customerName} 様`,
    "",
    "撤回申請の確認を進めるため、商品の返送後に追跡番号または追跡URLを提出してください。",
    "以下のリンクから返送証明を提出できます。",
    "",
    `返送証明提出リンク: ${returnProofUrl}`,
    `受付番号: ${withdrawalRequest.id}`,
    `注文番号: ${orderName}`,
    `リンク有効期限: ${formatDateTime(expiresAt)}`,
    "",
    "返送証明の提出だけでは返金は自動実行されません。返送状況と商品の状態を確認したうえで、キャンセルまたは返金手続きを進めます。",
    "通常配送分の初回送料は返金対象として確認しますが、追加配送費用や返送送料はお客様負担となる場合があります。",
    supportEmail ? `お問い合わせ: ${supportEmail}` : "",
  ].filter((line) => line !== "");
  const text = bodyLines.join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;line-height:1.8;color:#111">${bodyLines
    .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<br>"))
    .join("")}</div>`;

  return { subject, text, html };
}

function buildAcknowledgementEmailV2(withdrawalRequest) {
  const supportEmail = getWithdrawalSupportEmail();
  const customerName = withdrawalRequest.customerName || "お客様";
  const orderName =
    withdrawalRequest.shopifyOrderName || withdrawalRequest.shopifyOrderNumber || "-";
  const scopeLabel =
    withdrawalRequest.withdrawalScope === "PARTIAL" ? "一部の商品" : "注文全体";
  const submittedAt =
    withdrawalRequest.createdAt ||
    parseDateInput(withdrawalRequest.submittedPayloadJson?.submittedAt) ||
    new Date();
  const itemSummary = formatSelectedWithdrawalItems(withdrawalRequest);
  const subject = "撤回申請を受け付けました";
  const bodyLines = [
    `${customerName} 様`,
    "",
    "撤回申請を受け付けました。申請内容、返送状況、商品状態を確認したうえで処理します。",
    "",
    `受付番号: ${withdrawalRequest.id}`,
    `注文番号: ${orderName}`,
    `撤回対象: ${scopeLabel}`,
    `対象商品: ${itemSummary}`,
    `申請日時: ${formatDateTime(submittedAt)}`,
    withdrawalRequest.receivedDate
      ? `商品受取日: ${formatDateTime(withdrawalRequest.receivedDate)}`
      : "商品受取日: 未確認",
    withdrawalRequest.countryLabel || withdrawalRequest.countryCode
      ? `対象国: ${withdrawalRequest.countryLabel || withdrawalRequest.countryCode}`
      : "",
    withdrawalRequest.itemCondition
      ? `申告された商品状態: ${withdrawalRequest.itemCondition}`
      : "",
    "",
    "返金は自動実行されません。通常配送方法に相当する初回送料は返金対象として確認しますが、追加配送費用や返送送料はお客様負担となる場合があります。",
    "商品の確認に必要な範囲を超えて使用、汚損、破損がある場合、返金額が減額されることがあります。",
    "",
    supportEmail ? `お問い合わせ先: ${supportEmail}` : "",
  ].filter((line) => line !== "");

  return buildPlainAndHtmlEmail({ subject, bodyLines });
}

function buildReturnInstructionsEmailV2({
  withdrawalRequest,
  returnProofUrl,
  expiresAt,
}) {
  const supportEmail = getWithdrawalSupportEmail();
  const returnAddressLines = getWithdrawalReturnAddressLines();
  const customerName = withdrawalRequest.customerName || "お客様";
  const orderName =
    withdrawalRequest.shopifyOrderName || withdrawalRequest.shopifyOrderNumber || "-";
  const subject = "返送証明の提出をお願いします";
  const bodyLines = [
    `${customerName} 様`,
    "",
    "撤回申請の確認を進めるため、返送後に追跡番号または追跡URLを提出してください。",
    "",
    returnAddressLines.length > 0 ? "返送先:" : "返送先:",
    ...(returnAddressLines.length > 0
      ? returnAddressLines
      : ["返送先は別途ご案内します。案内前に返送しないでください。"]),
    "",
    `返送証明提出リンク: ${returnProofUrl}`,
    `受付番号: ${withdrawalRequest.id}`,
    `注文番号: ${orderName}`,
    `リンク有効期限: ${formatDateTime(expiresAt)}`,
    "",
    "返送証明の提出だけでは返金は自動実行されません。返送状況と商品状態を確認したうえで、キャンセルまたは返金手続きを進めます。",
    "通常配送分の初回送料は返金対象として確認しますが、追加配送費用や返送送料はお客様負担となる場合があります。",
    supportEmail ? `お問い合わせ先: ${supportEmail}` : "",
  ].filter((line) => line !== "");

  return buildPlainAndHtmlEmail({ subject, bodyLines });
}

function buildPlainAndHtmlEmail({ subject, bodyLines }) {
  const text = bodyLines.join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;line-height:1.8;color:#111">${bodyLines
    .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<br>"))
    .join("")}</div>`;

  return { subject, text, html };
}

function formatSelectedWithdrawalItemsLegacy(withdrawalRequest) {
  const selectedLineItemsJson = getJsonObject(withdrawalRequest?.selectedLineItemsJson);
  const submittedPayloadJson = getJsonObject(withdrawalRequest?.submittedPayloadJson);
  const lineItems = getJsonArray(selectedLineItemsJson.orderLineItems);
  const selectedValues = getWithdrawalSelectedLineValues(withdrawalRequest);

  if (String(withdrawalRequest?.withdrawalScope || "FULL").toUpperCase() !== "PARTIAL") {
    return "注文全体";
  }

  const selectedLines = lineItems
    .filter((line) => {
      if (selectedValues.size === 0) return false;
      const candidates = [
        line.id,
        line.shopifyLineItemId,
        line.shopifyProductId,
        line.shopifyVariantId,
        line.productId,
        line.variantId,
        line.title,
      ]
        .map((value) => normalizeText(value))
        .filter(Boolean);

      return candidates.some((candidate) => selectedValues.has(candidate));
    })
    .map((line) => {
      const quantity = Number(line.quantity || 1);
      return `${line.title || line.name || "商品"} x ${Number.isFinite(quantity) ? quantity : 1}`;
    });

  if (selectedLines.length > 0) {
    return selectedLines.join(" / ");
  }

  return (
    getJsonArray(selectedLineItemsJson.selectedLineItems).join(" / ") ||
    submittedPayloadJson.itemText ||
    selectedLineItemsJson.freeText ||
    "一部の商品"
  );
}

function getWithdrawalReturnAddressLines() {
  const raw = normalizeText(process.env.WITHDRAWAL_RETURN_ADDRESS);

  if (!raw) {
    return [];
  }

  return raw
    .replace(/\\n/g, "\n")
    .split(/\r?\n/)
    .map((line) => normalizeText(line, 180))
    .filter(Boolean);
}

function buildAcknowledgementEmailV3Legacy(withdrawalRequest) {
  const supportEmail = getWithdrawalSupportEmail();
  const customerName = withdrawalRequest.customerName || "お客様";
  const submittedAt =
    withdrawalRequest.createdAt ||
    parseDateInput(withdrawalRequest.submittedPayloadJson?.submittedAt) ||
    new Date();
  const bodyLines = [
    `${customerName} 様`,
    "",
    "撤回申請を受け付けました。申請内容、返送状況、商品の状態を確認してから処理します。",
    "",
    `受付番号: ${withdrawalRequest.id}`,
    `注文番号: ${getWithdrawalOrderName(withdrawalRequest)}`,
    `撤回対象: ${getWithdrawalScopeLabel(withdrawalRequest)}`,
    `対象商品: ${formatSelectedWithdrawalItems(withdrawalRequest)}`,
    `申請日時: ${formatDateTime(submittedAt)}`,
    withdrawalRequest.receivedDate
      ? `商品受取日: ${formatDateTime(withdrawalRequest.receivedDate)}`
      : "商品受取日: 未確認",
    withdrawalRequest.countryLabel || withdrawalRequest.countryCode
      ? `対象国: ${withdrawalRequest.countryLabel || withdrawalRequest.countryCode}`
      : "",
    "",
    "返金は自動実行されません。撤回が認められる場合、商品代金および通常配送方法に相当する初回送料を返金対象として確認します。",
    "通常配送より高い配送方法を選択された場合、その追加費用は返金対象外となる場合があります。返送送料は、お客様負担となる場合があります。",
    "商品の確認に必要な範囲を超えて使用・汚損・破損がある場合、返金額が減額されることがあります。",
    "",
    supportEmail ? `お問い合わせ: ${supportEmail}` : "",
  ].filter((line) => line !== "");

  return buildPlainAndHtmlEmail({
    subject: "撤回申請を受け付けました",
    bodyLines,
  });
}

function buildReturnInstructionsEmailV3Legacy({
  withdrawalRequest,
  returnProofUrl,
  expiresAt,
}) {
  const supportEmail = getWithdrawalSupportEmail();
  const returnAddressLines = getWithdrawalReturnAddressLines();
  const bodyLines = [
    `${withdrawalRequest.customerName || "お客様"} 様`,
    "",
    "撤回申請の確認を進めるため、商品の返送情報または返送証明を提出してください。",
    "",
    `返送証明の提出リンク: ${returnProofUrl}`,
    `受付番号: ${withdrawalRequest.id}`,
    `注文番号: ${getWithdrawalOrderName(withdrawalRequest)}`,
    `リンク有効期限: ${formatDateTime(expiresAt)}`,
    "",
    returnAddressLines.length > 0 ? "返送先:" : "返送先は別途ご案内します。",
    ...returnAddressLines,
    "",
    "返送証明の提出だけでは返金は自動実行されません。返送状況と商品の状態を確認してから処理します。",
    "通常配送分の初回送料は返金対象として確認しますが、追加配送費用や返送送料はお客様負担となる場合があります。",
    supportEmail ? `お問い合わせ: ${supportEmail}` : "",
  ].filter((line) => line !== "");

  return buildPlainAndHtmlEmail({
    subject: "返送情報の提出をお願いします",
    bodyLines,
  });
}

function buildCompletionEmailV3Legacy(withdrawalRequest) {
  const supportEmail = getWithdrawalSupportEmail();
  const currencyCode =
    withdrawalRequest.completionCurrencyCode ||
    withdrawalRequest.refundCurrencyCode ||
    getSnapshotCurrencyCode(withdrawalRequest) ||
    "JPY";
  const bodyLines = [
    `${withdrawalRequest.customerName || "お客様"} 様`,
    "",
    "撤回申請の確認が完了しました。処理結果をお知らせします。",
    "",
    `受付番号: ${withdrawalRequest.id}`,
    `注文番号: ${getWithdrawalOrderName(withdrawalRequest)}`,
    `処理結果: ${getCompletionStatusLabelV3(withdrawalRequest.completionStatus)}`,
    `返金処理額: ${formatMoneyText(withdrawalRequest.completionRefundedAmount, currencyCode)}`,
    `初回送料の返金額: ${formatMoneyText(withdrawalRequest.completionRefundedShipping, currencyCode)}`,
    withdrawalRequest.completionAction
      ? `処理内容: ${withdrawalRequest.completionAction}`
      : "",
    withdrawalRequest.completionNotes ? `補足: ${withdrawalRequest.completionNotes}` : "",
    "",
    "返金の反映時期は、ご利用の決済方法やカード会社により異なります。",
    supportEmail ? `お問い合わせ: ${supportEmail}` : "",
  ].filter((line) => line !== "");

  return buildPlainAndHtmlEmail({
    subject: "撤回申請の処理結果をお知らせします",
    bodyLines,
  });
}

function buildVendorNotificationEmailV3Legacy({ withdrawalRequest, recipient }) {
  const supportEmail = getWithdrawalSupportEmail();
  const storeNames =
    Array.isArray(recipient?.storeNames) && recipient.storeNames.length > 0
      ? recipient.storeNames.join(" / ")
      : "出店者";
  const lineTitles =
    Array.isArray(recipient?.lineTitles) && recipient.lineTitles.length > 0
      ? recipient.lineTitles.join(" / ")
      : getWithdrawalScopeLabel(withdrawalRequest);
  const vendorUrl = buildVendorWithdrawalUrl(withdrawalRequest, recipient);
  const bodyLines = [
    `${storeNames} 様`,
    "",
    "購入者から撤回申請が届きました。注文内容、発送状況、返送状況、商品の状態確認にご協力ください。",
    "",
    `受付番号: ${withdrawalRequest.id}`,
    `注文番号: ${getWithdrawalOrderName(withdrawalRequest)}`,
    `撤回対象: ${getWithdrawalScopeLabel(withdrawalRequest)}`,
    `対象商品: ${lineTitles}`,
    `購入者: ${withdrawalRequest.customerName || "-"}`,
    `申請日時: ${formatDateTime(withdrawalRequest.createdAt || new Date())}`,
    "",
    "管理者が最終判断を行います。発送済みの場合は、返送・追跡番号・商品状態を店舗側の撤回申請ページで更新してください。",
    vendorUrl ? `店舗側確認ページ: ${vendorUrl}` : "",
    supportEmail ? `問い合わせ先: ${supportEmail}` : "",
  ].filter((line) => line !== "");

  return buildPlainAndHtmlEmail({
    subject: `撤回申請の確認が必要です ${getWithdrawalOrderName(withdrawalRequest)}`,
    bodyLines,
  });
}

function buildStatusEmailV3Legacy(withdrawalRequest) {
  const supportEmail = getWithdrawalSupportEmail();
  const statusLabel = getWithdrawalStatusLabel(withdrawalRequest.status);
  const bodyLines = [
    `${withdrawalRequest.customerName || "お客様"} 様`,
    "",
    `撤回申請の状態が「${statusLabel}」に更新されました。`,
    getStatusCustomerMessageV3(withdrawalRequest.status),
    "",
    `受付番号: ${withdrawalRequest.id}`,
    `注文番号: ${getWithdrawalOrderName(withdrawalRequest)}`,
    supportEmail ? `お問い合わせ: ${supportEmail}` : "",
  ].filter((line) => line !== "");

  return buildPlainAndHtmlEmail({
    subject: `撤回申請の状態: ${statusLabel}`,
    bodyLines,
  });
}

function getWithdrawalOrderName(withdrawalRequest) {
  return (
    withdrawalRequest?.shopifyOrderName ||
    withdrawalRequest?.shopifyOrderNumber ||
    withdrawalRequest?.submittedPayloadJson?.orderNumber ||
    "-"
  );
}

function getWithdrawalScopeLabelLegacy(withdrawalRequest) {
  return withdrawalRequest?.withdrawalScope === "PARTIAL"
    ? "一部の商品"
    : "注文全体";
}

function getStatusCustomerMessageV3Legacy(status) {
  switch (status) {
    case WITHDRAWAL_STATUSES.UNDER_REVIEW:
      return "申請内容、返送状況、商品の状態を確認しています。";
    case WITHDRAWAL_STATUSES.APPROVED:
      return "撤回申請を確認しました。必要な返送や返金手続きについて続けて案内します。";
    case WITHDRAWAL_STATUSES.RETURN_REQUESTED:
      return "商品の返送または返送証明の提出が必要です。案内メールを確認してください。";
    case WITHDRAWAL_STATUSES.RETURN_RECEIVED:
      return "返送品または返送証明を確認しました。商品の状態確認後、返金可否を判断します。";
    case WITHDRAWAL_STATUSES.REFUND_PENDING:
      return "返金手続きの準備中です。";
    case WITHDRAWAL_STATUSES.REFUNDED:
      return "返金処理が完了しました。反映時期は決済方法により異なります。";
    case WITHDRAWAL_STATUSES.CANCELLED:
      return "対象注文のキャンセル処理が完了しました。";
    case WITHDRAWAL_STATUSES.REJECTED:
      return "確認の結果、今回の申請は撤回対象外として処理されました。";
    case WITHDRAWAL_STATUSES.EXPIRED:
      return "確認の結果、申請期限を過ぎている可能性があるため期限切れとして処理されました。";
    case WITHDRAWAL_STATUSES.ERROR:
      return "確認が必要な状態です。内容を確認して必要に応じて連絡します。";
    case WITHDRAWAL_STATUSES.ACKNOWLEDGED:
    case WITHDRAWAL_STATUSES.REQUESTED:
    default:
      return "申請内容を確認しています。確認が終わり次第、次の手続きを案内します。";
  }
}

function getCompletionStatusLabelV3Legacy(status) {
  const labels = {
    UNDECIDED: "未記録",
    REFUNDED: "返金済み",
    PARTIALLY_REFUNDED: "一部返金済み",
    CANCELLED: "キャンセル済み",
    NO_REFUND_CLOSED: "返金なしで完了",
    REJECTED_CLOSED: "対象外として完了",
    MANUAL_CLOSED: "手動完了",
  };

  return labels[String(status || "UNDECIDED").toUpperCase()] || String(status || "-");
}

function formatSelectedWithdrawalItems(withdrawalRequest) {
  const selectedLineItemsJson = getJsonObject(withdrawalRequest?.selectedLineItemsJson);
  const submittedPayloadJson = getJsonObject(withdrawalRequest?.submittedPayloadJson);
  const lineItems = getJsonArray(selectedLineItemsJson.orderLineItems);
  const selectedValues = getWithdrawalSelectedLineValues(withdrawalRequest);
  if (String(withdrawalRequest?.withdrawalScope || "FULL").toUpperCase() !== "PARTIAL") {
    return "注文全体";
  }
  const selectedLines = lineItems
    .filter((line) => {
      const candidates = [
        line.id,
        line.shopifyLineItemId,
        line.shopifyProductId,
        line.shopifyVariantId,
        line.productId,
        line.variantId,
        line.title,
      ]
        .map((value) => normalizeText(value))
        .filter(Boolean);
      return candidates.some((candidate) => selectedValues.has(candidate));
    })
    .map((line) => {
      const quantity = Number(line.quantity || 1);
      return `${line.title || line.name || "商品"} x ${Number.isFinite(quantity) ? quantity : 1}`;
    });
  return (
    selectedLines.join(" / ") ||
    getJsonArray(selectedLineItemsJson.selectedLineItems).join(" / ") ||
    submittedPayloadJson.itemText ||
    selectedLineItemsJson.freeText ||
    "一部の商品"
  );
}

function buildAcknowledgementEmailV3(withdrawalRequest) {
  const supportEmail = getWithdrawalSupportEmail();
  const submittedAt =
    withdrawalRequest.createdAt ||
    parseDateInput(withdrawalRequest.submittedPayloadJson?.submittedAt) ||
    new Date();
  const bodyLines = [
    `${withdrawalRequest.customerName || "お客様"} 様`,
    "",
    "撤回申請を受け付けました。注文内容、返送状況、商品状態を確認してから処理します。",
    "",
    `受付番号: ${withdrawalRequest.id}`,
    `注文番号: ${getWithdrawalOrderName(withdrawalRequest)}`,
    `撤回対象: ${getWithdrawalScopeLabel(withdrawalRequest)}`,
    `対象商品: ${formatSelectedWithdrawalItems(withdrawalRequest)}`,
    `申請日時: ${formatDateTime(submittedAt)}`,
    withdrawalRequest.receivedDate
      ? `商品受取日: ${formatDateTime(withdrawalRequest.receivedDate)}`
      : "商品受取日: 未確認",
    withdrawalRequest.countryLabel || withdrawalRequest.countryCode
      ? `対象国: ${withdrawalRequest.countryLabel || withdrawalRequest.countryCode}`
      : "",
    "",
    "この時点では返金やキャンセルは自動実行されません。撤回が認められる場合、商品代金と通常配送方法に相当する初回送料を返金対象として確認します。通常配送より高い配送方法の追加費用は返金対象外となる場合があります。",
    "返送送料は、当店が負担すると案内した場合または法令上必要な場合を除き、お客様負担となる場合があります。商品を必要な確認範囲を超えて使用し価値が減少した場合は、返金額を減額することがあります。",
    supportEmail ? `お問い合わせ: ${supportEmail}` : "",
  ].filter((line) => line !== "");
  return buildPlainAndHtmlEmail({ subject: "撤回申請を受け付けました", bodyLines });
}

function buildReturnInstructionsEmailV3({
  withdrawalRequest,
  returnProofUrl,
  expiresAt,
}) {
  const supportEmail = getWithdrawalSupportEmail();
  const returnAddressLines = getWithdrawalReturnAddressLines();
  const bodyLines = [
    `${withdrawalRequest.customerName || "お客様"} 様`,
    "",
    "撤回申請の確認を進めるため、商品を返送し、返送証明を提出してください。",
    "",
    `返送証明の提出リンク: ${returnProofUrl}`,
    `受付番号: ${withdrawalRequest.id}`,
    `注文番号: ${getWithdrawalOrderName(withdrawalRequest)}`,
    `リンク有効期限: ${formatDateTime(expiresAt)}`,
    "",
    returnAddressLines.length > 0 ? "返送先:" : "返送先は別途ご案内します。",
    ...returnAddressLines,
    "",
    "返送証明の提出だけでは返金は自動実行されません。商品の到着と状態を確認してから処理します。",
    "撤回が認められる場合、通常配送方法に相当する初回送料を返金対象として確認します。追加配送費用や返送送料は、お客様負担となる場合があります。",
    supportEmail ? `お問い合わせ: ${supportEmail}` : "",
  ].filter((line) => line !== "");
  return buildPlainAndHtmlEmail({ subject: "返送方法のご案内", bodyLines });
}

function buildCompletionEmailV3(withdrawalRequest) {
  const supportEmail = getWithdrawalSupportEmail();
  const currencyCode =
    withdrawalRequest.completionCurrencyCode ||
    withdrawalRequest.refundCurrencyCode ||
    getSnapshotCurrencyCode(withdrawalRequest) ||
    "JPY";
  const bodyLines = [
    `${withdrawalRequest.customerName || "お客様"} 様`,
    "",
    "撤回申請の確認が完了しました。処理結果をお知らせします。",
    "",
    `受付番号: ${withdrawalRequest.id}`,
    `注文番号: ${getWithdrawalOrderName(withdrawalRequest)}`,
    `処理結果: ${getCompletionStatusLabelV3(withdrawalRequest.completionStatus)}`,
    `商品代金等の返金額: ${formatMoneyText(withdrawalRequest.completionRefundedAmount, currencyCode)}`,
    `初回送料の返金額: ${formatMoneyText(withdrawalRequest.completionRefundedShipping, currencyCode)}`,
    withdrawalRequest.completionAction
      ? `処理内容: ${withdrawalRequest.completionAction}`
      : "",
    withdrawalRequest.completionNotes ? `補足: ${withdrawalRequest.completionNotes}` : "",
    "",
    "返金の反映時期は、ご利用の決済方法やカード会社により異なります。",
    supportEmail ? `お問い合わせ: ${supportEmail}` : "",
  ].filter((line) => line !== "");
  return buildPlainAndHtmlEmail({ subject: "撤回申請の処理結果", bodyLines });
}

function buildVendorNotificationEmailV3({ withdrawalRequest, recipient }) {
  const supportEmail = getWithdrawalSupportEmail();
  const storeNames =
    Array.isArray(recipient?.storeNames) && recipient.storeNames.length > 0
      ? recipient.storeNames.join(" / ")
      : "販売店舗";
  const lineTitles =
    Array.isArray(recipient?.lineTitles) && recipient.lineTitles.length > 0
      ? recipient.lineTitles.join(" / ")
      : getWithdrawalScopeLabel(withdrawalRequest);
  const vendorUrl = buildVendorWithdrawalUrl(withdrawalRequest, recipient);
  const bodyLines = [
    `${storeNames} ご担当者様`,
    "",
    "撤回申請が届きました。対象商品の発送状況と返送対応の確認をお願いします。",
    `受付番号: ${withdrawalRequest.id}`,
    `注文番号: ${getWithdrawalOrderName(withdrawalRequest)}`,
    `撤回対象: ${getWithdrawalScopeLabel(withdrawalRequest)}`,
    `対象商品: ${lineTitles}`,
    `申請日時: ${formatDateTime(withdrawalRequest.createdAt || new Date())}`,
    "",
    "返金判断は運営が行います。発送済みの場合は、店舗管理画面で返送品の到着と商品状態を記録してください。",
    vendorUrl ? `店舗側確認ページ: ${vendorUrl}` : "",
    supportEmail ? `問い合わせ先: ${supportEmail}` : "",
  ].filter((line) => line !== "");
  return buildPlainAndHtmlEmail({
    subject: `撤回申請の確認が必要です: ${getWithdrawalOrderName(withdrawalRequest)}`,
    bodyLines,
  });
}

function buildStatusEmailV3(withdrawalRequest) {
  const supportEmail = getWithdrawalSupportEmail();
  const statusLabel = getWithdrawalStatusLabel(withdrawalRequest.status);
  const bodyLines = [
    `${withdrawalRequest.customerName || "お客様"} 様`,
    "",
    `撤回申請の状態が「${statusLabel}」に更新されました。`,
    getStatusCustomerMessageV3(withdrawalRequest.status),
    "",
    `受付番号: ${withdrawalRequest.id}`,
    `注文番号: ${getWithdrawalOrderName(withdrawalRequest)}`,
    supportEmail ? `お問い合わせ: ${supportEmail}` : "",
  ].filter((line) => line !== "");
  return buildPlainAndHtmlEmail({ subject: `撤回申請の状態: ${statusLabel}`, bodyLines });
}

function getWithdrawalScopeLabel(withdrawalRequest) {
  return withdrawalRequest?.withdrawalScope === "PARTIAL" ? "一部の商品" : "注文全体";
}

function getStatusCustomerMessageV3(status) {
  const messages = {
    [WITHDRAWAL_STATUSES.UNDER_REVIEW]: "申請内容、返送状況、商品状態を確認しています。",
    [WITHDRAWAL_STATUSES.APPROVED]: "撤回申請を確認しました。必要な返送や返金手続きを続けてご案内します。",
    [WITHDRAWAL_STATUSES.RETURN_REQUESTED]: "商品の返送または返送証明の提出が必要です。案内メールをご確認ください。",
    [WITHDRAWAL_STATUSES.RETURN_RECEIVED]: "返送品または返送証明を確認しました。商品状態の確認後に返金可否を判断します。",
    [WITHDRAWAL_STATUSES.REFUND_PENDING]: "返金手続きの準備中です。",
    [WITHDRAWAL_STATUSES.REFUNDED]: "返金処理が完了しました。反映時期は決済方法により異なります。",
    [WITHDRAWAL_STATUSES.CANCELLED]: "対象注文のキャンセル処理が完了しました。",
    [WITHDRAWAL_STATUSES.REJECTED]: "確認の結果、今回の申請は撤回対象外として処理されました。",
    [WITHDRAWAL_STATUSES.EXPIRED]: "確認の結果、申請期限を過ぎているため受付を終了しました。",
    [WITHDRAWAL_STATUSES.ERROR]: "確認が必要な状態です。内容を確認し、必要に応じてご連絡します。",
  };
  return messages[status] || "申請内容を確認しています。確認後に次の手続きをご案内します。";
}

function getCompletionStatusLabelV3(status) {
  const labels = {
    UNDECIDED: "未決定",
    REFUNDED: "返金済み",
    PARTIALLY_REFUNDED: "一部返金済み",
    CANCELLED: "キャンセル済み",
    NO_REFUND_CLOSED: "返金なしで完了",
    REJECTED_CLOSED: "対象外として完了",
    MANUAL_CLOSED: "手動で完了",
  };
  return labels[String(status || "UNDECIDED").toUpperCase()] || String(status || "-");
}

function buildCompletionEmail(withdrawalRequest) {
  return buildWithdrawalCompletionSnapshot(withdrawalRequest);

  const supportEmail = getWithdrawalSupportEmail();
  const customerName = withdrawalRequest.customerName || "お客様";
  const orderName =
    withdrawalRequest.shopifyOrderName || withdrawalRequest.shopifyOrderNumber || "-";
  const statusLabel = getCompletionStatusLabel(withdrawalRequest.completionStatus);
  const currencyCode =
    withdrawalRequest.completionCurrencyCode ||
    withdrawalRequest.refundCurrencyCode ||
    getSnapshotCurrencyCode(withdrawalRequest) ||
    "JPY";
  const refundedAmount = formatMoneyText(
    withdrawalRequest.completionRefundedAmount,
    currencyCode,
  );
  const refundedShipping = formatMoneyText(
    withdrawalRequest.completionRefundedShipping,
    currencyCode,
  );
  const subject = "撤回申請の処理結果をお知らせします";
  const bodyLines = [
    `${customerName} 様`,
    "",
    "撤回申請の確認が完了しました。処理結果をお知らせします。",
    "",
    `受付番号: ${withdrawalRequest.id}`,
    `注文番号: ${orderName}`,
    `処理結果: ${statusLabel}`,
    `返金処理額: ${refundedAmount}`,
    `初回送料の返金額: ${refundedShipping}`,
    withdrawalRequest.completionAction
      ? `処理内容: ${withdrawalRequest.completionAction}`
      : "",
    withdrawalRequest.completionNotes
      ? `補足: ${withdrawalRequest.completionNotes}`
      : "",
    "",
    "返金の反映時期は、ご利用の決済方法やカード会社により異なる場合があります。",
    supportEmail ? `お問い合わせ: ${supportEmail}` : "",
  ].filter((line) => line !== "");
  const text = bodyLines.join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;line-height:1.8;color:#111">${bodyLines
    .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<br>"))
    .join("")}</div>`;

  return { subject, text, html };
}

function buildVendorNotificationEmail({ withdrawalRequest, recipient }) {
  return buildVendorNotificationEmailV3({ withdrawalRequest, recipient });

  const orderName =
    withdrawalRequest.shopifyOrderName || withdrawalRequest.shopifyOrderNumber || "-";
  const scopeLabel =
    withdrawalRequest.withdrawalScope === "PARTIAL" ? "一部商品" : "注文全体";
  const storeNames =
    Array.isArray(recipient.storeNames) && recipient.storeNames.length > 0
      ? recipient.storeNames.join(" / ")
      : "出店者";
  const lineTitles =
    Array.isArray(recipient.lineTitles) && recipient.lineTitles.length > 0
      ? recipient.lineTitles.join(" / ")
      : scopeLabel;
  const vendorUrl = buildVendorWithdrawalUrl(withdrawalRequest, recipient);
  const subject = `撤回申請の確認が必要です: ${orderName}`;
  const bodyLines = [
    `${storeNames} 様`,
    "",
    "購入者から撤回申請が届きました。注文内容、発送状況、返送状況、商品状態の確認にご協力ください。",
    "",
    `受付番号: ${withdrawalRequest.id}`,
    `注文番号: ${orderName}`,
    `撤回対象: ${scopeLabel}`,
    `対象商品: ${lineTitles}`,
    `購入者: ${withdrawalRequest.customerName || "-"}`,
    `申請日時: ${formatDateTime(withdrawalRequest.createdAt || new Date())}`,
    "",
    "管理者が最終判断を行います。すでに発送済みの場合は、店舗側の撤回申請ページで返送追跡番号や商品状態を更新してください。",
    vendorUrl ? `店舗側確認ページ: ${vendorUrl}` : "",
    "",
    getWithdrawalSupportEmail()
      ? `問い合わせ先: ${getWithdrawalSupportEmail()}`
      : "",
  ].filter((line) => line !== "");
  const text = bodyLines.join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;line-height:1.8;color:#111">${bodyLines
    .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<br>"))
    .join("")}</div>`;

  return { subject, text, html };
}

function buildVendorWithdrawalUrl(withdrawalRequest, recipient) {
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

function normalizeAppBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  try {
    return new URL(raw).origin;
  } catch (_error) {
    return null;
  }
}

function buildStatusEmail(withdrawalRequest) {
  return buildWithdrawalStatusSnapshot(withdrawalRequest);

  const customerName = withdrawalRequest.customerName || "お客様";
  const orderName =
    withdrawalRequest.shopifyOrderName || withdrawalRequest.shopifyOrderNumber || "-";
  const statusLabel = getWithdrawalStatusLabel(withdrawalRequest.status);
  const subject = `撤回申請の状況: ${statusLabel}`;
  const statusMessage = getStatusCustomerMessage(withdrawalRequest.status);
  const bodyLines = [
    `${customerName} 様`,
    "",
    `撤回申請の状況が「${statusLabel}」に更新されました。`,
    statusMessage,
    "",
    `受付番号: ${withdrawalRequest.id}`,
    `注文番号: ${orderName}`,
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
      return "注文内容、返送状況、商品の状態を確認しています。確認が終わり次第、次の手続きをご案内します。";
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
      return "確認が必要な状態です。内容を確認し、必要に応じて連絡します。";
    case WITHDRAWAL_STATUSES.ACKNOWLEDGED:
    case WITHDRAWAL_STATUSES.REQUESTED:
    default:
      return "申請内容を確認しています。確認が終わり次第、次の手続きをご案内します。";
  }
}

function mapCompletionStatusToWithdrawalStatus(completionStatus, currentStatus) {
  switch (String(completionStatus || "UNDECIDED").toUpperCase()) {
    case "REFUNDED":
    case "PARTIALLY_REFUNDED":
      return WITHDRAWAL_STATUSES.REFUNDED;
    case "CANCELLED":
      return WITHDRAWAL_STATUSES.CANCELLED;
    case "NO_REFUND_CLOSED":
    case "REJECTED_CLOSED":
      return WITHDRAWAL_STATUSES.REJECTED;
    case "MANUAL_CLOSED":
    case "UNDECIDED":
    default:
      return currentStatus || WITHDRAWAL_STATUSES.UNDER_REVIEW;
  }
}

function getCompletionStatusLabel(status) {
  const labels = {
    UNDECIDED: "未記録",
    REFUNDED: "返金済み",
    PARTIALLY_REFUNDED: "一部返金済み",
    CANCELLED: "キャンセル済み",
    NO_REFUND_CLOSED: "返金なしで完了",
    REJECTED_CLOSED: "対象外として完了",
    MANUAL_CLOSED: "手動完了",
  };

  return labels[String(status || "UNDECIDED").toUpperCase()] || String(status || "-");
}

function getSnapshotCurrencyCode(withdrawalRequest) {
  const snapshot =
    withdrawalRequest?.orderSnapshotJson &&
    typeof withdrawalRequest.orderSnapshotJson === "object"
      ? withdrawalRequest.orderSnapshotJson
      : null;

  return snapshot?.currencyCode || null;
}

function formatMoneyText(amount, currencyCode) {
  if (amount === null || amount === undefined || amount === "") {
    return "-";
  }

  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) {
    return String(amount);
  }

  const currency = String(currencyCode || "").toUpperCase();
  const digits = getCurrencyMinorUnitDigits(currency);
  const majorAmount = numeric / 10 ** digits;
  const formatted = majorAmount.toLocaleString("ja-JP", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

  return currency
    ? `${formatted} ${currency}`
    : formatted;
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

import crypto from "node:crypto";

import prisma from "../../db.server.js";
import { moneyAmountToMinorUnits } from "../sellerPayments/values.js";
import { shopifyGraphQLWithOfflineSession } from "../../utils/shopifyAdmin.server.js";
import {
  PAYMENT_ATTEMPT_STATUS,
  PAYMENT_PROVIDER,
  classifyPaymentGateway,
  isAsynchronousPaymentMethod,
  resolvePaymentAttemptStatus,
} from "./classification.js";

const SHOPIFY_API_VERSION = "2026-04";
const SHOPIFY_PAYMENT_TRANSACTIONS_QUERY = `#graphql
  query PaymentOperationsOrder($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      cancelledAt
      test
      currencyCode
      displayFinancialStatus
      totalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      transactions(first: 100) {
        id
        kind
        status
        gateway
        formattedGateway
        manualPaymentGateway
        test
        processedAt
        amountSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        parentTransaction {
          id
        }
      }
    }
  }
`;

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeOrderId(payload) {
  const explicit = normalizeText(payload?.admin_graphql_api_id || payload?.id);
  if (!explicit) return null;
  return explicit.startsWith("gid://")
    ? explicit
    : `gid://shopify/Order/${explicit}`;
}

function syntheticAttemptKey(orderId, gateway) {
  return `order:${orderId}:gateway:${normalizeLower(gateway) || "unknown"}`;
}

function attemptKey(orderId, transaction, gateway) {
  const transactionId = normalizeText(transaction?.id);
  return transactionId || syntheticAttemptKey(orderId, gateway);
}

function transactionAmount(transaction, order, payload) {
  const money = transaction?.amountSet?.shopMoney;
  const currencyCode = normalizeLower(
    money?.currencyCode || order?.currencyCode || payload?.currency || "jpy",
  );
  const amount = moneyAmountToMinorUnits(
    money?.amount ?? payload?.current_total_price ?? payload?.total_price,
    currencyCode,
  );
  return { amount, currencyCode };
}

function gatewayNamesFromPayload(payload) {
  const values = Array.isArray(payload?.payment_gateway_names)
    ? payload.payment_gateway_names
    : [payload?.gateway];
  return Array.from(new Set(values.map(normalizeText).filter(Boolean)));
}

function fallbackOrderFromPayload(payload) {
  return {
    id: normalizeOrderId(payload),
    name: normalizeText(payload?.name) || null,
    createdAt: payload?.created_at || null,
    cancelledAt: payload?.cancelled_at || null,
    test: Boolean(payload?.test),
    currencyCode: normalizeText(payload?.currency) || "JPY",
    displayFinancialStatus: normalizeText(payload?.financial_status) || null,
    transactions: gatewayNamesFromPayload(payload).map((gateway) => ({
      id: null,
      kind: null,
      status: null,
      gateway,
      formattedGateway: gateway,
      test: Boolean(payload?.test),
      processedAt: payload?.processed_at || null,
      amountSet: {
        shopMoney: {
          amount: payload?.current_total_price ?? payload?.total_price,
          currencyCode: payload?.currency || "JPY",
        },
      },
      parentTransaction: null,
    })),
  };
}

async function loadCanonicalPaymentOrder({ shopDomain, shopifyOrderId }) {
  const response = await shopifyGraphQLWithOfflineSession({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: SHOPIFY_PAYMENT_TRANSACTIONS_QUERY,
    variables: { id: shopifyOrderId },
  });
  return response?.data?.order || null;
}

function buildReviewCaseNumber(shopDomain, orderId, reason) {
  const digest = crypto
    .createHash("sha256")
    .update(`${shopDomain}:${orderId}:${reason}`)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  return `PAY-${digest}`;
}

async function openPaymentReviewCase(
  { shopDomain, shopifyOrderId, marketplaceOrderId, reason, detailsJson },
  prismaClient,
) {
  if (!prismaClient?.marketplaceOperationalCase?.upsert) return null;
  const caseNumber = buildReviewCaseNumber(
    shopDomain,
    shopifyOrderId,
    reason,
  );
  return prismaClient.marketplaceOperationalCase.upsert({
    where: { caseNumber },
    create: {
      caseNumber,
      caseType: "PAYMENT_REVIEW",
      status: "OPEN",
      priority: reason === "multiple_payment_attempts" ? "HIGH" : "NORMAL",
      marketplaceOrderId: marketplaceOrderId || null,
      summary: `Payment review required: ${reason}`,
      detailsJson: {
        shopDomain,
        shopifyOrderId,
        reason,
        ...detailsJson,
      },
      openedBy: "SYSTEM:PAYMENT_SYNC",
    },
    update: {
      status: "OPEN",
      priority: reason === "multiple_payment_attempts" ? "HIGH" : "NORMAL",
      summary: `Payment review required: ${reason}`,
      detailsJson: {
        shopDomain,
        shopifyOrderId,
        reason,
        ...detailsJson,
      },
    },
  });
}

function terminalTimestampData(status, now) {
  if (status === PAYMENT_ATTEMPT_STATUS.CAPTURED) return { capturedAt: now };
  if (status === PAYMENT_ATTEMPT_STATUS.FAILED) return { failedAt: now };
  if (
    status === PAYMENT_ATTEMPT_STATUS.CANCELLED ||
    status === PAYMENT_ATTEMPT_STATUS.EXPIRED_SHOPIFY
  ) {
    return { cancelledAt: now };
  }
  return {};
}

export async function syncShopifyOrderPaymentAttempts(
  { payload, shop, sourceTopic = "ORDERS_UPDATED" },
  {
    prismaClient = prisma,
    loadCanonicalPaymentOrderImpl = loadCanonicalPaymentOrder,
    now = new Date(),
    canonicalOnly = false,
    dryRun = false,
  } = {},
) {
  const paymentAttemptModelAvailable = dryRun
    ? prismaClient?.marketplacePaymentAttempt?.findMany
    : prismaClient?.marketplacePaymentAttempt?.upsert;
  if (!paymentAttemptModelAvailable) {
    return { ok: true, tracked: false, reason: "payment_models_unavailable" };
  }

  const shopDomain = normalizeLower(shop || payload?.shop_domain || payload?.shop);
  const shopifyOrderId = normalizeOrderId(payload);
  if (!shopDomain || !shopifyOrderId) {
    return { ok: false, terminal: true, reason: "payment_order_identity_missing" };
  }

  let order = null;
  let canonicalError = null;
  try {
    order = await loadCanonicalPaymentOrderImpl({ shopDomain, shopifyOrderId });
  } catch (error) {
    canonicalError = error instanceof Error ? error.message : String(error);
  }

  if (canonicalOnly && !order) {
    return {
      ok: true,
      tracked: false,
      reviewRequired: true,
      reason: canonicalError
        ? "canonical_payment_lookup_failed"
        : "canonical_payment_order_not_found",
      canonicalError,
    };
  }
  order ||= fallbackOrderFromPayload(payload);

  const marketplaceOrder = prismaClient?.marketplaceOrder?.findUnique
    ? await prismaClient.marketplaceOrder.findUnique({
        where: {
          shopDomain_shopifyOrderId: { shopDomain, shopifyOrderId },
        },
        select: { id: true },
      })
    : null;

  const transactions = Array.isArray(order?.transactions)
    ? order.transactions.filter((transaction) =>
        ["SALE", "CAPTURE", "AUTHORIZATION"].includes(
          normalizeText(transaction?.kind).toUpperCase(),
        ),
      )
    : [];
  const sourceTransactions =
    transactions.length > 0
      ? transactions
      : canonicalOnly
        ? []
        : fallbackOrderFromPayload(payload).transactions;

  if (sourceTransactions.length === 0) {
    return {
      ok: true,
      tracked: false,
      reviewRequired: canonicalOnly,
      reason: canonicalOnly
        ? "canonical_payment_transactions_unavailable"
        : "payment_gateway_not_available",
      canonicalError,
    };
  }

  const existingAttempts = dryRun
    ? await prismaClient.marketplacePaymentAttempt.findMany({
        where: { shopDomain, shopifyOrderId },
        select: {
          id: true,
          attemptKey: true,
          shopifyTransactionId: true,
          parentTransactionId: true,
          status: true,
          requiresReview: true,
        },
      })
    : [];
  const existingByKey = new Map(
    existingAttempts.map((attempt) => [attempt.attemptKey, attempt]),
  );
  const attempts = [];
  for (const transaction of sourceTransactions) {
    const gateway = normalizeText(transaction?.gateway || transaction?.formattedGateway);
    const classification = classifyPaymentGateway(
      transaction?.gateway,
      transaction?.formattedGateway,
    );
    const status = resolvePaymentAttemptStatus({
      transactionStatus: transaction?.status,
      transactionKind: transaction?.kind,
      financialStatus: order?.displayFinancialStatus || payload?.financial_status,
      cancelledAt: order?.cancelledAt || payload?.cancelled_at,
    });
    const { amount, currencyCode } = transactionAmount(transaction, order, payload);
    const createdAt = toDate(order?.createdAt || payload?.created_at);
    const expiresAt =
      createdAt && isAsynchronousPaymentMethod(classification.paymentMethod)
        ? new Date(createdAt.getTime() + 72 * 60 * 60 * 1000)
        : null;
    const key = attemptKey(shopifyOrderId, transaction, gateway);
    const requiresReview = classification.provider === PAYMENT_PROVIDER.UNKNOWN;
    const reviewReason = requiresReview ? "unknown_payment_gateway" : null;
    const processedAt = toDate(transaction?.processedAt || payload?.processed_at);
    const commonData = {
      shopifyOrderName: normalizeText(order?.name || payload?.name) || null,
      marketplaceOrderId: marketplaceOrder?.id || null,
      shopifyTransactionId: normalizeText(transaction?.id) || null,
      parentTransactionId:
        normalizeText(transaction?.parentTransaction?.id) || null,
      provider: classification.provider,
      paymentMethod: classification.paymentMethod,
      gatewayName: classification.gatewayName,
      formattedGateway: classification.formattedGateway,
      transactionKind: normalizeText(transaction?.kind) || null,
      transactionStatus: normalizeText(transaction?.status) || null,
      financialStatus:
        normalizeText(order?.displayFinancialStatus || payload?.financial_status) ||
        null,
      status,
      amount,
      currencyCode,
      test: Boolean(transaction?.test ?? order?.test ?? payload?.test),
      requiresReview,
      reviewReason,
      expiresAt,
      processedAt,
      ...terminalTimestampData(status, processedAt || now),
      metadataJson: {
        sourceTopic,
        canonicalQueryFailed: Boolean(canonicalError),
        manualPaymentGateway: Boolean(transaction?.manualPaymentGateway),
      },
    };
    const existing = existingByKey.get(key);
    const attempt = dryRun
      ? {
          id: existing?.id || null,
          shopDomain,
          shopifyOrderId,
          attemptKey: key,
          ...commonData,
          wouldCreate: !existing,
        }
      : await prismaClient.marketplacePaymentAttempt.upsert({
          where: {
            shopDomain_attemptKey: { shopDomain, attemptKey: key },
          },
          create: {
            shopDomain,
            shopifyOrderId,
            attemptKey: key,
            ...commonData,
          },
          update: {
            ...commonData,
            marketplaceOrderId: marketplaceOrder?.id || undefined,
            shopifyTransactionId: normalizeText(transaction?.id) || undefined,
            parentTransactionId:
              normalizeText(transaction?.parentTransaction?.id) || undefined,
          },
        });
    attempts.push(attempt);

    if (!dryRun && requiresReview) {
      await openPaymentReviewCase(
        {
          shopDomain,
          shopifyOrderId,
          marketplaceOrderId: marketplaceOrder?.id,
          reason: reviewReason,
          detailsJson: { gatewayName: gateway || null },
        },
        prismaClient,
      );
    }
  }

  if (dryRun) {
    const activeStatuses = new Set([
      PAYMENT_ATTEMPT_STATUS.PENDING,
      PAYMENT_ATTEMPT_STATUS.AUTHORIZED,
      PAYMENT_ATTEMPT_STATUS.CAPTURED,
    ]);
    const projectedKeys = new Set(attempts.map((attempt) => attempt.attemptKey));
    const activeAttempts = [
      ...existingAttempts.filter(
        (attempt) =>
          activeStatuses.has(attempt.status) &&
          !projectedKeys.has(attempt.attemptKey),
      ),
      ...attempts.filter((attempt) => activeStatuses.has(attempt.status)),
    ];
    const economicRoots = new Set(
      activeAttempts.map(
        (attempt) =>
          attempt.parentTransactionId ||
          attempt.shopifyTransactionId ||
          attempt.attemptKey,
      ),
    );
    const multipleAttempts = economicRoots.size > 1;
    return {
      ok: true,
      tracked: true,
      dryRun: true,
      attemptCount: attempts.length,
      creates: attempts.filter((attempt) => attempt.wouldCreate).length,
      updates: attempts.filter((attempt) => !attempt.wouldCreate).length,
      reviewRequired:
        multipleAttempts || attempts.some((attempt) => attempt.requiresReview),
      multipleAttempts,
      canonicalError,
      attempts,
    };
  }

  const activeAttempts = await prismaClient.marketplacePaymentAttempt.findMany({
    where: {
      shopDomain,
      shopifyOrderId,
      status: {
        in: [
          PAYMENT_ATTEMPT_STATUS.PENDING,
          PAYMENT_ATTEMPT_STATUS.AUTHORIZED,
          PAYMENT_ATTEMPT_STATUS.CAPTURED,
        ],
      },
    },
    select: {
      id: true,
      attemptKey: true,
      shopifyTransactionId: true,
      parentTransactionId: true,
    },
  });
  const economicRoots = new Set(
    activeAttempts.map(
      (attempt) =>
        attempt.parentTransactionId ||
        attempt.shopifyTransactionId ||
        attempt.attemptKey,
    ),
  );
  const multipleAttempts = economicRoots.size > 1;
  if (multipleAttempts) {
    await prismaClient.marketplacePaymentAttempt.updateMany({
      where: { shopDomain, shopifyOrderId },
      data: {
        requiresReview: true,
        reviewReason: "multiple_payment_attempts",
      },
    });
    await openPaymentReviewCase(
      {
        shopDomain,
        shopifyOrderId,
        marketplaceOrderId: marketplaceOrder?.id,
        reason: "multiple_payment_attempts",
        detailsJson: { activeAttemptCount: activeAttempts.length },
      },
      prismaClient,
    );
  }

  return {
    ok: true,
    tracked: true,
    attemptCount: attempts.length,
    multipleAttempts,
    canonicalError,
    attempts,
  };
}

export const PAYMENT_OPERATIONS_SYNC = Object.freeze({
  apiVersion: SHOPIFY_API_VERSION,
  shopifyPendingExpiryHours: 72,
});

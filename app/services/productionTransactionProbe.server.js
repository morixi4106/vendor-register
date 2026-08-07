import crypto from "node:crypto";

import prisma from "../db.server.js";
import { shopifyGraphQLWithOfflineSession } from "../utils/shopifyAdmin.server.js";
import {
  LIVE_ORDER_REFUND_E2E_CHECK_KEY,
  OPERATIONAL_ATTESTATION_STATUS,
  recordOperationalReadinessAttestation,
} from "./operationalReadiness.server.js";
import {
  buildProductionReleaseFingerprint,
  buildProductionReleaseExpectation,
} from "./productionRelease.server.js";
import {
  classifyPaymentGateway,
  PAYMENT_METHOD,
  PAYMENT_PROVIDER,
  PAYMENT_REFUND_MODE,
} from "./paymentOperations/classification.js";
import { inspectPaymentOperations } from "./paymentOperations/dashboard.server.js";
import { syncShopifyOrderPaymentAttempts } from "./paymentOperations/sync.server.js";
import { getMarketplaceCheckoutGateStatus } from "./marketplaceCheckoutGate.server.js";
import { getPlatformOperationalControl } from "./operationalControls.server.js";

export const PRODUCTION_TRANSACTION_PROBE_STATUS = Object.freeze({
  AWAITING_ORDER: "AWAITING_ORDER",
  AWAITING_SETTLEMENT: "AWAITING_SETTLEMENT",
  AWAITING_PAYOUT_EVIDENCE: "AWAITING_PAYOUT_EVIDENCE",
  AWAITING_REFUND_RESERVE_CONFIRMATION: "AWAITING_REFUND_RESERVE_CONFIRMATION",
  AWAITING_REFUND: "AWAITING_REFUND",
  PASSED: "PASSED",
  INVALIDATED: "INVALIDATED",
  CANCELLED: "CANCELLED",
});

const ACTIVE_PROBE_STATUSES = [
  PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_ORDER,
  PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_SETTLEMENT,
  PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_PAYOUT_EVIDENCE,
  PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_REFUND_RESERVE_CONFIRMATION,
  PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_REFUND,
];
const SHOPIFY_API_VERSION = "2026-04";
const SHOPIFY_TRANSACTION_LIMIT = 100;
const SUCCESSFUL_PAYMENT_TRANSACTION_KINDS = new Set(["CAPTURE", "SALE"]);
const SETTLEMENT_ENTRY_TYPES = [
  "shopify_order_paid",
  "refund",
  "shopify_order_cancelled",
];
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

const LEGACY_PRODUCTION_TRANSACTION_TARGET_VERSION = 1;
const PRODUCTION_TRANSACTION_TARGET_VERSION = 2;
const DEFAULT_PRODUCTION_TRANSACTION_TARGET = Object.freeze({
  version: PRODUCTION_TRANSACTION_TARGET_VERSION,
  provider: PAYMENT_PROVIDER.SHOPIFY_PAYMENTS,
  paymentMethod: PAYMENT_METHOD.CARD,
  refundMode: PAYMENT_REFUND_MODE.SHOPIFY_LINKED,
});
const KOMOJU_CARD_TRANSACTION_TARGET = Object.freeze({
  version: PRODUCTION_TRANSACTION_TARGET_VERSION,
  provider: PAYMENT_PROVIDER.KOMOJU,
  paymentMethod: PAYMENT_METHOD.CARD,
  refundMode: PAYMENT_REFUND_MODE.SHOPIFY_LINKED,
});

export const KOMOJU_PAYOUT_EVIDENCE_STRATEGY = Object.freeze({
  EXISTING_RECONCILED_PAYOUT: "EXISTING_RECONCILED_PAYOUT",
  CURRENT_PAYMENT_WITH_REFUND_RESERVE: "CURRENT_PAYMENT_WITH_REFUND_RESERVE",
  ZERO_BALANCE_LIMITED_LAUNCH: "ZERO_BALANCE_LIMITED_LAUNCH",
});

const ORDER_FIELDS = `#graphql
  fragment ProductionProbeTransactionFields on OrderTransaction {
    id
    kind
    status
    gateway
    formattedGateway
    manualPaymentGateway
    test
    processedAt
    paymentDetails {
      __typename
      ... on BasePaymentDetails {
        paymentMethodName
      }
      ... on CardPaymentDetails {
        wallet
      }
    }
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

  fragment ProductionProbeOrderFields on Order {
    id
    name
    createdAt
    updatedAt
    test
    cancelledAt
    currencyCode
    displayFinancialStatus
    displayFulfillmentStatus
    subtotalPriceSet {
      shopMoney {
        amount
        currencyCode
      }
    }
    totalShippingPriceSet {
      shopMoney {
        amount
        currencyCode
      }
    }
    totalTaxSet {
      shopMoney {
        amount
        currencyCode
      }
    }
    totalPriceSet {
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
    transactionsCount {
      count
    }
    transactions(first: 100) {
      ...ProductionProbeTransactionFields
    }
    refunds {
      id
      createdAt
      transactions(first: 100) {
        nodes {
          ...ProductionProbeTransactionFields
        }
        pageInfo {
          hasNextPage
        }
      }
    }
    lineItems(first: 250) {
      nodes {
        id
        quantity
        product {
          id
        }
        variant {
          id
        }
        originalUnitPriceSet {
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
      pageInfo {
        hasNextPage
      }
    }
  }
`;

const ORDER_BY_ID_QUERY = `#graphql
  ${ORDER_FIELDS}
  query ProductionProbeOrderById($id: ID!) {
    order(id: $id) {
      ...ProductionProbeOrderFields
    }
  }
`;

const ORDER_BY_NAME_QUERY = `#graphql
  ${ORDER_FIELDS}
  query ProductionProbeOrderByName($query: String!) {
    orders(first: 2, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        ...ProductionProbeOrderFields
      }
    }
  }
`;

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeSha256(value) {
  const normalized = clean(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function normalizeShop(value) {
  return clean(value).toLowerCase();
}

function normalizeCurrency(value) {
  return clean(value).toUpperCase() || "JPY";
}

function toMinorUnits(value, currencyCode) {
  const numeric = Number(clean(value).replaceAll(",", ""));
  if (!Number.isFinite(numeric)) return 0;
  return ZERO_DECIMAL_CURRENCIES.has(normalizeCurrency(currencyCode))
    ? Math.round(numeric)
    : Math.round(numeric * 100);
}

function toNonNegativeInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function parseDate(value) {
  if (!clean(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function normalizeProductionTransactionTarget({
  version,
  provider,
  paymentMethod,
} = {}) {
  const normalizedProvider = clean(provider).toUpperCase();
  const normalizedMethod = clean(paymentMethod).toUpperCase();
  if (
    ![PAYMENT_PROVIDER.SHOPIFY_PAYMENTS, PAYMENT_PROVIDER.KOMOJU].includes(
      normalizedProvider,
    ) ||
    normalizedMethod !== PAYMENT_METHOD.CARD
  ) {
    return null;
  }
  const normalizedVersion = Number(version);
  return {
    version:
      normalizedVersion === LEGACY_PRODUCTION_TRANSACTION_TARGET_VERSION
        ? LEGACY_PRODUCTION_TRANSACTION_TARGET_VERSION
        : PRODUCTION_TRANSACTION_TARGET_VERSION,
    provider: normalizedProvider,
    paymentMethod: normalizedMethod,
    refundMode: PAYMENT_REFUND_MODE.SHOPIFY_LINKED,
  };
}

export function getProductionTransactionProbeTarget(probe) {
  const configured = asObject(asObject(probe?.orderEvidenceJson).probeConfig);
  return (
    normalizeProductionTransactionTarget(configured) ||
    DEFAULT_PRODUCTION_TRANSACTION_TARGET
  );
}

function sameTransactionTarget(left, right) {
  return (
    left?.version === right?.version &&
    left?.provider === right?.provider &&
    left?.paymentMethod === right?.paymentMethod &&
    left?.refundMode === right?.refundMode
  );
}

function parseProviderConfig(value) {
  return new Set(
    clean(value)
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

function preflightCheck(id, passed, detail) {
  return { id, passed: passed === true, detail };
}

function resolveSafely(callback, fallback) {
  return Promise.resolve()
    .then(callback)
    .catch(() => fallback);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function hashEvidence(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function normalizeOrderReference(value) {
  const reference = clean(value);
  if (/^gid:\/\/shopify\/Order\/\d+$/.test(reference)) {
    return { kind: "id", value: reference };
  }
  const numeric = reference.replace(/^#/, "");
  if (/^\d{1,20}$/.test(numeric)) {
    return { kind: "name", value: `#${numeric}` };
  }
  return null;
}

function lineSnapshot(line, currencyCode) {
  const quantity = toNonNegativeInteger(line?.quantity);
  return {
    id: clean(line?.id) || null,
    productId: clean(line?.product?.id) || null,
    variantId: clean(line?.variant?.id) || null,
    quantity,
    unitAmount: toMinorUnits(
      line?.originalUnitPriceSet?.shopMoney?.amount,
      line?.originalUnitPriceSet?.shopMoney?.currencyCode || currencyCode,
    ),
    discountedTotalAmount: toMinorUnits(
      line?.discountedTotalSet?.shopMoney?.amount,
      line?.discountedTotalSet?.shopMoney?.currencyCode || currencyCode,
    ),
  };
}

function transactionSnapshot(transaction, currencyCode) {
  const paymentDetails = asObject(transaction?.paymentDetails);
  return {
    id: clean(transaction?.id) || null,
    kind: clean(transaction?.kind).toUpperCase(),
    status: clean(transaction?.status).toUpperCase(),
    gateway: clean(transaction?.gateway).toLowerCase() || null,
    formattedGateway: clean(transaction?.formattedGateway) || null,
    manualPaymentGateway: transaction?.manualPaymentGateway === true,
    test: transaction?.test === true,
    processedAt: parseDate(transaction?.processedAt)?.toISOString() || null,
    amount: toMinorUnits(
      transaction?.amountSet?.shopMoney?.amount,
      transaction?.amountSet?.shopMoney?.currencyCode || currencyCode,
    ),
    currencyCode: normalizeCurrency(
      transaction?.amountSet?.shopMoney?.currencyCode || currencyCode,
    ),
    parentTransactionId: clean(transaction?.parentTransaction?.id) || null,
    paymentDetailsType: clean(paymentDetails.__typename) || null,
    paymentMethodName: clean(paymentDetails.paymentMethodName) || null,
    paymentWallet: clean(paymentDetails.wallet) || null,
  };
}

function normalizePayoutEvidenceStrategy(value) {
  const strategy = clean(value).toUpperCase();
  return Object.values(KOMOJU_PAYOUT_EVIDENCE_STRATEGY).includes(strategy)
    ? strategy
    : null;
}

export function buildShopifyProbeOrderSnapshot(order) {
  const currencyCode = normalizeCurrency(order?.currencyCode);
  const lines = Array.isArray(order?.lineItems?.nodes)
    ? order.lineItems.nodes.map((line) => lineSnapshot(line, currencyCode))
    : [];
  const commercialEvidence = {
    currencyCode,
    subtotalAmount: toMinorUnits(
      order?.subtotalPriceSet?.shopMoney?.amount,
      currencyCode,
    ),
    shippingAmount: toMinorUnits(
      order?.totalShippingPriceSet?.shopMoney?.amount,
      currencyCode,
    ),
    taxAmount: toMinorUnits(
      order?.totalTaxSet?.shopMoney?.amount,
      currencyCode,
    ),
    totalAmount: toMinorUnits(
      order?.totalPriceSet?.shopMoney?.amount,
      currencyCode,
    ),
    lines,
  };
  const transactions = Array.isArray(order?.transactions)
    ? order.transactions.map((transaction) =>
        transactionSnapshot(transaction, currencyCode),
      )
    : [];
  const transactionCount = toNonNegativeInteger(
    order?.transactionsCount?.count,
  );
  const refunds = Array.isArray(order?.refunds)
    ? order.refunds.map((refund) => ({
        id: clean(refund?.id) || null,
        createdAt: parseDate(refund?.createdAt)?.toISOString() || null,
        transactions: Array.isArray(refund?.transactions?.nodes)
          ? refund.transactions.nodes.map((transaction) =>
              transactionSnapshot(transaction, currencyCode),
            )
          : [],
        transactionsComplete:
          refund?.transactions?.pageInfo?.hasNextPage !== true,
      }))
    : [];
  return {
    shopifyOrderId: clean(order?.id) || null,
    shopifyOrderName: clean(order?.name) || null,
    createdAt: parseDate(order?.createdAt)?.toISOString() || null,
    updatedAt: parseDate(order?.updatedAt)?.toISOString() || null,
    test: order?.test === true,
    cancelledAt: parseDate(order?.cancelledAt)?.toISOString() || null,
    financialStatus: clean(order?.displayFinancialStatus).toUpperCase(),
    fulfillmentStatus: clean(order?.displayFulfillmentStatus).toUpperCase(),
    refundedAmount: toMinorUnits(
      order?.totalRefundedSet?.shopMoney?.amount,
      currencyCode,
    ),
    refundIds: unique(refunds.map((refund) => refund.id)).sort(),
    refunds,
    transactions,
    transactionsComplete:
      transactionCount <= SHOPIFY_TRANSACTION_LIMIT &&
      transactionCount === transactions.length,
    lineItemsComplete: order?.lineItems?.pageInfo?.hasNextPage !== true,
    commercialEvidence,
    commercialFingerprint: hashEvidence(commercialEvidence),
  };
}

export async function fetchShopifyOrderForProductionProbe(
  { shopDomain, orderReference },
  { graphQL = shopifyGraphQLWithOfflineSession } = {},
) {
  const reference = normalizeOrderReference(orderReference);
  if (!reference) {
    return { ok: false, reason: "order_reference_invalid" };
  }
  const request =
    reference.kind === "id"
      ? {
          query: ORDER_BY_ID_QUERY,
          variables: { id: reference.value },
        }
      : {
          query: ORDER_BY_NAME_QUERY,
          variables: { query: `name:${reference.value}` },
        };
  const response = await graphQL({
    shopDomain: normalizeShop(shopDomain),
    apiVersion: SHOPIFY_API_VERSION,
    ...request,
  });
  const nodes =
    reference.kind === "id"
      ? response?.data?.order
        ? [response.data.order]
        : []
      : Array.isArray(response?.data?.orders?.nodes)
        ? response.data.orders.nodes
        : [];
  if (nodes.length === 0) {
    return { ok: false, reason: "shopify_order_not_found" };
  }
  if (nodes.length !== 1) {
    return { ok: false, reason: "shopify_order_reference_ambiguous" };
  }
  const snapshot = buildShopifyProbeOrderSnapshot(nodes[0]);
  if (!snapshot.shopifyOrderId || !snapshot.lineItemsComplete) {
    return {
      ok: false,
      reason: snapshot.shopifyOrderId
        ? "shopify_order_line_items_incomplete"
        : "shopify_order_not_found",
    };
  }
  if (!snapshot.transactionsComplete) {
    return {
      ok: false,
      reason: "shopify_order_transactions_incomplete",
    };
  }
  if (snapshot.refunds.some((refund) => !refund.transactionsComplete)) {
    return {
      ok: false,
      reason: "shopify_refund_transactions_incomplete",
    };
  }
  const lineItemIds = snapshot.commercialEvidence.lines.map((line) => line.id);
  if (
    lineItemIds.some((id) => !id) ||
    new Set(lineItemIds).size !== lineItemIds.length
  ) {
    return { ok: false, reason: "shopify_order_line_items_invalid" };
  }
  return { ok: true, order: nodes[0], snapshot };
}

function buildReleaseContext(releaseExpectation) {
  const expected = releaseExpectation || buildProductionReleaseExpectation();
  const releaseFingerprint = buildProductionReleaseFingerprint(expected);
  return {
    expected,
    releaseId: clean(expected?.releaseId),
    releaseFingerprint,
    configured: expected?.configured === true && Boolean(releaseFingerprint),
  };
}

function activeKey(shopDomain) {
  return `production-transaction-probe:${normalizeShop(shopDomain)}`;
}

async function transitionActiveProbe(
  {
    probe,
    expectedStatuses,
    data,
    conflictReason = "production_transaction_probe_conflict",
  },
  { prismaClient },
) {
  const result = await prismaClient.productionTransactionProbe.updateMany({
    where: {
      id: probe.id,
      activeKey: activeKey(probe.shopDomain),
      releaseFingerprint: probe.releaseFingerprint,
      status: { in: expectedStatuses },
    },
    data,
  });
  const latest = await prismaClient.productionTransactionProbe.findUnique({
    where: { id: probe.id },
  });
  return result.count === 1
    ? { ok: true, probe: latest }
    : { ok: false, reason: conflictReason, probe: latest };
}

export async function inspectProductionTransactionProbePreflight(
  {
    shopDomain,
    releaseExpectation,
    targetProvider = PAYMENT_PROVIDER.KOMOJU,
    targetPaymentMethod = PAYMENT_METHOD.CARD,
  },
  {
    prismaClient = prisma,
    env = process.env,
    inspectPaymentOperationsImpl = inspectPaymentOperations,
    getPlatformOperationalControlImpl = getPlatformOperationalControl,
    getMarketplaceCheckoutGateStatusImpl = getMarketplaceCheckoutGateStatus,
  } = {},
) {
  const shop = normalizeShop(shopDomain);
  const release = buildReleaseContext(releaseExpectation);
  const target = normalizeProductionTransactionTarget({
    provider: targetProvider,
    paymentMethod: targetPaymentMethod,
  });
  if (!shop || !target) {
    return {
      canStart: false,
      target: target || KOMOJU_CARD_TRANSACTION_TARGET,
      checks: [
        preflightCheck(
          "payment_target_supported",
          false,
          "対応していない決済対象です。",
        ),
      ],
    };
  }

  const [
    paymentOperations,
    operationalControl,
    publicationBoundary,
    productCount,
    existingReconciledPayout,
  ] = await Promise.all([
    resolveSafely(() => inspectPaymentOperationsImpl({ prismaClient }), {
      available: false,
      reason: "payment_operations_inspection_failed",
    }),
    resolveSafely(() => getPlatformOperationalControlImpl({ prismaClient }), {
      available: false,
      checkoutHold: true,
      checkoutControlState: "UNKNOWN",
    }),
    resolveSafely(
      () => getMarketplaceCheckoutGateStatusImpl(shop, { prismaClient, env }),
      {
        exists: false,
        active: false,
        publicationConfigurationReady: false,
        failedProductCount: 1,
      },
    ),
    prismaClient?.product?.count
      ? resolveSafely(
          () =>
            prismaClient.product.count({
              where: {
                shopDomain: shop,
                approvalStatus: "approved",
                price: { gt: 0 },
                shopifyProductId: { not: null },
                shopifyVariantId: { not: null },
                OR: [
                  { inventoryQuantity: null },
                  { inventoryQuantity: { gt: 0 } },
                ],
                vendorStore: {
                  is: {
                    isPlatformStore: true,
                    isTestStore: false,
                  },
                },
              },
            }),
          0,
        )
      : Promise.resolve(0),
    prismaClient?.paymentSettlementBatch?.findFirst
      ? resolveSafely(
          () =>
            prismaClient.paymentSettlementBatch.findFirst({
              where: {
                provider: "KOMOJU",
                status: "RECONCILED",
                bankDepositedAt: { not: null },
                evidenceHash: { not: null },
                lines: {
                  some: {
                    paymentAttemptId: { not: null },
                    matchStatus: "MATCHED",
                  },
                },
              },
              orderBy: [{ bankDepositedAt: "desc" }, { createdAt: "desc" }],
              select: {
                id: true,
                externalBatchId: true,
                bankDepositedAt: true,
              },
            }),
          null,
        )
      : Promise.resolve(null),
  ]);

  const configuredProviders = parseProviderConfig(
    env.PAYMENT_PROVIDERS || env.PAYMENT_PROVIDER,
  );
  const providerConfigured = configuredProviders.has(
    target.provider === PAYMENT_PROVIDER.KOMOJU ? "komoju" : "shopify_payments",
  );
  const komojuTarget = target.provider === PAYMENT_PROVIDER.KOMOJU;
  const paymentOperationsClean = Boolean(
    paymentOperations.available === true &&
    paymentOperations.pendingExpiredCount === 0 &&
    paymentOperations.attemptReviewCount === 0 &&
    paymentOperations.refundReviewCount === 0 &&
    paymentOperations.refundFailedCount === 0 &&
    paymentOperations.unmatchedSettlementCount === 0 &&
    toNonNegativeInteger(paymentOperations.settlementBatchReviewCount) === 0,
  );
  const purchaseControlReady = Boolean(
    release.expected?.functionId && release.expected?.validationId,
  );
  const checks = [
    preflightCheck(
      "release_configured",
      release.configured,
      release.configured
        ? `Release ${release.releaseId}`
        : "Render commitとShopify App versionが必要です。",
    ),
    preflightCheck(
      "purchase_control_release_ready",
      purchaseControlReady,
      purchaseControlReady
        ? "本番FunctionとValidationを確認しました。"
        : "本番FunctionまたはValidationを確認できません。",
    ),
    preflightCheck(
      "payment_provider_configured",
      providerConfigured,
      providerConfigured
        ? `${target.provider}を有効な決済プロバイダーとして確認しました。`
        : `${target.provider}がPAYMENT_PROVIDERSにありません。`,
    ),
    preflightCheck(
      "komoju_operations_enabled",
      !komojuTarget || env.KOMOJU_PAYMENT_OPERATIONS_ENABLED === "true",
      !komojuTarget || env.KOMOJU_PAYMENT_OPERATIONS_ENABLED === "true"
        ? "KOMOJU決済運用を記録できます。"
        : "KOMOJU_PAYMENT_OPERATIONS_ENABLED=trueが必要です。",
    ),
    preflightCheck(
      "refund_confirmation_enforced",
      !komojuTarget || env.PAYMENT_REFUND_CONFIRMATION_ENFORCED === "true",
      !komojuTarget || env.PAYMENT_REFUND_CONFIRMATION_ENFORCED === "true"
        ? "返金確認の安全制御は有効です。"
        : "PAYMENT_REFUND_CONFIRMATION_ENFORCED=trueが必要です。",
    ),
    preflightCheck(
      "payment_operations_clean",
      paymentOperationsClean,
      paymentOperationsClean
        ? "未解決の決済・返金・入金照合はありません。"
        : "決済運用画面の未解決項目を先に解消してください。",
    ),
    preflightCheck(
      "checkout_available",
      operationalControl.available === true &&
        operationalControl.checkoutHold !== true &&
        operationalControl.checkoutControlState === "IDLE",
      operationalControl.checkoutHold === true
        ? "購入緊急停止が有効です。"
        : "購入緊急停止は無効です。",
    ),
    preflightCheck(
      "publication_boundary_ready",
      publicationBoundary.active === true &&
        publicationBoundary.publicationConfigurationReady === true &&
        publicationBoundary.exposedProductCount === 0 &&
        publicationBoundary.failedProductCount === 0,
      publicationBoundary.active === true
        ? "第三者商品の公開境界は正常です。"
        : "第三者商品の公開境界を確認できません。",
    ),
    preflightCheck(
      "eligible_platform_product_available",
      productCount > 0,
      productCount > 0
        ? `購入可能な運営直販商品 ${productCount}件`
        : "購入可能な運営直販商品がありません。",
    ),
  ];

  return {
    canStart: checks.every((entry) => entry.passed),
    target,
    release,
    checks,
    eligibleProductCount: productCount,
    paymentOperations,
    operationalControl: {
      available: operationalControl.available === true,
      checkoutHold: operationalControl.checkoutHold === true,
      checkoutControlState: operationalControl.checkoutControlState,
    },
    publicationBoundary: {
      active: publicationBoundary.active === true,
      publicationConfigurationReady:
        publicationBoundary.publicationConfigurationReady === true,
      exposedProductCount: toNonNegativeInteger(
        publicationBoundary.exposedProductCount,
      ),
      failedProductCount: toNonNegativeInteger(
        publicationBoundary.failedProductCount,
      ),
    },
    payoutEvidence: {
      existingReconciledPayoutAvailable: Boolean(existingReconciledPayout),
      existingReconciledPayoutId: existingReconciledPayout?.id || null,
      existingReconciledPayoutReference:
        existingReconciledPayout?.externalBatchId || null,
      existingReconciledPayoutDepositedAt:
        existingReconciledPayout?.bankDepositedAt || null,
    },
  };
}

export async function createProductionTransactionProbe(
  {
    shopDomain,
    startedBy,
    releaseExpectation,
    targetProvider = PAYMENT_PROVIDER.SHOPIFY_PAYMENTS,
    targetPaymentMethod = PAYMENT_METHOD.CARD,
    komojuCardOnlyConfirmed = false,
    untestedAsyncMethodsDisabledConfirmed = false,
    komojuLiveConfirmed = false,
    singleCardIntegrationConfirmed = false,
    automaticCaptureConfirmed = false,
    releaseFreezeConfirmed = false,
    externalSettingsEvidenceReference,
    externalSettingsEvidenceHash,
    payoutEvidenceStrategy,
    maximumPlannedChargeAmount,
    confirmedRefundReserveAmount,
    confirmedKomojuUnsettledBalanceAmount,
    zeroUnsettledBalanceConfirmed = false,
    companyRefundReserveConfirmed = false,
    directRefundFallbackConfirmed = false,
    domesticPlatformDirectOnlyConfirmed = false,
  },
  { prismaClient = prisma, now = new Date() } = {},
) {
  if (!prismaClient?.productionTransactionProbe?.findUnique) {
    return { ok: false, reason: "production_transaction_probe_unavailable" };
  }
  const shop = normalizeShop(shopDomain);
  const actor = clean(startedBy);
  const release = buildReleaseContext(releaseExpectation);
  const target = normalizeProductionTransactionTarget({
    provider: targetProvider,
    paymentMethod: targetPaymentMethod,
  });
  if (!shop || !actor || !release.configured || !target) {
    return { ok: false, reason: "production_transaction_probe_input_invalid" };
  }
  if (
    target.provider === PAYMENT_PROVIDER.KOMOJU &&
    (komojuCardOnlyConfirmed !== true ||
      untestedAsyncMethodsDisabledConfirmed !== true ||
      komojuLiveConfirmed !== true ||
      singleCardIntegrationConfirmed !== true ||
      automaticCaptureConfirmed !== true ||
      releaseFreezeConfirmed !== true)
  ) {
    return { ok: false, reason: "komoju_scope_confirmation_required" };
  }
  const evidenceReference = clean(externalSettingsEvidenceReference);
  const evidenceHash = normalizeSha256(externalSettingsEvidenceHash);
  const strategy = normalizePayoutEvidenceStrategy(payoutEvidenceStrategy);
  const maximumCharge = toNonNegativeInteger(maximumPlannedChargeAmount);
  const refundReserve = toNonNegativeInteger(confirmedRefundReserveAmount);
  const confirmedUnsettledBalance = toNonNegativeInteger(
    confirmedKomojuUnsettledBalanceAmount,
  );
  const confirmedUnsettledBalanceProvided =
    clean(confirmedKomojuUnsettledBalanceAmount) !== "";
  if (
    target.provider === PAYMENT_PROVIDER.KOMOJU &&
    (!strategy || !evidenceReference || !evidenceHash || maximumCharge <= 0)
  ) {
    return { ok: false, reason: "komoju_external_readiness_missing" };
  }
  let existingPayout = null;
  if (
    target.provider === PAYMENT_PROVIDER.KOMOJU &&
    strategy === KOMOJU_PAYOUT_EVIDENCE_STRATEGY.EXISTING_RECONCILED_PAYOUT
  ) {
    existingPayout = await prismaClient.paymentSettlementBatch.findFirst({
      where: {
        provider: "KOMOJU",
        status: "RECONCILED",
        bankDepositedAt: { not: null },
        evidenceHash: { not: null },
        lines: {
          some: {
            paymentAttemptId: { not: null },
            matchStatus: "MATCHED",
          },
        },
      },
      orderBy: [{ bankDepositedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true, externalBatchId: true, bankDepositedAt: true },
    });
    if (!existingPayout) {
      return { ok: false, reason: "existing_reconciled_payout_required" };
    }
  }
  if (
    target.provider === PAYMENT_PROVIDER.KOMOJU &&
    (refundReserve <= 0 || refundReserve < maximumCharge)
  ) {
    return { ok: false, reason: "komoju_refund_reserve_insufficient" };
  }
  if (
    target.provider === PAYMENT_PROVIDER.KOMOJU &&
    strategy === KOMOJU_PAYOUT_EVIDENCE_STRATEGY.ZERO_BALANCE_LIMITED_LAUNCH &&
    (!confirmedUnsettledBalanceProvided ||
      confirmedUnsettledBalance !== 0 ||
      zeroUnsettledBalanceConfirmed !== true ||
      companyRefundReserveConfirmed !== true ||
      directRefundFallbackConfirmed !== true ||
      domesticPlatformDirectOnlyConfirmed !== true)
  ) {
    return { ok: false, reason: "komoju_limited_launch_confirmation_required" };
  }
  const externalReadiness = {
    version: 2,
    strategy,
    maximumPlannedChargeAmount: maximumCharge,
    confirmedRefundReserveAmount: refundReserve,
    confirmedKomojuUnsettledBalanceAmount:
      strategy ===
      KOMOJU_PAYOUT_EVIDENCE_STRATEGY.ZERO_BALANCE_LIMITED_LAUNCH
        ? confirmedUnsettledBalance
        : null,
    refundReserveType:
      strategy ===
      KOMOJU_PAYOUT_EVIDENCE_STRATEGY.ZERO_BALANCE_LIMITED_LAUNCH
        ? "COMPANY_CASH"
        : "KOMOJU_UNSETTLED_BALANCE",
    zeroUnsettledBalanceConfirmed:
      zeroUnsettledBalanceConfirmed === true,
    companyRefundReserveConfirmed: companyRefundReserveConfirmed === true,
    directRefundFallbackConfirmed: directRefundFallbackConfirmed === true,
    domesticPlatformDirectOnlyConfirmed:
      domesticPlatformDirectOnlyConfirmed === true,
    komojuLiveConfirmed: komojuLiveConfirmed === true,
    singleCardIntegrationConfirmed: singleCardIntegrationConfirmed === true,
    automaticCaptureConfirmed: automaticCaptureConfirmed === true,
    untestedAsyncMethodsDisabledConfirmed:
      untestedAsyncMethodsDisabledConfirmed === true,
    releaseFreezeConfirmed: releaseFreezeConfirmed === true,
    evidenceReference,
    evidenceHash,
    existingPayoutBatchId: existingPayout?.id || null,
    existingPayoutReference: existingPayout?.externalBatchId || null,
    confirmedAt: now.toISOString(),
    confirmedBy: actor,
  };
  const key = activeKey(shop);
  const existing = await prismaClient.productionTransactionProbe.findUnique({
    where: { activeKey: key },
  });
  if (existing) {
    if (existing.releaseFingerprint === release.releaseFingerprint) {
      if (
        !sameTransactionTarget(
          getProductionTransactionProbeTarget(existing),
          target,
        )
      ) {
        return {
          ok: false,
          reason: "active_probe_payment_target_mismatch",
          probe: existing,
        };
      }
      return { ok: true, existing: true, probe: existing };
    }
    const invalidated = await transitionActiveProbe(
      {
        probe: existing,
        expectedStatuses: ACTIVE_PROBE_STATUSES,
        data: {
          activeKey: null,
          status: PRODUCTION_TRANSACTION_PROBE_STATUS.INVALIDATED,
          invalidatedAt: now,
          lastCheckedAt: now,
          lastErrorCode: "release_changed",
        },
      },
      { prismaClient },
    );
    if (!invalidated.ok) return invalidated;
  }
  try {
    const probe = await prismaClient.productionTransactionProbe.create({
      data: {
        activeKey: key,
        shopDomain: shop,
        releaseId: release.releaseId,
        releaseFingerprint: release.releaseFingerprint,
        status: PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_ORDER,
        startedBy: actor,
        startedAt: now,
        lastCheckedAt: now,
        orderEvidenceJson: { probeConfig: target, externalReadiness },
      },
    });
    return { ok: true, existing: false, probe };
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    const concurrent = await prismaClient.productionTransactionProbe.findUnique(
      {
        where: { activeKey: key },
      },
    );
    if (!concurrent) {
      return { ok: false, reason: "production_transaction_probe_conflict" };
    }
    if (
      !sameTransactionTarget(
        getProductionTransactionProbeTarget(concurrent),
        target,
      )
    ) {
      return {
        ok: false,
        reason: "active_probe_payment_target_mismatch",
        probe: concurrent,
      };
    }
    return { ok: true, existing: true, probe: concurrent };
  }
}

async function resolvePlatformProducts(
  { shopDomain, snapshot },
  { prismaClient },
) {
  const clauses = [];
  const variantIds = unique(
    snapshot.commercialEvidence.lines.map((line) => line.variantId),
  );
  const productIds = unique(
    snapshot.commercialEvidence.lines.map((line) => line.productId),
  );
  if (variantIds.length > 0)
    clauses.push({ shopifyVariantId: { in: variantIds } });
  if (productIds.length > 0)
    clauses.push({ shopifyProductId: { in: productIds } });
  if (clauses.length === 0) {
    return { ok: false, reason: "shopify_order_products_missing" };
  }
  const products = await prismaClient.product.findMany({
    where: {
      shopDomain: normalizeShop(shopDomain),
      OR: clauses,
    },
    include: {
      vendorStore: {
        select: {
          id: true,
          isPlatformStore: true,
          isTestStore: true,
        },
      },
    },
  });
  const byVariantId = new Map(
    products
      .filter((product) => product.shopifyVariantId)
      .map((product) => [product.shopifyVariantId, product]),
  );
  const byProductId = new Map(
    products
      .filter((product) => product.shopifyProductId)
      .map((product) => [product.shopifyProductId, product]),
  );
  const matched = [];
  for (const line of snapshot.commercialEvidence.lines) {
    const product =
      (line.variantId && byVariantId.get(line.variantId)) ||
      (line.productId && byProductId.get(line.productId)) ||
      null;
    if (!product) {
      return { ok: false, reason: "local_product_mapping_missing" };
    }
    if (
      product.approvalStatus !== "approved" ||
      product.vendorStore?.isPlatformStore !== true ||
      product.vendorStore?.isTestStore === true
    ) {
      return { ok: false, reason: "order_contains_non_platform_product" };
    }
    matched.push({
      shopifyLineItemId: line.id,
      productId: product.id,
      vendorStoreId: product.vendorStoreId,
      quantity: line.quantity,
    });
  }
  return {
    ok: true,
    products: matched,
    vendorStoreIds: unique(matched.map((product) => product.vendorStoreId)),
  };
}

export async function attachOrderToProductionTransactionProbe(
  { probeId, orderReference, actorKey, releaseExpectation },
  {
    prismaClient = prisma,
    graphQL = shopifyGraphQLWithOfflineSession,
    now = new Date(),
  } = {},
) {
  const probe = await prismaClient.productionTransactionProbe.findUnique({
    where: { id: clean(probeId) },
  });
  if (
    !probe ||
    probe.status !== PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_ORDER ||
    probe.activeKey !== activeKey(probe.shopDomain)
  ) {
    return { ok: false, reason: "active_probe_not_found" };
  }
  const release = buildReleaseContext(releaseExpectation);
  if (
    !release.configured ||
    release.releaseFingerprint !== probe.releaseFingerprint
  ) {
    return invalidateProbeForReleaseChange(probe, { prismaClient, now });
  }
  const fetched = await fetchShopifyOrderForProductionProbe(
    { shopDomain: probe.shopDomain, orderReference },
    { graphQL },
  );
  if (!fetched.ok) return fetched;
  const { snapshot } = fetched;
  const createdAt = parseDate(snapshot.createdAt);
  if (snapshot.test) {
    return { ok: false, reason: "shopify_test_order_not_allowed" };
  }
  if (!createdAt || createdAt.getTime() < probe.startedAt.getTime()) {
    return { ok: false, reason: "order_predates_probe" };
  }
  if (snapshot.cancelledAt) {
    return { ok: false, reason: "order_already_cancelled" };
  }
  if (snapshot.financialStatus !== "PAID") {
    return { ok: false, reason: "order_not_paid" };
  }
  if (snapshot.refundedAmount > 0 || snapshot.refundIds.length > 0) {
    return { ok: false, reason: "order_already_refunded" };
  }
  if (
    snapshot.commercialEvidence.totalAmount <= 0 ||
    snapshot.commercialEvidence.lines.length === 0
  ) {
    return { ok: false, reason: "order_has_no_payable_lines" };
  }
  const externalReadiness = asObject(
    asObject(probe.orderEvidenceJson).externalReadiness,
  );
  const maximumPlannedChargeAmount = toNonNegativeInteger(
    externalReadiness.maximumPlannedChargeAmount,
  );
  if (
    getProductionTransactionProbeTarget(probe).provider ===
      PAYMENT_PROVIDER.KOMOJU &&
    (maximumPlannedChargeAmount <= 0 ||
      snapshot.commercialEvidence.totalAmount > maximumPlannedChargeAmount)
  ) {
    return { ok: false, reason: "order_exceeds_confirmed_charge_plan" };
  }
  const platformProducts = await resolvePlatformProducts(
    { shopDomain: probe.shopDomain, snapshot },
    { prismaClient },
  );
  if (!platformProducts.ok) return platformProducts;
  const orderEvidenceJson = {
    probeConfig: getProductionTransactionProbeTarget(probe),
    externalReadiness,
    shopifyOrderId: snapshot.shopifyOrderId,
    shopifyOrderName: snapshot.shopifyOrderName,
    createdAt: snapshot.createdAt,
    commercialFingerprint: snapshot.commercialFingerprint,
    commercialEvidence: snapshot.commercialEvidence,
    products: platformProducts.products,
    vendorStoreIds: platformProducts.vendorStoreIds,
    attachedBy: clean(actorKey) || probe.startedBy,
    attachedAt: now.toISOString(),
  };
  try {
    const transitioned = await transitionActiveProbe(
      {
        probe,
        expectedStatuses: [PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_ORDER],
        data: {
          shopifyOrderId: snapshot.shopifyOrderId,
          status: PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_SETTLEMENT,
          orderAttachedAt: now,
          lastCheckedAt: now,
          lastErrorCode: null,
          orderEvidenceJson,
        },
      },
      { prismaClient },
    );
    return transitioned.ok
      ? { ok: true, probe: transitioned.probe, snapshot }
      : transitioned;
  } catch (error) {
    if (error?.code === "P2002") {
      return { ok: false, reason: "shopify_order_already_used" };
    }
    throw error;
  }
}

async function loadLocalOrderEvidence(probe, prismaClient) {
  const marketplaceOrder = await prismaClient.marketplaceOrder.findUnique({
    where: {
      shopDomain_shopifyOrderId: {
        shopDomain: probe.shopDomain,
        shopifyOrderId: probe.shopifyOrderId,
      },
    },
    include: {
      sellerOrders: {
        include: {
          lines: true,
        },
      },
    },
  });
  const candidateLedgerEntries = await prismaClient.ledgerEntry.findMany({
    where: {
      entryType: { in: SETTLEMENT_ENTRY_TYPES },
      OR: [
        { stripeObjectId: probe.shopifyOrderId },
        {
          metadataJson: {
            path: ["shopifyOrderId"],
            equals: probe.shopifyOrderId,
          },
        },
      ],
    },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
  const ledgerEntries = candidateLedgerEntries.filter(
    (entry) =>
      normalizeShop(asObject(entry.metadataJson).shopDomain) ===
      probe.shopDomain,
  );
  const shadowCheck = prismaClient?.sellerOrderShadowCheck?.findFirst
    ? await prismaClient.sellerOrderShadowCheck.findFirst({
        where: {
          shopDomain: probe.shopDomain,
          shopifyOrderId: probe.shopifyOrderId,
        },
        orderBy: { checkedAt: "desc" },
      })
    : null;
  const paymentAttempts = prismaClient?.marketplacePaymentAttempt?.findMany
    ? await prismaClient.marketplacePaymentAttempt.findMany({
        where: {
          shopDomain: probe.shopDomain,
          shopifyOrderId: probe.shopifyOrderId,
        },
        orderBy: [{ processedAt: "asc" }, { createdAt: "asc" }],
        include: {
          settlementLine: {
            include: {
              batch: {
                select: {
                  id: true,
                  provider: true,
                  externalBatchId: true,
                  status: true,
                  bankDepositedAt: true,
                  evidenceHash: true,
                },
              },
            },
          },
        },
      })
    : [];
  const existingPayoutBatchId = clean(
    asObject(asObject(probe.orderEvidenceJson).externalReadiness)
      .existingPayoutBatchId,
  );
  const existingPayoutBatch =
    existingPayoutBatchId && prismaClient?.paymentSettlementBatch?.findUnique
      ? await prismaClient.paymentSettlementBatch.findUnique({
          where: { id: existingPayoutBatchId },
          include: {
            lines: {
              where: {
                paymentAttemptId: { not: null },
                matchStatus: "MATCHED",
              },
              select: { id: true },
            },
          },
        })
      : null;
  const storeIds = unique(
    (marketplaceOrder?.sellerOrders || []).map(
      (sellerOrder) => sellerOrder.vendorStoreId,
    ),
  );
  const stores =
    storeIds.length > 0
      ? await prismaClient.vendorStore.findMany({
          where: { id: { in: storeIds } },
          select: {
            id: true,
            isPlatformStore: true,
            isTestStore: true,
          },
        })
      : [];
  return {
    marketplaceOrder,
    ledgerEntries,
    shadowCheck,
    paymentAttempts,
    existingPayoutBatch,
    stores,
  };
}

function check(id, passed, code, details = {}) {
  return {
    id,
    passed: passed === true,
    code: passed === true ? null : code,
    ...details,
  };
}

function sellerOrderExpectedPaidAmount(sellerOrders) {
  return sellerOrders.reduce(
    (sum, sellerOrder) =>
      sum + toNonNegativeInteger(sellerOrder.sellerPayableAmount),
    0,
  );
}

function classifyProbeTransaction(transaction) {
  return classifyPaymentGateway(
    transaction?.gateway,
    transaction?.formattedGateway,
    {
      __typename: transaction?.paymentDetailsType,
      paymentMethodName: transaction?.paymentMethodName,
      wallet: transaction?.paymentWallet,
    },
  );
}

function requiresStructuredCardEvidence(target) {
  return (
    Number(target?.version) >= PRODUCTION_TRANSACTION_TARGET_VERSION &&
    target?.paymentMethod === PAYMENT_METHOD.CARD
  );
}

function transactionMatchesProvider(transaction, target) {
  return (
    transaction?.manualPaymentGateway !== true &&
    classifyProbeTransaction(transaction).provider === target.provider
  );
}

function transactionMatchesMethod(transaction, target) {
  if (requiresStructuredCardEvidence(target)) {
    return (
      transaction?.manualPaymentGateway !== true &&
      transaction?.paymentDetailsType === "CardPaymentDetails" &&
      !clean(transaction?.paymentWallet)
    );
  }
  return (
    transaction?.manualPaymentGateway !== true &&
    classifyProbeTransaction(transaction).paymentMethod === target.paymentMethod
  );
}

function refundTransactionMatchesMethod(transaction, target) {
  const classification = classifyProbeTransaction(transaction);
  if (transaction?.manualPaymentGateway === true) return false;
  if (classification.paymentMethod === target.paymentMethod) return true;

  // Shopify may return only the provider name on a refund transaction. The
  // captured parent transaction remains the authoritative payment-method link.
  return (
    target.refundMode === PAYMENT_REFUND_MODE.SHOPIFY_LINKED &&
    classification.provider === target.provider &&
    classification.paymentMethod === PAYMENT_METHOD.OTHER
  );
}

function getSuccessfulPaymentTransactions(snapshot) {
  return snapshot.transactions.filter(
    (transaction) =>
      SUCCESSFUL_PAYMENT_TRANSACTION_KINDS.has(transaction.kind) &&
      transaction.status === "SUCCESS",
  );
}

function getRefundTransactions(snapshot) {
  return snapshot.refunds.flatMap((refund) =>
    refund.transactions.map((transaction) => ({
      ...transaction,
      refundId: refund.id,
    })),
  );
}

function buildPaidInspection({ probe, snapshot, local }) {
  const target = getProductionTransactionProbeTarget(probe);
  const marketplaceOrder = local.marketplaceOrder;
  const sellerOrders = marketplaceOrder?.sellerOrders || [];
  const sellerOrderLines = sellerOrders.flatMap(
    (sellerOrder) => sellerOrder.lines,
  );
  const expectedLines = snapshot.commercialEvidence.lines;
  const actualLineByShopifyId = new Map(
    sellerOrderLines.map((line) => [line.shopifyLineItemId, line]),
  );
  const lineSnapshotsMatch =
    sellerOrderLines.length === expectedLines.length &&
    expectedLines.every((expectedLine) => {
      const actualLine = actualLineByShopifyId.get(expectedLine.id);
      return Boolean(
        actualLine &&
        actualLine.quantity === expectedLine.quantity &&
        actualLine.shopifyProductId === expectedLine.productId &&
        (expectedLine.variantId
          ? actualLine.shopifyVariantId === expectedLine.variantId
          : true) &&
        actualLine.unitAmount === expectedLine.unitAmount &&
        actualLine.netAmount === expectedLine.discountedTotalAmount,
      );
    });
  const paidEntries = local.ledgerEntries.filter(
    (entry) => entry.entryType === "shopify_order_paid",
  );
  const expectedSellerIds = new Set(
    sellerOrders.map((sellerOrder) => sellerOrder.sellerId).filter(Boolean),
  );
  const expectedPaidAmount = sellerOrderExpectedPaidAmount(sellerOrders);
  const actualPaidAmount = paidEntries.reduce(
    (sum, entry) => sum + toNonNegativeInteger(entry.amount),
    0,
  );
  const currencyCode = snapshot.commercialEvidence.currencyCode.toLowerCase();
  const paymentTransactions = getSuccessfulPaymentTransactions(snapshot);
  const paymentTransactionAmount = paymentTransactions.reduce(
    (sum, transaction) => sum + transaction.amount,
    0,
  );
  const paymentTransactionIds = paymentTransactions
    .map((transaction) => transaction.id)
    .filter(Boolean)
    .sort();
  const paymentTransactionIdSet = new Set(paymentTransactionIds);
  const matchingPaymentAttempts = (local.paymentAttempts || []).filter(
    (attempt) => {
      const metadata = asObject(attempt.metadataJson);
      const structuredCardMatches = requiresStructuredCardEvidence(target)
        ? metadata.paymentDetailsType === "CardPaymentDetails" &&
          !clean(metadata.paymentWallet)
        : true;
      return (
        attempt.status === "CAPTURED" &&
        attempt.test !== true &&
        attempt.requiresReview !== true &&
        attempt.provider === target.provider &&
        attempt.paymentMethod === target.paymentMethod &&
        paymentTransactionIdSet.has(attempt.shopifyTransactionId) &&
        attempt.amount === snapshot.commercialEvidence.totalAmount &&
        normalizeCurrency(attempt.currencyCode) ===
          snapshot.commercialEvidence.currencyCode &&
        structuredCardMatches
      );
    },
  );
  const checks = [
    check(
      "payment_transaction_present",
      paymentTransactions.length > 0,
      "payment_transaction_missing",
      { actualCount: paymentTransactions.length },
    ),
    check(
      "payment_transaction_single",
      paymentTransactions.length === 1,
      "payment_transaction_count_mismatch",
      { actualCount: paymentTransactions.length },
    ),
    check(
      "payment_transaction_status",
      paymentTransactions.every(
        (transaction) =>
          transaction.status === "SUCCESS" &&
          SUCCESSFUL_PAYMENT_TRANSACTION_KINDS.has(transaction.kind),
      ),
      "payment_transaction_not_captured",
    ),
    check(
      "payment_transaction_provider",
      paymentTransactions.length > 0 &&
        paymentTransactions.every((transaction) =>
          transactionMatchesProvider(transaction, target),
        ),
      "payment_transaction_provider_mismatch",
      { expectedProvider: target.provider },
    ),
    check(
      "payment_transaction_method",
      paymentTransactions.length > 0 &&
        paymentTransactions.every((transaction) =>
          transactionMatchesMethod(transaction, target),
        ),
      "payment_transaction_method_mismatch",
      { expectedPaymentMethod: target.paymentMethod },
    ),
    check(
      "payment_transaction_live",
      paymentTransactions.length > 0 &&
        paymentTransactions.every((transaction) => transaction.test !== true),
      "payment_transaction_is_test",
    ),
    check(
      "payment_transaction_amount",
      paymentTransactionAmount === snapshot.commercialEvidence.totalAmount,
      "payment_transaction_amount_mismatch",
      {
        expectedAmount: snapshot.commercialEvidence.totalAmount,
        actualAmount: paymentTransactionAmount,
      },
    ),
    check(
      "payment_transaction_currency",
      paymentTransactions.length > 0 &&
        paymentTransactions.every(
          (transaction) =>
            transaction.currencyCode ===
            snapshot.commercialEvidence.currencyCode,
        ),
      "payment_transaction_currency_mismatch",
    ),
    check(
      "payment_attempt_direct_match",
      matchingPaymentAttempts.length === 1,
      "payment_attempt_direct_match_missing",
      { actualCount: matchingPaymentAttempts.length },
    ),
    check(
      "commercial_fingerprint",
      asObject(probe.orderEvidenceJson).commercialFingerprint ===
        snapshot.commercialFingerprint,
      "shopify_order_changed_after_attachment",
    ),
    check(
      "marketplace_order",
      Boolean(marketplaceOrder),
      "marketplace_order_missing",
    ),
    check(
      "marketplace_currency",
      marketplaceOrder?.currencyCode?.toLowerCase() === currencyCode,
      "marketplace_order_currency_mismatch",
    ),
    check(
      "marketplace_total",
      marketplaceOrder?.totalAmount === snapshot.commercialEvidence.totalAmount,
      "marketplace_order_total_mismatch",
    ),
    check(
      "seller_orders",
      sellerOrders.length === 1,
      "seller_order_count_mismatch",
      { actualCount: sellerOrders.length },
    ),
    check(
      "platform_store",
      local.stores.length > 0 &&
        local.stores.every(
          (store) =>
            store.isPlatformStore === true && store.isTestStore !== true,
        ),
      "seller_order_not_platform_direct",
    ),
    check(
      "seller_order_lines",
      sellerOrders.length > 0 && lineSnapshotsMatch,
      "seller_order_lines_mismatch",
      {
        expectedCount: expectedLines.length,
        actualCount: sellerOrderLines.length,
      },
    ),
    check(
      "paid_ledger_count",
      paidEntries.length === sellerOrders.length && paidEntries.length === 1,
      "paid_ledger_count_mismatch",
      { actualCount: paidEntries.length },
    ),
    check(
      "paid_ledger_direction",
      paidEntries.length > 0 &&
        paidEntries.every((entry) => entry.direction === "credit"),
      "paid_ledger_direction_mismatch",
    ),
    check(
      "paid_ledger_currency",
      paidEntries.length > 0 &&
        paidEntries.every(
          (entry) => entry.currencyCode?.toLowerCase() === currencyCode,
        ),
      "paid_ledger_currency_mismatch",
    ),
    check(
      "paid_ledger_amount",
      expectedPaidAmount > 0 && actualPaidAmount === expectedPaidAmount,
      "paid_ledger_amount_mismatch",
      { expectedAmount: expectedPaidAmount, actualAmount: actualPaidAmount },
    ),
    check(
      "paid_ledger_seller",
      paidEntries.length > 0 &&
        paidEntries.every((entry) => expectedSellerIds.has(entry.sellerId)) &&
        new Set(paidEntries.map((entry) => entry.sellerId)).size ===
          expectedSellerIds.size,
      "paid_ledger_seller_mismatch",
    ),
    check(
      "seller_order_shadow",
      local.shadowCheck?.status === "matched",
      "seller_order_shadow_not_matched",
      { actualStatus: local.shadowCheck?.status || null },
    ),
  ];
  return {
    passed: checks.every((entry) => entry.passed),
    checks,
    expectedPaidAmount,
    actualPaidAmount,
    currencyCode: normalizeCurrency(snapshot.commercialEvidence.currencyCode),
    marketplaceOrderId: marketplaceOrder?.id || null,
    sellerOrderIds: sellerOrders.map((sellerOrder) => sellerOrder.id).sort(),
    paidLedgerEntryIds: paidEntries.map((entry) => entry.id).sort(),
    shopifyPaymentTransactionIds: paymentTransactionIds,
    shopifyPaymentTransactionAmount: paymentTransactionAmount,
    paymentAttemptIds: matchingPaymentAttempts
      .map((attempt) => attempt.id)
      .sort(),
    paymentTarget: target,
  };
}

function buildPayoutEvidenceInspection({ probe, local, paidInspection }) {
  if (paidInspection.paymentTarget?.provider !== PAYMENT_PROVIDER.KOMOJU) {
    return {
      passed: true,
      strategy: "NOT_REQUIRED",
      code: null,
      currentPaymentDirectlyLinked: false,
    };
  }
  const readiness = asObject(
    asObject(probe.orderEvidenceJson).externalReadiness,
  );
  const strategy = normalizePayoutEvidenceStrategy(readiness.strategy);
  if (strategy === KOMOJU_PAYOUT_EVIDENCE_STRATEGY.EXISTING_RECONCILED_PAYOUT) {
    const batch = local.existingPayoutBatch;
    const passed = Boolean(
      batch &&
      batch.provider === "KOMOJU" &&
      batch.status === "RECONCILED" &&
      batch.bankDepositedAt &&
      normalizeSha256(batch.evidenceHash) &&
      batch.lines?.length > 0,
    );
    return {
      passed,
      strategy,
      code: passed ? null : "existing_reconciled_payout_missing",
      batchId: batch?.id || null,
      externalBatchId: batch?.externalBatchId || null,
      bankDepositedAt: batch?.bankDepositedAt || null,
      currentPaymentDirectlyLinked: false,
    };
  }
  if (
    strategy ===
      KOMOJU_PAYOUT_EVIDENCE_STRATEGY.CURRENT_PAYMENT_WITH_REFUND_RESERVE ||
    strategy === KOMOJU_PAYOUT_EVIDENCE_STRATEGY.ZERO_BALANCE_LIMITED_LAUNCH
  ) {
    const expectedAttemptIds = new Set(paidInspection.paymentAttemptIds || []);
    const matchingLines = (local.paymentAttempts || []).flatMap((attempt) => {
      const line = attempt.settlementLine;
      return expectedAttemptIds.has(attempt.id) &&
        line?.matchStatus === "MATCHED" &&
        line.amount === attempt.amount &&
        line.batch?.provider === "KOMOJU" &&
        line.batch?.status === "RECONCILED" &&
        Boolean(line.batch?.bankDepositedAt) &&
        Boolean(normalizeSha256(line.batch?.evidenceHash))
        ? [line]
        : [];
    });
    const batchIds = unique(matchingLines.map((line) => line.batch?.id));
    const passed =
      expectedAttemptIds.size === 1 &&
      matchingLines.length === 1 &&
      batchIds.length === 1;
    return {
      passed,
      strategy,
      code: passed
        ? null
        : strategy ===
            KOMOJU_PAYOUT_EVIDENCE_STRATEGY.ZERO_BALANCE_LIMITED_LAUNCH
          ? "limited_launch_exception_required"
          : "current_payment_payout_evidence_missing",
      batchId: passed ? batchIds[0] : null,
      externalBatchId: passed
        ? matchingLines[0].batch?.externalBatchId || null
        : null,
      bankDepositedAt: passed
        ? matchingLines[0].batch?.bankDepositedAt || null
        : null,
      settlementLineIds: matchingLines.map((line) => line.id).sort(),
      currentPaymentDirectlyLinked: passed,
    };
  }
  return {
    passed: false,
    strategy: null,
    code: "payout_evidence_strategy_missing",
    currentPaymentDirectlyLinked: false,
  };
}

function buildRefundReserveConfirmationInspection({ probe, paidInspection }) {
  if (paidInspection.paymentTarget?.provider !== PAYMENT_PROVIDER.KOMOJU) {
    return { passed: true, code: null, amount: 0 };
  }
  const readiness = asObject(
    asObject(probe.orderEvidenceJson).externalReadiness,
  );
  const confirmation = asObject(readiness.refundReserveReconfirmation);
  const maximumCharge = toNonNegativeInteger(
    readiness.maximumPlannedChargeAmount,
  );
  const amount = toNonNegativeInteger(confirmation.amount);
  const confirmedAt = parseDate(confirmation.confirmedAt);
  const passed = Boolean(
    maximumCharge > 0 &&
    amount >= maximumCharge &&
    clean(confirmation.evidenceReference) &&
    normalizeSha256(confirmation.evidenceHash) &&
    confirmedAt,
  );
  return {
    passed,
    code: passed ? null : "komoju_refund_reserve_reconfirmation_required",
    amount,
    maximumPlannedChargeAmount: maximumCharge,
    evidenceReference: clean(confirmation.evidenceReference) || null,
    evidenceHash: normalizeSha256(confirmation.evidenceHash),
    confirmedAt: confirmedAt?.toISOString() || null,
    confirmedBy: clean(confirmation.confirmedBy) || null,
  };
}

export async function confirmProductionTransactionRefundReserve(
  {
    probeId,
    actorKey,
    releaseExpectation,
    confirmedRefundReserveAmount,
    evidenceReference,
    evidenceHash,
    confirm,
  },
  { prismaClient = prisma, now = new Date() } = {},
) {
  const probe = await prismaClient.productionTransactionProbe.findUnique({
    where: { id: clean(probeId) },
  });
  if (
    !probe ||
    probe.status !==
      PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_REFUND_RESERVE_CONFIRMATION
  ) {
    return { ok: false, reason: "refund_reserve_confirmation_not_available" };
  }
  const release = buildReleaseContext(releaseExpectation);
  if (
    !release.configured ||
    release.releaseFingerprint !== probe.releaseFingerprint
  ) {
    return invalidateProbeForReleaseChange(probe, { prismaClient, now });
  }
  const readiness = asObject(
    asObject(probe.orderEvidenceJson).externalReadiness,
  );
  const maximumCharge = toNonNegativeInteger(
    readiness.maximumPlannedChargeAmount,
  );
  const amount = toNonNegativeInteger(confirmedRefundReserveAmount);
  const reference = clean(evidenceReference);
  const normalizedHash = normalizeSha256(evidenceHash);
  if (
    confirm !== "refund_reserve_reconfirmed" ||
    maximumCharge <= 0 ||
    amount < maximumCharge ||
    !reference ||
    !normalizedHash
  ) {
    return {
      ok: false,
      reason: "komoju_refund_reserve_reconfirmation_invalid",
    };
  }
  return transitionActiveProbe(
    {
      probe,
      expectedStatuses: [
        PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_REFUND_RESERVE_CONFIRMATION,
      ],
      data: {
        lastCheckedAt: now,
        lastErrorCode: null,
        orderEvidenceJson: {
          ...asObject(probe.orderEvidenceJson),
          externalReadiness: {
            ...readiness,
            refundReserveReconfirmation: {
              amount,
              evidenceReference: reference,
              evidenceHash: normalizedHash,
              confirmedAt: now.toISOString(),
              confirmedBy: clean(actorKey) || probe.startedBy,
            },
          },
        },
      },
    },
    { prismaClient },
  );
}

function buildRefundInspection({ snapshot, local, paidInspection }) {
  const target =
    paidInspection.paymentTarget || DEFAULT_PRODUCTION_TRANSACTION_TARGET;
  const sellerOrders = local.marketplaceOrder?.sellerOrders || [];
  const expectedSellerIds = new Set(
    sellerOrders.map((sellerOrder) => sellerOrder.sellerId).filter(Boolean),
  );
  const refundEntries = local.ledgerEntries.filter(
    (entry) => entry.entryType === "refund",
  );
  const cancellationEntries = local.ledgerEntries.filter(
    (entry) => entry.entryType === "shopify_order_cancelled",
  );
  const reversalEntries = [...refundEntries, ...cancellationEntries];
  const reversalAmount = reversalEntries.reduce(
    (sum, entry) => sum + toNonNegativeInteger(entry.amount),
    0,
  );
  const expectedAmount = paidInspection.expectedPaidAmount;
  const refundIds = refundEntries.map((entry) =>
    clean(asObject(entry.metadataJson).shopifyRefundId),
  );
  const nonEmptyRefundIds = refundIds.filter(Boolean);
  const ledgerRefundIds = [...new Set(nonEmptyRefundIds)].sort();
  const shopifyRefundIds = [...snapshot.refundIds].sort();
  const refundTransactions = getRefundTransactions(snapshot);
  const successfulRefundTransactions = refundTransactions.filter(
    (transaction) =>
      transaction.kind === "REFUND" && transaction.status === "SUCCESS",
  );
  const successfulPaymentTransactionIds = new Set(
    paidInspection.shopifyPaymentTransactionIds,
  );
  const refundTransactionAmount = successfulRefundTransactions.reduce(
    (sum, transaction) => sum + transaction.amount,
    0,
  );
  const fullLineRefund = sellerOrders.every((sellerOrder) =>
    sellerOrder.lines.every(
      (line) =>
        toNonNegativeInteger(line.refundedQuantity) ===
        toNonNegativeInteger(line.quantity),
    ),
  );
  const checks = [
    check(
      "refund_transaction_present",
      successfulRefundTransactions.length > 0,
      "refund_transaction_missing",
      { actualCount: successfulRefundTransactions.length },
    ),
    check(
      "refund_transaction_status",
      refundTransactions.length > 0 &&
        refundTransactions.every(
          (transaction) =>
            transaction.kind === "REFUND" && transaction.status === "SUCCESS",
        ),
      "refund_transaction_not_successful",
    ),
    check(
      "refund_transaction_provider",
      successfulRefundTransactions.length > 0 &&
        successfulRefundTransactions.every((transaction) =>
          transactionMatchesProvider(transaction, target),
        ),
      "refund_transaction_provider_mismatch",
      { expectedProvider: target.provider },
    ),
    check(
      "refund_transaction_method",
      successfulRefundTransactions.length > 0 &&
        successfulRefundTransactions.every((transaction) =>
          refundTransactionMatchesMethod(transaction, target),
        ),
      "refund_transaction_method_mismatch",
      { expectedPaymentMethod: target.paymentMethod },
    ),
    check(
      "refund_transaction_live",
      successfulRefundTransactions.length > 0 &&
        successfulRefundTransactions.every(
          (transaction) => transaction.test !== true,
        ),
      "refund_transaction_is_test",
    ),
    check(
      "refund_transaction_parent",
      successfulRefundTransactions.length > 0 &&
        successfulRefundTransactions.every(
          (transaction) =>
            transaction.parentTransactionId &&
            successfulPaymentTransactionIds.has(
              transaction.parentTransactionId,
            ),
        ),
      "refund_transaction_parent_mismatch",
    ),
    check(
      "refund_transaction_amount",
      refundTransactionAmount === snapshot.commercialEvidence.totalAmount,
      "refund_transaction_amount_mismatch",
      {
        expectedAmount: snapshot.commercialEvidence.totalAmount,
        actualAmount: refundTransactionAmount,
      },
    ),
    check(
      "refund_transaction_currency",
      successfulRefundTransactions.length > 0 &&
        successfulRefundTransactions.every(
          (transaction) =>
            transaction.currencyCode === paidInspection.currencyCode,
        ),
      "refund_transaction_currency_mismatch",
    ),
    check(
      "shopify_financial_status",
      snapshot.financialStatus === "REFUNDED",
      "shopify_order_not_fully_refunded",
      { actualStatus: snapshot.financialStatus },
    ),
    check(
      "shopify_refund_total",
      snapshot.refundedAmount === snapshot.commercialEvidence.totalAmount,
      "shopify_refund_total_mismatch",
      {
        expectedAmount: snapshot.commercialEvidence.totalAmount,
        actualAmount: snapshot.refundedAmount,
      },
    ),
    check(
      "shopify_refund_record",
      snapshot.refundIds.length === 1,
      "shopify_refund_count_mismatch",
      { actualCount: snapshot.refundIds.length },
    ),
    check(
      "seller_order_refund_amount",
      sellerOrders.length > 0 &&
        sellerOrders.every(
          (sellerOrder) =>
            toNonNegativeInteger(sellerOrder.sellerRefundAmount) ===
            toNonNegativeInteger(sellerOrder.sellerPayableAmount),
        ),
      "seller_order_refund_amount_mismatch",
    ),
    check(
      "seller_order_refund_quantity",
      sellerOrders.length > 0 && fullLineRefund,
      "seller_order_refund_quantity_mismatch",
    ),
    check(
      "refund_ledger_count",
      refundEntries.length === 1,
      "refund_ledger_count_mismatch",
      { actualCount: refundEntries.length },
    ),
    check(
      "refund_ledger_direction",
      refundEntries.length > 0 &&
        refundEntries.every((entry) => entry.direction === "debit"),
      "refund_ledger_direction_mismatch",
    ),
    check(
      "refund_ledger_currency",
      refundEntries.length > 0 &&
        refundEntries.every(
          (entry) =>
            normalizeCurrency(entry.currencyCode) ===
            paidInspection.currencyCode,
        ),
      "refund_ledger_currency_mismatch",
    ),
    check(
      "refund_ledger_seller",
      refundEntries.length > 0 &&
        refundEntries.every((entry) => expectedSellerIds.has(entry.sellerId)) &&
        new Set(refundEntries.map((entry) => entry.sellerId)).size ===
          expectedSellerIds.size,
      "refund_ledger_seller_mismatch",
    ),
    check(
      "refund_ledger_identifiers",
      nonEmptyRefundIds.length === refundEntries.length &&
        ledgerRefundIds.length === refundEntries.length &&
        ledgerRefundIds.length === shopifyRefundIds.length &&
        ledgerRefundIds.every(
          (refundId, index) => refundId === shopifyRefundIds[index],
        ),
      "refund_ledger_identifier_mismatch",
    ),
    check(
      "reversal_amount",
      expectedAmount > 0 && reversalAmount === expectedAmount,
      "order_reversal_amount_mismatch",
      { expectedAmount, actualAmount: reversalAmount },
    ),
    check(
      "cancellation_no_double_debit",
      cancellationEntries.length <= 1 && reversalAmount <= expectedAmount,
      "order_cancellation_double_debit",
      { cancellationCount: cancellationEntries.length },
    ),
  ];
  return {
    passed: checks.every((entry) => entry.passed),
    checks,
    expectedAmount,
    actualAmount: reversalAmount,
    refundLedgerEntryIds: refundEntries.map((entry) => entry.id).sort(),
    cancellationLedgerEntryIds: cancellationEntries
      .map((entry) => entry.id)
      .sort(),
    shopifyRefundIds: snapshot.refundIds,
    shopifyRefundTransactionIds: successfulRefundTransactions
      .map((transaction) => transaction.id)
      .filter(Boolean)
      .sort(),
    shopifyRefundTransactionAmount: refundTransactionAmount,
    paymentTarget: target,
  };
}

function pendingReason(inspection) {
  return inspection.checks.find((entry) => !entry.passed)?.code || null;
}

async function invalidateProbeForReleaseChange(probe, { prismaClient, now }) {
  const transitioned = await transitionActiveProbe(
    {
      probe,
      expectedStatuses: ACTIVE_PROBE_STATUSES,
      data: {
        activeKey: null,
        status: PRODUCTION_TRANSACTION_PROBE_STATUS.INVALIDATED,
        invalidatedAt: now,
        lastCheckedAt: now,
        lastErrorCode: "release_changed",
      },
    },
    { prismaClient },
  );
  return {
    ok: false,
    reason: transitioned.ok ? "release_changed" : transitioned.reason,
    probe: transitioned.probe,
  };
}

export async function refreshProductionTransactionProbe(
  { probeId, actorKey, releaseExpectation },
  {
    prismaClient = prisma,
    graphQL = shopifyGraphQLWithOfflineSession,
    syncPaymentAttemptsImpl = syncShopifyOrderPaymentAttempts,
    now = new Date(),
  } = {},
) {
  const probe = await prismaClient.productionTransactionProbe.findUnique({
    where: { id: clean(probeId) },
  });
  if (!probe || !ACTIVE_PROBE_STATUSES.includes(probe.status)) {
    return { ok: false, reason: "active_probe_not_found" };
  }
  const release = buildReleaseContext(releaseExpectation);
  if (
    !release.configured ||
    release.releaseFingerprint !== probe.releaseFingerprint
  ) {
    return invalidateProbeForReleaseChange(probe, { prismaClient, now });
  }
  if (!probe.shopifyOrderId) {
    return { ok: true, pending: true, probe };
  }
  const fetched = await fetchShopifyOrderForProductionProbe(
    { shopDomain: probe.shopDomain, orderReference: probe.shopifyOrderId },
    { graphQL },
  );
  if (!fetched.ok) {
    const transitioned = await transitionActiveProbe(
      {
        probe,
        expectedStatuses: ACTIVE_PROBE_STATUSES,
        data: {
          lastCheckedAt: now,
          lastErrorCode: fetched.reason,
        },
      },
      { prismaClient },
    );
    return transitioned.ok
      ? { ...fetched, probe: transitioned.probe }
      : transitioned;
  }
  let local = await loadLocalOrderEvidence(probe, prismaClient);
  let paidInspection = buildPaidInspection({
    probe,
    snapshot: fetched.snapshot,
    local,
  });
  let paymentAttemptRecovery = null;
  const paymentTransactionIds = new Set(
    (paidInspection.shopifyPaymentTransactionIds || []).filter(Boolean),
  );
  const matchingAttemptStored = (local.paymentAttempts || []).some((attempt) =>
    paymentTransactionIds.has(attempt.shopifyTransactionId),
  );
  if (
    pendingReason(paidInspection) === "payment_attempt_direct_match_missing" &&
    !matchingAttemptStored
  ) {
    try {
      const recovery = await syncPaymentAttemptsImpl(
        {
          payload: { id: probe.shopifyOrderId },
          shop: probe.shopDomain,
          sourceTopic: "PRODUCTION_TRANSACTION_PROBE_RECOVERY",
        },
        {
          prismaClient,
          loadCanonicalPaymentOrderImpl: async () => fetched.order,
          now,
          canonicalOnly: true,
        },
      );
      paymentAttemptRecovery = {
        attempted: true,
        ok: recovery?.ok === true,
        tracked: recovery?.tracked === true,
        reason: clean(recovery?.reason) || null,
      };
      if (recovery?.ok === true && recovery?.tracked !== false) {
        local = await loadLocalOrderEvidence(probe, prismaClient);
        paidInspection = buildPaidInspection({
          probe,
          snapshot: fetched.snapshot,
          local,
        });
      }
    } catch (error) {
      paymentAttemptRecovery = {
        attempted: true,
        ok: false,
        tracked: false,
        reason: "payment_attempt_recovery_failed",
      };
      console.error("Production transaction payment recovery failed:", {
        probeId: probe.id,
        name: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  if (paymentAttemptRecovery) {
    paidInspection = { ...paidInspection, paymentAttemptRecovery };
  }
  if (!paidInspection.passed) {
    const transitioned = await transitionActiveProbe(
      {
        probe,
        expectedStatuses: ACTIVE_PROBE_STATUSES,
        data: {
          status: PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_SETTLEMENT,
          lastCheckedAt: now,
          lastErrorCode: pendingReason(paidInspection),
          paidEvidenceJson: paidInspection,
          marketplaceOrderId: paidInspection.marketplaceOrderId,
        },
      },
      { prismaClient },
    );
    if (!transitioned.ok) return transitioned;
    return {
      ok: true,
      pending: true,
      stage: "settlement",
      probe: transitioned.probe,
      paidInspection,
    };
  }
  const payoutEvidenceInspection = buildPayoutEvidenceInspection({
    probe,
    local,
    paidInspection,
  });
  if (!payoutEvidenceInspection.passed) {
    const transitioned = await transitionActiveProbe(
      {
        probe,
        expectedStatuses: ACTIVE_PROBE_STATUSES,
        data: {
          status: PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_PAYOUT_EVIDENCE,
          paidVerifiedAt: probe.paidVerifiedAt || now,
          lastCheckedAt: now,
          lastErrorCode: payoutEvidenceInspection.code,
          paidEvidenceJson: {
            ...paidInspection,
            payoutEvidenceInspection,
          },
          marketplaceOrderId: paidInspection.marketplaceOrderId,
        },
      },
      { prismaClient },
    );
    if (!transitioned.ok) return transitioned;
    return {
      ok: true,
      pending: true,
      stage: "payout_evidence",
      probe: transitioned.probe,
      paidInspection,
      payoutEvidenceInspection,
    };
  }
  const refundReserveConfirmationInspection =
    buildRefundReserveConfirmationInspection({ probe, paidInspection });
  if (!refundReserveConfirmationInspection.passed) {
    const transitioned = await transitionActiveProbe(
      {
        probe,
        expectedStatuses: ACTIVE_PROBE_STATUSES,
        data: {
          status:
            PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_REFUND_RESERVE_CONFIRMATION,
          paidVerifiedAt: probe.paidVerifiedAt || now,
          lastCheckedAt: now,
          lastErrorCode: refundReserveConfirmationInspection.code,
          paidEvidenceJson: {
            ...paidInspection,
            payoutEvidenceInspection,
            refundReserveConfirmationInspection,
          },
          marketplaceOrderId: paidInspection.marketplaceOrderId,
        },
      },
      { prismaClient },
    );
    if (!transitioned.ok) return transitioned;
    return {
      ok: true,
      pending: true,
      stage: "refund_reserve_confirmation",
      probe: transitioned.probe,
      paidInspection,
      payoutEvidenceInspection,
      refundReserveConfirmationInspection,
    };
  }
  const refundInspection = buildRefundInspection({
    snapshot: fetched.snapshot,
    local,
    paidInspection,
  });
  if (!refundInspection.passed) {
    const transitioned = await transitionActiveProbe(
      {
        probe,
        expectedStatuses: ACTIVE_PROBE_STATUSES,
        data: {
          status: PRODUCTION_TRANSACTION_PROBE_STATUS.AWAITING_REFUND,
          paidVerifiedAt: probe.paidVerifiedAt || now,
          lastCheckedAt: now,
          lastErrorCode: pendingReason(refundInspection),
          paidEvidenceJson: {
            ...paidInspection,
            payoutEvidenceInspection,
            refundReserveConfirmationInspection,
          },
          refundEvidenceJson: refundInspection,
          marketplaceOrderId: paidInspection.marketplaceOrderId,
        },
      },
      { prismaClient },
    );
    if (!transitioned.ok) return transitioned;
    return {
      ok: true,
      pending: true,
      stage: "refund",
      probe: transitioned.probe,
      paidInspection,
      payoutEvidenceInspection,
      refundReserveConfirmationInspection,
      refundInspection,
    };
  }
  const finalEvidence = {
    version: 5,
    probeId: probe.id,
    shopDomain: probe.shopDomain,
    releaseId: probe.releaseId,
    releaseFingerprint: probe.releaseFingerprint,
    shopifyOrderId: probe.shopifyOrderId,
    marketplaceOrderId: paidInspection.marketplaceOrderId,
    commercialFingerprint: fetched.snapshot.commercialFingerprint,
    paymentTarget: paidInspection.paymentTarget,
    paidInspection,
    payoutEvidenceInspection,
    refundReserveConfirmationInspection,
    refundInspection,
    completedAt: now.toISOString(),
    verifiedBy: clean(actorKey) || probe.startedBy,
  };
  const evidenceHash = hashEvidence(finalEvidence);
  const complete = async (tx) => {
    const claimed = await tx.productionTransactionProbe.updateMany({
      where: {
        id: probe.id,
        activeKey: activeKey(probe.shopDomain),
        releaseFingerprint: probe.releaseFingerprint,
        status: { in: ACTIVE_PROBE_STATUSES },
      },
      data: {
        activeKey: null,
        status: PRODUCTION_TRANSACTION_PROBE_STATUS.PASSED,
        paidVerifiedAt: probe.paidVerifiedAt || now,
        refundVerifiedAt: now,
        completedAt: now,
        lastCheckedAt: now,
        lastErrorCode: null,
        evidenceHash,
        paidEvidenceJson: {
          ...paidInspection,
          payoutEvidenceInspection,
          refundReserveConfirmationInspection,
        },
        refundEvidenceJson: refundInspection,
        finalEvidenceJson: finalEvidence,
        marketplaceOrderId: paidInspection.marketplaceOrderId,
      },
    });
    if (claimed.count !== 1) {
      const latest = await tx.productionTransactionProbe.findUnique({
        where: { id: probe.id },
      });
      if (
        latest?.status === PRODUCTION_TRANSACTION_PROBE_STATUS.PASSED &&
        latest?.releaseFingerprint === probe.releaseFingerprint &&
        latest?.shopifyOrderId === probe.shopifyOrderId
      ) {
        return { updated: latest, attestation: null, alreadyCompleted: true };
      }
      const conflict = new Error("production_transaction_probe_conflict");
      conflict.code = "PROBE_CONFLICT";
      throw conflict;
    }
    const updated = await tx.productionTransactionProbe.findUnique({
      where: { id: probe.id },
    });
    const attestation = await recordOperationalReadinessAttestation(
      {
        checkKey: LIVE_ORDER_REFUND_E2E_CHECK_KEY,
        status: OPERATIONAL_ATTESTATION_STATUS.CONFIRMED,
        evidenceReference: `production-transaction-probe:${probe.id}`,
        evidenceHash,
        confirmedBy: "system:production-transaction-probe",
        notes: `${paidInspection.paymentTarget.provider} ${paidInspection.paymentTarget.paymentMethod}の実取引、SellerOrder、売上台帳、元取引への全額返金を自動照合`,
        metadataJson: {
          verificationSource: "production_transaction_probe",
          probeId: probe.id,
          releaseId: probe.releaseId,
          releaseFingerprint: probe.releaseFingerprint,
          paymentProvider: paidInspection.paymentTarget.provider,
          paymentMethod: paidInspection.paymentTarget.paymentMethod,
          refundMode: paidInspection.paymentTarget.refundMode,
          completedAt: now.toISOString(),
        },
      },
      { prismaClient: tx, now },
    );
    if (!attestation.ok) {
      throw new Error(
        `production_transaction_probe_attestation_failed:${attestation.reason}`,
      );
    }
    return { updated, attestation };
  };
  let transactionResult;
  try {
    transactionResult =
      typeof prismaClient.$transaction === "function"
        ? await prismaClient.$transaction(complete, {
            isolationLevel: "Serializable",
          })
        : await complete(prismaClient);
  } catch (error) {
    if (error?.code === "PROBE_CONFLICT" || error?.code === "P2034") {
      return {
        ok: false,
        reason: "production_transaction_probe_conflict",
      };
    }
    throw error;
  }
  return {
    ok: true,
    pending: false,
    stage: "complete",
    probe: transactionResult.updated,
    attestation: transactionResult.attestation?.attestation || null,
    paidInspection,
    refundInspection,
  };
}

export async function cancelProductionTransactionProbe(
  { probeId, actorKey },
  { prismaClient = prisma, now = new Date() } = {},
) {
  const probe = await prismaClient.productionTransactionProbe.findUnique({
    where: { id: clean(probeId) },
  });
  if (!probe || !ACTIVE_PROBE_STATUSES.includes(probe.status)) {
    return { ok: false, reason: "active_probe_not_found" };
  }
  return transitionActiveProbe(
    {
      probe,
      expectedStatuses: ACTIVE_PROBE_STATUSES,
      data: {
        activeKey: null,
        status: PRODUCTION_TRANSACTION_PROBE_STATUS.CANCELLED,
        lastCheckedAt: now,
        lastErrorCode: `cancelled_by:${clean(actorKey) || "unknown"}`,
      },
    },
    { prismaClient },
  );
}

export async function getProductionTransactionProbePageData(
  { shopDomain, releaseExpectation },
  { prismaClient = prisma } = {},
) {
  const release = buildReleaseContext(releaseExpectation);
  if (!prismaClient?.productionTransactionProbe?.findMany) {
    return {
      available: false,
      reason: "production_transaction_probe_unavailable",
      release,
      activeProbe: null,
      recentProbes: [],
    };
  }
  const shop = normalizeShop(shopDomain);
  let probes;
  try {
    probes = await prismaClient.productionTransactionProbe.findMany({
      where: { shopDomain: shop },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
  } catch (error) {
    if (["P2021", "P2022"].includes(error?.code)) {
      return {
        available: false,
        reason: "production_transaction_probe_unavailable",
        release,
        activeProbe: null,
        recentProbes: [],
      };
    }
    throw error;
  }
  return {
    available: true,
    release,
    activeProbe:
      probes.find(
        (probe) =>
          probe.activeKey === activeKey(shop) &&
          ACTIVE_PROBE_STATUSES.includes(probe.status),
      ) || null,
    recentProbes: probes,
  };
}

export function serializeProductionTransactionProbe(probe) {
  if (!probe) return null;
  const paymentTarget = getProductionTransactionProbeTarget(probe);
  return {
    id: probe.id,
    status: probe.status,
    releaseId: probe.releaseId,
    shopDomain: probe.shopDomain,
    shopifyOrderId: probe.shopifyOrderId,
    marketplaceOrderId: probe.marketplaceOrderId,
    startedBy: probe.startedBy,
    startedAt: probe.startedAt,
    orderAttachedAt: probe.orderAttachedAt,
    paidVerifiedAt: probe.paidVerifiedAt,
    refundVerifiedAt: probe.refundVerifiedAt,
    completedAt: probe.completedAt,
    invalidatedAt: probe.invalidatedAt,
    lastCheckedAt: probe.lastCheckedAt,
    lastErrorCode: probe.lastErrorCode,
    evidenceHash: probe.evidenceHash,
    paymentTarget,
    orderEvidence: asObject(probe.orderEvidenceJson),
    paidEvidence: asObject(probe.paidEvidenceJson),
    refundEvidence: asObject(probe.refundEvidenceJson),
  };
}

export function buildProductionTransactionProbePage({
  activeProbe,
  release,
  target = KOMOJU_CARD_TRANSACTION_TARGET,
} = {}) {
  const paymentTarget = activeProbe
    ? getProductionTransactionProbeTarget(activeProbe)
    : normalizeProductionTransactionTarget(target) ||
      KOMOJU_CARD_TRANSACTION_TARGET;
  const paymentLabel =
    paymentTarget.provider === PAYMENT_PROVIDER.KOMOJU
      ? "KOMOJUクレジットカード"
      : "Shopify Payments";
  const status =
    activeProbe?.status ||
    (release?.configured ? "NOT_STARTED" : "RELEASE_UNCONFIGURED");
  const copy = {
    RELEASE_UNCONFIGURED: {
      tone: "warning",
      statusLabel: "リリース未設定",
      instruction:
        "Render commitとShopify App versionを設定し、現在のリリースを特定できる状態にしてください。",
    },
    NOT_STARTED: {
      tone: "neutral",
      statusLabel: "未開始",
      instruction: `確認を開始してから、Shopify標準商品ページで少額の運営直販商品を${paymentLabel}で購入してください。`,
    },
    AWAITING_ORDER: {
      tone: "warning",
      statusLabel: "注文待ち",
      instruction: `${paymentLabel}の本番決済を行い、確認開始後に作成した実注文の番号を入力してください。`,
    },
    AWAITING_SETTLEMENT: {
      tone: "warning",
      statusLabel: "売上反映待ち",
      instruction:
        "注文Webhook、SellerOrder、Shadow Check、売上台帳の反映を待っています。まだ返金しないでください。",
    },
    AWAITING_PAYOUT_EVIDENCE: {
      tone: "warning",
      statusLabel: "入金証拠待ち",
      instruction:
        "売上反映は一致しました。決済運用画面で今回のKOMOJU決済を銀行着金明細へ直接紐付けるまで、まだ返金しないでください。",
    },
    AWAITING_REFUND_RESERVE_CONFIRMATION: {
      tone: "warning",
      statusLabel: "返金原資の再確認待ち",
      instruction:
        "入金証拠まで一致しました。現在のKOMOJU未精算残高を改めて確認し、全額返金分の原資を証跡付きで記録してください。まだ返金しないでください。",
    },
    AWAITING_REFUND: {
      tone: "warning",
      statusLabel: "全額返金待ち",
      instruction:
        "売上反映は一致しました。同じ注文をShopify管理画面から全額返金し、在庫戻しは運用方針どおり選択してください。",
    },
    PASSED: {
      tone: "success",
      statusLabel: "完了",
      instruction:
        "注文、売上、全額返金、台帳差引が一致し、現在のリリースへ証跡を登録しました。",
    },
    INVALIDATED: {
      tone: "warning",
      statusLabel: "無効",
      instruction:
        "確認中または確認後にリリースが変わりました。現在のリリースで新しく確認してください。",
    },
    CANCELLED: {
      tone: "neutral",
      statusLabel: "中止",
      instruction: "必要なときに新しい確認を開始してください。",
    },
  };
  const statusCopy = copy[status] || copy.NOT_STARTED;
  const progress = {
    NOT_STARTED: 0,
    RELEASE_UNCONFIGURED: 0,
    AWAITING_ORDER: 1,
    AWAITING_SETTLEMENT: 2,
    AWAITING_PAYOUT_EVIDENCE: 3,
    AWAITING_REFUND_RESERVE_CONFIRMATION: 3,
    AWAITING_REFUND: 3,
    PASSED: 4,
    INVALIDATED: 0,
    CANCELLED: 0,
  }[status];
  const stepDefinitions = [
    {
      id: "start",
      label: "確認を開始",
      detail: "現在のリリースIDと開始時刻を固定します。",
    },
    {
      id: "order",
      label: "実注文を登録",
      detail:
        "テスト注文、開始前の注文、第三者商品、返金開始済みの注文は受け付けません。",
    },
    {
      id: "settlement",
      label: "売上反映を照合",
      detail:
        "MarketplaceOrder、SellerOrder、商品行、Shadow Check、売上台帳を比較します。",
    },
    {
      id: "refund",
      label: "全額返金を照合",
      detail:
        "Shopify返金、商品数量、返金台帳、二重差引がないことを確認します。",
    },
  ];
  return {
    status,
    ...statusCopy,
    steps: stepDefinitions.map((step, index) => ({
      ...step,
      done: progress > index,
    })),
  };
}

export const PRODUCTION_TRANSACTION_PROBE = Object.freeze({
  apiVersion: SHOPIFY_API_VERSION,
  activeStatuses: ACTIVE_PROBE_STATUSES,
});

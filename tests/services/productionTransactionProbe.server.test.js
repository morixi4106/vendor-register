import assert from "node:assert/strict";
import test from "node:test";

import {
  attachOrderToProductionTransactionProbe,
  buildProductionTransactionProbePage,
  buildShopifyProbeOrderSnapshot,
  confirmProductionTransactionRefundReserve,
  createProductionTransactionProbe,
  fetchShopifyOrderForProductionProbe,
  getProductionTransactionProbeTarget,
  inspectProductionTransactionProbePreflight,
  KOMOJU_PAYOUT_EVIDENCE_STRATEGY,
  refreshProductionTransactionProbe,
} from "../../app/services/productionTransactionProbe.server.js";
import {
  buildProductionReleaseExpectation,
  buildProductionReleaseFingerprint,
} from "../../app/services/productionRelease.server.js";

const SHOP = "example.myshopify.com";
const ORDER_ID = "gid://shopify/Order/1234";
const REFUND_ID = "gid://shopify/Refund/9876";
const LINE_ID = "gid://shopify/LineItem/10";
const PRODUCT_ID = "gid://shopify/Product/20";
const VARIANT_ID = "gid://shopify/ProductVariant/30";
const PAYMENT_TRANSACTION_ID = "gid://shopify/OrderTransaction/40";
const REFUND_TRANSACTION_ID = "gid://shopify/OrderTransaction/50";
const SETTINGS_EVIDENCE_HASH = "a".repeat(64);
const RESERVE_EVIDENCE_HASH = "b".repeat(64);
const KOMOJU_CARD_TARGET = Object.freeze({
  version: 2,
  provider: "KOMOJU",
  paymentMethod: "CARD",
  refundMode: "SHOPIFY_LINKED",
});
const SHOPIFY_CARD_TARGET = Object.freeze({
  version: 2,
  provider: "SHOPIFY_PAYMENTS",
  paymentMethod: "CARD",
  refundMode: "SHOPIFY_LINKED",
});
const RELEASE_ENV = {
  RENDER_GIT_COMMIT: "a".repeat(40),
  SHOPIFY_APP_VERSION: "app-version-1",
  SHOPIFY_PRIMARY_SHOP_DOMAIN: SHOP,
};

function releaseExpectation(env = RELEASE_ENV) {
  return buildProductionReleaseExpectation({ env });
}

function shopifyOrder({
  financialStatus = "PAID",
  refundedAmount = "0",
  refunds = [],
  transactions,
  transactionCount,
  testOrder = false,
  createdAt = "2026-07-29T01:01:00.000Z",
  paymentGateway = "shopify_payments",
  paymentFormattedGateway = "Shopify Payments",
  paymentDetails = {
    __typename: "CardPaymentDetails",
    paymentMethodName: "Visa",
    wallet: null,
  },
  refundGateway = paymentGateway,
  refundFormattedGateway = paymentFormattedGateway,
} = {}) {
  const paymentTransactions = transactions || [
    {
      id: PAYMENT_TRANSACTION_ID,
      kind: "SALE",
      status: "SUCCESS",
      gateway: paymentGateway,
      formattedGateway: paymentFormattedGateway,
      manualPaymentGateway: false,
      test: testOrder,
      paymentDetails,
      processedAt: "2026-07-29T01:01:30.000Z",
      amountSet: {
        shopMoney: { amount: "1114", currencyCode: "JPY" },
      },
      parentTransaction: null,
    },
  ];
  const normalizedRefunds = refunds.map((refund, index) => ({
    ...refund,
    transactions: refund.transactions || {
      nodes: [
        {
          id:
            index === 0
              ? REFUND_TRANSACTION_ID
              : `gid://shopify/OrderTransaction/refund-${index}`,
          kind: "REFUND",
          status: "SUCCESS",
          gateway: refundGateway,
          formattedGateway: refundFormattedGateway,
          manualPaymentGateway: false,
          test: testOrder,
          processedAt: "2026-07-29T01:10:00.000Z",
          amountSet: {
            shopMoney: {
              amount: refundedAmount === "0" ? "1114" : refundedAmount,
              currencyCode: "JPY",
            },
          },
          parentTransaction: { id: PAYMENT_TRANSACTION_ID },
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  }));
  return {
    id: ORDER_ID,
    name: "#1234",
    createdAt,
    updatedAt: "2026-07-29T01:02:00.000Z",
    test: testOrder,
    cancelledAt: null,
    currencyCode: "JPY",
    displayFinancialStatus: financialStatus,
    displayFulfillmentStatus: "UNFULFILLED",
    subtotalPriceSet: {
      shopMoney: { amount: "244", currencyCode: "JPY" },
    },
    totalShippingPriceSet: {
      shopMoney: { amount: "870", currencyCode: "JPY" },
    },
    totalTaxSet: {
      shopMoney: { amount: "22", currencyCode: "JPY" },
    },
    totalPriceSet: {
      shopMoney: { amount: "1114", currencyCode: "JPY" },
    },
    totalRefundedSet: {
      shopMoney: { amount: refundedAmount, currencyCode: "JPY" },
    },
    transactionsCount: {
      count: transactionCount ?? paymentTransactions.length,
    },
    transactions: paymentTransactions,
    refunds: normalizedRefunds,
    lineItems: {
      nodes: [
        {
          id: LINE_ID,
          title: "private title must not be stored",
          quantity: 1,
          currentQuantity: financialStatus === "REFUNDED" ? 0 : 1,
          sku: "PRIVATE-SKU",
          product: { id: PRODUCT_ID },
          variant: { id: VARIANT_ID },
          originalUnitPriceSet: {
            shopMoney: { amount: "244", currencyCode: "JPY" },
          },
          discountedTotalSet: {
            shopMoney: { amount: "244", currencyCode: "JPY" },
          },
        },
      ],
      pageInfo: { hasNextPage: false },
    },
    email: "buyer@example.com",
    customer: { displayName: "Private Buyer" },
    shippingAddress: { address1: "Private Address" },
  };
}

function probeRecord({
  status = "AWAITING_SETTLEMENT",
  release = releaseExpectation(),
  target = null,
  externalReadiness: externalReadinessOverride,
} = {}) {
  const snapshot = buildShopifyProbeOrderSnapshot(shopifyOrder());
  const effectiveTarget = target || SHOPIFY_CARD_TARGET;
  const externalReadiness =
    externalReadinessOverride !== undefined
      ? externalReadinessOverride
      : effectiveTarget.provider === "KOMOJU"
        ? {
            version: 2,
            strategy:
              KOMOJU_PAYOUT_EVIDENCE_STRATEGY.EXISTING_RECONCILED_PAYOUT,
            maximumPlannedChargeAmount: 2000,
            confirmedRefundReserveAmount: 2000,
            existingPayoutBatchId: "settlement_batch_existing",
            evidenceReference: "private-evidence:komoju-settings",
            evidenceHash: SETTINGS_EVIDENCE_HASH,
            refundReserveReconfirmation: {
              amount: 2000,
              evidenceReference: "private-evidence:komoju-reserve",
              evidenceHash: RESERVE_EVIDENCE_HASH,
              confirmedAt: "2026-07-29T01:05:00.000Z",
              confirmedBy: "shopify_user:1",
            },
          }
        : null;
  return {
    id: "probe_1",
    activeKey: `production-transaction-probe:${SHOP}`,
    shopDomain: SHOP,
    releaseId: release.releaseId,
    releaseFingerprint: buildProductionReleaseFingerprint(release),
    status,
    shopifyOrderId: status === "AWAITING_ORDER" ? null : ORDER_ID,
    marketplaceOrderId: null,
    startedBy: "shopify_user:1",
    startedAt: new Date("2026-07-29T01:00:00.000Z"),
    orderAttachedAt: new Date("2026-07-29T01:03:00.000Z"),
    paidVerifiedAt: null,
    refundVerifiedAt: null,
    completedAt: null,
    invalidatedAt: null,
    lastCheckedAt: new Date("2026-07-29T01:03:00.000Z"),
    lastErrorCode: null,
    evidenceHash: null,
    orderEvidenceJson: {
      probeConfig: effectiveTarget,
      ...(externalReadiness ? { externalReadiness } : {}),
      commercialFingerprint: snapshot.commercialFingerprint,
      commercialEvidence: snapshot.commercialEvidence,
    },
    paidEvidenceJson: null,
    refundEvidenceJson: null,
    finalEvidenceJson: null,
    createdAt: new Date("2026-07-29T01:00:00.000Z"),
    updatedAt: new Date("2026-07-29T01:03:00.000Z"),
  };
}

function paymentAttempt({ target = SHOPIFY_CARD_TARGET, test = false } = {}) {
  return {
    id: "payment_attempt_1",
    marketplaceOrderId: "marketplace_order_1",
    shopDomain: SHOP,
    shopifyOrderId: ORDER_ID,
    shopifyTransactionId: PAYMENT_TRANSACTION_ID,
    provider: target.provider,
    paymentMethod: "CARD",
    status: "CAPTURED",
    amount: 1114,
    currencyCode: "jpy",
    test,
    requiresReview: false,
    processedAt: new Date("2026-07-29T01:01:30.000Z"),
    capturedAt: new Date("2026-07-29T01:01:30.000Z"),
    metadataJson: {
      paymentDetailsType: "CardPaymentDetails",
      paymentMethodName: "Visa",
      paymentWallet: null,
    },
    settlementLine: null,
  };
}

function marketplaceOrder({ refunded = false, lineOverrides = {} } = {}) {
  return {
    id: "marketplace_order_1",
    shopDomain: SHOP,
    shopifyOrderId: ORDER_ID,
    totalAmount: 1114,
    currencyCode: "jpy",
    sellerOrders: [
      {
        id: "seller_order_1",
        sellerId: "seller_1",
        vendorStoreId: "platform_store_1",
        sellerPayableAmount: 244,
        sellerRefundAmount: refunded ? 244 : 0,
        lines: [
          {
            id: "seller_line_1",
            shopifyLineItemId: LINE_ID,
            shopifyProductId: PRODUCT_ID,
            shopifyVariantId: VARIANT_ID,
            quantity: 1,
            refundedQuantity: refunded ? 1 : 0,
            unitAmount: 244,
            netAmount: 244,
            ...lineOverrides,
          },
        ],
      },
    ],
  };
}

function paidLedger() {
  return {
    id: "ledger_paid_1",
    sellerId: "seller_1",
    entryType: "shopify_order_paid",
    stripeObjectId: ORDER_ID,
    amount: 244,
    currencyCode: "jpy",
    direction: "credit",
    metadataJson: { shopDomain: SHOP, shopifyOrderId: ORDER_ID },
    occurredAt: new Date("2026-07-29T01:02:00.000Z"),
  };
}

function refundLedger({ refundId = REFUND_ID } = {}) {
  return {
    id: "ledger_refund_1",
    sellerId: "seller_1",
    entryType: "refund",
    stripeObjectId: refundId,
    amount: 244,
    currencyCode: "jpy",
    direction: "debit",
    metadataJson: {
      shopDomain: SHOP,
      shopifyOrderId: ORDER_ID,
      shopifyRefundId: refundId,
    },
    occurredAt: new Date("2026-07-29T01:10:00.000Z"),
  };
}

function graphQLFor(order, calls = []) {
  return async (request) => {
    calls.push(request);
    return request.variables.id
      ? { data: { order } }
      : { data: { orders: { nodes: [order] } } };
  };
}

function refreshPrisma({
  probe = probeRecord(),
  order = marketplaceOrder(),
  ledgerEntries = [paidLedger()],
  paymentAttempts,
  existingPayoutBatch,
} = {}) {
  const target = getProductionTransactionProbeTarget(probe);
  const attempts = paymentAttempts || [paymentAttempt({ target })];
  const payoutBatch = existingPayoutBatch || {
    id: "settlement_batch_existing",
    provider: "KOMOJU",
    externalBatchId: "komoju-payout-existing",
    status: "RECONCILED",
    bankDepositedAt: new Date("2026-07-28T00:00:00.000Z"),
    evidenceHash: "c".repeat(64),
    lines: [{ id: "settlement_line_existing" }],
  };
  const state = {
    probe,
    order,
    ledgerEntries,
    paymentAttempts: attempts,
    updates: [],
    attestation: null,
  };
  const prismaClient = {
    productionTransactionProbe: {
      async findUnique() {
        return state.probe;
      },
      async updateMany({ where, data }) {
        const statusMatches =
          !where.status?.in || where.status.in.includes(state.probe.status);
        if (
          where.id !== state.probe.id ||
          where.activeKey !== state.probe.activeKey ||
          where.releaseFingerprint !== state.probe.releaseFingerprint ||
          !statusMatches
        ) {
          return { count: 0 };
        }
        state.probe = { ...state.probe, ...data };
        state.updates.push(data);
        return { count: 1 };
      },
    },
    marketplaceOrder: {
      async findUnique() {
        return state.order;
      },
    },
    ledgerEntry: {
      async findMany() {
        return state.ledgerEntries;
      },
    },
    sellerOrderShadowCheck: {
      async findFirst() {
        return { status: "matched" };
      },
    },
    marketplacePaymentAttempt: {
      async findMany() {
        return state.paymentAttempts;
      },
      async upsert({ create, update }) {
        const existingIndex = state.paymentAttempts.findIndex(
          (attempt) => attempt.attemptKey === create.attemptKey,
        );
        const value = {
          id:
            existingIndex >= 0
              ? state.paymentAttempts[existingIndex].id
              : `payment_attempt_${state.paymentAttempts.length + 1}`,
          ...(existingIndex >= 0 ? state.paymentAttempts[existingIndex] : {}),
          ...(existingIndex >= 0 ? update : create),
          settlementLine: null,
        };
        if (existingIndex >= 0) state.paymentAttempts[existingIndex] = value;
        else state.paymentAttempts.push(value);
        return value;
      },
    },
    paymentSettlementBatch: {
      async findUnique() {
        return payoutBatch;
      },
    },
    vendorStore: {
      async findMany() {
        return [
          {
            id: "platform_store_1",
            isPlatformStore: true,
            isTestStore: false,
          },
        ];
      },
    },
    operationalReadinessAttestation: {
      async upsert({ create }) {
        state.attestation = { id: "attestation_1", ...create };
        return state.attestation;
      },
    },
  };
  prismaClient.$transaction = async (callback) => callback(prismaClient);
  return { prismaClient, state };
}

test("Shopify snapshot stores commercial evidence without buyer PII or presentation text", () => {
  const snapshot = buildShopifyProbeOrderSnapshot(shopifyOrder());
  const serialized = JSON.stringify(snapshot);

  assert.equal(snapshot.commercialEvidence.totalAmount, 1114);
  assert.equal(snapshot.commercialEvidence.lines[0].unitAmount, 244);
  assert.deepEqual(
    snapshot.transactions.map((transaction) => transaction.id),
    [PAYMENT_TRANSACTION_ID],
  );
  assert.equal(snapshot.transactions[0].gateway, "shopify_payments");
  assert.doesNotMatch(serialized, /buyer@example\.com/);
  assert.doesNotMatch(serialized, /Private Buyer/);
  assert.doesNotMatch(serialized, /Private Address/);
  assert.doesNotMatch(serialized, /private title/);
  assert.doesNotMatch(serialized, /PRIVATE-SKU/);
});

test("Shopify order lookup is read-only and validates the reference", async () => {
  const invalid = await fetchShopifyOrderForProductionProbe(
    { shopDomain: SHOP, orderReference: "not-an-order" },
    { graphQL: async () => assert.fail("GraphQL must not run") },
  );
  assert.deepEqual(invalid, {
    ok: false,
    reason: "order_reference_invalid",
  });

  const calls = [];
  const found = await fetchShopifyOrderForProductionProbe(
    { shopDomain: SHOP, orderReference: "#1234" },
    { graphQL: graphQLFor(shopifyOrder(), calls) },
  );
  assert.equal(found.ok, true);
  assert.match(calls[0].query, /query ProductionProbeOrderByName/);
  assert.doesNotMatch(calls[0].query, /\bmutation\b/);
});

test("starting a probe reuses the same release and invalidates an older release", async () => {
  const current = probeRecord({ status: "AWAITING_ORDER" });
  let existing = current;
  const updates = [];
  const creates = [];
  const prismaClient = {
    productionTransactionProbe: {
      async findUnique() {
        return existing;
      },
      async updateMany({ data }) {
        updates.push(data);
        existing = null;
        return { count: 1 };
      },
      async create({ data }) {
        creates.push(data);
        return { id: "probe_new", ...data };
      },
    },
  };

  const same = await createProductionTransactionProbe(
    {
      shopDomain: SHOP,
      startedBy: "operator",
      releaseExpectation: releaseExpectation(),
    },
    { prismaClient },
  );
  assert.equal(same.existing, true);
  assert.equal(creates.length, 0);

  existing = {
    ...current,
    releaseFingerprint: "old-release",
  };
  const replaced = await createProductionTransactionProbe(
    {
      shopDomain: SHOP,
      startedBy: "operator",
      releaseExpectation: releaseExpectation(),
    },
    { prismaClient },
  );
  assert.equal(replaced.existing, false);
  assert.equal(updates[0].status, "INVALIDATED");
  assert.equal(creates.length, 1);
});

test("starting a KOMOJU card probe requires scope confirmations and stores its target", async () => {
  let createdData = null;
  const prismaClient = {
    productionTransactionProbe: {
      async findUnique() {
        return null;
      },
      async create({ data }) {
        createdData = data;
        return { id: "probe_komoju", ...data };
      },
    },
  };
  const input = {
    shopDomain: SHOP,
    startedBy: "operator",
    releaseExpectation: releaseExpectation(),
    targetProvider: "KOMOJU",
    targetPaymentMethod: "CARD",
  };

  const rejected = await createProductionTransactionProbe(input, {
    prismaClient,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "komoju_scope_confirmation_required");
  assert.equal(createdData, null);

  const missingHash = await createProductionTransactionProbe(
    {
      ...input,
      komojuCardOnlyConfirmed: true,
      untestedAsyncMethodsDisabledConfirmed: true,
      komojuLiveConfirmed: true,
      singleCardIntegrationConfirmed: true,
      automaticCaptureConfirmed: true,
      releaseFreezeConfirmed: true,
      externalSettingsEvidenceReference: "private-evidence:komoju-settings",
      payoutEvidenceStrategy:
        KOMOJU_PAYOUT_EVIDENCE_STRATEGY.CURRENT_PAYMENT_WITH_REFUND_RESERVE,
      maximumPlannedChargeAmount: 2000,
      confirmedRefundReserveAmount: 2000,
    },
    { prismaClient },
  );
  assert.deepEqual(missingHash, {
    ok: false,
    reason: "komoju_external_readiness_missing",
  });
  assert.equal(createdData, null);

  const created = await createProductionTransactionProbe(
    {
      ...input,
      komojuCardOnlyConfirmed: true,
      untestedAsyncMethodsDisabledConfirmed: true,
      komojuLiveConfirmed: true,
      singleCardIntegrationConfirmed: true,
      automaticCaptureConfirmed: true,
      releaseFreezeConfirmed: true,
      externalSettingsEvidenceReference: "private-evidence:komoju-settings",
      externalSettingsEvidenceHash: SETTINGS_EVIDENCE_HASH,
      payoutEvidenceStrategy:
        KOMOJU_PAYOUT_EVIDENCE_STRATEGY.CURRENT_PAYMENT_WITH_REFUND_RESERVE,
      maximumPlannedChargeAmount: 2000,
      confirmedRefundReserveAmount: 2000,
    },
    { prismaClient },
  );
  assert.equal(created.ok, true);
  assert.deepEqual(
    createdData.orderEvidenceJson.probeConfig,
    KOMOJU_CARD_TARGET,
  );
  assert.deepEqual(
    getProductionTransactionProbeTarget(created.probe),
    KOMOJU_CARD_TARGET,
  );
});

test("an existing KOMOJU payout never permits a zero refund reserve", async () => {
  const prismaClient = {
    productionTransactionProbe: {
      async findUnique() {
        return null;
      },
      async create() {
        assert.fail("an insufficient reserve must not create a probe");
      },
    },
    paymentSettlementBatch: {
      async findFirst() {
        return {
          id: "settlement_batch_existing",
          externalBatchId: "komoju-payout-existing",
          bankDepositedAt: new Date("2026-07-28T00:00:00.000Z"),
        };
      },
    },
  };
  const result = await createProductionTransactionProbe(
    {
      shopDomain: SHOP,
      startedBy: "operator",
      releaseExpectation: releaseExpectation(),
      targetProvider: "KOMOJU",
      targetPaymentMethod: "CARD",
      komojuCardOnlyConfirmed: true,
      untestedAsyncMethodsDisabledConfirmed: true,
      komojuLiveConfirmed: true,
      singleCardIntegrationConfirmed: true,
      automaticCaptureConfirmed: true,
      releaseFreezeConfirmed: true,
      externalSettingsEvidenceReference: "private-evidence:komoju-settings",
      externalSettingsEvidenceHash: SETTINGS_EVIDENCE_HASH,
      payoutEvidenceStrategy:
        KOMOJU_PAYOUT_EVIDENCE_STRATEGY.EXISTING_RECONCILED_PAYOUT,
      maximumPlannedChargeAmount: 2000,
      confirmedRefundReserveAmount: 0,
    },
    { prismaClient },
  );

  assert.deepEqual(result, {
    ok: false,
    reason: "komoju_refund_reserve_insufficient",
  });
});

test("preflight permits one KOMOJU card run only when every automatic check passes", async () => {
  const release = buildProductionReleaseExpectation({
    env: RELEASE_ENV,
    checkoutValidation: {
      validation: {
        id: "gid://shopify/Validation/1",
        shopifyFunction: { id: "gid://shopify/Function/1" },
      },
    },
  });
  const prismaClient = {
    product: {
      async count() {
        return 1;
      },
    },
  };
  const options = {
    prismaClient,
    env: {
      PAYMENT_PROVIDERS: "shopify_payments,komoju",
      KOMOJU_PAYMENT_OPERATIONS_ENABLED: "true",
      PAYMENT_REFUND_CONFIRMATION_ENFORCED: "true",
    },
    inspectPaymentOperationsImpl: () => ({
      available: true,
      pendingExpiredCount: 0,
      attemptReviewCount: 0,
      refundReviewCount: 0,
      refundFailedCount: 0,
      unmatchedSettlementCount: 0,
    }),
    getPlatformOperationalControlImpl: () => ({
      available: true,
      checkoutHold: false,
      checkoutControlState: "IDLE",
    }),
    getMarketplaceCheckoutGateStatusImpl: () => ({
      active: true,
      publicationConfigurationReady: true,
      exposedProductCount: 0,
      failedProductCount: 0,
    }),
  };

  const ready = await inspectProductionTransactionProbePreflight(
    {
      shopDomain: SHOP,
      releaseExpectation: release,
      targetProvider: "KOMOJU",
      targetPaymentMethod: "CARD",
    },
    options,
  );
  assert.equal(ready.canStart, true);
  assert.equal(
    ready.checks.every((entry) => entry.passed),
    true,
  );

  const blocked = await inspectProductionTransactionProbePreflight(
    {
      shopDomain: SHOP,
      releaseExpectation: release,
      targetProvider: "KOMOJU",
      targetPaymentMethod: "CARD",
    },
    {
      ...options,
      inspectPaymentOperationsImpl: () => ({
        available: true,
        pendingExpiredCount: 0,
        attemptReviewCount: 1,
        refundReviewCount: 0,
        refundFailedCount: 0,
        unmatchedSettlementCount: 0,
      }),
    },
  );
  assert.equal(blocked.canStart, false);
  assert.equal(
    blocked.checks.find((entry) => entry.id === "payment_operations_clean")
      .passed,
    false,
  );
});

test("attaching an order rejects test orders before persisting evidence", async () => {
  const probe = probeRecord({ status: "AWAITING_ORDER" });
  let updated = false;
  const prismaClient = {
    productionTransactionProbe: {
      async findUnique() {
        return probe;
      },
      async update() {
        updated = true;
        return probe;
      },
    },
  };
  const result = await attachOrderToProductionTransactionProbe(
    {
      probeId: probe.id,
      orderReference: "#1234",
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    {
      prismaClient,
      graphQL: graphQLFor(shopifyOrder({ testOrder: true })),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "shopify_test_order_not_allowed");
  assert.equal(updated, false);
});

test("attaching an order rejects an order that already contains refund evidence", async () => {
  const probe = probeRecord({ status: "AWAITING_ORDER" });
  const prismaClient = {
    productionTransactionProbe: {
      async findUnique() {
        return probe;
      },
    },
  };
  const result = await attachOrderToProductionTransactionProbe(
    {
      probeId: probe.id,
      orderReference: ORDER_ID,
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    {
      prismaClient,
      graphQL: graphQLFor(
        shopifyOrder({
          financialStatus: "PAID",
          refundedAmount: "1",
          refunds: [{ id: REFUND_ID }],
        }),
      ),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "order_already_refunded");
});

test("attaching an order rejects orders created before the verification run", async () => {
  const probe = probeRecord({ status: "AWAITING_ORDER" });
  const prismaClient = {
    productionTransactionProbe: {
      async findUnique() {
        return probe;
      },
      async update() {
        assert.fail("an old order must not be persisted");
      },
    },
  };
  const result = await attachOrderToProductionTransactionProbe(
    {
      probeId: probe.id,
      orderReference: ORDER_ID,
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    {
      prismaClient,
      graphQL: graphQLFor(
        shopifyOrder({ createdAt: "2026-07-29T00:59:59.999Z" }),
      ),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "order_predates_probe");
});

test("attaching an order fails closed when a Shopify product is not mapped locally", async () => {
  const probe = probeRecord({ status: "AWAITING_ORDER" });
  const prismaClient = {
    productionTransactionProbe: {
      async findUnique() {
        return probe;
      },
    },
    product: {
      async findMany() {
        return [];
      },
    },
  };
  const result = await attachOrderToProductionTransactionProbe(
    {
      probeId: probe.id,
      orderReference: ORDER_ID,
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    {
      prismaClient,
      graphQL: graphQLFor(shopifyOrder()),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "local_product_mapping_missing");
});

test("attaching an order only accepts mapped approved platform products", async () => {
  let probe = probeRecord({ status: "AWAITING_ORDER" });
  let persisted = null;
  const prismaClient = {
    productionTransactionProbe: {
      async findUnique() {
        return probe;
      },
      async updateMany({ data }) {
        persisted = data;
        probe = { ...probe, ...data };
        return { count: 1 };
      },
    },
    product: {
      async findMany() {
        return [
          {
            id: "product_local_1",
            shopifyProductId: PRODUCT_ID,
            shopifyVariantId: VARIANT_ID,
            vendorStoreId: "platform_store_1",
            approvalStatus: "approved",
            vendorStore: {
              id: "platform_store_1",
              isPlatformStore: true,
              isTestStore: false,
            },
          },
        ];
      },
    },
  };
  const result = await attachOrderToProductionTransactionProbe(
    {
      probeId: probe.id,
      orderReference: ORDER_ID,
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    {
      prismaClient,
      graphQL: graphQLFor(shopifyOrder()),
      now: new Date("2026-07-29T01:04:00.000Z"),
    },
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(persisted.status, "AWAITING_SETTLEMENT");
  assert.equal(
    persisted.orderEvidenceJson.products[0].productId,
    "product_local_1",
  );
  assert.doesNotMatch(JSON.stringify(persisted), /Private Buyer/);
});

test("attaching an order fails closed when another request wins the transition", async () => {
  const probe = probeRecord({ status: "AWAITING_ORDER" });
  const prismaClient = {
    productionTransactionProbe: {
      async findUnique() {
        return probe;
      },
      async updateMany() {
        return { count: 0 };
      },
    },
    product: {
      async findMany() {
        return [
          {
            id: "product_local_1",
            shopifyProductId: PRODUCT_ID,
            shopifyVariantId: VARIANT_ID,
            vendorStoreId: "platform_store_1",
            approvalStatus: "approved",
            vendorStore: {
              id: "platform_store_1",
              isPlatformStore: true,
              isTestStore: false,
            },
          },
        ];
      },
    },
  };
  const result = await attachOrderToProductionTransactionProbe(
    {
      probeId: probe.id,
      orderReference: ORDER_ID,
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    {
      prismaClient,
      graphQL: graphQLFor(shopifyOrder()),
      now: new Date("2026-07-29T01:04:00.000Z"),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "production_transaction_probe_conflict");
});

test("paid inspection waits when SellerOrder line evidence differs", async () => {
  const { prismaClient, state } = refreshPrisma({
    order: marketplaceOrder({ lineOverrides: { quantity: 2 } }),
  });
  const result = await refreshProductionTransactionProbe(
    {
      probeId: "probe_1",
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    { prismaClient, graphQL: graphQLFor(shopifyOrder()) },
  );

  assert.equal(result.ok, true);
  assert.equal(result.pending, true);
  assert.equal(result.stage, "settlement");
  assert.equal(state.probe.lastErrorCode, "seller_order_lines_mismatch");
  assert.equal(state.attestation, null);
});

test("paid inspection never accepts a ledger entry assigned to another seller", async () => {
  const wrongSellerLedger = { ...paidLedger(), sellerId: "seller_other" };
  const { prismaClient, state } = refreshPrisma({
    ledgerEntries: [wrongSellerLedger],
  });
  const result = await refreshProductionTransactionProbe(
    {
      probeId: "probe_1",
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    { prismaClient, graphQL: graphQLFor(shopifyOrder()) },
  );

  assert.equal(result.ok, true);
  assert.equal(result.pending, true);
  assert.equal(result.stage, "settlement");
  assert.equal(state.probe.lastErrorCode, "paid_ledger_seller_mismatch");
  assert.equal(state.attestation, null);
});

test("paid inspection rejects a manually marked or wrong-provider transaction", async () => {
  const { prismaClient, state } = refreshPrisma();
  const manualTransaction = {
    ...shopifyOrder().transactions[0],
    gateway: "manual",
    formattedGateway: "Manual",
    manualPaymentGateway: true,
  };
  const result = await refreshProductionTransactionProbe(
    {
      probeId: "probe_1",
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    {
      prismaClient,
      graphQL: graphQLFor(shopifyOrder({ transactions: [manualTransaction] })),
    },
  );

  assert.equal(result.pending, true);
  assert.equal(result.stage, "settlement");
  assert.equal(
    state.probe.lastErrorCode,
    "payment_transaction_provider_mismatch",
  );
  assert.equal(state.attestation, null);
});

test("paid inspection rejects a test transaction on a non-test order", async () => {
  const { prismaClient, state } = refreshPrisma();
  const testTransaction = {
    ...shopifyOrder().transactions[0],
    test: true,
  };
  const result = await refreshProductionTransactionProbe(
    {
      probeId: "probe_1",
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    {
      prismaClient,
      graphQL: graphQLFor(shopifyOrder({ transactions: [testTransaction] })),
    },
  );

  assert.equal(result.pending, true);
  assert.equal(result.stage, "settlement");
  assert.equal(state.probe.lastErrorCode, "payment_transaction_is_test");
});

test("refresh repairs a missing payment attempt from the same Shopify order", async () => {
  const { prismaClient, state } = refreshPrisma({ paymentAttempts: [] });
  const result = await refreshProductionTransactionProbe(
    {
      probeId: "probe_1",
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    {
      prismaClient,
      graphQL: graphQLFor(shopifyOrder()),
      now: new Date("2026-07-29T01:06:00.000Z"),
    },
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.stage, "refund");
  assert.equal(state.paymentAttempts.length, 1);
  assert.equal(result.paidInspection.paymentAttemptRecovery?.attempted, true);
  assert.equal(result.paidInspection.paymentAttemptRecovery?.ok, true);
  assert.equal(state.probe.status, "AWAITING_REFUND");
});

test("paid order advances to refund without writing an attestation", async () => {
  const { prismaClient, state } = refreshPrisma();
  const result = await refreshProductionTransactionProbe(
    {
      probeId: "probe_1",
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    { prismaClient, graphQL: graphQLFor(shopifyOrder()) },
  );

  assert.equal(result.ok, true);
  assert.equal(result.pending, true);
  assert.equal(result.stage, "refund");
  assert.equal(state.probe.status, "AWAITING_REFUND");
  assert.equal(state.attestation, null);
});

test("KOMOJU card payment advances to refund while other providers remain rejected", async () => {
  const targetProbe = probeRecord({ target: KOMOJU_CARD_TARGET });
  const komojuOrder = shopifyOrder({
    paymentGateway: "komoju_credit_card",
    paymentFormattedGateway: "KOMOJU - Credit Card",
  });
  const { prismaClient, state } = refreshPrisma({ probe: targetProbe });
  const accepted = await refreshProductionTransactionProbe(
    {
      probeId: targetProbe.id,
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    { prismaClient, graphQL: graphQLFor(komojuOrder) },
  );
  assert.equal(accepted.pending, true);
  assert.equal(accepted.stage, "refund");
  assert.equal(state.probe.status, "AWAITING_REFUND");
  assert.equal(state.probe.paidEvidenceJson.paymentTarget.provider, "KOMOJU");

  const wrongProviderProbe = probeRecord({ target: KOMOJU_CARD_TARGET });
  const wrongProviderState = refreshPrisma({ probe: wrongProviderProbe });
  const rejected = await refreshProductionTransactionProbe(
    {
      probeId: wrongProviderProbe.id,
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    {
      prismaClient: wrongProviderState.prismaClient,
      graphQL: graphQLFor(shopifyOrder()),
    },
  );
  assert.equal(rejected.pending, true);
  assert.equal(rejected.stage, "settlement");
  assert.equal(
    wrongProviderState.state.probe.lastErrorCode,
    "payment_transaction_provider_mismatch",
  );
});

test("current KOMOJU payment waits for its directly linked bank deposit before refund", async () => {
  const externalReadiness = {
    version: 2,
    strategy:
      KOMOJU_PAYOUT_EVIDENCE_STRATEGY.CURRENT_PAYMENT_WITH_REFUND_RESERVE,
    maximumPlannedChargeAmount: 2000,
    confirmedRefundReserveAmount: 2000,
    evidenceReference: "private-evidence:komoju-settings",
    evidenceHash: SETTINGS_EVIDENCE_HASH,
  };
  const probe = probeRecord({
    target: KOMOJU_CARD_TARGET,
    externalReadiness,
  });
  const transaction = shopifyOrder({
    paymentGateway: "komoju_credit_card",
    paymentFormattedGateway: "KOMOJU - Credit Card",
  });
  const withoutDeposit = refreshPrisma({ probe });
  const pending = await refreshProductionTransactionProbe(
    {
      probeId: probe.id,
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    {
      prismaClient: withoutDeposit.prismaClient,
      graphQL: graphQLFor(transaction),
    },
  );
  assert.equal(pending.pending, true);
  assert.equal(pending.stage, "payout_evidence");
  assert.equal(withoutDeposit.state.probe.status, "AWAITING_PAYOUT_EVIDENCE");
  assert.equal(
    withoutDeposit.state.probe.lastErrorCode,
    "current_payment_payout_evidence_missing",
  );

  const directlyLinkedAttempt = paymentAttempt({ target: KOMOJU_CARD_TARGET });
  directlyLinkedAttempt.settlementLine = {
    id: "settlement_line_current",
    amount: 1114,
    matchStatus: "MATCHED",
    batch: {
      id: "settlement_batch_current",
      provider: "KOMOJU",
      externalBatchId: "komoju-payout-current",
      status: "RECONCILED",
      bankDepositedAt: new Date("2026-08-01T00:00:00.000Z"),
      evidenceHash: "d".repeat(64),
    },
  };
  const withDeposit = refreshPrisma({
    probe: probeRecord({
      status: "AWAITING_PAYOUT_EVIDENCE",
      target: KOMOJU_CARD_TARGET,
      externalReadiness,
    }),
    paymentAttempts: [directlyLinkedAttempt],
  });
  const readyToRefund = await refreshProductionTransactionProbe(
    {
      probeId: probe.id,
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    {
      prismaClient: withDeposit.prismaClient,
      graphQL: graphQLFor(transaction),
    },
  );
  assert.equal(readyToRefund.pending, true);
  assert.equal(readyToRefund.stage, "refund_reserve_confirmation");
  assert.equal(
    withDeposit.state.probe.status,
    "AWAITING_REFUND_RESERVE_CONFIRMATION",
  );

  const insufficient = await confirmProductionTransactionRefundReserve(
    {
      probeId: probe.id,
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
      confirmedRefundReserveAmount: 1999,
      evidenceReference: "private-evidence:refund-reserve-recheck",
      evidenceHash: RESERVE_EVIDENCE_HASH,
      confirm: "refund_reserve_reconfirmed",
    },
    {
      prismaClient: withDeposit.prismaClient,
      now: new Date("2026-08-01T00:04:00.000Z"),
    },
  );
  assert.deepEqual(insufficient, {
    ok: false,
    reason: "komoju_refund_reserve_reconfirmation_invalid",
  });
  assert.equal(
    withDeposit.state.probe.status,
    "AWAITING_REFUND_RESERVE_CONFIRMATION",
  );

  const confirmed = await confirmProductionTransactionRefundReserve(
    {
      probeId: probe.id,
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
      confirmedRefundReserveAmount: 2000,
      evidenceReference: "private-evidence:refund-reserve-recheck",
      evidenceHash: RESERVE_EVIDENCE_HASH,
      confirm: "refund_reserve_reconfirmed",
    },
    {
      prismaClient: withDeposit.prismaClient,
      now: new Date("2026-08-01T00:05:00.000Z"),
    },
  );
  assert.equal(confirmed.ok, true);

  const afterConfirmation = await refreshProductionTransactionProbe(
    {
      probeId: probe.id,
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    {
      prismaClient: withDeposit.prismaClient,
      graphQL: graphQLFor(transaction),
      now: new Date("2026-08-01T00:06:00.000Z"),
    },
  );
  assert.equal(afterConfirmation.stage, "refund");
  assert.equal(withDeposit.state.probe.status, "AWAITING_REFUND");
});

test("KOMOJU convenience-store payment cannot satisfy the card-only probe", async () => {
  const probe = probeRecord({ target: KOMOJU_CARD_TARGET });
  const { prismaClient, state } = refreshPrisma({ probe });
  const result = await refreshProductionTransactionProbe(
    {
      probeId: probe.id,
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    {
      prismaClient,
      graphQL: graphQLFor(
        shopifyOrder({
          paymentGateway: "komoju_convenience_store",
          paymentFormattedGateway: "KOMOJU - Convenience Store",
          paymentDetails: {
            __typename: "LocalPaymentMethodsPaymentDetails",
            paymentMethodName: "Konbini",
          },
        }),
      ),
    },
  );

  assert.equal(result.pending, true);
  assert.equal(result.stage, "settlement");
  assert.equal(
    state.probe.lastErrorCode,
    "payment_transaction_method_mismatch",
  );
});

test("one KOMOJU card order and its linked full refund complete the release evidence", async () => {
  const probe = probeRecord({
    status: "AWAITING_REFUND",
    target: KOMOJU_CARD_TARGET,
  });
  const { prismaClient, state } = refreshPrisma({
    probe,
    order: marketplaceOrder({ refunded: true }),
    ledgerEntries: [paidLedger(), refundLedger()],
  });
  const order = shopifyOrder({
    financialStatus: "REFUNDED",
    refundedAmount: "1114",
    paymentGateway: "komoju_credit_card",
    paymentFormattedGateway: "KOMOJU - Credit Card",
    // Shopify can abbreviate the linked refund gateway to the provider name.
    refundGateway: "komoju",
    refundFormattedGateway: "KOMOJU",
    refunds: [{ id: REFUND_ID, createdAt: "2026-07-29T01:10:00.000Z" }],
  });
  const result = await refreshProductionTransactionProbe(
    {
      probeId: probe.id,
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    {
      prismaClient,
      graphQL: graphQLFor(order),
      now: new Date("2026-07-29T01:11:00.000Z"),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.stage, "complete");
  assert.equal(state.probe.status, "PASSED");
  assert.equal(state.probe.finalEvidenceJson.paymentTarget.provider, "KOMOJU");
  assert.equal(
    state.probe.finalEvidenceJson.paymentTarget.paymentMethod,
    "CARD",
  );
  assert.equal(state.attestation.metadataJson.paymentProvider, "KOMOJU");
  assert.equal(state.attestation.metadataJson.paymentMethod, "CARD");
});

test("full refund completes once and records release-bound automatic evidence", async () => {
  const { prismaClient, state } = refreshPrisma({
    probe: probeRecord({ status: "AWAITING_REFUND" }),
    order: marketplaceOrder({ refunded: true }),
    ledgerEntries: [paidLedger(), refundLedger()],
  });
  const order = shopifyOrder({
    financialStatus: "REFUNDED",
    refundedAmount: "1114",
    refunds: [
      {
        id: REFUND_ID,
        createdAt: "2026-07-29T01:10:00.000Z",
      },
    ],
  });
  const result = await refreshProductionTransactionProbe(
    {
      probeId: "probe_1",
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    {
      prismaClient,
      graphQL: graphQLFor(order),
      now: new Date("2026-07-29T01:11:00.000Z"),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.stage, "complete");
  assert.equal(state.probe.status, "PASSED");
  assert.match(state.probe.evidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(
    state.attestation.metadataJson.verificationSource,
    "production_transaction_probe",
  );
  assert.equal(
    state.attestation.metadataJson.releaseId,
    releaseExpectation().releaseId,
  );
  assert.equal(
    state.attestation.evidenceReference,
    "production-transaction-probe:probe_1",
  );
});

test("a refund ledger identifier mismatch never passes", async () => {
  const { prismaClient, state } = refreshPrisma({
    probe: probeRecord({ status: "AWAITING_REFUND" }),
    order: marketplaceOrder({ refunded: true }),
    ledgerEntries: [
      paidLedger(),
      refundLedger({ refundId: "gid://shopify/Refund/other" }),
    ],
  });
  const result = await refreshProductionTransactionProbe(
    {
      probeId: "probe_1",
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    {
      prismaClient,
      graphQL: graphQLFor(
        shopifyOrder({
          financialStatus: "REFUNDED",
          refundedAmount: "1114",
          refunds: [{ id: REFUND_ID }],
        }),
      ),
    },
  );

  assert.equal(result.pending, true);
  assert.equal(result.stage, "refund");
  assert.equal(state.probe.lastErrorCode, "refund_ledger_identifier_mismatch");
  assert.equal(state.attestation, null);
});

test("a pending Shopify refund transaction never completes the probe", async () => {
  const { prismaClient, state } = refreshPrisma({
    probe: probeRecord({ status: "AWAITING_REFUND" }),
    order: marketplaceOrder({ refunded: true }),
    ledgerEntries: [paidLedger(), refundLedger()],
  });
  const pendingRefund = {
    ...shopifyOrder({
      financialStatus: "REFUNDED",
      refundedAmount: "1114",
      refunds: [{ id: REFUND_ID }],
    }).refunds[0],
  };
  pendingRefund.transactions.nodes[0].status = "PENDING";
  const result = await refreshProductionTransactionProbe(
    {
      probeId: "probe_1",
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    {
      prismaClient,
      graphQL: graphQLFor(
        shopifyOrder({
          financialStatus: "REFUNDED",
          refundedAmount: "1114",
          refunds: [pendingRefund],
        }),
      ),
    },
  );

  assert.equal(result.pending, true);
  assert.equal(result.stage, "refund");
  assert.equal(state.probe.lastErrorCode, "refund_transaction_missing");
  assert.equal(state.attestation, null);
});

test("a refund not linked to the captured payment transaction never passes", async () => {
  const { prismaClient, state } = refreshPrisma({
    probe: probeRecord({ status: "AWAITING_REFUND" }),
    order: marketplaceOrder({ refunded: true }),
    ledgerEntries: [paidLedger(), refundLedger()],
  });
  const unrelatedRefund = shopifyOrder({
    financialStatus: "REFUNDED",
    refundedAmount: "1114",
    refunds: [{ id: REFUND_ID }],
  }).refunds[0];
  unrelatedRefund.transactions.nodes[0].parentTransaction = {
    id: "gid://shopify/OrderTransaction/unrelated",
  };
  const result = await refreshProductionTransactionProbe(
    {
      probeId: "probe_1",
      actorKey: "operator",
      releaseExpectation: releaseExpectation(),
    },
    {
      prismaClient,
      graphQL: graphQLFor(
        shopifyOrder({
          financialStatus: "REFUNDED",
          refundedAmount: "1114",
          refunds: [unrelatedRefund],
        }),
      ),
    },
  );

  assert.equal(result.pending, true);
  assert.equal(result.stage, "refund");
  assert.equal(state.probe.lastErrorCode, "refund_transaction_parent_mismatch");
  assert.equal(state.attestation, null);
});

test("release changes invalidate an in-progress probe before Shopify lookup", async () => {
  const { prismaClient, state } = refreshPrisma();
  let graphQLCalled = false;
  const result = await refreshProductionTransactionProbe(
    {
      probeId: "probe_1",
      actorKey: "operator",
      releaseExpectation: releaseExpectation({
        ...RELEASE_ENV,
        RENDER_GIT_COMMIT: "b".repeat(40),
      }),
    },
    {
      prismaClient,
      graphQL: async () => {
        graphQLCalled = true;
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "release_changed");
  assert.equal(state.probe.status, "INVALIDATED");
  assert.equal(graphQLCalled, false);
});

test("page guidance exposes a single next action for each stage", () => {
  const waiting = buildProductionTransactionProbePage({
    activeProbe: { status: "AWAITING_REFUND" },
    release: { configured: true },
  });
  assert.equal(waiting.statusLabel, "全額返金待ち");
  assert.match(waiting.instruction, /Shopify管理画面から全額返金/);
  assert.deepEqual(
    waiting.steps.map((step) => step.done),
    [true, true, true, false],
  );
});

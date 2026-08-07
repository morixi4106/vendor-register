import assert from "node:assert/strict";
import test from "node:test";

import {
  PAYMENT_ATTEMPT_STATUS,
  PAYMENT_METHOD,
  PAYMENT_PROVIDER,
  PAYMENT_REFUND_MODE,
  PAYMENT_REFUND_STATUS,
  backfillPaymentAttemptsFromPaidLedger,
  classifyPaymentGateway,
  confirmManualPaymentRefundOperation,
  inspectPaymentOperations,
  observeShopifyRefundOperation,
  previewPaymentAttemptsFromPaidLedger,
  recordPaymentSettlementBatch,
  resolvePaymentAttemptStatus,
  syncShopifyOrderPaymentAttempts,
} from "../../app/services/paymentOperations.server.js";
import { buildPaymentOperationChecks } from "../../app/services/productionReadiness/payments.server.js";
import {
  buildEnvironmentChecks,
  inspectOperationEnvironment,
} from "../../app/services/productionReadiness/environment.server.js";

test("KOMOJU gateway names are classified by payment method", () => {
  const convenience = classifyPaymentGateway("KOMOJU - Convenience Store");
  assert.equal(convenience.provider, PAYMENT_PROVIDER.KOMOJU);
  assert.equal(convenience.paymentMethod, PAYMENT_METHOD.CONVENIENCE_STORE);
  assert.equal(convenience.refundMode, PAYMENT_REFUND_MODE.KOMOJU_MANUAL);

  const card = classifyPaymentGateway("KOMOJU - Credit Card");
  assert.equal(card.provider, PAYMENT_PROVIDER.KOMOJU);
  assert.equal(card.paymentMethod, PAYMENT_METHOD.CARD);
  assert.equal(card.refundMode, PAYMENT_REFUND_MODE.SHOPIFY_LINKED);

  const structuredCard = classifyPaymentGateway("KOMOJU", "KOMOJU", {
    __typename: "CardPaymentDetails",
    paymentMethodName: "Visa",
    wallet: null,
  });
  assert.equal(structuredCard.provider, PAYMENT_PROVIDER.KOMOJU);
  assert.equal(structuredCard.paymentMethod, PAYMENT_METHOD.CARD);

  const structuredLocalMethod = classifyPaymentGateway("KOMOJU", "KOMOJU", {
    __typename: "LocalPaymentMethodsPaymentDetails",
    paymentMethodName: "Konbini",
  });
  assert.equal(
    structuredLocalMethod.paymentMethod,
    PAYMENT_METHOD.CONVENIENCE_STORE,
  );
});

test("payment status follows canonical transaction state", () => {
  assert.equal(
    resolvePaymentAttemptStatus({
      transactionStatus: "PENDING",
      transactionKind: "SALE",
      financialStatus: "PENDING",
    }),
    PAYMENT_ATTEMPT_STATUS.PENDING,
  );
  assert.equal(
    resolvePaymentAttemptStatus({
      transactionStatus: "SUCCESS",
      transactionKind: "SALE",
      financialStatus: "PAID",
    }),
    PAYMENT_ATTEMPT_STATUS.CAPTURED,
  );
  assert.equal(
    resolvePaymentAttemptStatus({
      transactionStatus: "FAILURE",
      transactionKind: "SALE",
      financialStatus: "PENDING",
    }),
    PAYMENT_ATTEMPT_STATUS.FAILED,
  );
});

test("order payment sync stores a pending KOMOJU attempt with an expiry", async () => {
  const upserts = [];
  const now = new Date("2026-08-06T00:00:00.000Z");
  const result = await syncShopifyOrderPaymentAttempts(
    {
      shop: "example.myshopify.com",
      payload: {
        id: 100,
        name: "#100",
        created_at: "2026-08-06T00:00:00.000Z",
      },
      sourceTopic: "ORDERS_CREATE",
    },
    {
      now,
      loadCanonicalPaymentOrderImpl: async () => ({
        id: "gid://shopify/Order/100",
        name: "#100",
        createdAt: "2026-08-06T00:00:00.000Z",
        cancelledAt: null,
        test: false,
        currencyCode: "JPY",
        displayFinancialStatus: "PENDING",
        transactions: [
          {
            id: "gid://shopify/OrderTransaction/1",
            kind: "SALE",
            status: "PENDING",
            gateway: "KOMOJU - Convenience Store",
            formattedGateway: "KOMOJU - Convenience Store",
            test: false,
            processedAt: "2026-08-06T00:00:00.000Z",
            amountSet: {
              shopMoney: { amount: "1650", currencyCode: "JPY" },
            },
            parentTransaction: null,
          },
        ],
      }),
      prismaClient: {
        marketplaceOrder: { findUnique: async () => ({ id: "order-1" }) },
        marketplacePaymentAttempt: {
          upsert: async (args) => {
            upserts.push(args);
            return { id: "attempt-1", ...args.create };
          },
          findMany: async () => [
            {
              id: "attempt-1",
              attemptKey: "gid://shopify/OrderTransaction/1",
              shopifyTransactionId: "gid://shopify/OrderTransaction/1",
              parentTransactionId: null,
            },
          ],
          updateMany: async () => ({ count: 0 }),
        },
        marketplaceOperationalCase: { upsert: async () => null },
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.multipleAttempts, false);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].create.provider, PAYMENT_PROVIDER.KOMOJU);
  assert.equal(
    upserts[0].create.paymentMethod,
    PAYMENT_METHOD.CONVENIENCE_STORE,
  );
  assert.equal(upserts[0].create.status, PAYMENT_ATTEMPT_STATUS.PENDING);
  assert.equal(
    upserts[0].create.expiresAt.toISOString(),
    "2026-08-09T00:00:00.000Z",
  );
});

test("canonical-only payment sync never fabricates an attempt when Shopify lookup fails", async () => {
  let databaseWrite = false;
  const result = await syncShopifyOrderPaymentAttempts(
    {
      shop: "example.myshopify.com",
      payload: {
        id: 100,
        payment_gateway_names: [
          "shopify_payments",
          "web",
          "Shopify Payments",
          "card",
        ],
      },
      sourceTopic: "PAID_LEDGER_BACKFILL",
    },
    {
      canonicalOnly: true,
      loadCanonicalPaymentOrderImpl: async () => {
        throw new Error("canonical unavailable");
      },
      prismaClient: {
        marketplacePaymentAttempt: {
          upsert: async () => {
            databaseWrite = true;
          },
        },
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.tracked, false);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.reason, "canonical_payment_lookup_failed");
  assert.equal(databaseWrite, false);
});

test("canonical-only dry run uses transaction IDs instead of ledger gateway aliases", async () => {
  const result = await syncShopifyOrderPaymentAttempts(
    {
      shop: "example.myshopify.com",
      payload: {
        id: 100,
        payment_gateway_names: [
          "shopify_payments",
          "web",
          "Shopify Payments",
          "card",
        ],
      },
      sourceTopic: "PAID_LEDGER_BACKFILL",
    },
    {
      canonicalOnly: true,
      dryRun: true,
      loadCanonicalPaymentOrderImpl: async () => ({
        id: "gid://shopify/Order/100",
        name: "#100",
        createdAt: "2026-08-06T00:00:00.000Z",
        cancelledAt: null,
        test: false,
        currencyCode: "JPY",
        displayFinancialStatus: "PAID",
        transactions: [
          {
            id: "gid://shopify/OrderTransaction/1",
            kind: "SALE",
            status: "SUCCESS",
            gateway: "shopify_payments",
            formattedGateway: "Shopify Payments",
            test: false,
            processedAt: "2026-08-06T00:00:00.000Z",
            amountSet: {
              shopMoney: { amount: "1650", currencyCode: "JPY" },
            },
            parentTransaction: null,
          },
        ],
      }),
      prismaClient: {
        marketplaceOrder: { findUnique: async () => ({ id: "order-1" }) },
        marketplacePaymentAttempt: { findMany: async () => [] },
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.attemptCount, 1);
  assert.equal(result.creates, 1);
  assert.equal(result.updates, 0);
  assert.equal(result.reviewRequired, false);
  assert.equal(
    result.attempts[0].attemptKey,
    "gid://shopify/OrderTransaction/1",
  );
  assert.equal(result.attempts[0].provider, PAYMENT_PROVIDER.SHOPIFY_PAYMENTS);
});

function paidLedgerEntry({ id, orderId, gatewayNames = [] }) {
  return {
    id,
    amount: 1650,
    currencyCode: "jpy",
    occurredAt: new Date("2026-08-06T00:00:00.000Z"),
    metadataJson: {
      shopDomain: "example.myshopify.com",
      shopifyOrderId: `gid://shopify/Order/${orderId}`,
      shopifyOrderName: `#${orderId}`,
      shopifyPaymentGatewayNames: gatewayNames,
    },
  };
}

test("paid ledger backfill groups seller ledger rows by order before canonical sync", async () => {
  const calls = [];
  const pollutedGateways = [
    "shopify_payments",
    "web",
    "Shopify Payments",
    "card",
  ];
  const prismaClient = {
    ledgerEntry: {
      findMany: async () => [
        paidLedgerEntry({
          id: "ledger-1",
          orderId: 100,
          gatewayNames: pollutedGateways,
        }),
        paidLedgerEntry({
          id: "ledger-2",
          orderId: 100,
          gatewayNames: pollutedGateways,
        }),
      ],
    },
  };
  const syncImpl = async (input, options) => {
    calls.push({ input, options });
    assert.equal(input.payload.payment_gateway_names, undefined);
    assert.equal(options.canonicalOnly, true);
    if (options.dryRun) {
      return {
        ok: true,
        tracked: true,
        dryRun: true,
        attemptCount: 1,
        creates: 1,
        updates: 0,
        reviewRequired: false,
        multipleAttempts: false,
        attempts: [{ attemptKey: "transaction-1", requiresReview: false }],
      };
    }
    return {
      ok: true,
      tracked: true,
      attemptCount: 1,
      reviewRequired: false,
    };
  };

  const preview = await previewPaymentAttemptsFromPaidLedger(
    { limit: 200 },
    { prismaClient, syncShopifyOrderPaymentAttemptsImpl: syncImpl },
  );
  assert.equal(preview.canApply, true);
  assert.equal(preview.processedLedgerRows, 2);
  assert.equal(preview.uniqueOrders, 1);
  assert.equal(preview.duplicateLedgerRows, 1);
  assert.equal(preview.metadataGatewayAnomalyRows, 2);
  assert.equal(preview.projectedCreates, 1);
  assert.equal(preview.existingAttemptOrders, 0);

  const applied = await backfillPaymentAttemptsFromPaidLedger(
    { actor: "shopify_user:1", limit: 200 },
    { prismaClient, syncShopifyOrderPaymentAttemptsImpl: syncImpl },
  );
  assert.equal(applied.ok, true);
  assert.equal(applied.createdOrUpdated, 1);
  assert.equal(calls.filter((call) => call.options.dryRun).length, 2);
  assert.equal(calls.filter((call) => !call.options.dryRun).length, 1);
});

test("paid ledger backfill excludes test-store ledger rows", async () => {
  let findManyWhere = null;
  let countWhere = null;
  let syncCalled = false;
  const preview = await previewPaymentAttemptsFromPaidLedger(
    { limit: 200 },
    {
      prismaClient: {
        ledgerEntry: {
          findMany: async (args) => {
            findManyWhere = args.where;
            return [];
          },
          count: async (args) => {
            countWhere = args.where;
            return 9;
          },
        },
      },
      syncShopifyOrderPaymentAttemptsImpl: async () => {
        syncCalled = true;
        return { ok: true, tracked: true };
      },
    },
  );

  assert.equal(findManyWhere.seller.is.vendorStore.is.isTestStore, false);
  assert.equal(countWhere.seller.is.vendorStore.is.isTestStore, true);
  assert.equal(preview.processedLedgerRows, 0);
  assert.equal(preview.excludedTestLedgerRows, 9);
  assert.equal(preview.uniqueOrders, 0);
  assert.equal(preview.canApply, false);
  assert.equal(syncCalled, false);
});

test("paid ledger backfill stops before writes when canonical preflight needs review", async () => {
  let writeAttempted = false;
  const result = await backfillPaymentAttemptsFromPaidLedger(
    { actor: "shopify_user:1", limit: 10 },
    {
      prismaClient: {
        ledgerEntry: {
          findMany: async () => [
            paidLedgerEntry({
              id: "ledger-1",
              orderId: 100,
              gatewayNames: ["shopify_payments", "web", "card"],
            }),
          ],
        },
      },
      syncShopifyOrderPaymentAttemptsImpl: async (_input, options) => {
        if (!options.dryRun) writeAttempted = true;
        return {
          ok: true,
          tracked: true,
          dryRun: true,
          attemptCount: 2,
          creates: 2,
          updates: 0,
          reviewRequired: true,
          multipleAttempts: true,
          attempts: [
            { attemptKey: "transaction-1", requiresReview: false },
            { attemptKey: "transaction-2", requiresReview: false },
          ],
        };
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "payment_backfill_preflight_blocked");
  assert.equal(result.canApply, false);
  assert.equal(result.multipleAttemptOrders, 1);
  assert.equal(writeAttempted, false);
});

test("paid-ledger backfill fails closed when an entry has no order identity", async () => {
  let writeAttempted = false;
  const result = await backfillPaymentAttemptsFromPaidLedger(
    { actor: "shopify_user:1", limit: 10 },
    {
      prismaClient: {
        ledgerEntry: {
          findMany: async () => [
            {
              id: "ledger-missing-order",
              amount: 1650,
              currencyCode: "jpy",
              occurredAt: new Date("2026-08-06T00:00:00.000Z"),
              metadataJson: { shopDomain: "example.myshopify.com" },
            },
          ],
        },
      },
      syncShopifyOrderPaymentAttemptsImpl: async (_input, options) => {
        if (!options.dryRun) writeAttempted = true;
        return { ok: true, tracked: true, dryRun: true };
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "payment_backfill_orders_not_found");
  assert.equal(result.skippedLedgerRows, 1);
  assert.deepEqual(result.blockerReasons, {
    payment_order_identity_missing: 1,
  });
  assert.equal(writeAttempted, false);
});

function refundPayload() {
  return {
    id: 900,
    order_id: 100,
    currency: "JPY",
    refund_line_items: [
      {
        id: 1,
        quantity: 1,
        line_item_id: 10,
        subtotal: "1650",
        line_item: { id: 10, product_id: 20, variant_id: 30 },
      },
    ],
    transactions: [
      {
        id: 40,
        kind: "REFUND",
        status: "PENDING",
        gateway: "KOMOJU - Convenience Store",
        amount: "1650",
        currency: "JPY",
      },
    ],
  };
}

function refundPrisma({ existing = null } = {}) {
  let operation = existing;
  return {
    marketplacePaymentAttempt: {
      findFirst: async () => ({
        id: "attempt-1",
        provider: PAYMENT_PROVIDER.KOMOJU,
        paymentMethod: PAYMENT_METHOD.CONVENIENCE_STORE,
      }),
    },
    marketplaceOrder: { findUnique: async () => ({ id: "order-1" }) },
    paymentRefundOperation: {
      findUnique: async () => operation,
      upsert: async (args) => {
        operation = { id: "refund-op-1", ...args.create };
        return operation;
      },
    },
  };
}

test("a completed direct refund blocks provider refund ledger application", async () => {
  const prismaClient = refundPrisma();
  prismaClient.orderRefundGuard = {
    async findUnique() {
      return {
        id: "guard-direct",
        marketplaceOrderId: "order-1",
        channel: "DIRECT",
        status: "COMPLETED",
      };
    },
  };
  const result = await observeShopifyRefundOperation(
    { payload: refundPayload(), shop: "example.myshopify.com" },
    {
      prismaClient,
      env: { PAYMENT_REFUND_CONFIRMATION_ENFORCED: "true" },
      now: new Date("2026-08-06T00:00:00.000Z"),
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.allowLedger, false);
  assert.equal(result.reason, "direct_customer_refund_already_completed");
  assert.equal(result.operation.status, PAYMENT_REFUND_STATUS.REVIEW_REQUIRED);
  assert.equal(result.operation.metadataJson.refundChannelConflict, true);
});

test("manual KOMOJU refund is held before the legacy ledger", async () => {
  const result = await observeShopifyRefundOperation(
    { payload: refundPayload(), shop: "example.myshopify.com" },
    {
      prismaClient: refundPrisma(),
      env: { PAYMENT_REFUND_CONFIRMATION_ENFORCED: "true" },
      now: new Date("2026-08-06T00:00:00.000Z"),
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.allowLedger, false);
  assert.equal(result.operation.status, PAYMENT_REFUND_STATUS.REVIEW_REQUIRED);
  assert.equal(result.operation.refundMode, PAYMENT_REFUND_MODE.KOMOJU_MANUAL);
});

test("manual KOMOJU refund confirmation stays disabled without the operations flag", async () => {
  let databaseRead = false;
  const result = await confirmManualPaymentRefundOperation(
    {
      operationId: "refund-op-1",
      providerReference: "komoju-refund-1",
      evidenceReference: "private-evidence:refund-1",
      actor: "shopify_user:1",
      confirm: "provider_refund_confirmed",
    },
    {
      env: {},
      prismaClient: {
        paymentRefundOperation: {
          findUnique: async () => {
            databaseRead = true;
            return null;
          },
        },
      },
    },
  );

  assert.deepEqual(result, {
    ok: false,
    reason: "komoju_payment_operations_disabled",
  });
  assert.equal(databaseRead, false);
});

test("an applied manual refund keeps its snapshot available for withdrawal reconciliation", async () => {
  const snapshot = refundPayload();
  const operation = {
    id: "refund-op-1",
    refundMode: PAYMENT_REFUND_MODE.KOMOJU_MANUAL,
    ledgerAppliedAt: new Date("2026-08-06T01:00:00.000Z"),
    shopifyRefundSnapshotJson: snapshot,
  };
  const result = await confirmManualPaymentRefundOperation(
    {
      operationId: operation.id,
      providerReference: "komoju-refund-1",
      evidenceReference: "private-evidence:refund-1",
      actor: "shopify_user:1",
      confirm: "provider_refund_confirmed",
    },
    {
      env: { KOMOJU_PAYMENT_OPERATIONS_ENABLED: "true" },
      prismaClient: {
        paymentRefundOperation: {
          findUnique: async () => operation,
        },
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.duplicate, true);
  assert.equal(result.payload, snapshot);
});

test("duplicate refund webhook cannot downgrade an applied operation", async () => {
  const applied = {
    id: "refund-op-1",
    status: PAYMENT_REFUND_STATUS.LEDGER_APPLIED,
    ledgerAppliedAt: new Date("2026-08-06T01:00:00.000Z"),
  };
  const result = await observeShopifyRefundOperation(
    { payload: refundPayload(), shop: "example.myshopify.com" },
    { prismaClient: refundPrisma({ existing: applied }) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, true);
  assert.equal(result.allowLedger, false);
  assert.equal(result.operation, applied);
});

test("settlement evidence detects a net amount mismatch", async () => {
  let writeCount = 0;
  const prismaClient = {
    marketplacePaymentAttempt: {
      async findMany() {
        return [
          {
            id: "attempt-1",
            provider: "KOMOJU",
            status: "CAPTURED",
            test: false,
            requiresReview: false,
            amount: 10000,
            currencyCode: "jpy",
          },
        ];
      },
    },
    paymentRefundOperation: {
      async findMany() {
        return [];
      },
    },
    paymentSettlementBatch: {
      async findUnique() {
        return null;
      },
      async upsert() {
        writeCount += 1;
        return { id: "batch-1" };
      },
    },
    paymentSettlementLine: {
      async findFirst() {
        return null;
      },
      async deleteMany() {
        writeCount += 1;
      },
      async createMany() {
        writeCount += 1;
      },
    },
  };
  prismaClient.$transaction = async (callback) => callback(prismaClient);
  const result = await recordPaymentSettlementBatch(
    {
      provider: "KOMOJU",
      externalBatchId: "batch-1",
      grossAmount: "10000",
      refundAmount: "1000",
      feeAmount: "200",
      netAmount: "9000",
      currencyCode: "jpy",
      payoutDate: "2026-08-06",
      bankDepositedAt: "2026-08-06",
      evidenceReference: "private-evidence:batch-1",
      evidenceHash: "1".repeat(64),
      actor: "shopify_user:1",
      confirm: "settlement_evidence_recorded",
      paymentAttemptIds: ["attempt-1"],
    },
    { prismaClient },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "settlement_direct_totals_mismatch");
  assert.equal(result.expectedNetAmount, 8800);
  assert.equal(result.linkedGrossAmount, 10000);
  assert.equal(writeCount, 0);
});

test("settlement evidence links a reconciled payout directly to its payment attempt", async () => {
  let createdBatch;
  let createdLines;
  const prismaClient = {
    marketplacePaymentAttempt: {
      async findMany() {
        return [
          {
            id: "attempt-1",
            marketplaceOrderId: "order-1",
            shopifyTransactionId: "gid://shopify/OrderTransaction/1",
            provider: "KOMOJU",
            status: "CAPTURED",
            test: false,
            requiresReview: false,
            amount: 10000,
            currencyCode: "jpy",
            processedAt: new Date("2026-08-06T00:00:00.000Z"),
          },
        ];
      },
    },
    paymentRefundOperation: {
      async findMany() {
        return [];
      },
    },
    paymentSettlementBatch: {
      async findUnique() {
        return null;
      },
      async create({ data }) {
        createdBatch = data;
        return { id: "batch-1", ...data };
      },
    },
    paymentSettlementLine: {
      async findFirst() {
        return null;
      },
      async deleteMany() {},
      async createMany({ data }) {
        createdLines = data;
      },
    },
  };
  prismaClient.$transaction = async (callback) => callback(prismaClient);
  const result = await recordPaymentSettlementBatch(
    {
      provider: "KOMOJU",
      externalBatchId: "batch-1",
      grossAmount: "10000",
      refundAmount: "0",
      feeAmount: "200",
      netAmount: "9800",
      currencyCode: "jpy",
      payoutDate: "2026-08-06",
      bankDepositedAt: "2026-08-06",
      evidenceReference: "private-evidence:batch-1",
      evidenceHash: "2".repeat(64),
      actor: "shopify_user:1",
      confirm: "settlement_evidence_recorded",
      paymentAttemptIds: ["attempt-1"],
    },
    { prismaClient },
  );

  assert.equal(result.ok, true);
  assert.equal(createdBatch.status, "RECONCILED");
  assert.equal(createdBatch.metadataJson.directLineReconciliation, true);
  assert.equal(createdLines.length, 2);
  assert.equal(createdLines[0].paymentAttemptId, "attempt-1");
  assert.equal(createdLines[0].matchStatus, "MATCHED");
  assert.equal(createdLines[1].lineType, "FEE");
});

test("settlement evidence rejects a payment attempt already linked to another payout", async () => {
  let writeCount = 0;
  const prismaClient = {
    marketplacePaymentAttempt: {
      async findMany() {
        return [
          {
            id: "attempt-1",
            provider: "KOMOJU",
            status: "CAPTURED",
            test: false,
            requiresReview: false,
            amount: 10000,
            currencyCode: "jpy",
          },
        ];
      },
    },
    paymentRefundOperation: {
      async findMany() {
        return [];
      },
    },
    paymentSettlementBatch: {
      async findUnique() {
        return null;
      },
      async upsert() {
        writeCount += 1;
        return { id: "batch-2" };
      },
    },
    paymentSettlementLine: {
      async findFirst() {
        return { id: "line-from-batch-1" };
      },
      async deleteMany() {
        writeCount += 1;
      },
      async createMany() {
        writeCount += 1;
      },
    },
  };
  prismaClient.$transaction = async (callback) => callback(prismaClient);

  const result = await recordPaymentSettlementBatch(
    {
      provider: "KOMOJU",
      externalBatchId: "batch-2",
      grossAmount: "10000",
      refundAmount: "0",
      feeAmount: "200",
      netAmount: "9800",
      currencyCode: "jpy",
      payoutDate: "2026-08-07",
      bankDepositedAt: "2026-08-07",
      evidenceReference: "private-evidence:batch-2",
      evidenceHash: "3".repeat(64),
      actor: "shopify_user:1",
      confirm: "settlement_evidence_recorded",
      paymentAttemptIds: ["attempt-1"],
    },
    { prismaClient },
  );

  assert.deepEqual(result, {
    ok: false,
    reason: "settlement_line_already_registered",
  });
  assert.equal(writeCount, 0);
});

test("a reconciled settlement batch is idempotent but cannot be changed", async () => {
  const evidenceHash = "4".repeat(64);
  const attempt = {
    id: "attempt-1",
    marketplaceOrderId: "order-1",
    shopifyTransactionId: "gid://shopify/OrderTransaction/1",
    provider: "KOMOJU",
    status: "CAPTURED",
    test: false,
    requiresReview: false,
    amount: 10000,
    currencyCode: "jpy",
    processedAt: new Date("2026-08-06T00:00:00.000Z"),
  };
  const existingBatch = {
    id: "batch-immutable",
    provider: "KOMOJU",
    externalBatchId: "batch-immutable",
    status: "RECONCILED",
    grossAmount: 10000,
    refundAmount: 0,
    feeAmount: 200,
    netAmount: 9800,
    currencyCode: "jpy",
    payoutDate: new Date("2026-08-06T00:00:00.000Z"),
    bankDepositedAt: new Date("2026-08-06T00:00:00.000Z"),
    evidenceReference: "private-evidence:immutable",
    evidenceHash,
    lines: [
      {
        externalLineId: "payment:gid://shopify/OrderTransaction/1",
        lineType: "PAYMENT",
        paymentAttemptId: "attempt-1",
        refundOperationId: null,
        marketplaceOrderId: "order-1",
        providerReference: "gid://shopify/OrderTransaction/1",
        amount: 10000,
        feeAmount: 0,
        currencyCode: "jpy",
        matchStatus: "MATCHED",
        occurredAt: new Date("2026-08-06T00:00:00.000Z"),
      },
      {
        externalLineId: "fee:aggregate",
        lineType: "FEE",
        paymentAttemptId: null,
        refundOperationId: null,
        marketplaceOrderId: null,
        providerReference: null,
        amount: 0,
        feeAmount: 200,
        currencyCode: "jpy",
        matchStatus: "MATCHED",
        occurredAt: new Date("2026-08-06T00:00:00.000Z"),
      },
    ],
  };
  let writes = 0;
  const prismaClient = {
    marketplacePaymentAttempt: { findMany: async () => [attempt] },
    paymentRefundOperation: { findMany: async () => [] },
    paymentSettlementBatch: {
      async findUnique({ where }) {
        return where.provider_externalBatchId ? existingBatch : existingBatch;
      },
      async create() {
        writes += 1;
      },
    },
    paymentSettlementLine: {
      async findFirst() {
        return null;
      },
      async createMany() {
        writes += 1;
      },
    },
  };
  prismaClient.$transaction = async (callback) => callback(prismaClient);
  const baseInput = {
    provider: "KOMOJU",
    externalBatchId: "batch-immutable",
    grossAmount: "10000",
    refundAmount: "0",
    feeAmount: "200",
    netAmount: "9800",
    currencyCode: "jpy",
    payoutDate: "2026-08-06",
    bankDepositedAt: "2026-08-06",
    evidenceReference: "private-evidence:immutable",
    evidenceHash,
    actor: "shopify_user:1",
    confirm: "settlement_evidence_recorded",
    paymentAttemptIds: ["attempt-1"],
  };

  const repeated = await recordPaymentSettlementBatch(baseInput, {
    prismaClient,
  });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.idempotent, true);
  assert.equal(writes, 0);

  const changed = await recordPaymentSettlementBatch(
    { ...baseInput, evidenceReference: "private-evidence:replacement" },
    { prismaClient },
  );
  assert.deepEqual(changed, {
    ok: false,
    reason: "settlement_batch_immutable",
  });
  assert.equal(writes, 0);
});

test("settlement evidence hash cannot be reused by another payout", async () => {
  const evidenceHash = "5".repeat(64);
  let writes = 0;
  const prismaClient = {
    marketplacePaymentAttempt: {
      async findMany() {
        return [
          {
            id: "attempt-2",
            provider: "KOMOJU",
            status: "CAPTURED",
            test: false,
            requiresReview: false,
            amount: 10000,
            currencyCode: "jpy",
            processedAt: new Date("2026-08-06T00:00:00.000Z"),
          },
        ];
      },
    },
    paymentRefundOperation: { findMany: async () => [] },
    paymentSettlementBatch: {
      async findUnique({ where }) {
        return where.evidenceHash ? { id: "batch-original" } : null;
      },
      async create() {
        writes += 1;
      },
    },
    paymentSettlementLine: {
      findFirst: async () => null,
      async createMany() {
        writes += 1;
      },
    },
  };
  prismaClient.$transaction = async (callback) => callback(prismaClient);
  const result = await recordPaymentSettlementBatch(
    {
      provider: "KOMOJU",
      externalBatchId: "batch-new",
      grossAmount: "10000",
      refundAmount: "0",
      feeAmount: "200",
      netAmount: "9800",
      currencyCode: "jpy",
      payoutDate: "2026-08-06",
      bankDepositedAt: "2026-08-06",
      evidenceReference: "private-evidence:reused",
      evidenceHash,
      actor: "shopify_user:1",
      confirm: "settlement_evidence_recorded",
      paymentAttemptIds: ["attempt-2"],
    },
    { prismaClient },
  );

  assert.deepEqual(result, {
    ok: false,
    reason: "settlement_evidence_hash_already_registered",
  });
  assert.equal(writes, 0);
});

test("settlement evidence rejects a future bank deposit date", async () => {
  const result = await recordPaymentSettlementBatch(
    {
      provider: "KOMOJU",
      externalBatchId: "batch-future",
      grossAmount: "10000",
      refundAmount: "0",
      feeAmount: "200",
      netAmount: "9800",
      currencyCode: "jpy",
      payoutDate: "2026-08-08",
      bankDepositedAt: "2026-08-08",
      evidenceReference: "private-evidence:future",
      evidenceHash: "6".repeat(64),
      actor: "shopify_user:1",
      confirm: "settlement_evidence_recorded",
      paymentAttemptIds: ["attempt-future"],
    },
    {
      prismaClient: {
        $transaction: async () =>
          assert.fail("invalid dates must not query DB"),
      },
      now: new Date("2026-08-07T12:00:00.000Z"),
    },
  );

  assert.deepEqual(result, {
    ok: false,
    reason: "settlement_date_invalid",
  });
});

test("settlement evidence rejects a bank deposit before its payment", async () => {
  const result = await recordPaymentSettlementBatch(
    {
      provider: "KOMOJU",
      externalBatchId: "batch-before-payment",
      grossAmount: "10000",
      refundAmount: "0",
      feeAmount: "200",
      netAmount: "9800",
      currencyCode: "jpy",
      payoutDate: "2026-08-05",
      bankDepositedAt: "2026-08-05",
      evidenceReference: "private-evidence:before-payment",
      evidenceHash: "7".repeat(64),
      actor: "shopify_user:1",
      confirm: "settlement_evidence_recorded",
      paymentAttemptIds: ["attempt-after-deposit"],
    },
    {
      prismaClient: {
        marketplacePaymentAttempt: {
          async findMany() {
            return [
              {
                id: "attempt-after-deposit",
                provider: "KOMOJU",
                status: "CAPTURED",
                test: false,
                requiresReview: false,
                amount: 10000,
                currencyCode: "jpy",
                processedAt: new Date("2026-08-06T00:00:00.000Z"),
              },
            ];
          },
        },
        paymentRefundOperation: { findMany: async () => [] },
        paymentSettlementBatch: { findUnique: async () => null },
        paymentSettlementLine: { findFirst: async () => null },
        async $transaction(callback) {
          return callback(this);
        },
      },
      now: new Date("2026-08-07T12:00:00.000Z"),
    },
  );

  assert.deepEqual(result, {
    ok: false,
    reason: "settlement_bank_deposit_precedes_payment",
  });
});

test("payment operation inspection aggregates operational blockers", async () => {
  const values = [2, 1, 3, 4, 5, 6];
  const inspection = await inspectPaymentOperations({
    prismaClient: {
      marketplacePaymentAttempt: { count: async () => values.shift() },
      paymentRefundOperation: { count: async () => values.shift() },
      paymentSettlementLine: { count: async () => values.shift() },
      paymentSettlementBatch: { count: async () => values.shift() },
    },
  });
  assert.equal(inspection.pendingExpiredCount, 2);
  assert.equal(inspection.attemptReviewCount, 1);
  assert.equal(inspection.refundReviewCount, 3);
  assert.equal(inspection.refundFailedCount, 4);
  assert.equal(inspection.unmatchedSettlementCount, 5);
  assert.equal(inspection.settlementBatchReviewCount, 6);
  assert.equal(inspection.criticalCount, 5);
  assert.equal(inspection.attentionCount, 16);
});

test("KOMOJU readiness requires the refund confirmation gate", () => {
  const operationEnv = inspectOperationEnvironment({
    PAYMENT_PROVIDERS: "shopify_payments,komoju",
    SELLER_PAYOUT_PROVIDER: "manual",
  });
  assert.deepEqual(operationEnv.paymentProviders, [
    "shopify_payments",
    "komoju",
  ]);
  assert.equal(operationEnv.komojuEnabled, true);

  const checks = buildPaymentOperationChecks({
    inspection: {
      available: true,
      pendingExpiredCount: 0,
      attemptReviewCount: 0,
      refundReviewCount: 1,
      refundFailedCount: 0,
      unmatchedSettlementCount: 0,
    },
    operationEnv,
  });
  assert.equal(
    checks.find((check) => check.id === "payment_refunds_review")?.status,
    "warning",
  );
});

test("KOMOJU environment checks fail closed until both operational flags are set", () => {
  const base = {
    PAYMENT_PROVIDERS: "shopify_payments,komoju",
    SELLER_PAYOUT_PROVIDER: "manual",
  };
  const stripeEnv = {
    secretKeyMode: "missing",
    publishableKeyMode: "missing",
    modesMatch: false,
    hasPlatformWebhookSecret: false,
    hasConnectWebhookSecret: false,
    platformWebhookSecretLooksValid: true,
    connectWebhookSecretLooksValid: true,
    platformFeeBps: 0,
    platformFeeBpsValid: true,
  };
  const blocked = buildEnvironmentChecks({
    stripeEnv,
    env: base,
    operationEnv: inspectOperationEnvironment(base),
  });
  assert.equal(
    blocked.find((check) => check.id === "komoju_payment_operations_enabled")
      ?.status,
    "fail",
  );
  assert.equal(
    blocked.find((check) => check.id === "payment_refund_confirmation_enforced")
      ?.status,
    "fail",
  );

  const enabledEnv = {
    ...base,
    KOMOJU_PAYMENT_OPERATIONS_ENABLED: "true",
    PAYMENT_REFUND_CONFIRMATION_ENFORCED: "true",
  };
  const enabled = buildEnvironmentChecks({
    stripeEnv,
    env: enabledEnv,
    operationEnv: inspectOperationEnvironment(enabledEnv),
  });
  assert.equal(
    enabled.find((check) => check.id === "komoju_payment_operations_enabled")
      ?.status,
    "pass",
  );
  assert.equal(
    enabled.find((check) => check.id === "payment_refund_confirmation_enforced")
      ?.status,
    "pass",
  );
});

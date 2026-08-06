import assert from "node:assert/strict";
import test from "node:test";

import {
  PAYMENT_ATTEMPT_STATUS,
  PAYMENT_METHOD,
  PAYMENT_PROVIDER,
  PAYMENT_REFUND_MODE,
  PAYMENT_REFUND_STATUS,
  classifyPaymentGateway,
  confirmManualPaymentRefundOperation,
  inspectPaymentOperations,
  observeShopifyRefundOperation,
  recordPaymentSettlementBatch,
  resolvePaymentAttemptStatus,
  syncShopifyOrderPaymentAttempts,
} from "../../app/services/paymentOperations.server.js";
import {
  buildPaymentOperationChecks,
} from "../../app/services/productionReadiness/payments.server.js";
import {
  buildEnvironmentChecks,
  inspectOperationEnvironment,
} from "../../app/services/productionReadiness/environment.server.js";

test("KOMOJU gateway names are classified by payment method", () => {
  const convenience = classifyPaymentGateway(
    "KOMOJU - Convenience Store",
  );
  assert.equal(convenience.provider, PAYMENT_PROVIDER.KOMOJU);
  assert.equal(convenience.paymentMethod, PAYMENT_METHOD.CONVENIENCE_STORE);
  assert.equal(convenience.refundMode, PAYMENT_REFUND_MODE.KOMOJU_MANUAL);

  const card = classifyPaymentGateway("KOMOJU - Credit Card");
  assert.equal(card.provider, PAYMENT_PROVIDER.KOMOJU);
  assert.equal(card.paymentMethod, PAYMENT_METHOD.CARD);
  assert.equal(card.refundMode, PAYMENT_REFUND_MODE.SHOPIFY_LINKED);
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
  let submitted;
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
      actor: "shopify_user:1",
      confirm: "settlement_evidence_recorded",
    },
    {
      prismaClient: {
        paymentSettlementBatch: {
          upsert: async (args) => {
            submitted = args;
            return { id: "batch-1", ...args.create };
          },
        },
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.expectedNetAmount, 8800);
  assert.equal(submitted.create.status, "REVIEW_REQUIRED");
});

test("payment operation inspection aggregates operational blockers", async () => {
  const values = [2, 1, 3, 4, 5];
  const inspection = await inspectPaymentOperations({
    prismaClient: {
      marketplacePaymentAttempt: { count: async () => values.shift() },
      paymentRefundOperation: { count: async () => values.shift() },
      paymentSettlementLine: { count: async () => values.shift() },
    },
  });
  assert.equal(inspection.pendingExpiredCount, 2);
  assert.equal(inspection.attemptReviewCount, 1);
  assert.equal(inspection.refundReviewCount, 3);
  assert.equal(inspection.refundFailedCount, 4);
  assert.equal(inspection.unmatchedSettlementCount, 5);
  assert.equal(inspection.criticalCount, 5);
  assert.equal(inspection.attentionCount, 10);
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

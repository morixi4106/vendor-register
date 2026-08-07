import assert from "node:assert/strict";
import test from "node:test";

import {
  completeDirectCustomerRefund,
  prepareDirectCustomerRefund,
  recordDirectCustomerRefund,
} from "../../app/services/directCustomerRefund.server.js";

const SHOP = "example.myshopify.com";
const ORDER_ID = "gid://shopify/Order/100";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const NOW = new Date("2026-08-10T00:00:00.000Z");

function input(overrides = {}) {
  return {
    shopDomain: SHOP,
    orderReference: "#100",
    amount: 1650,
    currencyCode: "JPY",
    recipientConsentReference: "private:consent/100",
    recipientConsentHash: HASH_A,
    transferEvidenceReference: "private:transfer/100",
    transferEvidenceHash: HASH_B,
    transferReferenceMasked: "****1234",
    actor: "admin@example.com",
    confirm: "direct_customer_refund_completed",
    ...overrides,
  };
}

function order(overrides = {}) {
  return {
    id: "order-1",
    shopDomain: SHOP,
    shopifyOrderId: ORDER_ID,
    shopifyOrderName: "#100",
    totalAmount: 1650,
    currencyCode: "jpy",
    refundGuard: null,
    directCustomerRefund: null,
    paymentAttempts: [
      {
        id: "attempt-1",
        provider: "KOMOJU",
        amount: 1650,
        currencyCode: "jpy",
      },
    ],
    paymentRefundOperations: [],
    sellerOrders: [
      {
        id: "seller-order-1",
        sellerId: "seller-1",
        sellerRefundAmount: 0,
        paymentStatus: "paid",
        lines: [{ id: "line-1", quantity: 1 }],
      },
    ],
    ...overrides,
  };
}

function directRefundPrisma({ storedOrder = order(), ledgerEntries } = {}) {
  const state = {
    order: storedOrder,
    guard: storedOrder.refundGuard,
    directRefund: storedOrder.directCustomerRefund,
    ledgerEntries:
      ledgerEntries === undefined
        ? [
            {
              id: "paid-ledger-1",
              sellerId: "seller-1",
              entryType: "shopify_order_paid",
              amount: 1650,
            },
          ]
        : ledgerEntries,
    createdLedger: [],
  };
  const prismaClient = {
    async $transaction(callback) {
      return callback(prismaClient);
    },
    marketplaceOrder: {
      async findMany() {
        state.order.directCustomerRefund = state.directRefund;
        state.order.refundGuard = state.guard;
        return [state.order];
      },
    },
    ledgerEntry: {
      async findMany() {
        return [...state.ledgerEntries, ...state.createdLedger];
      },
      async create({ data }) {
        const row = { id: `ledger-${state.createdLedger.length + 1}`, ...data };
        state.createdLedger.push(row);
        return row;
      },
    },
    orderRefundGuard: {
      async create({ data }) {
        state.guard = { id: "guard-1", ...data };
        return state.guard;
      },
      async update({ data }) {
        state.guard = { ...state.guard, ...data };
        return state.guard;
      },
    },
    seller: {
      async findUnique() {
        return { id: "seller-1", stripeAccount: null };
      },
    },
    sellerOrderLine: {
      async update() {
        return {};
      },
    },
    sellerOrder: {
      async update() {
        return {};
      },
    },
    directCustomerRefund: {
      async create({ data }) {
        state.directRefund = { id: "direct-refund-1", ...data };
        return state.directRefund;
      },
    },
    _state: state,
  };
  return prismaClient;
}

const refreshControl = async () => ({ ok: true, skipped: true });

test("preparing a direct refund reserves the channel without recording a transfer", async () => {
  const prismaClient = directRefundPrisma();
  let refreshCount = 0;
  const result = await prepareDirectCustomerRefund(
    input({ confirm: "direct_customer_refund_prepare" }),
    {
      prismaClient,
      now: NOW,
      refreshLimitedLaunchControl: async () => {
        refreshCount += 1;
        return { ok: true };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(prismaClient._state.guard.channel, "DIRECT");
  assert.equal(prismaClient._state.guard.status, "RESERVED");
  assert.equal(prismaClient._state.directRefund, null);
  assert.equal(prismaClient._state.createdLedger.length, 0);
  assert.equal(refreshCount, 1);
});

test("completing a direct refund without a reservation is rejected", async () => {
  const prismaClient = directRefundPrisma();
  const result = await completeDirectCustomerRefund(input(), {
    prismaClient,
    now: NOW,
    refreshLimitedLaunchControl: refreshControl,
  });

  assert.deepEqual(result, {
    ok: false,
    reason: "direct_refund_not_prepared",
  });
  assert.equal(prismaClient._state.directRefund, null);
  assert.equal(prismaClient._state.createdLedger.length, 0);
});

test("a prepared direct refund completes with the same consent evidence", async () => {
  const prismaClient = directRefundPrisma();
  const prepared = await prepareDirectCustomerRefund(
    input({ confirm: "direct_customer_refund_prepare" }),
    {
      prismaClient,
      now: NOW,
      refreshLimitedLaunchControl: refreshControl,
    },
  );
  const completed = await completeDirectCustomerRefund(input(), {
    prismaClient,
    now: NOW,
    refreshLimitedLaunchControl: refreshControl,
  });

  assert.equal(prepared.ok, true);
  assert.equal(completed.ok, true);
  assert.equal(prismaClient._state.guard.status, "COMPLETED");
  assert.equal(prismaClient._state.createdLedger.length, 1);
});

test("direct refund records one full debit and completes the refund guard", async () => {
  const prismaClient = directRefundPrisma();
  const result = await recordDirectCustomerRefund(input(), {
    prismaClient,
    now: NOW,
    refreshLimitedLaunchControl: refreshControl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.existing, false);
  assert.equal(prismaClient._state.guard.channel, "DIRECT");
  assert.equal(prismaClient._state.guard.status, "COMPLETED");
  assert.equal(prismaClient._state.createdLedger.length, 1);
  assert.equal(
    prismaClient._state.createdLedger[0].entryType,
    "direct_customer_refund",
  );
  assert.equal(prismaClient._state.createdLedger[0].amount, 1650);
});

test("the same direct refund evidence is idempotent", async () => {
  const prismaClient = directRefundPrisma();
  const first = await recordDirectCustomerRefund(input(), {
    prismaClient,
    now: NOW,
    refreshLimitedLaunchControl: refreshControl,
  });
  const second = await recordDirectCustomerRefund(input(), {
    prismaClient,
    now: NOW,
    refreshLimitedLaunchControl: refreshControl,
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.existing, true);
  assert.equal(prismaClient._state.createdLedger.length, 1);
});

test("provider refund reservation prevents a later direct refund", async () => {
  const prismaClient = directRefundPrisma({
    storedOrder: order({
      refundGuard: {
        id: "guard-provider",
        channel: "PROVIDER",
        status: "RESERVED",
      },
    }),
  });
  const result = await recordDirectCustomerRefund(input(), {
    prismaClient,
    now: NOW,
    refreshLimitedLaunchControl: refreshControl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.equal(result.reason, "provider_refund_already_started");
  assert.equal(prismaClient._state.guard.status, "CONFLICT");
  assert.equal(
    prismaClient._state.guard.metadataJson.conflictReason,
    "direct_refund_after_provider_reservation",
  );
  assert.equal(prismaClient._state.createdLedger.length, 0);
});

test("missing paid ledger leaves no stale direct-refund reservation", async () => {
  const prismaClient = directRefundPrisma({ ledgerEntries: [] });
  const result = await recordDirectCustomerRefund(input(), {
    prismaClient,
    now: NOW,
    refreshLimitedLaunchControl: refreshControl,
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "direct_refund_paid_ledger_not_found",
  });
  assert.equal(prismaClient._state.guard, null);
  assert.equal(prismaClient._state.createdLedger.length, 0);
});

test("a partial paid ledger cannot be recorded as a full direct refund", async () => {
  const prismaClient = directRefundPrisma({
    ledgerEntries: [
      {
        id: "paid-ledger-1",
        sellerId: "seller-1",
        entryType: "shopify_order_paid",
        amount: 1000,
      },
    ],
  });
  const result = await recordDirectCustomerRefund(input(), {
    prismaClient,
    now: NOW,
    refreshLimitedLaunchControl: refreshControl,
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "direct_refund_ledger_amount_mismatch",
  });
  assert.equal(prismaClient._state.guard, null);
  assert.equal(prismaClient._state.createdLedger.length, 0);
});

test("a captured KOMOJU payment in another currency is rejected", async () => {
  const prismaClient = directRefundPrisma({
    storedOrder: order({
      paymentAttempts: [
        {
          id: "attempt-1",
          provider: "KOMOJU",
          amount: 1650,
          currencyCode: "usd",
        },
      ],
    }),
  });
  const result = await recordDirectCustomerRefund(input(), {
    prismaClient,
    now: NOW,
    refreshLimitedLaunchControl: refreshControl,
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "direct_refund_komoju_sale_not_found",
  });
});

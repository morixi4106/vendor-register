import assert from "node:assert/strict";
import test from "node:test";

import {
  attachOrderToProductionTransactionProbe,
  buildProductionTransactionProbePage,
  buildShopifyProbeOrderSnapshot,
  createProductionTransactionProbe,
  fetchShopifyOrderForProductionProbe,
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
  testOrder = false,
  createdAt = "2026-07-29T01:01:00.000Z",
} = {}) {
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
    refunds,
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
} = {}) {
  const snapshot = buildShopifyProbeOrderSnapshot(shopifyOrder());
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
} = {}) {
  const state = {
    probe,
    order,
    ledgerEntries,
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
        shopifyOrder({ createdAt: "2026-07-28T00:00:00.000Z" }),
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

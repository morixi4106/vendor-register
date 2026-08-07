import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKomojuLimitedLaunchProjection,
  calculateKomojuLimitedLaunchExposure,
  refreshKomojuLimitedLaunchControl,
} from "../../app/services/komojuLimitedLaunchControl.server.js";

const SHOP = "example.myshopify.com";
const NOW = new Date("2026-08-10T00:00:00.000Z");

function control(overrides = {}) {
  return {
    id: "control_1",
    shopDomain: SHOP,
    probeId: "probe_1",
    status: "ACTIVE",
    startsAt: new Date("2026-08-07T00:00:00.000Z"),
    expiresAt: new Date("2026-08-14T00:00:00.000Z"),
    maxOrderCount: 3,
    maxGrossAmount: 5000,
    maxOutstandingLiability: 5000,
    maxSingleOrderAmount: 2000,
    companyRefundReserveAmount: 5000,
    orderCount: 1,
    grossAmount: 1650,
    outstandingLiabilityAmount: 1650,
    allowedProductIdsJson: ["product_1"],
    allowedShopifyProductIdsJson: ["gid://shopify/Product/1"],
    metadataJson: { seedMarketplaceOrderId: "order_1" },
    blockedAt: null,
    ...overrides,
  };
}

function paidOrder({ id, totalAmount = 1650, directRefund = null } = {}) {
  return {
    id,
    totalAmount,
    financialStatus: directRefund ? "REFUNDED" : "PAID",
    sellerOrders: [
      {
        lines: [
          {
            productId: "product_1",
            shopifyProductId: "gid://shopify/Product/1",
          },
        ],
      },
    ],
    paymentRefundOperations: [],
    directCustomerRefund: directRefund,
  };
}

function prismaFor({ storedControl = control(), orders = [] } = {}) {
  let current = storedControl;
  return {
    komojuLimitedLaunchControl: {
      async findUnique() {
        return current;
      },
      async update({ data }) {
        current = { ...current, ...data };
        return current;
      },
    },
    productionTransactionProbe: {
      async findUnique() {
        return { status: "AWAITING_PAYOUT_EVIDENCE" };
      },
    },
    marketplaceOrder: {
      async findMany() {
        return orders;
      },
    },
    get current() {
      return current;
    },
  };
}

test("limited launch exposure counts orders, gross and outstanding liability", async () => {
  const exposure = await calculateKomojuLimitedLaunchExposure(control(), {
    prismaClient: prismaFor({
      orders: [
        paidOrder({ id: "order_1" }),
        paidOrder({
          id: "order_2",
          totalAmount: 1200,
          directRefund: { status: "COMPLETED", amount: 1200 },
        }),
      ],
    }),
  });
  assert.deepEqual(exposure, {
    orderCount: 2,
    grossAmount: 2850,
    outstandingLiabilityAmount: 1650,
    marketplaceOrderIds: ["order_1", "order_2"],
    disallowedProductOrderIds: [],
  });
});

test("a paid order outside the allowlist is counted and blocks the launch", async () => {
  const disallowed = paidOrder({ id: "order_2", totalAmount: 1200 });
  disallowed.sellerOrders[0].lines[0].productId = "product_not_allowed";
  const prismaClient = prismaFor({
    orders: [paidOrder({ id: "order_1" }), disallowed],
  });
  const result = await refreshKomojuLimitedLaunchControl(
    { shopDomain: SHOP, applyEmergencyHold: true },
    {
      prismaClient,
      now: NOW,
      syncProjection: async () => ({ ok: true }),
      emergencyHold: async () => ({ ok: true }),
    },
  );
  assert.equal(result.exposure.orderCount, 2);
  assert.equal(result.exposure.grossAmount, 2850);
  assert.deepEqual(result.exposure.disallowedProductOrderIds, ["order_2"]);
  assert.equal(
    result.blockReason,
    "komoju_limited_launch_product_allowlist_violated",
  );
  assert.equal(result.control.status, "BLOCKED");
});

test("reaching an exposure cap blocks projection and applies the emergency hold", async () => {
  const prismaClient = prismaFor({
    storedControl: control({ maxOrderCount: 2 }),
    orders: [paidOrder({ id: "order_1" }), paidOrder({ id: "order_2" })],
  });
  const projections = [];
  const holds = [];
  const result = await refreshKomojuLimitedLaunchControl(
    { shopDomain: SHOP, applyEmergencyHold: true },
    {
      prismaClient,
      now: NOW,
      syncProjection: async ({ projection }) => {
        projections.push(projection);
        return { ok: true };
      },
      emergencyHold: async (input) => {
        holds.push(input);
        return { ok: true };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.blockReason, "komoju_limited_launch_order_limit_reached");
  assert.equal(prismaClient.current.status, "BLOCKED");
  assert.equal(projections[0].s, "BLOCKED");
  assert.equal(holds.length, 1);
});

test("expiry blocks even when no scheduled monitor ran before checkout", async () => {
  const prismaClient = prismaFor({
    storedControl: control({ expiresAt: NOW }),
    orders: [paidOrder({ id: "order_1" })],
  });
  const result = await refreshKomojuLimitedLaunchControl(
    { shopDomain: SHOP, applyEmergencyHold: true },
    {
      prismaClient,
      now: NOW,
      syncProjection: async () => ({ ok: true }),
      emergencyHold: async () => ({ ok: true }),
    },
  );
  assert.equal(result.blockReason, "komoju_limited_launch_expired");
  assert.equal(result.control.status, "BLOCKED");
});

test("projection sync failure cannot skip the emergency hold", async () => {
  const prismaClient = prismaFor({
    storedControl: control({ expiresAt: NOW }),
    orders: [paidOrder({ id: "order_1" })],
  });
  const events = [];
  const result = await refreshKomojuLimitedLaunchControl(
    { shopDomain: SHOP, applyEmergencyHold: true },
    {
      prismaClient,
      now: NOW,
      emergencyHold: async () => {
        events.push("hold");
        return { ok: true };
      },
      syncProjection: async () => {
        events.push("projection");
        return { ok: false, reason: "projection_unavailable" };
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "projection_unavailable");
  assert.deepEqual(events, ["hold", "projection"]);
  assert.equal(prismaClient.current.status, "BLOCKED");
});

test("emergency hold failure cannot skip the blocking projection", async () => {
  const prismaClient = prismaFor({
    storedControl: control({ expiresAt: NOW }),
    orders: [paidOrder({ id: "order_1" })],
  });
  const projections = [];
  const result = await refreshKomojuLimitedLaunchControl(
    { shopDomain: SHOP, applyEmergencyHold: true },
    {
      prismaClient,
      now: NOW,
      emergencyHold: async () => {
        throw new Error("hold unavailable");
      },
      syncProjection: async ({ projection }) => {
        projections.push(projection);
        return { ok: true };
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.holdResult.reason, "limited_launch_emergency_hold_failed");
  assert.equal(projections[0].s, "BLOCKED");
  assert.equal(prismaClient.current.status, "BLOCKED");
});

test("a blocked launch cannot reactivate before strict E2E passes", async () => {
  const prismaClient = prismaFor({
    storedControl: control({
      status: "BLOCKED",
      blockReason: "komoju_limited_launch_liability_limit_reached",
      outstandingLiabilityAmount: 0,
    }),
    orders: [],
  });
  const result = await refreshKomojuLimitedLaunchControl(
    { shopDomain: SHOP, applyEmergencyHold: false },
    {
      prismaClient,
      now: NOW,
      syncProjection: async () => ({ ok: true }),
    },
  );
  assert.equal(result.control.status, "BLOCKED");
  assert.equal(
    result.blockReason,
    "komoju_limited_launch_liability_limit_reached",
  );
});

test("active projection exposes only remaining allowance", () => {
  const projection = buildKomojuLimitedLaunchProjection(
    control({ orderCount: 2, grossAmount: 3000, outstandingLiabilityAmount: 2500 }),
  );
  assert.deepEqual(projection, {
    v: 1,
    s: "ACTIVE",
    e: "2026-08-14",
    p: ["gid://shopify/Product/1"],
    m: 2000,
    o: 1,
    g: 2000,
    l: 2500,
    c: "JPY",
  });
});

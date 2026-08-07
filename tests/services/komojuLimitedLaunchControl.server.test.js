import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKomojuLimitedLaunchProjection,
  calculateKomojuLimitedLaunchExposure,
  evaluateKomojuLimitedLaunchControl,
  isCompleteKomojuLimitedLaunchMetadata,
  prepareKomojuLimitedLaunchBaseline,
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
    maxOrderCount: 2,
    maxGrossAmount: 5000,
    maxOutstandingLiability: 5000,
    maxSingleOrderAmount: 2000,
    companyRefundReserveAmount: 5000,
    orderCount: 1,
    grossAmount: 1650,
    outstandingLiabilityAmount: 1650,
    allowedProductIdsJson: ["product_1"],
    allowedShopifyProductIdsJson: ["gid://shopify/Product/1"],
    projectionVersion: 2,
    metadataJson: {
      seedMarketplaceOrderId: "order_1",
      allowedShopifyVariantId: "gid://shopify/ProductVariant/1",
      canaryQuantity: 1,
      canaryInventoryQuantity: 1,
      canaryInventoryTracked: true,
      canaryInventoryPolicy: "DENY",
      evidencePackageReference: "secure-evidence:limited-launch-1",
    },
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
            shopifyVariantId: "gid://shopify/ProductVariant/1",
            quantity: 1,
          },
        ],
      },
    ],
    paymentRefundOperations: [],
    refundGuard: null,
    directCustomerRefund: directRefund,
  };
}

function prismaFor({
  storedControl = control(),
  orders = [],
  probe = { status: "AWAITING_PAYOUT_EVIDENCE" },
} = {}) {
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
        return probe;
      },
    },
    seller: {
      async count() {
        return 0;
      },
    },
    product: {
      async count() {
        return 0;
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

function completeMetadata(overrides = {}) {
  return {
    verificationSource: "komoju_zero_balance_limited_launch",
    probeId: "probe_1",
    shopDomain: SHOP,
    shopifyOrderId: "gid://shopify/Order/1",
    marketplaceOrderId: "order_1",
    releaseId: "aaaaaaaaaaaa:app-v1",
    releaseFingerprint: "c".repeat(64),
    saleVerifiedAt: "2026-08-07T00:00:00.000Z",
    completionDeadline: "2026-08-14T00:00:00.000Z",
    actualPaidAmount: 1650,
    currencyCode: "JPY",
    maximumPlannedChargeAmount: 2000,
    companyRefundReserveAmount: 5000,
    maxOrderCount: 2,
    maxGrossAmount: 5000,
    maxOutstandingLiability: 5000,
    allowedProductIds: ["product_1"],
    allowedShopifyProductIds: ["gid://shopify/Product/1"],
    allowedShopifyVariantId: "gid://shopify/ProductVariant/1",
    canaryQuantity: 1,
    canaryInventoryQuantity: 1,
    canaryInventoryTracked: true,
    canaryInventoryPolicy: "DENY",
    allowedProductNames: ["Canary product"],
    komojuPayoutCycle: "WEEKLY",
    expectedBankDepositAt: "2026-08-12T00:00:00.000Z",
    minimumPayoutAmount: 1000,
    estimatedProcessingFeeAmount: 50,
    payoutNotOnHoldConfirmed: true,
    confirmedKomojuUnsettledBalanceAmount: 0,
    zeroUnsettledBalanceConfirmed: true,
    companyRefundReserveConfirmed: true,
    directRefundFallbackConfirmed: true,
    domesticPlatformDirectOnlyConfirmed: true,
    thirdPartyCommerceDisabled: true,
    euEnabledSellerCount: 0,
    euEnabledProductCount: 0,
    internationalEnabledProductCount: 0,
    evidencePackageReference: "secure-evidence:limited-launch-1",
    strictE2eStillRequired: true,
    ...overrides,
  };
}

test("the permanent Shopify baseline is an explicit fail-closed INACTIVE projection", async () => {
  const writes = [];
  const result = await prepareKomojuLimitedLaunchBaseline(
    { shopDomain: SHOP },
    {
      syncProjection: async (input) => {
        writes.push(input);
        return {
          ok: true,
          compareDigest: "baseline-digest",
          projection: input.projection,
        };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].shopDomain, SHOP);
  assert.equal(writes[0].projection.s, "INACTIVE");
  assert.equal(writes[0].projection.v, 2);
  assert.equal(writes[0].projection.r, 1);
  assert.equal(result.sync.compareDigest, "baseline-digest");
});

test("limited launch metadata rejects legacy partial evidence", () => {
  assert.equal(isCompleteKomojuLimitedLaunchMetadata(completeMetadata()), true);
  assert.equal(
    isCompleteKomojuLimitedLaunchMetadata({
      verificationSource: "komoju_zero_balance_limited_launch",
      probeId: "probe_1",
      releaseId: "aaaaaaaaaaaa:app-v1",
      releaseFingerprint: "c".repeat(64),
      maxOrderCount: 2,
      allowedShopifyVariantId: "gid://shopify/ProductVariant/1",
    }),
    false,
  );
  assert.equal(
    isCompleteKomojuLimitedLaunchMetadata(
      completeMetadata({ payoutNotOnHoldConfirmed: false }),
    ),
    false,
  );
});

test("readiness rejects missing, mismatched, and legacy projection evidence", async () => {
  const baseControl = control({
    attestationId: "attestation_1",
    orderCount: 1,
    grossAmount: 1650,
    outstandingLiabilityAmount: 1650,
  });
  const metadata = completeMetadata();
  const attestation = {
    id: "attestation_1",
    status: "CONFIRMED",
    expiresAt: baseControl.expiresAt,
    metadataJson: metadata,
  };
  const probe = {
    id: "probe_1",
    status: "AWAITING_PAYOUT_EVIDENCE",
    releaseId: metadata.releaseId,
    releaseFingerprint: metadata.releaseFingerprint,
    paidVerifiedAt: new Date(metadata.saleVerifiedAt),
    paidEvidenceJson: { passed: true },
    orderEvidenceJson: {
      externalReadiness: { strategy: "ZERO_BALANCE_LIMITED_LAUNCH" },
    },
  };
  const options = {
    now: NOW,
    scope: { ready: true },
    exposure: {
      orderCount: 1,
      grossAmount: 1650,
      outstandingLiabilityAmount: 1650,
      marketplaceOrderIds: ["order_1"],
      disallowedProductOrderIds: [],
      invalidCanaryOrderIds: [],
      directRefundGuardOrderIds: [],
    },
    attestation,
    probe,
    env: {
      RENDER_GIT_COMMIT: "a".repeat(40),
      SHOPIFY_APP_VERSION: "app-v1",
    },
  };

  const missingProjection = await evaluateKomojuLimitedLaunchControl(
    baseControl,
    options,
  );
  assert.equal(missingProjection.ready, false);
  assert.equal(missingProjection.reason, "limited_launch_projection_mismatch");

  const projection = buildKomojuLimitedLaunchProjection(baseControl);
  const mismatchedProjection = await evaluateKomojuLimitedLaunchControl(
    {
      ...baseControl,
      projectionSyncedAt: NOW,
      metadataJson: {
        ...baseControl.metadataJson,
        projectionState: projection.s,
        projectionRevision: projection.r,
        projectionHash: projection.h,
        projectionReadbackHash: "0".repeat(64),
        projectionReadbackRevision: projection.r,
        projectionCompareDigest: "digest-1",
      },
    },
    options,
  );
  assert.equal(mismatchedProjection.ready, false);
  assert.equal(mismatchedProjection.reason, "limited_launch_projection_mismatch");

  const legacyAttestation = await evaluateKomojuLimitedLaunchControl(
    {
      ...baseControl,
      projectionSyncedAt: NOW,
      metadataJson: {
        ...baseControl.metadataJson,
        projectionState: projection.s,
        projectionRevision: projection.r,
        projectionHash: projection.h,
        projectionReadbackHash: projection.h,
        projectionReadbackRevision: projection.r,
        projectionCompareDigest: "digest-1",
      },
    },
    {
      ...options,
      attestation: {
        ...attestation,
        metadataJson: {
          verificationSource: metadata.verificationSource,
          probeId: metadata.probeId,
        },
      },
    },
  );
  assert.equal(legacyAttestation.ready, false);
  assert.equal(
    legacyAttestation.reason,
    "komoju_limited_launch_attestation_mismatch",
  );
});

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
    invalidCanaryOrderIds: [],
    directRefundGuardOrderIds: [],
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
  assert.deepEqual(events, ["projection", "projection", "hold"]);
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
    v: 2,
    s: "ACTIVE",
    r: 2,
    e: "2026-08-14",
    x: "2026-08-14T00:00:00.000Z",
    p: ["gid://shopify/Product/1"],
    q: "gid://shopify/ProductVariant/1",
    m: 2000,
    o: 0,
    g: 2000,
    l: 2500,
    c: "JPY",
    h: projection.h,
  });
});

test("a prepared direct refund immediately blocks the limited launch", async () => {
  const order = paidOrder({ id: "order_1" });
  order.refundGuard = { channel: "DIRECT", status: "RESERVED" };
  const prismaClient = prismaFor({ orders: [order] });
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

  assert.equal(result.control.status, "BLOCKED");
  assert.equal(
    result.blockReason,
    "komoju_limited_launch_direct_refund_detected",
  );
  assert.equal(projections.at(-1).s, "BLOCKED");
  assert.equal(holds.length, 1);
});

test("a release change blocks the active control and applies the emergency hold", async () => {
  const prismaClient = prismaFor({
    storedControl: control({ attestationId: "attestation_1" }),
    orders: [paidOrder({ id: "order_1" })],
    probe: {
      status: "AWAITING_PAYOUT_EVIDENCE",
      releaseId: `${"a".repeat(12)}:app-v1`,
    },
  });
  const projections = [];
  const holds = [];
  const result = await refreshKomojuLimitedLaunchControl(
    { shopDomain: SHOP },
    {
      prismaClient,
      env: {
        RENDER_GIT_COMMIT: "b".repeat(40),
        SHOPIFY_APP_VERSION: "app-v2",
      },
      now: NOW,
      syncProjection: async ({ projection }) => {
        projections.push(projection);
        return { ok: true, compareDigest: "release-block-digest" };
      },
      emergencyHold: async (input) => {
        holds.push(input);
        return { ok: true };
      },
    },
  );

  assert.equal(result.blockReason, "komoju_limited_launch_release_changed");
  assert.equal(prismaClient.current.status, "BLOCKED");
  assert.equal(projections.at(-1).s, "BLOCKED");
  assert.equal(holds.length, 1);
});

test("scope expansion and probe cancellation each block the active control", async () => {
  for (const scenario of [
    {
      env: { PUBLIC_DRAFT_ORDER_CHECKOUT_ENABLED: "true" },
      probe: { status: "AWAITING_PAYOUT_EVIDENCE" },
      expected: "komoju_limited_launch_scope_changed",
    },
    {
      env: {},
      probe: { status: "CANCELLED" },
      expected: "komoju_limited_launch_probe_not_continuing",
    },
  ]) {
    const prismaClient = prismaFor({
      orders: [paidOrder({ id: "order_1" })],
      probe: scenario.probe,
    });
    const result = await refreshKomojuLimitedLaunchControl(
      { shopDomain: SHOP },
      {
        prismaClient,
        env: scenario.env,
        now: NOW,
        syncProjection: async () => ({
          ok: true,
          compareDigest: "scenario-block-digest",
        }),
        emergencyHold: async () => ({ ok: true }),
      },
    );

    assert.equal(result.blockReason, scenario.expected);
    assert.equal(prismaClient.current.status, "BLOCKED");
  }
});

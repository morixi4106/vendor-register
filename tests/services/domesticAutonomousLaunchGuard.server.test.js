import assert from "node:assert/strict";
import test from "node:test";

import { runDomesticAutonomousLaunchGuard } from "../../app/services/domesticAutonomousLaunchGuard.server.js";

const NOW = new Date("2026-09-29T00:00:00.000Z");
const SHOP = "example.myshopify.com";
const FINGERPRINT = "a".repeat(64);

function activeAuthorization() {
  return {
    active: true,
    enabled: true,
    reason: null,
  };
}

function dependencies(overrides = {}) {
  return {
    prismaClient: {},
    env: {
      DOMESTIC_AUTONOMOUS_LAUNCH_MAX_ORDER_AMOUNT: "50000",
      SHOPIFY_PRIMARY_SHOP_DOMAIN: SHOP,
    },
    now: NOW,
    inspectAuthorizationImpl: () => activeAuthorization(),
    inspectCheckoutValidationImpl: async () => ({
      ok: true,
      exists: true,
      prepared: true,
      active: false,
    }),
    buildReleaseExpectationImpl: () => ({ configured: true }),
    getProbePageDataImpl: async () => ({
      available: true,
      release: { configured: true, releaseFingerprint: FINGERPRINT },
      activeProbe: null,
      recentProbes: [],
    }),
    inspectPreflightImpl: async () => ({ canStart: true }),
    createProbeImpl: async (input) => ({
      ok: true,
      probe: {
        id: "probe_1",
        status: "AWAITING_ORDER",
        releaseFingerprint: FINGERPRINT,
        maximumPlannedChargeAmount: input.maximumPlannedChargeAmount,
      },
    }),
    attachOrderImpl: async () => assert.fail("order attach was not expected"),
    refreshProbeImpl: async () => assert.fail("refresh was not expected"),
    applyEmergencyHoldImpl: async () => ({ ok: true }),
    inspectDomesticScopeImpl: async () => ({
      ready: true,
      thirdPartyCommerceDisabled: true,
      euEnabledSellerCount: 0,
      euEnabledProductCount: 0,
      internationalEnabledProductCount: 0,
    }),
    ...overrides,
  };
}

test("monitor run arms the first-order probe with the configured ceiling", async () => {
  let createInput = null;
  const result = await runDomesticAutonomousLaunchGuard(
    { shopDomain: SHOP },
    dependencies({
      createProbeImpl: async (input) => {
        createInput = input;
        return {
          ok: true,
          probe: {
            id: "probe_1",
            status: "AWAITING_ORDER",
            releaseFingerprint: FINGERPRINT,
          },
        };
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.armed, true);
  assert.equal(createInput.maximumPlannedChargeAmount, 50_000);
  assert.equal(createInput.startedBy, "domestic-autonomous-launch-guard");
  assert.equal(createInput.targetProvider, "AUTODETECT");
  assert.equal(createInput.targetPaymentMethod, "AUTODETECT");
  assert.equal(createInput.komojuLiveConfirmed, undefined);
  assert.equal(createInput.singleCardIntegrationConfirmed, undefined);
  assert.equal(createInput.automaticCaptureConfirmed, undefined);
});

test("an enabled but expired authorization applies the emergency hold", async () => {
  let holdReason = null;
  const result = await runDomesticAutonomousLaunchGuard(
    { shopDomain: SHOP },
    dependencies({
      inspectAuthorizationImpl: () => ({
        active: false,
        enabled: true,
        reason: "authorization_expired_or_not_started",
      }),
      applyEmergencyHoldImpl: async ({ reason }) => {
        holdReason = reason;
        return { ok: true };
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.secured, true);
  assert.match(holdReason, /authorization_expired_or_not_started/);
});

test("a paid order cannot arrive before the probe is armed", async () => {
  const result = await runDomesticAutonomousLaunchGuard(
    { shopDomain: SHOP, orderReference: "gid://shopify/Order/1" },
    dependencies(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.secured, true);
  assert.equal(result.reason, "probe_not_armed_before_order");
});

test("the armed probe attaches and verifies the first paid order", async () => {
  const activeProbe = {
    id: "probe_1",
    status: "AWAITING_ORDER",
    releaseFingerprint: FINGERPRINT,
    shopifyOrderId: null,
    startedAt: new Date("2026-09-28T23:50:00.000Z"),
  };
  let attachedOrder = null;
  const result = await runDomesticAutonomousLaunchGuard(
    { shopDomain: SHOP, orderReference: "gid://shopify/Order/1" },
    dependencies({
      getProbePageDataImpl: async () => ({
        available: true,
        release: { configured: true, releaseFingerprint: FINGERPRINT },
        activeProbe,
        recentProbes: [activeProbe],
      }),
      attachOrderImpl: async (input) => {
        attachedOrder = input.orderReference;
        return {
          ok: true,
          probe: {
            ...activeProbe,
            status: "AWAITING_SETTLEMENT",
            shopifyOrderId: input.orderReference,
            orderAttachedAt: NOW,
          },
        };
      },
      refreshProbeImpl: async () => ({
        ok: true,
        pending: false,
        probe: { id: "probe_1", status: "PASSED" },
      }),
    }),
  );

  assert.equal(attachedOrder, "gid://shopify/Order/1");
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
});

test("a second paid order is rejected while the first order is pending", async () => {
  const activeProbe = {
    id: "probe_1",
    status: "AWAITING_SETTLEMENT",
    releaseFingerprint: FINGERPRINT,
    shopifyOrderId: "gid://shopify/Order/1",
    orderAttachedAt: NOW,
  };
  let holdReason = null;
  const result = await runDomesticAutonomousLaunchGuard(
    { shopDomain: SHOP, orderReference: "gid://shopify/Order/2" },
    dependencies({
      getProbePageDataImpl: async () => ({
        available: true,
        release: { configured: true, releaseFingerprint: FINGERPRINT },
        activeProbe,
        recentProbes: [activeProbe],
      }),
      applyEmergencyHoldImpl: async ({ reason }) => {
        holdReason = reason;
        return { ok: true };
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.secured, true);
  assert.equal(result.reason, "unexpected_additional_order");
  assert.match(holdReason, /unexpected_additional_order/);
});

test("settlement lag is tolerated briefly and then fails closed", async () => {
  const probe = {
    id: "probe_1",
    status: "AWAITING_SETTLEMENT",
    releaseFingerprint: FINGERPRINT,
    shopifyOrderId: "gid://shopify/Order/1",
    orderAttachedAt: new Date("2026-09-28T23:30:00.000Z"),
    lastErrorCode: "seller_order_missing",
  };
  const base = dependencies({
    getProbePageDataImpl: async () => ({
      available: true,
      release: { configured: true, releaseFingerprint: FINGERPRINT },
      activeProbe: probe,
      recentProbes: [probe],
    }),
    refreshProbeImpl: async () => ({
      ok: true,
      pending: true,
      probe,
    }),
  });
  const timedOut = await runDomesticAutonomousLaunchGuard(
    { shopDomain: SHOP },
    base,
  );
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.secured, true);
  assert.equal(timedOut.reason, "seller_order_missing");

  const pending = await runDomesticAutonomousLaunchGuard(
    { shopDomain: SHOP },
    {
      ...base,
      now: new Date("2026-09-28T23:40:00.000Z"),
    },
  );
  assert.equal(pending.ok, true);
  assert.equal(pending.pending, true);
});

test("a current passed probe is reused without another order", async () => {
  const passed = {
    id: "probe_passed",
    status: "PASSED",
    releaseFingerprint: FINGERPRINT,
  };
  const result = await runDomesticAutonomousLaunchGuard(
    { shopDomain: SHOP },
    dependencies({
      getProbePageDataImpl: async () => ({
        available: true,
        release: { configured: true, releaseFingerprint: FINGERPRINT },
        activeProbe: null,
        recentProbes: [passed],
      }),
      createProbeImpl: async () => assert.fail("probe must not be recreated"),
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.probeId, "probe_passed");
});

test("webhooks from a non-primary shop are ignored", async () => {
  let holdCalls = 0;
  const result = await runDomesticAutonomousLaunchGuard(
    { shopDomain: "old-dev.myshopify.com" },
    dependencies({
      applyEmergencyHoldImpl: async () => {
        holdCalls += 1;
        return { ok: true };
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.active, false);
  assert.equal(result.reason, "non_primary_shop_ignored");
  assert.equal(holdCalls, 0);
});

test("an enabled launch without a primary shop fails closed", async () => {
  const result = await runDomesticAutonomousLaunchGuard(
    { shopDomain: SHOP },
    dependencies({
      env: { DOMESTIC_AUTONOMOUS_LAUNCH_MAX_ORDER_AMOUNT: "50000" },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.secured, true);
  assert.equal(result.reason, "primary_shop_domain_missing");
});

test("the launch fails closed when domestic-only scope is no longer true", async () => {
  const result = await runDomesticAutonomousLaunchGuard(
    { shopDomain: SHOP },
    dependencies({
      inspectDomesticScopeImpl: async () => ({
        ready: false,
        thirdPartyCommerceDisabled: true,
        euEnabledSellerCount: 0,
        euEnabledProductCount: 0,
        internationalEnabledProductCount: 1,
      }),
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.secured, true);
  assert.equal(result.reason, "domestic_launch_scope_invalid");
});

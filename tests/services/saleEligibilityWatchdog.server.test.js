import assert from "node:assert/strict";
import test from "node:test";

import {
  enforceCatalogSyncSaleEligibilityFailSafe,
  inspectShopifyControlCapability,
  SALE_ELIGIBILITY_WATCHDOG,
} from "../../app/services/saleEligibilityWatchdog.server.js";

function prismaWithControl(control = null) {
  return {
    platformOperationalControl: {
      findUnique: async () => control,
    },
  };
}

const healthyCapability = async () => ({ ok: true, failures: [] });

test("watchdog does nothing while catalog freshness is healthy", async () => {
  let holdCalls = 0;
  const result = await enforceCatalogSyncSaleEligibilityFailSafe({
    prismaClient: prismaWithControl(),
    inspectFreshness: async () => ({
      status: "healthy",
      reason: null,
    }),
    inspectCapability: healthyCapability,
    applyEmergencyHold: async () => {
      holdCalls += 1;
      return { ok: true };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "none");
  assert.equal(result.protected, false);
  assert.equal(holdCalls, 0);
});

test("watchdog applies the platform emergency hold for critical staleness", async () => {
  const calls = [];
  const now = new Date("2026-07-24T12:00:00.000Z");
  const result = await enforceCatalogSyncSaleEligibilityFailSafe({
    prismaClient: prismaWithControl({
      checkoutHold: false,
      checkoutControlState: "IDLE",
    }),
    now,
    env: { SHOPIFY_PRIMARY_SHOP_DOMAIN: "example.myshopify.com" },
    inspectFreshness: async () => ({
      status: "critical",
      reason: "catalog_sync_critical_stale",
      ageMinutes: 181,
      criticalMinutes: 180,
    }),
    inspectCapability: healthyCapability,
    applyEmergencyHold: async (input, options) => {
      calls.push({ input, options });
      return {
        ok: true,
        control: { checkoutControlState: "ACTIVE" },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.protected, true);
  assert.equal(result.action, "emergency_hold_applied");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.changedBy, SALE_ELIGIBILITY_WATCHDOG.actor);
  assert.equal(calls[0].input.shopDomain, "example.myshopify.com");
  assert.match(calls[0].input.reason, /ageMinutes=181/);
  assert.equal(calls[0].options.now, now);
});

test("watchdog does not repeat work while purchase protection is active", async () => {
  let holdCalls = 0;
  const result = await enforceCatalogSyncSaleEligibilityFailSafe({
    prismaClient: prismaWithControl({
      checkoutHold: true,
      checkoutControlState: "PARTIAL_FAILURE",
    }),
    inspectFreshness: async () => ({
      status: "critical",
      reason: "catalog_sync_success_missing",
      ageMinutes: null,
      criticalMinutes: 180,
    }),
    inspectCapability: healthyCapability,
    applyEmergencyHold: async () => {
      holdCalls += 1;
      return { ok: false };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.protected, true);
  assert.equal(result.action, "already_protected");
  assert.equal(holdCalls, 0);
});

test("watchdog reports a protection failure without auto-recovery", async () => {
  const result = await enforceCatalogSyncSaleEligibilityFailSafe({
    prismaClient: prismaWithControl({
      checkoutHold: false,
      checkoutControlState: "IDLE",
    }),
    inspectFreshness: async () => ({
      status: "critical",
      reason: "catalog_sync_timing_policy_invalid",
      ageMinutes: 10,
      criticalMinutes: 5,
    }),
    inspectCapability: healthyCapability,
    applyEmergencyHold: async () => ({
      ok: false,
      reason: "publication_boundary_partial_failure",
      failureCount: 2,
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, "emergency_hold_failed");
  assert.equal(result.failureCount, 2);
  assert.equal(result.reason, "publication_boundary_partial_failure");
});

test("control capability loss requests independent protection immediately", async () => {
  let holdCalls = 0;
  const result = await enforceCatalogSyncSaleEligibilityFailSafe({
    prismaClient: prismaWithControl({
      checkoutHold: false,
      checkoutControlState: "IDLE",
    }),
    inspectCapability: async () => ({
      ok: false,
      code: "shopify_control_capability_lost",
      failures: ["shopify_offline_session_missing"],
      shopDomain: "example.myshopify.com",
    }),
    inspectFreshness: async () => {
      throw new Error("freshness must not mask capability loss");
    },
    applyEmergencyHold: async () => {
      holdCalls += 1;
      return { ok: true };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "critical");
  assert.equal(result.protected, false);
  assert.equal(result.requiresExternalProtection, true);
  assert.equal(result.reason, "shopify_control_capability_lost");
  assert.equal(holdCalls, 1);
});

test("capability inspection fails for an expired offline session and disabled validation", async () => {
  const result = await inspectShopifyControlCapability({
    prismaClient: {
      platformOperationalControl: {
        findUnique: async () => ({
          checkoutHold: false,
          checkoutControlState: "IDLE",
        }),
      },
      operationalHeartbeat: {
        findUnique: async () => null,
      },
      session: {
        findFirst: async () => ({
          scope: [
            "read_orders",
            "read_products",
            "read_publications",
            "write_publications",
            "read_validations",
            "write_validations",
            "read_merchant_managed_fulfillment_orders",
            "write_merchant_managed_fulfillment_orders",
          ].join(","),
          expires: new Date("2026-07-23T00:00:00.000Z"),
        }),
      },
    },
    now: new Date("2026-07-24T00:00:00.000Z"),
    env: { SHOPIFY_PRIMARY_SHOP_DOMAIN: "example.myshopify.com" },
    inspectValidation: async () => ({
      ok: true,
      active: false,
      validationCount: 1,
      runtimeErrorDetected: false,
      reason: "validation_disabled",
    }),
  });

  assert.equal(result.ok, false);
  assert.ok(result.failures.includes("shopify_offline_session_missing"));
  assert.ok(
    result.failures.includes("shopify_checkout_validation_unavailable"),
  );
});

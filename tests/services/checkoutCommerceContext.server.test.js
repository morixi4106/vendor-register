import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCheckoutCommerceContext,
  buildCheckoutCommerceScopeCheck,
  inspectCheckoutCommerceContext,
} from "../../app/services/checkoutCommerceContext.server.js";
import {
  inspectOperationalReadiness,
  LIVE_ORDER_REFUND_E2E_CHECK_KEY,
  SHOPIFY_PAYMENTS_PAYOUT_CHECK_KEY,
} from "../../app/services/operationalReadiness.server.js";
import { includeCheckoutValidationInProductionReadiness } from "../../app/services/productionReadiness/checkoutControls.server.js";
import { buildOperationalReadinessChecks } from "../../app/services/operationalReadinessChecks.js";
import { DOMESTIC_AUTONOMOUS_LAUNCH_AUTHORIZATION } from "../../app/services/domesticAutonomousLaunchAuthorization.js";
import { domesticShippingProfiles } from "../fixtures/checkoutCommerceContext.js";

const standardEnv = {
  PLATFORM_DIRECT_CHECKOUT_MODE: "SHOPIFY_STANDARD_DIRECT",
  PAYMENT_PROVIDERS: "komoju",
};
const now = new Date("2026-10-15T10:00:00Z");

test("known domestic scope alone permits standard direct checkout", () => {
  const { mode } = buildCheckoutCommerceContext(
    domesticShippingProfiles,
    standardEnv,
  );
  assert.equal(mode.standardDirectReady, true);
  assert.equal(buildCheckoutCommerceScopeCheck(mode).status, "pass");
});

test("stored international country policies cannot look domestic just because air packet is disabled", async () => {
  const context = await inspectCheckoutCommerceContext({
    env: standardEnv,
    prismaClient: {
      product: {
        findMany: async ({ where }) => {
          assert.equal(where.approvalStatus, "approved");
          assert.equal(where.vendorStore.is.isTestStore, false);
          return [
            {
              id: "product_1",
              internationalShippingMethod: "NONE",
              countryPolicy: { allowedCountries: ["JP", "US"] },
            },
          ];
        },
      },
      internationalShippingCountryAvailability: { findMany: async () => [] },
    },
  });
  assert.equal(context.shippingProfiles.airPacketCount, 0);
  assert.equal(context.mode.reason, "international_sales_require_validation");
});

test("each international configuration independently rejects domestic standard checkout", () => {
  for (const profile of [
    { ...domesticShippingProfiles, airPacketCount: 1 },
    {
      ...domesticShippingProfiles,
      serviceAvailability: {
        ...domesticShippingProfiles.serviceAvailability,
        activeCount: 1,
      },
    },
    {
      ...domesticShippingProfiles,
      serviceAvailability: {
        ...domesticShippingProfiles.serviceAvailability,
        requiredCountryCount: 1,
      },
    },
  ]) {
    const standard = buildCheckoutCommerceContext(profile, standardEnv).mode;
    assert.equal(standard.standardDirectReady, false);
    assert.equal(standard.reason, "international_sales_require_validation");
    assert.equal(buildCheckoutCommerceScopeCheck(standard).status, "fail");
    const validated = buildCheckoutCommerceContext(profile, {
      PAYMENT_PROVIDERS: "komoju",
    }).mode;
    assert.equal(validated.reason, null);
    assert.equal(validated.standardDirectReady, false);
    assert.equal(buildCheckoutCommerceScopeCheck(validated).status, "pass");
  }
});

test("missing tables, invalid counts and failed inspection cannot assume domestic scope", async () => {
  for (const profile of [
    null,
    { available: false },
    { ...domesticShippingProfiles, airPacketCount: undefined },
    { ...domesticShippingProfiles, airPacketCount: -1 },
    { ...domesticShippingProfiles, airPacketCount: "0" },
  ]) {
    assert.equal(
      buildCheckoutCommerceContext(profile, standardEnv).mode.reason,
      "checkout_scope_unverified",
    );
  }
  const context = await inspectCheckoutCommerceContext({
    env: standardEnv,
    inspectShippingProfilesImpl: async () => {
      throw new Error("database detail");
    },
  });
  assert.equal(context.mode.reason, "checkout_scope_unverified");
  assert.ok(!JSON.stringify(context).includes("database detail"));
});

test("international KOMOJU direct retains strict proof without unused Shopify Payments requirements", async () => {
  const env = { PAYMENT_PROVIDERS: "komoju" };
  const checkoutContext = buildCheckoutCommerceContext(
    { ...domesticShippingProfiles, airPacketCount: 1 },
    env,
  );
  const inspection = await inspectOperationalReadiness({
    env,
    checkoutContext,
    prismaClient: {
      operationalReadinessAttestation: { findMany: async () => [] },
    },
  });
  for (const key of [
    "SHOPIFY_PAYMENTS_LIVE_CONFIRMED",
    SHOPIFY_PAYMENTS_PAYOUT_CHECK_KEY,
  ]) {
    const row = inspection.rows.find((row) => row.definition.key === key);
    assert.ok(row, key);
    assert.equal(row.definition.supplemental, true, key);
  }
  assert.notEqual(
    inspection.rows.find(
      (row) => row.definition.key === LIVE_ORDER_REFUND_E2E_CHECK_KEY,
    ).definition.supplemental,
    true,
  );
  assert.notEqual(
    inspection.rows.find(
      (row) =>
        row.definition.key === "CHECKOUT_VALIDATION_LIVE_PROBE_COMPLETED",
    ).definition.supplemental,
    true,
  );
});

test("domestic risk acceptance is not inherited by international or unverified scope", () => {
  const env = {
    ...standardEnv,
    DOMESTIC_AUTONOMOUS_LAUNCH_ENABLED: "true",
    DOMESTIC_AUTONOMOUS_LAUNCH_AUTHORIZATION,
    DOMESTIC_AUTONOMOUS_LAUNCH_SCOPE: "DOMESTIC_PLATFORM_DIRECT_ONLY",
    DOMESTIC_AUTONOMOUS_LAUNCH_AUTHORIZED_AT: "2026-09-29T00:00:00Z",
    DOMESTIC_AUTONOMOUS_LAUNCH_EXPIRES_AT: "2026-12-28T00:00:00Z",
    PRODUCTION_INTEGRITY_MONITOR_ENABLED: "true",
  };
  for (const profile of [
    { available: false },
    { ...domesticShippingProfiles, airPacketCount: 1 },
  ]) {
    const check = buildOperationalReadinessChecks({
      env,
      now,
      inspection: {
        checkoutMode: buildCheckoutCommerceContext(profile, env).mode,
        rows: [
          {
            definition: { key: "LEGAL_DISCLOSURES_REVIEWED" },
            ready: false,
            reason: "missing",
          },
        ],
      },
    })[0];
    assert.equal(check.status, "fail");
    assert.notEqual(check.releaseBlocking, false);
  }
});

test("readiness requires active validation for overseas and scope checks are idempotent", () => {
  const checkoutMode = buildCheckoutCommerceContext(
    { ...domesticShippingProfiles, airPacketCount: 1 },
    standardEnv,
  ).mode;
  const initial = { operationalReadiness: { checkoutMode }, checks: [] };
  const validation = { ok: true, exists: true, prepared: true, active: false };
  const once = includeCheckoutValidationInProductionReadiness(
    initial,
    validation,
    standardEnv,
  );
  const twice = includeCheckoutValidationInProductionReadiness(
    once,
    validation,
    standardEnv,
  );
  assert.equal(
    twice.checks.filter(
      (check) => check.id === "platform_direct_checkout_scope",
    ).length,
    1,
  );
  assert.equal(
    twice.checks.find(
      (check) => check.id === "marketplace_checkout_server_validation",
    ).status,
    "fail",
  );
  assert.equal(twice.canGoLive, false);
});

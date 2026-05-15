import assert from "node:assert/strict";
import test from "node:test";

import { inspectStripeEnvironment } from "../../app/services/productionReadiness.server.js";

test("inspectStripeEnvironment detects live Stripe keys", () => {
  const result = inspectStripeEnvironment({
    STRIPE_SECRET_KEY: "sk_live_123",
    STRIPE_PUBLISHABLE_KEY: "pk_live_123",
    STRIPE_WEBHOOK_SECRET: "whsec_platform",
    STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect",
    STRIPE_PLATFORM_FEE_BPS: "1000",
  });

  assert.equal(result.secretKeyMode, "live");
  assert.equal(result.publishableKeyMode, "live");
  assert.equal(result.isLive, true);
  assert.equal(result.modesMatch, true);
  assert.equal(result.platformFeeBpsValid, true);
});

test("inspectStripeEnvironment detects test/live mode mismatch", () => {
  const result = inspectStripeEnvironment({
    STRIPE_SECRET_KEY: "sk_test_123",
    STRIPE_PUBLISHABLE_KEY: "pk_live_123",
    STRIPE_PLATFORM_FEE_BPS: "1000",
  });

  assert.equal(result.secretKeyMode, "test");
  assert.equal(result.publishableKeyMode, "live");
  assert.equal(result.isLive, false);
  assert.equal(result.isTest, true);
  assert.equal(result.modesMatch, false);
});

test("inspectStripeEnvironment rejects invalid fee bps", () => {
  const result = inspectStripeEnvironment({
    STRIPE_SECRET_KEY: "sk_live_123",
    STRIPE_PUBLISHABLE_KEY: "pk_live_123",
    STRIPE_PLATFORM_FEE_BPS: "10001",
  });

  assert.equal(result.platformFeeBpsValid, false);
});

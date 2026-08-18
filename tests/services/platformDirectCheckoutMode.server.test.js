import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectPlatformDirectCheckoutMode,
  PLATFORM_DIRECT_CHECKOUT_MODE,
} from "../../app/services/platformDirectCheckoutMode.server.js";

test("standard direct mode is enabled only while every third-party commerce flag is off", () => {
  const ready = inspectPlatformDirectCheckoutMode({
    PLATFORM_DIRECT_CHECKOUT_MODE: "SHOPIFY_STANDARD_DIRECT",
  });

  assert.equal(ready.standardDirectReady, true);
  assert.equal(
    ready.effectiveMode,
    PLATFORM_DIRECT_CHECKOUT_MODE.SHOPIFY_STANDARD_DIRECT,
  );
  assert.deepEqual(ready.enabledThirdPartyFlags, []);

  const blocked = inspectPlatformDirectCheckoutMode({
    PLATFORM_DIRECT_CHECKOUT_MODE: "SHOPIFY_STANDARD_DIRECT",
    MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED: "true",
  });

  assert.equal(blocked.standardDirectReady, false);
  assert.equal(
    blocked.effectiveMode,
    PLATFORM_DIRECT_CHECKOUT_MODE.MARKETPLACE_VALIDATED,
  );
  assert.deepEqual(blocked.enabledThirdPartyFlags, [
    "MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED",
  ]);
  assert.equal(blocked.reason, "third_party_commerce_must_be_disabled");
});

test("unknown or missing mode preserves the strict marketplace behavior", () => {
  assert.equal(
    inspectPlatformDirectCheckoutMode({}).effectiveMode,
    PLATFORM_DIRECT_CHECKOUT_MODE.MARKETPLACE_VALIDATED,
  );
  assert.equal(
    inspectPlatformDirectCheckoutMode({
      PLATFORM_DIRECT_CHECKOUT_MODE: "unexpected",
    }).standardDirectRequested,
    false,
  );
});

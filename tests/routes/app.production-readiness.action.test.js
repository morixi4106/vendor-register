import assert from "node:assert/strict";
import test from "node:test";
import { loadRouteHandler } from "../helpers/loadRouteHandler.js";
import { resolveProductionReadinessOperatorRole } from "../../app/utils/marketplaceOperatorRoles.js";
import { buildCheckoutCommerceContext } from "../../app/services/checkoutCommerceContext.server.js";
import { domesticShippingProfiles, domesticNativeScope } from "../fixtures/checkoutCommerceContext.js";

test("validation disabling requires known domestic scope before calling Shopify", async () => {
  for (const [profile, native, expectedStatus] of [
    [domesticShippingProfiles, domesticNativeScope, 200],
    [domesticShippingProfiles, { ...domesticNativeScope, internationalConfigured: true }, 409],
    [domesticShippingProfiles, { available: false }, 409],
    [{ ...domesticShippingProfiles, airPacketCount: 1 }, domesticNativeScope, 409],
    [{ available: false }, domesticNativeScope, 409],
  ]) {
    const calls = [];
    const mode = buildCheckoutCommerceContext(profile, {
      PLATFORM_DIRECT_CHECKOUT_MODE: "SHOPIFY_STANDARD_DIRECT",
    }, native).mode;
    const action = loadRouteHandler(
      new URL("../../app/routes/app.production-readiness.jsx", import.meta.url),
      "action",
      {
        resolveProductionReadinessOperatorRole,
        requireMarketplaceOperator: async () => {
          calls.push("authorize");
          return {
            session: { shop: "example.myshopify.com" },
            operator: { actorKey: "shopify_user:123" },
          };
        },
        loadModule: async (name) => {
          if (name === "../services/checkoutCommerceContext.server.js")
            return { inspectCheckoutCommerceContext: async ({ shopDomain }) => {
              assert.equal(shopDomain, "example.myshopify.com");
              return { mode };
            } };
          assert.equal(name, "../services/shopifyCheckoutValidation.server.js");
          return {
            ensureMarketplaceCheckoutValidation: async (_shop, options) => {
              calls.push(options);
              return { ok: true };
            },
          };
        },
      },
    );
    const response = await action({
      request: new Request("https://example.test", {
        method: "POST",
        body: new URLSearchParams({
          intent: "disable_checkout_validation_for_standard_direct",
        }),
      }),
    });
    assert.equal(response.status, expectedStatus);
    assert.deepEqual(
      calls,
      expectedStatus === 200
        ? ["authorize", { enabled: false }]
        : ["authorize"],
    );
  }
});

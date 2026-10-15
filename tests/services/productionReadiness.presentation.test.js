import assert from "node:assert/strict";
import test from "node:test";

import { buildShopifyReadiness } from "../../app/services/productionReadiness/shopify.server.js";

function fixture(productShippingProfiles) {
  return {
    configuredScopes: ["read_orders"],
    grantedScopes: ["read_orders"],
    normalizedShopDomain: "example.myshopify.com",
    targetOfflineSession: { id: "offline-session", accessToken: "private-token" },
    shopifyProductSync: { available: true, unresolvedCount: 0 },
    productShippingProfiles,
    sessions: [{ shop: "example.myshopify.com", accessToken: "private-token" }, { shop: "" }],
  };
}

test("the Shopify summary preserves existing fields and exposes only aggregate shipping data", () => {
  const result = buildShopifyReadiness(fixture({
    available: true,
    airPacketCount: 2,
    serviceAvailability: { requiredCountryCount: 3 },
    privateAddress: "private-address",
  }));
  assert.deepEqual(result, {
    configuredScopes: ["read_orders"],
    grantedScopes: ["read_orders"],
    evaluatedShopDomain: "example.myshopify.com",
    offlineSessionFound: true,
    productSync: { available: true, unresolvedCount: 0 },
    productShipping: { available: true, internationalProductCount: 2, requiredCountryCount: 3 },
    offlineSessionShops: ["example.myshopify.com"],
  });
  assert.ok(!JSON.stringify(result).includes("private-"));
});

test("missing shipping counts remain unknown rather than becoming verified zero counts", () => {
  const result = buildShopifyReadiness(fixture({ available: false }));
  assert.deepEqual(result.productShipping, { available: false, internationalProductCount: null, requiredCountryCount: null });
});

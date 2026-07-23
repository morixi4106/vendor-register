import assert from "node:assert/strict";
import test from "node:test";

import { runShopifyProductCatalogSyncAgent } from "../../scripts/shopify-product-catalog-sync-agent.mjs";

const TOKEN = "catalog-sync-test-token-with-at-least-32-characters";

test("catalog sync agent sends one authenticated bounded request", async () => {
  let request = null;
  const result = await runShopifyProductCatalogSyncAgent({
    env: {
      APP_URL: "https://app.example.com",
      SHOPIFY_PRODUCT_CATALOG_SYNC_TOKEN: TOKEN,
    },
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return jsonResponse({
        ok: true,
        result: { scanned: 10, updated: 2, unresolved: 0 },
        checkoutPolicies: { failedCount: 0 },
      });
    },
  });

  assert.equal(
    request.url,
    "https://app.example.com/internal/shopify-product-catalog-sync",
  );
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(String(request.options.body), "limit=250");
  assert.deepEqual(result, {
    scanned: 10,
    updated: 2,
    unresolved: 0,
    failed: 0,
  });
});

test("catalog sync agent rejects missing or weak credentials", async () => {
  await assert.rejects(
    runShopifyProductCatalogSyncAgent({
      env: { APP_URL: "https://app.example.com" },
    }),
    /catalog_sync_token_invalid/,
  );
});

test("catalog sync agent fails when synchronization is incomplete", async () => {
  await assert.rejects(
    runShopifyProductCatalogSyncAgent({
      env: {
        APP_URL: "https://app.example.com",
        SHOPIFY_PRODUCT_CATALOG_SYNC_TOKEN: TOKEN,
      },
      fetchImpl: async () =>
        jsonResponse({
          ok: true,
          result: { scanned: 10, updated: 0, unresolved: 1 },
          checkoutPolicies: { failedCount: 0 },
        }),
    }),
    /catalog_sync_incomplete/,
  );
});

test("catalog sync agent rejects non-JSON and unsuccessful responses", async () => {
  await assert.rejects(
    runShopifyProductCatalogSyncAgent({
      env: {
        APP_URL: "https://app.example.com",
        SHOPIFY_PRODUCT_CATALOG_SYNC_TOKEN: TOKEN,
      },
      fetchImpl: async () =>
        new Response("Unauthorized", {
          status: 401,
          headers: { "Content-Type": "text/plain" },
        }),
    }),
    /catalog_sync_invalid_response/,
  );
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

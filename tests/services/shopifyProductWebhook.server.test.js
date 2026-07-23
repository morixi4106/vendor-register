import assert from "node:assert/strict";
import test from "node:test";

import { processShopifyProductWebhook } from "../../app/services/shopifyProductWebhook.server.js";

const payload = {
  id: 123,
  admin_graphql_api_id: "gid://shopify/Product/123",
  title: "商品",
  vendor: "store",
  variants: [
    {
      id: 456,
      admin_graphql_api_id: "gid://shopify/ProductVariant/456",
      price: "1000",
    },
  ],
};

test("successful product webhooks synchronize the checkout policy", async () => {
  const calls = [];
  const result = await processShopifyProductWebhook(
    {
      payload,
      topic: "PRODUCTS_UPDATE",
      shop: "shop.myshopify.com",
    },
    {
      syncPayload: async () => ({
        ok: true,
        product: { id: "product_1", vendorStoreId: "store_1" },
      }),
      syncPolicy: async (input) => {
        calls.push(input);
        return { ok: true, changed: false };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.deferred, false);
  assert.deepEqual(calls, [
    {
      localProductId: "product_1",
      shopDomain: "shop.myshopify.com",
    },
  ]);
});

test("policy API failures are persisted and acknowledged for scheduled recovery", async () => {
  const failures = [];
  const heartbeats = [];
  const result = await processShopifyProductWebhook(
    {
      payload,
      topic: "PRODUCTS_UPDATE",
      shop: "shop.myshopify.com",
    },
    {
      syncPayload: async () => ({
        ok: true,
        product: { id: "product_1", vendorStoreId: "store_1" },
      }),
      syncPolicy: async () => {
        throw new Error("GraphqlQueryError: Throttled");
      },
      recordPolicyFailure: async (input) => {
        failures.push(input);
      },
      recordHeartbeat: async (input) => {
        heartbeats.push(input);
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.deferred, true);
  assert.equal(result.reason, "marketplace_checkout_policy_sync_failed");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].localProductId, "product_1");
  assert.equal(failures[0].vendorStoreId, "store_1");
  assert.equal(heartbeats.length, 1);
  assert.equal(heartbeats[0].status, "failed");
  assert.equal(
    heartbeats[0].errorCode,
    "marketplace_checkout_policy_sync_failed",
  );
});

test("a policy failure marker must be durable before the webhook is acknowledged", async () => {
  await assert.rejects(
    processShopifyProductWebhook(
      {
        payload,
        topic: "PRODUCTS_UPDATE",
        shop: "shop.myshopify.com",
      },
      {
        syncPayload: async () => ({
          ok: true,
          product: { id: "product_1", vendorStoreId: "store_1" },
        }),
        syncPolicy: async () => {
          throw new Error("GraphqlQueryError: Throttled");
        },
        recordPolicyFailure: async () => {
          throw new Error("database unavailable");
        },
      },
    ),
    /database unavailable/,
  );
});

test("unresolved products keep their existing issue and absorb boundary throttling", async () => {
  const heartbeats = [];
  const result = await processShopifyProductWebhook(
    {
      payload,
      topic: "PRODUCTS_CREATE",
      shop: "shop.myshopify.com",
    },
    {
      syncPayload: async () => ({
        ok: false,
        reason: "vendor_label_not_found",
      }),
      enforceUnresolvedBoundary: async () => {
        throw new Error("GraphqlQueryError: Throttled");
      },
      recordHeartbeat: async (input) => {
        heartbeats.push(input);
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.deferred, true);
  assert.equal(result.reason, "unresolved_product_boundary_failed");
  assert.equal(heartbeats.length, 1);
  assert.equal(heartbeats[0].status, "failed");
});

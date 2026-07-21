import assert from "node:assert/strict";
import test from "node:test";

import {
  syncAndRecordShopifyVariantWeight,
  syncShopifyVariantWeight,
} from "../../app/services/shopifyInventoryWeight.server.js";

test("syncShopifyVariantWeight resolves the inventory item and writes grams", async () => {
  const calls = [];
  const graphQL = async (request) => {
    calls.push(request);
    if (request.query.includes("ProductVariantInventoryItem")) {
      return {
        data: {
          productVariant: {
            inventoryItem: { id: "gid://shopify/InventoryItem/1" },
          },
        },
      };
    }
    return {
      data: {
        inventoryItemUpdate: {
          inventoryItem: { id: "gid://shopify/InventoryItem/1" },
          userErrors: [],
        },
      },
    };
  };

  const result = await syncShopifyVariantWeight({
    shopDomain: "example.myshopify.com",
    variantId: "gid://shopify/ProductVariant/1",
    weightGrams: 350,
    graphQL,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].variables.input, {
    requiresShipping: true,
    measurement: {
      weight: {
        value: 350,
        unit: "GRAMS",
      },
    },
  });
});

test("syncShopifyVariantWeight surfaces Shopify user errors", async () => {
  await assert.rejects(
    syncShopifyVariantWeight({
      shopDomain: "example.myshopify.com",
      variantId: "gid://shopify/ProductVariant/1",
      inventoryItemId: "gid://shopify/InventoryItem/1",
      weightGrams: 350,
      graphQL: async () => ({
        data: {
          inventoryItemUpdate: {
            inventoryItem: null,
            userErrors: [{ field: ["measurement"], message: "invalid" }],
          },
        },
      }),
    }),
    /inventoryItemUpdate userErrors/,
  );
});

test("syncAndRecordShopifyVariantWeight records timeout failures for readiness checks", async () => {
  const updates = [];
  const prismaClient = {
    product: {
      update: async (args) => {
        updates.push(args);
        return args.data;
      },
    },
  };

  await assert.rejects(
    syncAndRecordShopifyVariantWeight({
      productId: "product_1",
      shopDomain: "example.myshopify.com",
      variantId: "gid://shopify/ProductVariant/1",
      inventoryItemId: "gid://shopify/InventoryItem/1",
      weightGrams: 350,
      prismaClient,
      graphQL: async () => {
        throw new Error("Shopify request timed out");
      },
    }),
    /timed out/,
  );

  assert.equal(updates.length, 1);
  assert.equal(updates[0].where.id, "product_1");
  assert.equal(updates[0].data.shopifyWeightSyncStatus, "ERROR");
  assert.match(updates[0].data.shopifyWeightSyncError, /timed out/);
});

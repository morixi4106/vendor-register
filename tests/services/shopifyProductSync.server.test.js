import assert from "node:assert/strict";
import test from "node:test";

import {
  createShopifyProductSnapshot,
  syncShopifyProductPayload,
} from "../../app/services/shopifyProductSync.server.js";

function productPayload(overrides = {}) {
  return {
    id: 123,
    admin_graphql_api_id: "gid://shopify/Product/123",
    title: "Shopify直登録商品",
    body_html: "<p>説明です</p>",
    vendor: "store-handle",
    product_type: "生活",
    status: "active",
    tags: "featured",
    image: { src: "https://example.com/product.jpg" },
    variants: [
      {
        id: 456,
        admin_graphql_api_id: "gid://shopify/ProductVariant/456",
        price: "1200",
        inventory_quantity: 4,
      },
    ],
    ...overrides,
  };
}

function createIssueDelegate() {
  const calls = [];
  return {
    calls,
    upsert: async (args) => {
      calls.push(args);
      return { id: "issue_1", ...args.create, ...args.update };
    },
  };
}

test("createShopifyProductSnapshot normalizes REST product payload", () => {
  const snapshot = createShopifyProductSnapshot(productPayload());

  assert.equal(snapshot.id, "gid://shopify/Product/123");
  assert.equal(snapshot.variantId, "gid://shopify/ProductVariant/456");
  assert.equal(snapshot.price, 1200);
  assert.equal(snapshot.inventoryQuantity, 4);
  assert.equal(snapshot.description, "説明です");
});

test("sync preserves an existing local owner and pricing", async () => {
  const issues = createIssueDelegate();
  const existing = {
    id: "product_1",
    name: "旧名",
    description: "旧説明",
    imageUrl: null,
    category: "旧カテゴリ",
    price: 500,
    calculatedPrice: 900,
    vendorStoreId: "store_existing",
    shopifyVariantId: null,
  };
  let updateArgs = null;
  const prismaClient = {
    product: {
      findFirst: async () => existing,
      update: async (args) => {
        updateArgs = args;
        return { ...existing, ...args.data };
      },
    },
    shopifyProductSyncIssue: issues,
  };

  const result = await syncShopifyProductPayload(productPayload(), {
    prismaClient,
    shopDomain: "shop.myshopify.com",
  });

  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(result.product.vendorStoreId, "store_existing");
  assert.equal(result.product.price, 500);
  assert.equal(result.product.calculatedPrice, 900);
  assert.equal(updateArgs.data.name, "Shopify直登録商品");
  assert.equal("price" in updateArgs.data, false);
});

test("sync imports a direct Shopify product when vendor handle resolves uniquely", async () => {
  const issues = createIssueDelegate();
  let createArgs = null;
  const store = { id: "store_1", storeName: "店舗1" };
  const prismaClient = {
    product: {
      findFirst: async () => null,
      create: async (args) => {
        createArgs = args;
        return { id: "product_1", ...args.data };
      },
    },
    vendor: {
      findMany: async () => [{ vendorStore: store }],
    },
    vendorStore: {
      findMany: async () => [],
    },
    shopifyProductSyncIssue: issues,
  };

  const result = await syncShopifyProductPayload(productPayload(), {
    prismaClient,
    shopDomain: "shop.myshopify.com",
  });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(createArgs.data.vendorStoreId, "store_1");
  assert.equal(createArgs.data.approvalStatus, "approved");
  assert.equal(createArgs.data.price, 1200);
  assert.equal(createArgs.data.calculatedPrice, 1200);
  assert.equal(createArgs.data.priceFormulaVersion, "shopify_direct_import_v1");
});

test("sync records an issue instead of guessing when vendor is unknown", async () => {
  const issues = createIssueDelegate();
  let productCreated = false;
  const prismaClient = {
    product: {
      findFirst: async () => null,
      create: async () => {
        productCreated = true;
      },
    },
    vendor: { findMany: async () => [] },
    vendorStore: { findMany: async () => [] },
    shopifyProductSyncIssue: issues,
  };

  const result = await syncShopifyProductPayload(productPayload(), {
    prismaClient,
    shopDomain: "shop.myshopify.com",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "vendor_label_not_found");
  assert.equal(productCreated, false);
  assert.equal(issues.calls.length, 1);
  assert.equal(issues.calls[0].create.status, "unresolved");
});

test("sync does not choose between duplicate store names", async () => {
  const issues = createIssueDelegate();
  const prismaClient = {
    product: { findFirst: async () => null },
    vendor: { findMany: async () => [] },
    vendorStore: {
      findMany: async () => [
        { id: "store_1", storeName: "同名店" },
        { id: "store_2", storeName: "同名店" },
      ],
    },
    shopifyProductSyncIssue: issues,
  };

  const result = await syncShopifyProductPayload(
    productPayload({ vendor: "同名店" }),
    { prismaClient, shopDomain: "shop.myshopify.com" },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "vendor_label_ambiguous");
  assert.deepEqual(issues.calls[0].create.candidateStoreIdsJson, [
    "store_1",
    "store_2",
  ]);
});

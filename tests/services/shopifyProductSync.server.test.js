import assert from "node:assert/strict";
import test from "node:test";

import {
  createShopifyProductSnapshot,
  isShopifyProductPolicySyncCoolingDown,
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

test("createShopifyProductSnapshot converts Shopify variant weights upward to grams", () => {
  const snapshot = createShopifyProductSnapshot(
    productPayload({
      variants: [
        {
          id: 456,
          admin_graphql_api_id: "gid://shopify/ProductVariant/456",
          price: "1200",
          inventory_quantity: 4,
          weight: 0.501,
          weight_unit: "kg",
        },
      ],
    }),
  );

  assert.equal(snapshot.shippingWeightGrams, 501);
  assert.equal(snapshot.variantCount, 1);
});

test("policy sync cooldown only applies to recent unresolved policy failures", async () => {
  const now = new Date("2026-07-23T21:30:00.000Z");
  let issue = {
    status: "unresolved",
    reason: "marketplace_checkout_policy_sync_failed",
    lastAttemptAt: new Date("2026-07-23T21:29:00.000Z"),
  };
  const prismaClient = {
    shopifyProductSyncIssue: {
      findUnique: async () => issue,
    },
  };

  const recentFailure = await isShopifyProductPolicySyncCoolingDown(
    {
      payload: productPayload(),
      shopDomain: "shop.myshopify.com",
      cooldownMs: 5 * 60 * 1000,
    },
    { prismaClient, now },
  );
  assert.equal(recentFailure, true);

  issue = {
    ...issue,
    lastAttemptAt: new Date("2026-07-23T21:20:00.000Z"),
  };
  const expiredFailure = await isShopifyProductPolicySyncCoolingDown(
    {
      payload: productPayload(),
      shopDomain: "shop.myshopify.com",
      cooldownMs: 5 * 60 * 1000,
    },
    { prismaClient, now },
  );
  assert.equal(expiredFailure, false);

  issue = {
    ...issue,
    status: "resolved",
    lastAttemptAt: new Date("2026-07-23T21:29:00.000Z"),
  };
  const resolvedFailure = await isShopifyProductPolicySyncCoolingDown(
    {
      payload: productPayload(),
      shopDomain: "shop.myshopify.com",
      cooldownMs: 5 * 60 * 1000,
    },
    { prismaClient, now },
  );
  assert.equal(resolvedFailure, false);
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

test("sync does not touch Product.updatedAt when Shopify sends an unchanged snapshot", async () => {
  let updateCalls = 0;
  const existing = {
    id: "platform_product",
    name: "Same title",
    description: "Same description",
    imageUrl: "https://example.com/product.jpg",
    category: "Goods",
    price: 1200,
    calculatedPrice: 1200,
    approvalStatus: "approved",
    vendorStoreId: "platform_store",
    shopifyProductId: "gid://shopify/Product/123",
    shopifyVariantId: "gid://shopify/ProductVariant/456",
    shopifyVariantCount: 1,
    shopDomain: "shop.myshopify.com",
    priceSyncStatus: "applied",
    priceSyncError: null,
    priceFormulaVersion: "shopify_direct_import_v1",
    inventoryQuantity: 4,
    inventorySyncError: null,
    shippingWeightGrams: null,
    vendorStore: { id: "platform_store", isPlatformStore: true },
  };
  const prismaClient = {
    product: {
      findFirst: async () => existing,
      update: async () => {
        updateCalls += 1;
        throw new Error("unchanged products must not be updated");
      },
    },
  };

  const result = await syncShopifyProductPayload(
    productPayload({
      title: "Same title",
      body_html: "<p>Same description</p>",
      product_type: "Goods",
    }),
    {
      prismaClient,
      shopDomain: "shop.myshopify.com",
      resolveIssue: false,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.created, false);
  assert.equal(result.changed, false);
  assert.equal(updateCalls, 0);
});

test("sync can preserve a policy failure until the Shopify boundary succeeds", async () => {
  const issues = createIssueDelegate();
  const existing = {
    id: "product_1",
    name: "Existing",
    price: 500,
    calculatedPrice: 900,
    vendorStoreId: "store_existing",
    shopifyVariantId: null,
  };
  const prismaClient = {
    product: {
      findFirst: async () => existing,
      update: async (args) => ({ ...existing, ...args.data }),
    },
    shopifyProductSyncIssue: issues,
  };

  const result = await syncShopifyProductPayload(productPayload(), {
    prismaClient,
    shopDomain: "shop.myshopify.com",
    resolveIssue: false,
  });

  assert.equal(result.ok, true);
  assert.equal(issues.calls.length, 0);
});

test("sync preserves a confirmed profile when Shopify echoes the same weight", async () => {
  const issues = createIssueDelegate();
  const existing = {
    id: "product_1",
    name: "旧名",
    price: 500,
    calculatedPrice: 900,
    vendorStoreId: "store_existing",
    shopifyVariantId: "gid://shopify/ProductVariant/456",
    shippingWeightGrams: 500,
    shippingWeightConfirmedAt: new Date("2026-07-01T00:00:00Z"),
    shippingWeightSource: "MANUAL_CONFIRMED",
    shopifyWeightSyncStatus: "SYNCED",
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

  await syncShopifyProductPayload(
    productPayload({
      variants: [
        {
          id: 456,
          admin_graphql_api_id: "gid://shopify/ProductVariant/456",
          price: "1200",
          inventory_quantity: 4,
          grams: 500,
        },
      ],
    }),
    { prismaClient, shopDomain: "shop.myshopify.com" },
  );

  assert.equal("shippingWeightGrams" in updateArgs.data, false);
  assert.equal("shippingWeightConfirmedAt" in updateArgs.data, false);
  assert.equal("shippingWeightSource" in updateArgs.data, false);
  assert.equal("shopifyWeightSyncStatus" in updateArgs.data, false);
});

test("sync invalidates a confirmed profile when Shopify changes the weight", async () => {
  const issues = createIssueDelegate();
  const existing = {
    id: "product_1",
    name: "旧名",
    price: 500,
    calculatedPrice: 900,
    vendorStoreId: "store_existing",
    shopifyVariantId: "gid://shopify/ProductVariant/456",
    shippingWeightGrams: 500,
    shippingWeightConfirmedAt: new Date("2026-07-01T00:00:00Z"),
    shippingWeightSource: "MANUAL_CONFIRMED",
    shopifyWeightSyncStatus: "SYNCED",
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

  await syncShopifyProductPayload(
    productPayload({
      variants: [
        {
          id: 456,
          admin_graphql_api_id: "gid://shopify/ProductVariant/456",
          price: "1200",
          inventory_quantity: 4,
          grams: 600,
        },
      ],
    }),
    { prismaClient, shopDomain: "shop.myshopify.com" },
  );

  assert.equal(updateArgs.data.shippingWeightGrams, 600);
  assert.equal(updateArgs.data.shippingWeightConfirmedAt, null);
  assert.equal(updateArgs.data.shippingWeightSource, "SHOPIFY_UNVERIFIED");
  assert.equal(updateArgs.data.shopifyWeightSyncStatus, "EXTERNAL_CHANGE");
  assert.match(updateArgs.data.shopifyWeightSyncError, /再確認/);
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

test("sync assigns the configured Shopify vendor label to the platform store", async () => {
  const issues = createIssueDelegate();
  let createArgs = null;
  const platformStore = {
    id: "platform_store",
    storeName: "Oja Immanuel Bacchus",
    isPlatformStore: true,
  };
  const prismaClient = {
    product: {
      findFirst: async () => null,
      create: async (args) => {
        createArgs = args;
        return { id: "platform_product", ...args.data };
      },
    },
    vendorStore: {
      findFirst: async ({ where }) => {
        assert.deepEqual(where, { isPlatformStore: true });
        return platformStore;
      },
    },
    shopifyProductSyncIssue: issues,
  };

  const result = await syncShopifyProductPayload(
    productPayload({ vendor: "Oja Immanuel Bacchus" }),
    { prismaClient, shopDomain: "shop.myshopify.com" },
  );

  assert.equal(result.ok, true);
  assert.equal(result.source, "platform_vendor_label");
  assert.equal(createArgs.data.vendorStoreId, "platform_store");
  assert.equal(createArgs.data.costAmount, null);
  assert.equal(
    createArgs.data.priceSnapshotJson.source,
    "shopify_admin_platform_product",
  );
});

test("sync keeps Shopify as the price and publication source for platform products", async () => {
  const issues = createIssueDelegate();
  let updateArgs = null;
  const existing = {
    id: "platform_product",
    name: "Old title",
    price: 500,
    calculatedPrice: 500,
    approvalStatus: "approved",
    vendorStoreId: "platform_store",
    shopifyVariantId: null,
    vendorStore: { id: "platform_store", isPlatformStore: true },
  };
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

  const result = await syncShopifyProductPayload(
    productPayload({
      vendor: "Oja Immanuel Bacchus",
      status: "draft",
      variants: [
        {
          id: 456,
          admin_graphql_api_id: "gid://shopify/ProductVariant/456",
          price: "1600",
          inventory_quantity: 7,
        },
      ],
    }),
    { prismaClient, shopDomain: "shop.myshopify.com" },
  );

  assert.equal(result.ok, true);
  assert.equal(updateArgs.data.price, 1600);
  assert.equal(updateArgs.data.calculatedPrice, 1600);
  assert.equal(updateArgs.data.approvalStatus, "pending");
  assert.equal(updateArgs.data.inventoryQuantity, 7);
  assert.equal(
    updateArgs.data.priceSnapshotJson.source,
    "shopify_admin_platform_product",
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  ProductPublicationError,
  ensureApprovedProductPublished,
  getVendorCollectionPublicationIssue,
} from "../../app/services/productPublication.server.js";

function createPrismaClient(product) {
  return {
    product: {
      findUnique: async (args) => {
        assert.deepEqual(args.where, { id: product?.id || "missing" });
        return product;
      },
    },
  };
}

test("getVendorCollectionPublicationIssue accepts completed collection and product publish", () => {
  assert.equal(
    getVendorCollectionPublicationIssue({
      ok: true,
      publish: { ok: true },
      productPublish: { ok: true },
    }),
    null,
  );
});

test("getVendorCollectionPublicationIssue reports product publish failures", () => {
  assert.deepEqual(
    getVendorCollectionPublicationIssue({
      ok: true,
      publish: { ok: true },
      productPublish: {
        ok: false,
        reason: "product_publish_failed",
        errors: [{ productId: "gid://shopify/Product/1" }],
      },
    }),
    {
      reason: "product_publish_failed",
      details: {
        ok: false,
        reason: "product_publish_failed",
        errors: [{ productId: "gid://shopify/Product/1" }],
      },
    },
  );
});

test("ensureApprovedProductPublished syncs the vendor collection for an approved Shopify product", async () => {
  const product = {
    id: "product_1",
    approvalStatus: "approved",
    shopifyProductId: "gid://shopify/Product/1",
    shopDomain: "shop-a.myshopify.com",
    vendorStoreId: "store_1",
  };
  let syncCall = null;

  const result = await ensureApprovedProductPublished(product.id, {
    prismaClient: createPrismaClient(product),
    syncVendorCollectionByStoreIdImpl: async (vendorStoreId, options) => {
      syncCall = { vendorStoreId, options };

      return {
        ok: true,
        shopDomain: "shop-a.myshopify.com",
        publish: { ok: true },
        productPublish: { ok: true },
      };
    },
  });

  assert.deepEqual(syncCall, {
    vendorStoreId: "store_1",
    options: {
      shopDomain: "shop-a.myshopify.com",
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.productId, "product_1");
  assert.equal(result.shopifyProductId, "gid://shopify/Product/1");
});

test("ensureApprovedProductPublished fails before sync when the product is not approved", async () => {
  const product = {
    id: "product_1",
    approvalStatus: "pending",
    shopifyProductId: "gid://shopify/Product/1",
    shopDomain: "shop-a.myshopify.com",
    vendorStoreId: "store_1",
  };
  let syncCalled = false;

  await assert.rejects(
    ensureApprovedProductPublished(product.id, {
      prismaClient: createPrismaClient(product),
      syncVendorCollectionByStoreIdImpl: async () => {
        syncCalled = true;
      },
    }),
    (error) => {
      assert.ok(error instanceof ProductPublicationError);
      assert.equal(error.details.reason, "product_not_approved");
      return true;
    },
  );
  assert.equal(syncCalled, false);
});

test("ensureApprovedProductPublished fails when product publish did not complete", async () => {
  const product = {
    id: "product_1",
    approvalStatus: "approved",
    shopifyProductId: "gid://shopify/Product/1",
    shopDomain: "shop-a.myshopify.com",
    vendorStoreId: "store_1",
  };

  await assert.rejects(
    ensureApprovedProductPublished(product.id, {
      prismaClient: createPrismaClient(product),
      syncVendorCollectionByStoreIdImpl: async () => ({
        ok: true,
        publish: { ok: true },
        productPublish: {
          ok: false,
          reason: "product_publish_failed",
        },
      }),
    }),
    (error) => {
      assert.ok(error instanceof ProductPublicationError);
      assert.equal(error.details.reason, "product_publish_failed");
      return true;
    },
  );
});

test("ensureApprovedProductPublished blocks governance-incomplete products when the gate is enabled", async () => {
  const product = {
    id: "product_1",
    approvalStatus: "approved",
    shopifyProductId: "gid://shopify/Product/1",
    shopDomain: "shop-a.myshopify.com",
    vendorStoreId: "store_1",
    complianceProfile: null,
    vendorStore: {
      id: "store_1",
      isTestStore: false,
      returnAddresses: [],
      seller: null,
      vendorAuth: null,
    },
  };

  await assert.rejects(
    ensureApprovedProductPublished(product.id, {
      prismaClient: createPrismaClient(product),
      syncVendorCollectionByStoreIdImpl: async () => {
        throw new Error("must not sync");
      },
      env: {
        MARKETPLACE_GOVERNANCE_GATE_ENABLED: "true",
        SELLER_AGREEMENT_VERSION: "seller-2026-01",
      },
    }),
    (error) => {
      assert.ok(error instanceof ProductPublicationError);
      assert.equal(error.details.reason, "marketplace_governance_incomplete");
      assert.ok(error.details.productReasons.includes("product_compliance_missing"));
      return true;
    },
  );
});

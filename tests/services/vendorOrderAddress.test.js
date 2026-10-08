import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { getVendorOrderShippingAddress } from "../../app/services/vendorManagement.server.js";

const request = {
  storeId: "store-a",
  orderId: "gid://shopify/Order/1001",
  shopDomain: "shop.myshopify.com",
};

test("another store's order never reaches Shopify address lookup", async () => {
  let queried = false;
  const result = await getVendorOrderShippingAddress(request, {
    prismaClient: {
      sellerOrder: {
        findFirst: async (args) => {
          const fields = new Set(
            Prisma.dmmf.datamodel.models
              .find((model) => model.name === "SellerOrder")
              .fields.map((field) => field.name),
          );
          for (const field of Object.keys(args.where))
            assert.ok(fields.has(field));
          assert.equal(args.where.vendorStoreId, "store-a");
          assert.equal(
            args.where.marketplaceOrder.is.shopDomain,
            request.shopDomain,
          );
          return null;
        },
      },
      ledgerEntry: {
        findFirst: async (args) => {
          assert.equal(args.where.seller.is.vendorStoreId, "store-a");
          assert.deepEqual(
            args.where.AND.map((condition) => condition.metadataJson.equals),
            [request.orderId, request.shopDomain],
          );
          return null;
        },
      },
    },
    shopifyGraphQLWithOfflineSessionImpl: async () => {
      queried = true;
    },
  });
  assert.equal(result.status, 404);
  assert.equal(queried, false);
});

test("owned paid orders expose the address only through the dedicated lookup", async () => {
  const result = await getVendorOrderShippingAddress(request, {
    prismaClient: {
      sellerOrder: { findFirst: async () => ({ id: "seller-order" }) },
    },
    shopifyGraphQLWithOfflineSessionImpl: async () => ({
      data: {
        order: {
          id: request.orderId,
          displayFinancialStatus: "PAID",
          shippingAddress: {
            name: "Buyer",
            countryCodeV2: "JP",
            city: "City",
            address1: "Address",
          },
        },
      },
    }),
  });
  assert.equal(result.ok, true);
  assert.ok(JSON.stringify(result.shippingAddressLines).includes("Buyer"));
});

test("fully refunded orders cannot fetch shipping contact information", async () => {
  const result = await getVendorOrderShippingAddress(request, {
    prismaClient: {
      sellerOrder: { findFirst: async () => ({ id: "seller-order" }) },
    },
    shopifyGraphQLWithOfflineSessionImpl: async () => ({
      data: {
        order: { id: request.orderId, displayFinancialStatus: "REFUNDED" },
      },
    }),
  });
  assert.equal(result.status, 409);
});

test("cancelled paid orders cannot expose a shipping address", async () => {
  const result = await getVendorOrderShippingAddress(request, {
    prismaClient: {
      sellerOrder: { findFirst: async () => ({ id: "seller-order" }) },
    },
    shopifyGraphQLWithOfflineSessionImpl: async () => ({
      data: {
        order: {
          id: request.orderId,
          cancelledAt: "2026-10-08T10:00:00Z",
          displayFinancialStatus: "PAID",
        },
      },
    }),
  });
  assert.equal(result.status, 409);
});

test("local refunded seller orders are rejected before Shopify lookup", async () => {
  const result = await getVendorOrderShippingAddress(request, {
    prismaClient: {
      sellerOrder: { findFirst: async () => ({ paymentStatus: "refunded" }) },
    },
    shopifyGraphQLWithOfflineSessionImpl: async () => {
      assert.fail("must not query Shopify");
    },
  });
  assert.equal(result.status, 409);
});

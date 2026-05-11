import assert from "node:assert/strict";
import test from "node:test";

import {
  getPublicProductDisplayPrice,
  serializePublicVendorStorefront,
} from "../../app/utils/publicVendorStorefront.js";

test("getPublicProductDisplayPrice prefers calculated price", () => {
  assert.equal(
    getPublicProductDisplayPrice({
      price: 100,
      calculatedPrice: 27965,
    }),
    27965,
  );
});

test("serializePublicVendorStorefront exposes theme-safe storefront data", () => {
  assert.deepEqual(
    serializePublicVendorStorefront({
      vendor: {
        handle: "vendor",
        storeName: "Test Store",
      },
      store: {
        id: "store_1",
        storeName: "Test Store",
        country: "Japan",
        category: "Cosmetics",
        address: "Tokyo",
        note: null,
      },
      products: [
        {
          id: "product_1",
          name: "Serum",
          description: "Test product",
          imageUrl: null,
          category: "Cosmetics",
          price: 100,
          calculatedPrice: 27965,
          shopDomain: "SHOP-A.myshopify.com",
          shopifyProductId: "gid://shopify/Product/1",
        },
      ],
    }),
    {
      vendor: {
        handle: "vendor",
        storeName: "Test Store",
      },
      store: {
        id: "store_1",
        handle: "vendor",
        storeName: "Test Store",
        country: "Japan",
        category: "Cosmetics",
        address: "Tokyo",
        note: null,
      },
      products: [
        {
          id: "product_1",
          name: "Serum",
          description: "Test product",
          imageUrl: null,
          category: "Cosmetics",
          price: 27965,
          currency: "JPY",
          formattedPrice: "￥27,965",
          isPurchasable: true,
        },
      ],
    },
  );
});

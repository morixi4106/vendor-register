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
  const storefront = serializePublicVendorStorefront({
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
        approvalStatus: "approved",
        productEuStatus: "DISABLED",
        countryPolicy: null,
      },
    ],
  });

  assert.equal(storefront.vendor.handle, "vendor");
  assert.equal(storefront.store.collectionHandle, "vendor-vendor");
  assert.equal(storefront.deliveryCountry, null);
  assert.equal(storefront.productCount, 1);
  assert.equal(storefront.visibleProductCount, 1);
  assert.equal(storefront.hiddenProductCount, 0);
  assert.equal(storefront.products[0].price, 27965);
  assert.equal(storefront.products[0].currency, "JPY");
  assert.equal(storefront.products[0].isPurchasable, true);
  assert.equal(storefront.products[0].basePurchasable, true);
  assert.equal(storefront.products[0].deliveryEligibility.status, "UNKNOWN_COUNTRY");
});

test("serializePublicVendorStorefront can filter products by selected delivery country", () => {
  const storefront = serializePublicVendorStorefront({
    vendor: {
      handle: "vendor",
      storeName: "Test Store",
      seller: {
        euSellerStatus: "FULL_KYBC_APPROVED",
      },
    },
    store: {
      id: "store_1",
      storeName: "Test Store",
    },
    deliveryCountry: "FR",
    filterByDeliveryEligibility: true,
    products: [
      {
        id: "product_ok",
        name: "Poster",
        price: 1000,
        calculatedPrice: 1000,
        shopDomain: "shop-a.myshopify.com",
        approvalStatus: "approved",
        productEuStatus: "APPROVED_LOW_RISK",
        countryPolicy: null,
      },
      {
        id: "product_ng",
        name: "Battery",
        price: 2000,
        calculatedPrice: 2000,
        shopDomain: "shop-a.myshopify.com",
        approvalStatus: "approved",
        productEuStatus: "REJECTED_HIGH_RISK",
        countryPolicy: null,
      },
    ],
  });

  assert.equal(storefront.deliveryCountry, "FR");
  assert.equal(storefront.productCount, 2);
  assert.equal(storefront.visibleProductCount, 1);
  assert.equal(storefront.hiddenProductCount, 1);
  assert.deepEqual(
    storefront.products.map((product) => product.id),
    ["product_ok"],
  );
  assert.equal(
    storefront.products[0].deliveryEligibility.status,
    "REQUIRES_IMPORT_WARNING",
  );
});

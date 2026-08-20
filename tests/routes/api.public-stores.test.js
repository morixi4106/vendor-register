import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPublicStoresWhereInput,
  serializePublicStore,
} from "../../app/utils/publicStores.js";

test("serializePublicStore sends platform stores to the Shopify collection", () => {
  assert.deepEqual(
    serializePublicStore({
      id: "store_1",
      storeName: "Test Store",
      category: "Cosmetics",
      country: "Japan",
      address: "Tokyo",
      note: null,
      isPlatformStore: true,
      vendorAuth: {
        handle: "vendor",
        status: "active",
      },
    }),
    {
      id: "store_1",
      handle: "vendor",
      isPlatformStore: true,
      collectionHandle: "vendor-vendor",
      collectionUrl: "/collections/vendor-vendor",
      storeName: "Test Store",
      category: "Cosmetics",
      country: "Japan",
      address: "Tokyo",
      note: null,
    },
  );
});

test("buildPublicStoresWhereInput hides third-party stores while draft checkout is disabled", () => {
  assert.deepEqual(buildPublicStoresWhereInput(), {
    isTestStore: false,
    isPlatformStore: true,
    vendorAuth: {
      is: {
        status: "active",
      },
    },
  });
});

test("buildPublicStoresWhereInput allows only the permitted third-party store", () => {
  assert.deepEqual(
    buildPublicStoresWhereInput({
      draftOrderCheckoutEnabled: true,
      pilotVendorStoreId: "store_pilot",
    }),
    {
      isTestStore: false,
      OR: [
        { isPlatformStore: true },
        { id: "store_pilot", isPlatformStore: false },
      ],
      vendorAuth: {
        is: {
          status: "active",
        },
      },
    },
  );
});

test("buildPublicStoresWhereInput remains platform-only without a permit", () => {
  assert.deepEqual(
    buildPublicStoresWhereInput({ draftOrderCheckoutEnabled: true }),
    {
      isTestStore: false,
      isPlatformStore: true,
      vendorAuth: {
        is: {
          status: "active",
        },
      },
    },
  );
});

test("serializePublicStore skips stores without a vendor handle", () => {
  assert.equal(
    serializePublicStore({
      id: "store_1",
      vendorAuth: null,
    }),
    null,
  );
});

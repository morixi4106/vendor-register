import assert from "node:assert/strict";
import test from "node:test";

import { serializePublicStore } from "../../app/utils/publicStores.js";

test("serializePublicStore exposes vendor handle for storefront links", () => {
  assert.deepEqual(
    serializePublicStore({
      id: "store_1",
      storeName: "Test Store",
      category: "Cosmetics",
      country: "Japan",
      address: "Tokyo",
      note: null,
      vendorAuth: {
        handle: "vendor",
        status: "active",
      },
    }),
    {
      id: "store_1",
      handle: "vendor",
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

test("serializePublicStore skips stores without a vendor handle", () => {
  assert.equal(
    serializePublicStore({
      id: "store_1",
      vendorAuth: null,
    }),
    null,
  );
});

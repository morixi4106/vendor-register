import assert from "node:assert/strict";
import test from "node:test";

import {
  VENDOR_STORE_PUBLICATION_STATES,
  getVendorStorePublicationState,
} from "../../app/utils/vendorStoreAdminState.js";

test("test data is never presented as publicly visible", () => {
  const result = getVendorStorePublicationState({
    id: "store_test",
    isTestStore: true,
    isPlatformStore: false,
  });

  assert.equal(result.code, VENDOR_STORE_PUBLICATION_STATES.TEST_DATA);
  assert.equal(result.visible, false);
});

test("a production platform store is a Shopify collection listing target", () => {
  const result = getVendorStorePublicationState({
    id: "store_platform",
    isTestStore: false,
    isPlatformStore: true,
  });

  assert.equal(
    result.code,
    VENDOR_STORE_PUBLICATION_STATES.PLATFORM_COLLECTION,
  );
  assert.equal(result.visible, true);
});

test("a non-platform store is not public just because it is production data", () => {
  const result = getVendorStorePublicationState({
    id: "store_marketplace",
    isTestStore: false,
    isPlatformStore: false,
  });

  assert.equal(
    result.code,
    VENDOR_STORE_PUBLICATION_STATES.MARKETPLACE_DISABLED,
  );
  assert.equal(result.visible, false);
});

test("only the active enabled pilot store is public", () => {
  const result = getVendorStorePublicationState(
    {
      id: "store_marketplace",
      isTestStore: false,
      isPlatformStore: false,
    },
    {
      draftOrderCheckoutEnabled: true,
      domesticMarketplacePilotEnabled: true,
      activePilotStoreId: "store_marketplace",
    },
  );

  assert.equal(result.code, VENDOR_STORE_PUBLICATION_STATES.DOMESTIC_PILOT);
  assert.equal(result.visible, true);
});

test("a pilot record does not make a store public while checkout is disabled", () => {
  const result = getVendorStorePublicationState(
    {
      id: "store_marketplace",
      isTestStore: false,
      isPlatformStore: false,
    },
    {
      draftOrderCheckoutEnabled: false,
      domesticMarketplacePilotEnabled: true,
      activePilotStoreId: "store_marketplace",
    },
  );

  assert.equal(
    result.code,
    VENDOR_STORE_PUBLICATION_STATES.MARKETPLACE_DISABLED,
  );
  assert.equal(result.visible, false);
});

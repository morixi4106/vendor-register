import assert from "node:assert/strict";
import test from "node:test";

import {
  READ_DRAFT_ORDERS_SCOPE,
  getVendorOrdersAccessState,
} from "../../app/services/vendorManagement.server.js";

test("getVendorOrdersAccessState returns ready when read_draft_orders is granted", async () => {
  const result = await getVendorOrdersAccessState(
    { storeId: "store_1" },
    {
      listVendorStoreShopDomainsImpl: async () => ["shop-a.myshopify.com"],
      listGrantedAppAccessScopesImpl: async () => [
        "read_orders",
        READ_DRAFT_ORDERS_SCOPE,
      ],
    },
  );

  assert.deepEqual(result, {
    status: "ready",
    hasReadDraftOrders: true,
    grantedScopes: ["read_orders", READ_DRAFT_ORDERS_SCOPE],
    shopDomain: "shop-a.myshopify.com",
    shopDomains: ["shop-a.myshopify.com"],
  });
});

test("getVendorOrdersAccessState returns missing_scope when read_draft_orders is not granted", async () => {
  const result = await getVendorOrdersAccessState(
    { storeId: "store_1" },
    {
      listVendorStoreShopDomainsImpl: async () => ["shop-a.myshopify.com"],
      listGrantedAppAccessScopesImpl: async () => ["read_orders"],
    },
  );

  assert.deepEqual(result, {
    status: "missing_scope",
    hasReadDraftOrders: false,
    grantedScopes: ["read_orders"],
    shopDomain: "shop-a.myshopify.com",
    shopDomains: ["shop-a.myshopify.com"],
  });
});

test("getVendorOrdersAccessState returns missing_shop when no linked shopDomain exists", async () => {
  const result = await getVendorOrdersAccessState(
    { storeId: "store_1" },
    {
      listVendorStoreShopDomainsImpl: async () => [],
    },
  );

  assert.deepEqual(result, {
    status: "missing_shop",
    hasReadDraftOrders: false,
    grantedScopes: [],
    shopDomain: null,
    shopDomains: [],
  });
});

test("getVendorOrdersAccessState returns ambiguous_shop when multiple shopDomains exist", async () => {
  const result = await getVendorOrdersAccessState(
    { storeId: "store_1" },
    {
      listVendorStoreShopDomainsImpl: async () => [
        "shop-a.myshopify.com",
        "shop-b.myshopify.com",
      ],
    },
  );

  assert.deepEqual(result, {
    status: "ambiguous_shop",
    hasReadDraftOrders: false,
    grantedScopes: [],
    shopDomain: null,
    shopDomains: ["shop-a.myshopify.com", "shop-b.myshopify.com"],
  });
});

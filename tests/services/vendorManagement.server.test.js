import assert from "node:assert/strict";
import test from "node:test";

import {
  READ_DRAFT_ORDERS_SCOPE,
  VENDOR_DRAFT_ORDERS_PAGE_SIZE,
  buildVendorDraftOrdersSearchQuery,
  getVendorOrdersAccessState,
  getVendorOrdersPageData,
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

test("buildVendorDraftOrdersSearchQuery uses vendor tags and completed status", () => {
  assert.equal(
    buildVendorDraftOrdersSearchQuery("amber-cellar"),
    'tag:vendor-storefront tag:"vendor:amber-cellar" status:completed',
  );
});

test("getVendorOrdersPageData returns mapped orders when read_draft_orders is granted", async () => {
  let receivedGraphQLCall = null;
  const result = await getVendorOrdersPageData(
    {
      storeId: "store_1",
      vendorHandle: "amber-cellar",
    },
    {
      listVendorStoreShopDomainsImpl: async () => ["shop-a.myshopify.com"],
      listGrantedAppAccessScopesImpl: async () => [
        "read_orders",
        READ_DRAFT_ORDERS_SCOPE,
      ],
      shopifyGraphQLWithOfflineSessionImpl: async (input) => {
        receivedGraphQLCall = input;

        return {
          data: {
            draftOrders: {
              nodes: [
                {
                  id: "gid://shopify/DraftOrder/1",
                  name: "#D1",
                  createdAt: "2026-04-29T08:00:00Z",
                  completedAt: "2026-04-29T08:30:00Z",
                  order: {
                    id: "gid://shopify/Order/1001",
                    name: "#1001",
                    createdAt: "2026-04-29T08:35:00Z",
                    email: "taro@example.com",
                    displayFinancialStatus: "PAID",
                    displayFulfillmentStatus: "UNFULFILLED",
                    customer: {
                      displayName: "Taro Yamada",
                    },
                    currentTotalPriceSet: {
                      shopMoney: {
                        amount: "8400",
                        currencyCode: "JPY",
                      },
                    },
                  },
                },
                {
                  id: "gid://shopify/DraftOrder/2",
                  name: "#D2",
                  createdAt: "2026-04-28T08:00:00Z",
                  completedAt: "2026-04-28T08:30:00Z",
                  order: null,
                },
              ],
            },
          },
        };
      },
    },
  );

  assert.equal(receivedGraphQLCall.shopDomain, "shop-a.myshopify.com");
  assert.equal(receivedGraphQLCall.apiVersion, "2026-01");
  assert.match(receivedGraphQLCall.query, /draftOrders/);
  assert.deepEqual(receivedGraphQLCall.variables, {
    first: VENDOR_DRAFT_ORDERS_PAGE_SIZE,
    query: 'tag:vendor-storefront tag:"vendor:amber-cellar" status:completed',
  });
  assert.equal(result.accessState.status, "ready");
  assert.equal(result.queryString, 'tag:vendor-storefront tag:"vendor:amber-cellar" status:completed');
  assert.equal(result.pageSize, VENDOR_DRAFT_ORDERS_PAGE_SIZE);
  assert.deepEqual(result.orders, [
    {
      id: "gid://shopify/Order/1001",
      orderId: "gid://shopify/Order/1001",
      orderName: "#1001",
      shopifyOrderNumber: "#1001",
      createdAt: "2026-04-29T08:35:00Z",
      createdAtLabel: "2026/04/29 17:35",
      customerName: "Taro Yamada",
      email: "taro@example.com",
      totalAmount: 8400,
      totalCurrencyCode: "JPY",
      totalLabel: "￥8,400",
      financialStatus: "PAID",
      financialStatusLabel: "支払い済み",
      financialStatusTone: "success",
      fulfillmentStatus: "UNFULFILLED",
      fulfillmentStatusLabel: "未発送",
      fulfillmentStatusTone: "neutral",
    },
  ]);
});

test("getVendorOrdersPageData does not query draftOrders before read_draft_orders is granted", async () => {
  let graphQLCallCount = 0;
  const result = await getVendorOrdersPageData(
    {
      storeId: "store_1",
      vendorHandle: "amber-cellar",
    },
    {
      listVendorStoreShopDomainsImpl: async () => ["shop-a.myshopify.com"],
      listGrantedAppAccessScopesImpl: async () => ["read_orders"],
      shopifyGraphQLWithOfflineSessionImpl: async () => {
        graphQLCallCount += 1;
        return { data: {} };
      },
    },
  );

  assert.equal(graphQLCallCount, 0);
  assert.equal(result.accessState.status, "missing_scope");
  assert.equal(result.queryString, null);
  assert.equal(result.pageSize, VENDOR_DRAFT_ORDERS_PAGE_SIZE);
  assert.deepEqual(result.orders, []);
});

test("getVendorOrdersPageData sanitizes reconnect failures from draftOrders lookup", async () => {
  const result = await getVendorOrdersPageData(
    {
      storeId: "store_1",
      vendorHandle: "amber-cellar",
    },
    {
      listVendorStoreShopDomainsImpl: async () => ["shop-a.myshopify.com"],
      listGrantedAppAccessScopesImpl: async () => [
        "read_orders",
        READ_DRAFT_ORDERS_SCOPE,
      ],
      shopifyGraphQLWithOfflineSessionImpl: async () => {
        throw new Error("Offline session not found for shop: shop-a.myshopify.com");
      },
    },
  );

  assert.equal(result.accessState.status, "missing_connection");
  assert.deepEqual(result.orders, []);
  assert.equal(result.queryString, null);
  assert.equal(result.pageSize, VENDOR_DRAFT_ORDERS_PAGE_SIZE);
});

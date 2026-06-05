import assert from "node:assert/strict";
import test from "node:test";

import {
  READ_DRAFT_ORDERS_SCOPE,
  VENDOR_DRAFT_ORDERS_PAGE_SIZE,
  buildVendorDraftOrdersSearchQuery,
  getVendorReturnTo,
  getVendorVerifyRedirectPath,
  getVendorOrdersAccessState,
  getVendorOrdersPageData,
  sanitizeVendorReturnTo,
  serializeVendorProduct,
  syncShopifyInventoryQuantity,
  updateVendorProductInventory,
} from "../../app/services/vendorManagement.server.js";

test("sanitizeVendorReturnTo accepts only local non-verify paths", () => {
  assert.equal(sanitizeVendorReturnTo("/seller/settings/payments"), "/seller/settings/payments");
  assert.equal(sanitizeVendorReturnTo("//evil.example/path"), "/vendor/dashboard");
  assert.equal(sanitizeVendorReturnTo("https://evil.example/path"), "/vendor/dashboard");
  assert.equal(sanitizeVendorReturnTo("/vendor/verify?returnTo=/seller/settings/payments"), "/vendor/dashboard");
});

test("getVendorReturnTo reads safe returnTo query values", () => {
  const request = new Request(
    "https://vendor-register.example/vendor/verify?returnTo=%2Fseller%2Fsettings%2Fpayments",
  );

  assert.equal(getVendorReturnTo(request), "/seller/settings/payments");
});

test("getVendorVerifyRedirectPath preserves the protected route as returnTo", () => {
  const request = new Request(
    "https://vendor-register.example/seller/settings/payments?tab=wise",
  );

  assert.equal(
    getVendorVerifyRedirectPath(request),
    "/vendor/verify?returnTo=%2Fseller%2Fsettings%2Fpayments%3Ftab%3Dwise",
  );
});

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

test("serializeVendorProduct formats product price with the original currency", () => {
  const product = serializeVendorProduct({
    id: "product_1",
    name: "Test product",
    category: "Cosmetics",
    price: 100,
    costCurrency: "EUR",
    approvalStatus: "approved",
    updatedAt: "2026-05-11T00:00:00Z",
  });

  assert.equal(product.priceLabel, "€100");
  assert.equal(product.currencyCode, "EUR");
  assert.equal(product.stockLabel, "未設定");
  assert.equal(product.stockStatusLabel, "在庫入力待ち");
});

test("serializeVendorProduct exposes delivery policy labels", () => {
  const product = serializeVendorProduct({
    id: "product_1",
    name: "Test product",
    category: "Cosmetics",
    price: 100,
    costCurrency: "JPY",
    approvalStatus: "pending",
    productEuStatus: "PENDING_REVIEW",
    countryPolicy: {
      allowedCountries: ["JP", "US"],
      blockedCountries: [],
      requiresWarningCountries: [],
    },
    updatedAt: "2026-05-11T00:00:00Z",
  });

  assert.equal(product.deliveryPolicyLabel, "配送先限定");
  assert.equal(product.deliveryPolicyTone, "warning");
  assert.match(product.deliveryPolicyDetail, /配送できる国/);
});

test("updateVendorProductInventory stores quantity and syncs linked products", async () => {
  const syncedAt = new Date("2026-06-06T00:00:00Z");
  const productRow = {
    id: "product_1",
    name: "Test product",
    category: "Cosmetics",
    price: 100,
    costCurrency: "JPY",
    approvalStatus: "approved",
    shopDomain: "shop-a.myshopify.com",
    shopifyProductId: "gid://shopify/Product/1001",
    inventoryQuantity: null,
    inventorySyncedAt: null,
    inventorySyncError: null,
    updatedAt: syncedAt,
  };
  const updateCalls = [];
  let receivedSyncInput = null;
  const prismaClient = {
    product: {
      findFirst: async () => ({
        id: productRow.id,
        shopDomain: productRow.shopDomain,
        shopifyProductId: productRow.shopifyProductId,
      }),
      update: async ({ data }) => {
        updateCalls.push(data);
        Object.assign(productRow, data);
        return { ...productRow };
      },
    },
  };

  const result = await updateVendorProductInventory({
    storeId: "store_1",
    productId: productRow.id,
    inventoryQuantity: "7",
    prismaClient,
    syncShopifyInventoryQuantityImpl: async (input) => {
      receivedSyncInput = input;
      return { ok: true };
    },
    now: () => syncedAt,
  });

  assert.equal(result.ok, true);
  assert.equal(result.warning, null);
  assert.equal(result.product.inventoryQuantity, 7);
  assert.equal(result.product.inventorySyncLabel, "同期済み");
  assert.deepEqual(receivedSyncInput, {
    shopDomain: "shop-a.myshopify.com",
    shopifyProductId: "gid://shopify/Product/1001",
    quantity: 7,
  });
  assert.deepEqual(updateCalls, [
    {
      inventoryQuantity: 7,
      inventorySyncedAt: null,
      inventorySyncError: null,
    },
    {
      inventorySyncedAt: syncedAt,
      inventorySyncError: null,
    },
  ]);
});

test("updateVendorProductInventory keeps local quantity when public-store sync fails", async () => {
  const productRow = {
    id: "product_1",
    name: "Test product",
    category: "Cosmetics",
    price: 100,
    costCurrency: "JPY",
    approvalStatus: "approved",
    shopDomain: "shop-a.myshopify.com",
    shopifyProductId: "gid://shopify/Product/1001",
    inventoryQuantity: null,
    inventorySyncedAt: null,
    inventorySyncError: null,
    updatedAt: new Date("2026-06-06T00:00:00Z"),
  };
  const prismaClient = {
    product: {
      findFirst: async () => ({
        id: productRow.id,
        shopDomain: productRow.shopDomain,
        shopifyProductId: productRow.shopifyProductId,
      }),
      update: async ({ data }) => {
        Object.assign(productRow, data);
        return { ...productRow };
      },
    },
  };

  const result = await updateVendorProductInventory({
    storeId: "store_1",
    productId: productRow.id,
    inventoryQuantity: "3",
    prismaClient,
    syncShopifyInventoryQuantityImpl: async () => {
      throw new Error("ACCESS_DENIED: write_inventory");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.product.inventoryQuantity, 3);
  assert.equal(result.product.inventorySyncLabel, "同期要確認");
  assert.match(result.warning, /権限/);
  assert.match(productRow.inventorySyncError, /権限/);
});

test("updateVendorProductInventory skips sync before the product is public-linked", async () => {
  const productRow = {
    id: "product_1",
    name: "Test product",
    category: "Cosmetics",
    price: 100,
    costCurrency: "JPY",
    approvalStatus: "pending",
    shopDomain: null,
    shopifyProductId: null,
    inventoryQuantity: null,
    inventorySyncedAt: null,
    inventorySyncError: null,
    updatedAt: new Date("2026-06-06T00:00:00Z"),
  };
  let syncCallCount = 0;
  const prismaClient = {
    product: {
      findFirst: async () => ({
        id: productRow.id,
        shopDomain: productRow.shopDomain,
        shopifyProductId: productRow.shopifyProductId,
      }),
      update: async ({ data }) => {
        Object.assign(productRow, data);
        return { ...productRow };
      },
    },
  };

  const result = await updateVendorProductInventory({
    storeId: "store_1",
    productId: productRow.id,
    inventoryQuantity: "4",
    prismaClient,
    syncShopifyInventoryQuantityImpl: async () => {
      syncCallCount += 1;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(syncCallCount, 0);
  assert.equal(result.product.inventoryQuantity, 4);
  assert.equal(result.product.inventorySyncLabel, "公開後に同期");
});

test("syncShopifyInventoryQuantity enables tracking and sets available inventory", async () => {
  const calls = [];
  const result = await syncShopifyInventoryQuantity({
    shopDomain: "shop-a.myshopify.com",
    shopifyProductId: "gid://shopify/Product/1001",
    quantity: 5,
    shopifyGraphQLWithOfflineSessionImpl: async (call) => {
      calls.push(call);

      if (call.query.includes("ProductInventorySyncTarget")) {
        return {
          data: {
            product: {
              id: "gid://shopify/Product/1001",
              variants: {
                nodes: [
                  {
                    id: "gid://shopify/ProductVariant/2001",
                    inventoryItem: {
                      id: "gid://shopify/InventoryItem/3001",
                      tracked: false,
                    },
                  },
                ],
              },
            },
            locations: {
              nodes: [
                {
                  id: "gid://shopify/Location/4001",
                  name: "Main",
                },
              ],
            },
          },
        };
      }

      if (call.query.includes("InventoryItemTrackingUpdate")) {
        return {
          data: {
            inventoryItemUpdate: {
              inventoryItem: {
                id: "gid://shopify/InventoryItem/3001",
                tracked: true,
              },
              userErrors: [],
            },
          },
        };
      }

      if (call.query.includes("InventorySetQuantities")) {
        return {
          data: {
            inventorySetQuantities: {
              inventoryAdjustmentGroup: {
                createdAt: "2026-06-06T00:00:00Z",
                reason: "correction",
              },
              userErrors: [],
            },
          },
        };
      }

      throw new Error("Unexpected GraphQL query");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.inventoryItemId, "gid://shopify/InventoryItem/3001");
  assert.equal(result.locationId, "gid://shopify/Location/4001");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].variables, {
    id: "gid://shopify/InventoryItem/3001",
    input: {
      tracked: true,
    },
  });
  assert.equal(calls[2].variables.input.name, "available");
  assert.equal(calls[2].variables.input.reason, "correction");
  assert.equal(calls[2].variables.input.ignoreCompareQuantity, true);
  assert.deepEqual(calls[2].variables.input.quantities, [
    {
      inventoryItemId: "gid://shopify/InventoryItem/3001",
      locationId: "gid://shopify/Location/4001",
      quantity: 5,
      compareQuantity: null,
    },
  ]);
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
      publicOrderIdLabel: "1001",
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

import assert from "node:assert/strict";
import test from "node:test";

import {
  READ_ORDERS_SCOPE,
  READ_DRAFT_ORDERS_SCOPE,
  VENDOR_DRAFT_ORDERS_PAGE_SIZE,
  buildVendorDraftOrdersSearchQuery,
  createVendorOrderFulfillment,
  getVendorReturnTo,
  getVendorVerifyRedirectPath,
  getVendorOrdersAccessState,
  getVendorOrdersPageData,
  getConfiguredAdminEmails,
  isConfiguredAdminEmail,
  parseShipmentRegistrationInput,
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

test("configured admin emails support comma-separated admin access lists", () => {
  const env = {
    ADMIN_EMAIL: "Owner@Example.com",
    ADMIN_EMAILS: "admin-a@example.com, admin-b@example.com",
    VENDOR_ADMIN_EMAILS: "admin-b@example.com, vendor-admin@example.com",
  };

  assert.deepEqual(getConfiguredAdminEmails(env), [
    "owner@example.com",
    "admin-a@example.com",
    "admin-b@example.com",
    "vendor-admin@example.com",
  ]);
  assert.equal(isConfiguredAdminEmail("ADMIN-A@example.com", env), true);
  assert.equal(isConfiguredAdminEmail("seller@example.com", env), false);
});

test("getVendorOrdersAccessState returns ready when read_orders is granted", async () => {
  const result = await getVendorOrdersAccessState(
    { storeId: "store_1" },
    {
      listVendorStoreShopDomainsImpl: async () => ["shop-a.myshopify.com"],
      listGrantedAppAccessScopesImpl: async () => [
        READ_ORDERS_SCOPE,
        READ_DRAFT_ORDERS_SCOPE,
      ],
    },
  );

  assert.deepEqual(result, {
    status: "ready",
    hasReadOrders: true,
    hasReadDraftOrders: true,
    grantedScopes: [READ_ORDERS_SCOPE, READ_DRAFT_ORDERS_SCOPE],
    shopDomain: "shop-a.myshopify.com",
    shopDomains: ["shop-a.myshopify.com"],
  });
});

test("getVendorOrdersAccessState returns missing_scope when read_orders is not granted", async () => {
  const result = await getVendorOrdersAccessState(
    { storeId: "store_1" },
    {
      listVendorStoreShopDomainsImpl: async () => ["shop-a.myshopify.com"],
      listGrantedAppAccessScopesImpl: async () => [READ_DRAFT_ORDERS_SCOPE],
    },
  );

  assert.deepEqual(result, {
    status: "missing_scope",
    hasReadOrders: false,
    hasReadDraftOrders: true,
    grantedScopes: [READ_DRAFT_ORDERS_SCOPE],
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

test.skip("getVendorOrdersPageData returns mapped orders when read_draft_orders is granted", async () => {
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
      shippingAddressLabel: "未設定",
      shippingAddressLines: [],
      shippingAddressSummary: "未設定",
      totalAmount: 8400,
      totalCurrencyCode: "JPY",
      totalLabel: "￥8,400",
      financialStatus: "PAID",
      financialStatusLabel: "支払い済み",
      financialStatusTone: "success",
      fulfillmentStatus: "UNFULFILLED",
      fulfillmentStatusLabel: "未発送",
      fulfillmentStatusTone: "neutral",
      trackingLabel: "-",
      trackingUrl: null,
      canRegisterShipment: true,
    },
  ]);
});

test("getVendorOrdersPageData returns mapped orders from seller ledger order ids", async () => {
  let receivedGraphQLCall = null;
  let receivedLedgerQuery = null;
  const result = await getVendorOrdersPageData(
    {
      storeId: "store_1",
    },
    {
      listVendorStoreShopDomainsImpl: async () => ["shop-a.myshopify.com"],
      listGrantedAppAccessScopesImpl: async () => [READ_ORDERS_SCOPE],
      prismaClient: {
        ledgerEntry: {
          findMany: async (query) => {
            if (query.where.entryType === "refund") {
              return [];
            }

            receivedLedgerQuery = query;
            return [
              {
                id: "ledger_1",
                entryType: "shopify_order_paid",
                stripeObjectId: "gid://shopify/Order/1001",
                amount: 8400,
                currencyCode: "jpy",
                metadataJson: {
                  shopifyOrderName: "#1001",
                },
                occurredAt: new Date("2026-04-29T08:35:00Z"),
                createdAt: new Date("2026-04-29T08:36:00Z"),
              },
            ];
          },
        },
      },
      shopifyGraphQLWithOfflineSessionImpl: async (input) => {
        receivedGraphQLCall = input;

        return {
          data: {
            nodes: [
              {
                id: "gid://shopify/Order/1001",
                name: "#1001",
                createdAt: "2026-04-29T08:35:00Z",
                email: "taro@example.com",
                displayFinancialStatus: "PAID",
                displayFulfillmentStatus: "UNFULFILLED",
                customer: {
                  displayName: "Taro Yamada",
                },
                shippingAddress: {
                  countryCodeV2: "JP",
                },
                currentTotalPriceSet: {
                  shopMoney: {
                    amount: "8400",
                    currencyCode: "JPY",
                  },
                },
                fulfillments: [],
              },
            ],
          },
        };
      },
    },
  );

  assert.equal(receivedLedgerQuery.where.entryType, "shopify_order_paid");
  assert.deepEqual(receivedLedgerQuery.where.seller, {
    is: {
      vendorStoreId: "store_1",
    },
  });
  assert.equal(receivedGraphQLCall.shopDomain, "shop-a.myshopify.com");
  assert.equal(receivedGraphQLCall.apiVersion, "2026-01");
  assert.match(receivedGraphQLCall.query, /nodes\(ids: \$ids\)/);
  assert.deepEqual(receivedGraphQLCall.variables, {
    ids: ["gid://shopify/Order/1001"],
  });
  assert.equal(result.accessState.status, "ready");
  assert.equal(result.queryString, "ledger:shopify_order_paid");
  assert.equal(result.pageSize, VENDOR_DRAFT_ORDERS_PAGE_SIZE);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].id, "gid://shopify/Order/1001");
  assert.equal(result.orders[0].shopifyOrderNumber, "#1001");
  assert.equal(result.orders[0].customerName, "Taro Yamada");
  assert.equal(result.orders[0].totalAmount, 8400);
  assert.equal(result.orders[0].financialStatus, "PAID");
  assert.equal(result.orders[0].fulfillmentStatus, "UNFULFILLED");
  assert.equal(result.orders[0].shippingCountryCode, "JP");
  assert.equal(result.orders[0].shippingAddressSummary, "未設定");
  assert.equal(result.orders[0].canRegisterShipment, true);
});

test("getVendorOrdersPageData marks fully refunded ledger orders as not shippable", async () => {
  const result = await getVendorOrdersPageData(
    {
      storeId: "store_1",
    },
    {
      listVendorStoreShopDomainsImpl: async () => ["shop-a.myshopify.com"],
      listGrantedAppAccessScopesImpl: async () => [READ_ORDERS_SCOPE],
      prismaClient: {
        ledgerEntry: {
          findMany: async (query) => {
            if (query.where.entryType === "refund") {
              return [
                {
                  id: "ledger_refund_1",
                  entryType: "refund",
                  stripeObjectId: "gid://shopify/Refund/5001",
                  amount: 8400,
                  currencyCode: "jpy",
                  metadataJson: {
                    shopifyOrderId: "gid://shopify/Order/1001",
                  },
                  occurredAt: new Date("2026-04-29T09:35:00Z"),
                  createdAt: new Date("2026-04-29T09:36:00Z"),
                },
              ];
            }

            return [
              {
                id: "ledger_1",
                entryType: "shopify_order_paid",
                stripeObjectId: "gid://shopify/Order/1001",
                amount: 8400,
                currencyCode: "jpy",
                metadataJson: {},
                occurredAt: new Date("2026-04-29T08:35:00Z"),
                createdAt: new Date("2026-04-29T08:36:00Z"),
              },
            ];
          },
        },
      },
      shopifyGraphQLWithOfflineSessionImpl: async () => ({
        data: {
          nodes: [
            {
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
              fulfillments: [],
            },
          ],
        },
      }),
    },
  );

  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].financialStatus, "REFUNDED");
  assert.equal(result.orders[0].financialStatusLabel, "返金済み");
  assert.equal(result.orders[0].ledgerRefundAmount, 8400);
  assert.equal(result.orders[0].isFullyRefundedByLedger, true);
  assert.equal(result.orders[0].canRegisterShipment, false);
});

test("parseShipmentRegistrationInput validates tracking fields", () => {
  const valid = parseShipmentRegistrationInput({
    orderId: "gid://shopify/Order/1001",
    trackingNumber: "JP123456789",
    trackingCarrierId: "japan_post",
    notifyCustomer: "on",
  });

  assert.deepEqual(valid, {
    ok: true,
    orderId: "gid://shopify/Order/1001",
    trackingNumber: "JP123456789",
    trackingCarrierId: "japan_post",
    trackingCompany: "Japan Post",
    trackingCompanyLabel: "日本郵便",
    trackingUrl:
      "https://trackings.post.japanpost.jp/services/srv/search/direct?locale=ja&reqCodeNo1=JP123456789",
    notifyCustomer: true,
  });

  assert.equal(
    parseShipmentRegistrationInput({
      orderId: "gid://shopify/Order/1001",
    }).error,
    "追跡番号を入力してください。",
  );

  assert.equal(
    parseShipmentRegistrationInput({
      orderId: "gid://shopify/Order/1001",
      trackingNumber: "JP123456789",
      trackingCarrierId: "unknown",
    }).error,
    "配送会社を選択してください。",
  );

  assert.equal(
    parseShipmentRegistrationInput({
      orderId: "gid://shopify/Order/1001",
      trackingNumber: "JP123456789",
      trackingCarrierId: "japan_post",
      trackingUrl: "ftp://track.example/JP123456789",
    }).error,
    "追跡URLは https:// から始まるURLで入力してください。",
  );
});

test("createVendorOrderFulfillment creates a Shopify fulfillment for a vendor order", async () => {
  const calls = [];
  const result = await createVendorOrderFulfillment({
    storeId: "store_1",
    vendorHandle: "amber-cellar",
    shipment: {
      orderId: "gid://shopify/Order/1001",
      trackingNumber: "JP123456789",
      trackingCompany: "Japan Post",
      trackingUrl:
        "https://trackings.post.japanpost.jp/services/srv/search/direct?locale=ja&reqCodeNo1=JP123456789",
      notifyCustomer: true,
    },
    listVendorStoreShopDomainsImpl: async () => ["shop-a.myshopify.com"],
    prismaClient: {
      ledgerEntry: {
        findMany: async () => [],
      },
    },
    shopifyGraphQLWithOfflineSessionImpl: async (call) => {
      calls.push(call);

      if (call.query.includes("VendorOrderFulfillmentTarget")) {
        return {
          data: {
            order: {
              id: "gid://shopify/Order/1001",
              name: "#1001",
              tags: ["vendor-storefront", "vendor:amber-cellar"],
              displayFinancialStatus: "PAID",
              displayFulfillmentStatus: "UNFULFILLED",
              fulfillmentOrders: {
                nodes: [
                  {
                    id: "gid://shopify/FulfillmentOrder/9001",
                    status: "OPEN",
                    requestStatus: "UNSUBMITTED",
                    assignedLocation: {
                      name: "Main",
                      location: {
                        id: "gid://shopify/Location/4001",
                        name: "Main",
                      },
                    },
                  },
                ],
              },
            },
          },
        };
      }

      if (call.query.includes("VendorOrderFulfillmentCreate")) {
        return {
          data: {
            fulfillmentCreate: {
              fulfillment: {
                id: "gid://shopify/Fulfillment/7001",
              },
              userErrors: [],
            },
          },
        };
      }

      throw new Error("Unexpected GraphQL query");
    },
  });

  assert.deepEqual(result, {
    ok: true,
    orderId: "gid://shopify/Order/1001",
    orderName: "#1001",
    fulfillmentId: "gid://shopify/Fulfillment/7001",
    message: "#1001を発送済みにしました。",
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].variables.fulfillment, {
    lineItemsByFulfillmentOrder: [
      {
        fulfillmentOrderId: "gid://shopify/FulfillmentOrder/9001",
      },
    ],
    notifyCustomer: true,
    trackingInfo: {
      company: "Japan Post",
      number: "JP123456789",
      url:
        "https://trackings.post.japanpost.jp/services/srv/search/direct?locale=ja&reqCodeNo1=JP123456789",
    },
  });
});

test("createVendorOrderFulfillment allows ledger-owned Shopify checkout orders without vendor tags", async () => {
  const calls = [];
  const result = await createVendorOrderFulfillment({
    storeId: "store_1",
    vendorHandle: "amber-cellar",
    shipment: {
      orderId: "gid://shopify/Order/1001",
      trackingNumber: "JP123456789",
      trackingCompany: "Japan Post",
      trackingUrl: null,
      notifyCustomer: false,
    },
    listVendorStoreShopDomainsImpl: async () => ["shop-a.myshopify.com"],
    prismaClient: {
      ledgerEntry: {
        findMany: async (query) => {
          assert.deepEqual(query.where.seller, {
            is: {
              vendorStoreId: "store_1",
            },
          });
          return [
            {
              id: "ledger_1",
              entryType: "shopify_order_paid",
              stripeObjectId: "gid://shopify/Order/1001",
              amount: 8400,
              currencyCode: "jpy",
              metadataJson: {},
              occurredAt: new Date("2026-04-29T08:35:00Z"),
              createdAt: new Date("2026-04-29T08:36:00Z"),
            },
          ];
        },
      },
    },
    shopifyGraphQLWithOfflineSessionImpl: async (call) => {
      calls.push(call);

      if (call.query.includes("VendorOrderFulfillmentTarget")) {
        return {
          data: {
            order: {
              id: "gid://shopify/Order/1001",
              name: "#1001",
              tags: [],
              displayFinancialStatus: "PAID",
              displayFulfillmentStatus: "UNFULFILLED",
              fulfillmentOrders: {
                nodes: [
                  {
                    id: "gid://shopify/FulfillmentOrder/9001",
                    status: "OPEN",
                    requestStatus: "UNSUBMITTED",
                    assignedLocation: {
                      name: "Main",
                      location: {
                        id: "gid://shopify/Location/4001",
                        name: "Main",
                      },
                    },
                  },
                ],
              },
            },
          },
        };
      }

      if (call.query.includes("VendorOrderFulfillmentCreate")) {
        return {
          data: {
            fulfillmentCreate: {
              fulfillment: {
                id: "gid://shopify/Fulfillment/7001",
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
  assert.equal(result.orderId, "gid://shopify/Order/1001");
  assert.equal(result.fulfillmentId, "gid://shopify/Fulfillment/7001");
  assert.equal(calls.length, 2);
});

test("createVendorOrderFulfillment rejects fully refunded ledger-owned orders", async () => {
  const result = await createVendorOrderFulfillment({
    storeId: "store_1",
    vendorHandle: "amber-cellar",
    shipment: {
      orderId: "gid://shopify/Order/1001",
      trackingNumber: "JP123456789",
      trackingCompany: "Japan Post",
      trackingUrl: null,
      notifyCustomer: false,
    },
    listVendorStoreShopDomainsImpl: async () => ["shop-a.myshopify.com"],
    prismaClient: {
      ledgerEntry: {
        findMany: async () => [
          {
            id: "ledger_1",
            entryType: "shopify_order_paid",
            stripeObjectId: "gid://shopify/Order/1001",
            amount: 8400,
            currencyCode: "jpy",
            metadataJson: {},
            occurredAt: new Date("2026-04-29T08:35:00Z"),
            createdAt: new Date("2026-04-29T08:36:00Z"),
          },
          {
            id: "ledger_refund_1",
            entryType: "refund",
            stripeObjectId: "gid://shopify/Refund/5001",
            amount: 8400,
            currencyCode: "jpy",
            metadataJson: {
              shopifyOrderId: "gid://shopify/Order/1001",
            },
            occurredAt: new Date("2026-04-29T09:35:00Z"),
            createdAt: new Date("2026-04-29T09:36:00Z"),
          },
        ],
      },
    },
    shopifyGraphQLWithOfflineSessionImpl: async () => ({
      data: {
        order: {
          id: "gid://shopify/Order/1001",
          name: "#1001",
          tags: [],
          displayFinancialStatus: "PAID",
          displayFulfillmentStatus: "UNFULFILLED",
          fulfillmentOrders: {
            nodes: [
              {
                id: "gid://shopify/FulfillmentOrder/9001",
                status: "OPEN",
                requestStatus: "UNSUBMITTED",
                assignedLocation: {
                  name: "Main",
                  location: {
                    id: "gid://shopify/Location/4001",
                  },
                },
              },
            ],
          },
        },
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.error, "返金済みの注文は発送登録できません。");
});

test("createVendorOrderFulfillment rejects another vendor order", async () => {
  const result = await createVendorOrderFulfillment({
    storeId: "store_1",
    vendorHandle: "amber-cellar",
    shipment: {
      orderId: "gid://shopify/Order/1001",
      trackingNumber: "JP123456789",
      trackingCompany: "",
      trackingUrl: null,
      notifyCustomer: false,
    },
    listVendorStoreShopDomainsImpl: async () => ["shop-a.myshopify.com"],
    shopifyGraphQLWithOfflineSessionImpl: async () => ({
      data: {
        order: {
          id: "gid://shopify/Order/1001",
          name: "#1001",
          tags: ["vendor-storefront", "vendor:other-shop"],
          displayFinancialStatus: "PAID",
          displayFulfillmentStatus: "UNFULFILLED",
          fulfillmentOrders: {
            nodes: [
              {
                id: "gid://shopify/FulfillmentOrder/9001",
                status: "OPEN",
                requestStatus: "UNSUBMITTED",
                assignedLocation: {
                  name: "Main",
                  location: {
                    id: "gid://shopify/Location/4001",
                  },
                },
              },
            ],
          },
        },
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.error, "この注文は現在の店舗では発送登録できません。");
});

test("getVendorOrdersPageData does not query Shopify when seller ledger has no order ids", async () => {
  let graphQLCallCount = 0;
  const result = await getVendorOrdersPageData(
    {
      storeId: "store_1",
    },
    {
      listVendorStoreShopDomainsImpl: async () => ["shop-a.myshopify.com"],
      listGrantedAppAccessScopesImpl: async () => [READ_ORDERS_SCOPE],
      prismaClient: {
        ledgerEntry: {
          findMany: async () => [],
        },
      },
      shopifyGraphQLWithOfflineSessionImpl: async () => {
        graphQLCallCount += 1;
        return { data: {} };
      },
    },
  );

  assert.equal(graphQLCallCount, 0);
  assert.equal(result.accessState.status, "ready");
  assert.equal(result.queryString, "ledger:shopify_order_paid");
  assert.equal(result.pageSize, VENDOR_DRAFT_ORDERS_PAGE_SIZE);
  assert.deepEqual(result.orders, []);
});

test("getVendorOrdersPageData sanitizes reconnect failures from draftOrders lookup", async () => {
  const result = await getVendorOrdersPageData(
    {
      storeId: "store_1",
    },
    {
      listVendorStoreShopDomainsImpl: async () => ["shop-a.myshopify.com"],
      listGrantedAppAccessScopesImpl: async () => [
        READ_ORDERS_SCOPE,
      ],
      prismaClient: {
        ledgerEntry: {
          findMany: async () => [
            {
              id: "ledger_1",
              stripeObjectId: "gid://shopify/Order/1001",
              amount: 8400,
              currencyCode: "jpy",
              metadataJson: {},
              occurredAt: new Date("2026-04-29T08:35:00Z"),
              createdAt: new Date("2026-04-29T08:36:00Z"),
            },
          ],
        },
      },
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

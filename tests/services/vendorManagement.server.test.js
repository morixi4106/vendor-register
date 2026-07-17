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
  getVendorWithdrawalRequestDetail,
  listVendorWithdrawalRequests,
  getConfiguredAdminEmails,
  isConfiguredAdminEmail,
  parseShipmentRegistrationInput,
  sanitizeVendorReturnTo,
  serializeVendorProduct,
  syncShopifyInventoryQuantity,
  updateVendorWithdrawalReturnInfo,
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
  assert.equal(receivedGraphQLCall.apiVersion, "2026-04");
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
      shippingAddressRows: [],
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
                  name: "Taro Yamada",
                  zip: "100-0001",
                  country: "Japan",
                  province: "Tōkyō",
                  city: "千代田区",
                  address1: "千代田",
                  address2: "1-1-1",
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
  assert.equal(receivedGraphQLCall.apiVersion, "2026-04");
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
  assert.equal(result.orders[0].shippingAddressSummary, "東京都千代田区");
  assert.deepEqual(result.orders[0].shippingAddressLines, [
    "〒100-0001",
    "東京都千代田区",
    "千代田 1-1-1",
    "Taro Yamada 様",
  ]);
  assert.deepEqual(result.orders[0].shippingAddressRows, [
    { label: "宛名", value: "Taro Yamada 様" },
    { label: "郵便番号", value: "100-0001" },
    { label: "国/地域", value: "日本" },
    { label: "都道府県", value: "東京都" },
    { label: "市区町村", value: "千代田区" },
    { label: "住所1", value: "千代田" },
    { label: "住所2", value: "1-1-1" },
  ]);
  assert.equal(result.orders[0].canRegisterShipment, true);
});

test("getVendorOrdersPageData can read mapped orders from seller orders behind flag", async () => {
  let receivedGraphQLCall = null;
  let receivedSellerOrderQuery = null;
  let ledgerQueryCount = 0;
  const result = await getVendorOrdersPageData(
    {
      storeId: "store_1",
    },
    {
      listVendorStoreShopDomainsImpl: async () => ["shop-a.myshopify.com"],
      listGrantedAppAccessScopesImpl: async () => [READ_ORDERS_SCOPE],
      useSellerOrderRead: true,
      prismaClient: {
        sellerOrder: {
          findMany: async (query) => {
            receivedSellerOrderQuery = query;
            return [
              {
                id: "seller_order_1",
                shopifyOrderId: "gid://shopify/Order/1001",
                shopifyOrderName: "#1001",
                sellerRefundAmount: 0,
                sellerNetAmount: 8400,
                sellerPayableAmount: 8400,
                currencyCode: "jpy",
                paymentStatus: "paid",
                fulfillmentStatus: "unfulfilled",
                createdAt: new Date("2026-04-29T08:35:00Z"),
                updatedAt: new Date("2026-04-29T08:36:00Z"),
                shipments: [
                  {
                    id: "seller_shipment_1",
                    shopifyFulfillmentId: "gid://shopify/Fulfillment/7001",
                    trackingNumber: "JP123456789",
                    trackingCompany: "Japan Post",
                    trackingUrl: "https://example.com/track/JP123456789",
                    status: "registered",
                    shippedAt: new Date("2026-04-29T09:00:00Z"),
                    createdAt: new Date("2026-04-29T09:00:00Z"),
                  },
                ],
              },
            ];
          },
        },
        ledgerEntry: {
          findMany: async () => {
            ledgerQueryCount += 1;
            return [];
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
                  name: "Taro Yamada",
                  zip: "100-0001",
                  country: "Japan",
                  province: "Tokyo",
                  city: "Chiyoda",
                  address1: "1-1-1",
                  address2: "1-1-1",
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

  assert.deepEqual(receivedSellerOrderQuery.where, {
    vendorStoreId: "store_1",
  });
  assert.equal(ledgerQueryCount, 0);
  assert.equal(receivedGraphQLCall.shopDomain, "shop-a.myshopify.com");
  assert.deepEqual(receivedGraphQLCall.variables, {
    ids: ["gid://shopify/Order/1001"],
  });
  assert.equal(result.accessState.status, "ready");
  assert.equal(result.queryString, "seller_order:shadow");
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].id, "gid://shopify/Order/1001");
  assert.equal(result.orders[0].ledgerPaidAmount, 8400);
  assert.equal(result.orders[0].ledgerRefundAmount, 0);
  assert.equal(result.orders[0].ledgerNetAmount, 8400);
  assert.equal(result.orders[0].trackingLabel, "Japan Post: JP123456789");
  assert.equal(
    result.orders[0].trackingUrl,
    "https://example.com/track/JP123456789",
  );
  assert.equal(result.orders[0].canRegisterShipment, true);
});

test("listVendorWithdrawalRequests returns only requests linked to the vendor seller orders", async () => {
  const sellerOrders = [
    {
      id: "seller_order_1",
      marketplaceOrderId: "marketplace_order_1",
      shopifyOrderId: "gid://shopify/Order/1001",
      lines: [
        {
          id: "seller_line_1",
          shopifyLineItemId: "gid://shopify/LineItem/line_1",
          shopifyProductId: "gid://shopify/Product/1001",
          shopifyVariantId: "gid://shopify/ProductVariant/2001",
          productId: "product_1",
          title: "Vendor product",
          quantity: 1,
        },
      ],
    },
  ];
  const withdrawalRequests = [
    {
      id: "withdrawal_1",
      marketplaceOrderId: "marketplace_order_1",
      shopifyOrderId: "gid://shopify/Order/1001",
      shopifyOrderName: "#1001",
      customerName: "Taro",
      customerEmail: "taro@example.com",
      withdrawalScope: "FULL",
      status: "RETURN_REQUESTED",
      eligibilityStatus: "ELIGIBLE",
      returnRequirementStatus: "WAITING",
      returnConditionStatus: "UNDECIDED",
      submittedPayloadJson: {},
      selectedLineItemsJson: {},
      orderSnapshotJson: {},
      createdAt: new Date("2026-07-10T00:00:00Z"),
      updatedAt: new Date("2026-07-10T00:00:00Z"),
    },
    {
      id: "withdrawal_other",
      marketplaceOrderId: "marketplace_order_2",
      shopifyOrderId: "gid://shopify/Order/2001",
      customerName: "Other",
      customerEmail: "other@example.com",
      withdrawalScope: "FULL",
      status: "REQUESTED",
      eligibilityStatus: "ELIGIBLE",
      returnRequirementStatus: "UNDECIDED",
      returnConditionStatus: "UNDECIDED",
      submittedPayloadJson: {},
      selectedLineItemsJson: {},
      orderSnapshotJson: {},
      createdAt: new Date("2026-07-10T00:00:00Z"),
      updatedAt: new Date("2026-07-10T00:00:00Z"),
    },
  ];
  const prismaClient = {
    sellerOrder: {
      findMany: async (query) => {
        assert.deepEqual(query.where, { vendorStoreId: "store_1" });
        return sellerOrders;
      },
    },
    withdrawalRequest: {
      findMany: async (query) => {
        assert.deepEqual(query.where.OR, [
          { shopifyOrderId: { in: ["gid://shopify/Order/1001"] } },
          { marketplaceOrderId: { in: ["marketplace_order_1"] } },
        ]);
        return withdrawalRequests;
      },
    },
  };

  const result = await listVendorWithdrawalRequests(
    { storeId: "store_1" },
    { prismaClient },
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "withdrawal_1");
  assert.equal(result[0].shopifyOrderName, "#1001");
  assert.equal(result[0].statusLabel, "返送待ち");
});

test("updateVendorWithdrawalReturnInfo verifies vendor access and records return info", async () => {
  const withdrawalRequest = {
    id: "withdrawal_1",
    marketplaceOrderId: "marketplace_order_1",
    shopifyOrderId: "gid://shopify/Order/1001",
    shopifyOrderName: "#1001",
    customerName: "Taro",
    customerEmail: "taro@example.com",
    withdrawalScope: "PARTIAL",
    status: "RETURN_REQUESTED",
    eligibilityStatus: "ELIGIBLE",
    returnRequirementStatus: "WAITING",
    returnConditionStatus: "UNDECIDED",
    submittedPayloadJson: {},
    selectedLineItemsJson: {
      selectedLineItems: ["gid://shopify/LineItem/line_1"],
    },
    orderSnapshotJson: {},
    statusHistory: [],
    emailLogs: [],
    createdAt: new Date("2026-07-10T00:00:00Z"),
    updatedAt: new Date("2026-07-10T00:00:00Z"),
  };
  const sellerOrders = [
    {
      id: "seller_order_1",
      marketplaceOrderId: "marketplace_order_1",
      shopifyOrderId: "gid://shopify/Order/1001",
      sellerPayableAmount: 1000,
      sellerRefundAmount: 0,
      currencyCode: "jpy",
      fulfillmentStatus: "fulfilled",
      lines: [
        {
          id: "seller_line_1",
          shopifyLineItemId: "gid://shopify/LineItem/line_1",
          shopifyProductId: "gid://shopify/Product/1001",
          shopifyVariantId: "gid://shopify/ProductVariant/2001",
          productId: "product_1",
          title: "Vendor product",
          quantity: 1,
          netAmount: 1000,
          currencyCode: "jpy",
        },
        {
          id: "seller_line_2",
          shopifyLineItemId: "gid://shopify/LineItem/line_2",
          shopifyProductId: "gid://shopify/Product/1002",
          shopifyVariantId: "gid://shopify/ProductVariant/2002",
          productId: "product_2",
          title: "Unselected product",
          quantity: 1,
          netAmount: 500,
          currencyCode: "jpy",
        },
      ],
    },
  ];
  const statusHistory = [];
  const prismaClient = {
    withdrawalRequest: {
      findUnique: async ({ include }) => {
        if (include) {
          return {
            ...withdrawalRequest,
            statusHistory,
            emailLogs: [],
          };
        }

        return withdrawalRequest;
      },
      update: async ({ data }) => {
        Object.assign(withdrawalRequest, data);
        return {
          ...withdrawalRequest,
        };
      },
    },
    sellerOrder: {
      findMany: async () => sellerOrders,
    },
    withdrawalRequestStatusHistory: {
      create: async ({ data }) => {
        statusHistory.push(data);
        return data;
      },
    },
    $transaction: async (callback) =>
      callback({
        withdrawalRequest: prismaClient.withdrawalRequest,
        withdrawalRequestStatusHistory:
          prismaClient.withdrawalRequestStatusHistory,
      }),
  };
  const formData = new FormData();
  formData.set("returnRequirementStatus", "CONDITION_CHECKED");
  formData.set("returnConditionStatus", "UNUSED_OK");
  formData.set("returnTrackingCompany", "Japan Post");
  formData.set("returnTrackingNumber", "TEST123456789JP");
  formData.set("returnReceivedAt", "2026-07-10");
  formData.set("returnConditionNotes", "問題なし");

  const detail = await getVendorWithdrawalRequestDetail(
    { storeId: "store_1", withdrawalRequestId: "withdrawal_1" },
    { prismaClient },
  );
  assert.equal(detail.withdrawalRequest.id, "withdrawal_1");
  assert.equal(detail.sellerOrders[0].lines.length, 1);
  assert.equal(detail.sellerOrders[0].lines[0].id, "seller_line_1");

  const result = await updateVendorWithdrawalReturnInfo(
    {
      storeId: "store_1",
      withdrawalRequestId: "withdrawal_1",
      formData,
    },
    { prismaClient },
  );

  assert.equal(result.ok, true);
  assert.equal(withdrawalRequest.returnRequirementStatus, "CONDITION_CHECKED");
  assert.equal(withdrawalRequest.returnConditionStatus, "UNUSED_OK");
  assert.equal(withdrawalRequest.returnTrackingNumber, "TEST123456789JP");
  assert.equal(withdrawalRequest.returnInfoUpdatedBy, "vendor:store_1");
  assert.equal(statusHistory.at(-1).reason, "return_info_updated");
  assert.equal(statusHistory.at(-1).changedBy, "vendor:store_1");
});

test("getVendorOrdersPageData marks fully refunded SellerOrder rows as not shippable", async () => {
  let ledgerQueryCount = 0;
  const result = await getVendorOrdersPageData(
    {
      storeId: "store_1",
    },
    {
      listVendorStoreShopDomainsImpl: async () => ["shop-a.myshopify.com"],
      listGrantedAppAccessScopesImpl: async () => [READ_ORDERS_SCOPE],
      useSellerOrderRead: true,
      prismaClient: {
        sellerOrder: {
          findMany: async () => [
            {
              id: "seller_order_1",
              shopifyOrderId: "gid://shopify/Order/1001",
              shopifyOrderName: "#1001",
              sellerRefundAmount: 8400,
              sellerNetAmount: 8400,
              sellerPayableAmount: 8400,
              currencyCode: "jpy",
              paymentStatus: "refunded",
              fulfillmentStatus: "unfulfilled",
              createdAt: new Date("2026-04-29T08:35:00Z"),
              updatedAt: new Date("2026-04-29T08:36:00Z"),
              shipments: [],
            },
          ],
        },
        ledgerEntry: {
          findMany: async () => {
            ledgerQueryCount += 1;
            return [];
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
              shippingAddress: null,
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

  assert.equal(ledgerQueryCount, 0);
  assert.equal(result.accessState.status, "ready");
  assert.equal(result.queryString, "seller_order:shadow");
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].financialStatus, "REFUNDED");
  assert.equal(result.orders[0].ledgerPaidAmount, 8400);
  assert.equal(result.orders[0].ledgerRefundAmount, 8400);
  assert.equal(result.orders[0].ledgerNetAmount, 0);
  assert.equal(result.orders[0].canRegisterShipment, false);
});

test("getVendorOrdersPageData falls back to ledger when SellerOrder read fails", async () => {
  let ledgerQueryCount = 0;
  const result = await getVendorOrdersPageData(
    {
      storeId: "store_1",
    },
    {
      listVendorStoreShopDomainsImpl: async () => ["shop-a.myshopify.com"],
      listGrantedAppAccessScopesImpl: async () => [READ_ORDERS_SCOPE],
      useSellerOrderRead: true,
      prismaClient: {
        sellerOrder: {
          findMany: async () => {
            throw new Error("SELLER_ORDER_TABLE_UNAVAILABLE");
          },
        },
        ledgerEntry: {
          findMany: async (query) => {
            ledgerQueryCount += 1;
            if (query.where.entryType === "refund") {
              return [];
            }

            return [
              {
                id: "ledger_1",
                entryType: "shopify_order_paid",
                stripeObjectId: "gid://shopify/Order/1001",
                amount: 8400,
                currencyCode: "jpy",
                metadataJson: { shopifyOrderName: "#1001" },
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
              displayFinancialStatus: "PAID",
              displayFulfillmentStatus: "UNFULFILLED",
              customer: { displayName: "Taro Yamada" },
              shippingAddress: null,
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

  assert.equal(result.accessState.status, "ready");
  assert.equal(result.queryString, "ledger:shopify_order_paid");
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].shopifyOrderNumber, "#1001");
  assert.equal(ledgerQueryCount, 2);
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
    sellerOrderId: null,
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

test("createVendorOrderFulfillment limits SellerOrder shipments to matching line items", async () => {
  const calls = [];
  const lineUpdates = [];
  let sellerOrderUpdate = null;
  let sellerShipmentCreate = null;

  const result = await createVendorOrderFulfillment({
    storeId: "store_1",
    vendorHandle: "amber-cellar",
    shipment: {
      orderId: "gid://shopify/Order/1001",
      sellerOrderId: "seller_order_1",
      trackingNumber: "JP123456789",
      trackingCompany: "Japan Post",
      trackingUrl: null,
      notifyCustomer: false,
    },
    listVendorStoreShopDomainsImpl: async () => ["shop-a.myshopify.com"],
    prismaClient: {
      sellerOrder: {
        findFirst: async (query) => {
          assert.deepEqual(query.where, {
            id: "seller_order_1",
            vendorStoreId: "store_1",
            shopifyOrderId: "gid://shopify/Order/1001",
          });

          return {
            id: "seller_order_1",
            shopifyOrderId: "gid://shopify/Order/1001",
            sellerRefundAmount: 0,
            sellerNetAmount: 2000,
            sellerPayableAmount: 2000,
            currencyCode: "jpy",
            paymentStatus: "paid",
            fulfillmentStatus: "unfulfilled",
            metadataJson: {},
            lines: [
              {
                id: "seller_order_line_1",
                shopifyLineItemId: "gid://shopify/LineItem/line-1",
                quantity: 2,
                fulfilledQuantity: 0,
                refundedQuantity: 0,
              },
            ],
          };
        },
        update: async (query) => {
          sellerOrderUpdate = query;
          return query.data;
        },
      },
      sellerOrderLine: {
        update: async (query) => {
          lineUpdates.push(query);
          return query.data;
        },
      },
      sellerShipment: {
        create: async (query) => {
          sellerShipmentCreate = query;
          return { id: "seller_shipment_1" };
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
                    lineItems: {
                      nodes: [
                        {
                          id: "gid://shopify/FulfillmentOrderLineItem/fo-line-1",
                          remainingQuantity: 2,
                          totalQuantity: 2,
                          lineItem: {
                            id: "gid://shopify/LineItem/line-1",
                          },
                        },
                        {
                          id: "gid://shopify/FulfillmentOrderLineItem/fo-line-2",
                          remainingQuantity: 1,
                          totalQuantity: 1,
                          lineItem: {
                            id: "gid://shopify/LineItem/line-2",
                          },
                        },
                      ],
                    },
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
  assert.deepEqual(calls[1].variables.fulfillment.lineItemsByFulfillmentOrder, [
    {
      fulfillmentOrderId: "gid://shopify/FulfillmentOrder/9001",
      fulfillmentOrderLineItems: [
        {
          id: "gid://shopify/FulfillmentOrderLineItem/fo-line-1",
          quantity: 2,
        },
      ],
    },
  ]);
  assert.deepEqual(lineUpdates, [
    {
      where: {
        id: "seller_order_line_1",
      },
      data: {
        fulfilledQuantity: 2,
      },
    },
  ]);
  assert.equal(sellerOrderUpdate.where.id, "seller_order_1");
  assert.equal(sellerOrderUpdate.data.fulfillmentStatus, "fulfilled");
  assert.deepEqual(sellerShipmentCreate.data, {
    sellerOrderId: "seller_order_1",
    shopifyFulfillmentId: "gid://shopify/Fulfillment/7001",
    trackingNumber: "JP123456789",
    trackingCompany: "Japan Post",
    trackingUrl: null,
    status: "registered",
    shippedAt: sellerShipmentCreate.data.shippedAt,
    metadataJson: {
      source: "vendor_portal",
    },
    lines: {
      create: [
        {
          sellerOrderLineId: "seller_order_line_1",
          shopifyLineItemId: "gid://shopify/LineItem/line-1",
          shopifyFulfillmentOrderId: "gid://shopify/FulfillmentOrder/9001",
          shopifyFulfillmentOrderLineItemId:
            "gid://shopify/FulfillmentOrderLineItem/fo-line-1",
          quantity: 2,
        },
      ],
    },
  });
  assert.equal(
    sellerOrderUpdate.data.metadataJson.lastShipment.fulfillmentId,
    "gid://shopify/Fulfillment/7001",
  );
  assert.equal(
    sellerOrderUpdate.data.metadataJson.lastShipment.sellerShipmentId,
    "seller_shipment_1",
  );
  assert.equal(
    sellerOrderUpdate.data.metadataJson.lastShipment.trackingNumber,
    "JP123456789",
  );
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

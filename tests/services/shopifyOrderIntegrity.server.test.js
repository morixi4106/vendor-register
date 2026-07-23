import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileRecentShopifyOrderIntegrity,
  reconcileShopifyOrderIntegrity,
  shopifyOrderToIntegrityPayload,
} from "../../app/services/shopifyOrderIntegrity.server.js";
import { POST_ORDER_ELIGIBILITY_TRIGGER } from "../../app/services/saleEligibility.server.js";

function order(overrides = {}) {
  return {
    id: "gid://shopify/Order/100",
    name: "#100",
    createdAt: "2026-07-24T00:00:00.000Z",
    processedAt: "2026-07-24T00:01:00.000Z",
    updatedAt: "2026-07-24T00:02:00.000Z",
    cancelledAt: null,
    currencyCode: "JPY",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    email: "buyer@example.test",
    customAttributes: [],
    shippingAddress: { countryCodeV2: "JP" },
    billingAddress: null,
    lineItems: {
      nodes: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Item",
          quantity: 3,
          currentQuantity: 2,
          requiresShipping: true,
          sku: "SKU-1",
          customAttributes: [{ key: "localProductId", value: "product-1" }],
          product: { id: "gid://shopify/Product/1" },
          variant: { id: "gid://shopify/ProductVariant/1" },
          originalUnitPriceSet: {
            shopMoney: { amount: "100", currencyCode: "JPY" },
          },
          discountedTotalSet: {
            shopMoney: { amount: "180", currencyCode: "JPY" },
          },
        },
      ],
      pageInfo: { hasNextPage: false },
    },
    ...overrides,
  };
}

test("canonical Shopify order is converted using current quantity and discount", () => {
  const payload = shopifyOrderToIntegrityPayload(order());
  assert.equal(payload.line_items.length, 1);
  assert.equal(payload.line_items[0].quantity, 2);
  assert.equal(payload.line_items[0].price, "100");
  assert.equal(payload.line_items[0].total_discount, "20");
  assert.equal(payload.shipping_address.country_code, "JP");
});

test("order reconciliation refetches canonical state and invokes integrity-only settlement", async () => {
  const calls = [];
  const result = await reconcileShopifyOrderIntegrity(
    {
      shopDomain: "example.myshopify.com",
      shopifyOrderId: "gid://shopify/Order/100",
      triggerType: POST_ORDER_ELIGIBILITY_TRIGGER.ORDERS_EDITED,
    },
    {
      graphQL: async () => ({ data: { order: order() } }),
      processPaidSettlement: async (input, options) => {
        calls.push({ input, options });
        return { ok: true, quarantined: false };
      },
      prismaClient: {},
    },
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.integrityOnly, true);
  assert.equal(calls[0].options.verifyOrderTimeProjection, false);
  assert.equal(
    calls[0].options.integrityTrigger,
    POST_ORDER_ELIGIBILITY_TRIGGER.ORDERS_EDITED,
  );
});

test("order reconciliation fails closed when more than 250 lines exist", async () => {
  const result = await reconcileShopifyOrderIntegrity(
    {
      shopDomain: "example.myshopify.com",
      shopifyOrderId: "gid://shopify/Order/100",
    },
    {
      graphQL: async () => ({
        data: {
          order: order({
            lineItems: {
              nodes: order().lineItems.nodes,
              pageInfo: { hasNextPage: true },
            },
          }),
        },
      }),
      processPaidSettlement: async () => {
        throw new Error("must not run");
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "shopify_order_line_items_incomplete");
});

test("periodic reconciliation is bounded and records failures", async () => {
  const reconciled = [];
  const heartbeats = [];
  const prismaClient = {
    operationalHeartbeat: {
      async upsert({ create, update }) {
        heartbeats.push({ create, update });
        return create;
      },
    },
  };
  const result = await reconcileRecentShopifyOrderIntegrity(
    {
      shopDomain: "example.myshopify.com",
      lookbackHours: 999,
      limit: 2,
    },
    {
      prismaClient,
      now: new Date("2026-07-24T12:00:00.000Z"),
      graphQL: async ({ variables }) => {
        assert.match(variables.query, /^updated_at:>=/);
        return {
          data: {
            orders: {
              nodes: [
                {
                  id: "gid://shopify/Order/1",
                  displayFinancialStatus: "PAID",
                  displayFulfillmentStatus: "UNFULFILLED",
                  cancelledAt: null,
                },
                {
                  id: "gid://shopify/Order/2",
                  displayFinancialStatus: "PAID",
                  displayFulfillmentStatus: "UNFULFILLED",
                  cancelledAt: null,
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      },
      reconcileOrder: async ({ shopifyOrderId }) => {
        reconciled.push(shopifyOrderId);
        return {
          ok: shopifyOrderId.endsWith("/1"),
          shopifyOrderId,
          reason: shopifyOrderId.endsWith("/1") ? null : "failed",
        };
      },
    },
  );

  assert.equal(result.scanned, 2);
  assert.equal(result.failedCount, 1);
  assert.equal(result.ok, false);
  assert.deepEqual(reconciled, [
    "gid://shopify/Order/1",
    "gid://shopify/Order/2",
  ]);
  assert.equal(heartbeats.length, 1);
});

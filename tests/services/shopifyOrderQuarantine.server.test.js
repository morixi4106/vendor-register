import assert from "node:assert/strict";
import test from "node:test";

import {
  applyShopifyOrderQuarantine,
  SHOPIFY_ORDER_QUARANTINE,
} from "../../app/services/shopifyOrderQuarantine.server.js";

test("applyShopifyOrderQuarantine tags the order and holds every fulfillment order", async () => {
  const calls = [];
  const result = await applyShopifyOrderQuarantine(
    {
      shopDomain: "example.myshopify.com",
      shopifyOrderId: "gid://shopify/Order/100",
      operationalCaseId: "case_100",
      requiresShipping: true,
    },
    {
      graphQL: async ({ query, variables }) => {
        calls.push({ query, variables });
        if (query.includes("OrderFulfillmentOrdersForQuarantine")) {
          return {
            data: {
              order: {
                id: variables.id,
                fulfillmentOrders: {
                  nodes: [
                    {
                      id: "gid://shopify/FulfillmentOrder/1",
                      status: "OPEN",
                      fulfillmentHolds: [],
                    },
                    {
                      id: "gid://shopify/FulfillmentOrder/2",
                      status: "OPEN",
                      fulfillmentHolds: [],
                    },
                  ],
                },
              },
            },
          };
        }
        if (query.includes("TagQuarantinedOrder")) {
          return {
            data: {
              tagsAdd: {
                node: { id: variables.id },
                userErrors: [],
              },
            },
          };
        }
        return {
          data: {
            fulfillmentOrderHold: {
              fulfillmentHold: {
                id: `hold:${variables.id}`,
                handle: variables.fulfillmentHold.handle,
                heldByRequestingApp: true,
                reason: "OTHER",
                reasonNotes: variables.fulfillmentHold.reasonNotes,
              },
              fulfillmentOrder: {
                id: variables.id,
                status: "ON_HOLD",
              },
              userErrors: [],
            },
          },
        };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.tag.tag, SHOPIFY_ORDER_QUARANTINE.tag);
  assert.equal(result.fulfillmentOrders.length, 2);
  assert.equal(
    result.fulfillmentOrders.every((entry) => entry.holdId),
    true,
  );
  assert.equal(
    calls.filter((entry) => entry.query.includes("HoldFulfillmentOrder"))
      .length,
    2,
  );
});

test("applyShopifyOrderQuarantine reuses an app hold with the same handle", async () => {
  let holdMutationCount = 0;
  const result = await applyShopifyOrderQuarantine(
    {
      shopDomain: "example.myshopify.com",
      shopifyOrderId: "gid://shopify/Order/101",
      requiresShipping: true,
    },
    {
      graphQL: async ({ query, variables }) => {
        if (query.includes("OrderFulfillmentOrdersForQuarantine")) {
          return {
            data: {
              order: {
                id: variables.id,
                fulfillmentOrders: {
                  nodes: [
                    {
                      id: "gid://shopify/FulfillmentOrder/3",
                      status: "ON_HOLD",
                      fulfillmentHolds: [
                        {
                          id: "gid://shopify/FulfillmentHold/3",
                          handle: SHOPIFY_ORDER_QUARANTINE.holdHandle,
                          heldByRequestingApp: true,
                          reason: "OTHER",
                        },
                      ],
                    },
                  ],
                },
              },
            },
          };
        }
        if (query.includes("TagQuarantinedOrder")) {
          return {
            data: {
              tagsAdd: { node: { id: variables.id }, userErrors: [] },
            },
          };
        }
        holdMutationCount += 1;
        return { data: {} };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.fulfillmentOrders[0].alreadyApplied, true);
  assert.equal(holdMutationCount, 0);
});

test("applyShopifyOrderQuarantine reports partial failure when one hold fails", async () => {
  const result = await applyShopifyOrderQuarantine(
    {
      shopDomain: "example.myshopify.com",
      shopifyOrderId: "gid://shopify/Order/102",
      requiresShipping: true,
    },
    {
      graphQL: async ({ query, variables }) => {
        if (query.includes("OrderFulfillmentOrdersForQuarantine")) {
          return {
            data: {
              order: {
                id: variables.id,
                fulfillmentOrders: {
                  nodes: [
                    {
                      id: "gid://shopify/FulfillmentOrder/4",
                      status: "OPEN",
                      fulfillmentHolds: [],
                    },
                  ],
                },
              },
            },
          };
        }
        if (query.includes("TagQuarantinedOrder")) {
          return {
            data: {
              tagsAdd: { node: { id: variables.id }, userErrors: [] },
            },
          };
        }
        return {
          data: {
            fulfillmentOrderHold: {
              fulfillmentHold: null,
              fulfillmentOrder: { id: variables.id, status: "OPEN" },
              userErrors: [
                { field: ["id"], message: "The order cannot be held." },
              ],
            },
          },
        };
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "PARTIAL_FAILURE");
  assert.equal(result.tag.ok, true);
  assert.equal(result.fulfillmentOrders[0].ok, false);
});

test("applyShopifyOrderQuarantine pages fulfillment orders and persists every hold id", async () => {
  const persisted = [];
  let lookupCount = 0;
  const result = await applyShopifyOrderQuarantine(
    {
      shopDomain: "example.myshopify.com",
      shopifyOrderId: "gid://shopify/Order/103",
      operationalCaseId: "case-103",
      requiresShipping: true,
    },
    {
      prismaClient: {
        shopifyOrderQuarantineHold: {
          async upsert(args) {
            persisted.push(args);
            return args.create;
          },
        },
      },
      graphQL: async ({ query, variables }) => {
        if (query.includes("OrderFulfillmentOrdersForQuarantine")) {
          lookupCount += 1;
          const id = `gid://shopify/FulfillmentOrder/${lookupCount}`;
          return {
            data: {
              order: {
                id: variables.id,
                fulfillmentOrders: {
                  nodes: [
                    {
                      id,
                      status: "OPEN",
                      fulfillmentHolds: [],
                    },
                  ],
                  pageInfo:
                    lookupCount === 1
                      ? { hasNextPage: true, endCursor: "next-page" }
                      : { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        }
        if (query.includes("TagQuarantinedOrder")) {
          return {
            data: {
              tagsAdd: { node: { id: variables.id }, userErrors: [] },
            },
          };
        }
        return {
          data: {
            fulfillmentOrderHold: {
              fulfillmentHold: {
                id: `hold:${variables.id}`,
                handle: variables.fulfillmentHold.handle,
                heldByRequestingApp: true,
                reason: "OTHER",
              },
              fulfillmentOrder: { id: variables.id, status: "ON_HOLD" },
              userErrors: [],
            },
          },
        };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(lookupCount, 2);
  assert.equal(result.fulfillmentOrders.length, 2);
  assert.equal(persisted.length, 2);
  assert.ok(
    persisted.every((entry) =>
      entry.create.fulfillmentHoldId.startsWith("hold:"),
    ),
  );
});

test("terminal fulfillment orders remain an explicit partial failure", async () => {
  const persisted = [];
  const result = await applyShopifyOrderQuarantine(
    {
      shopDomain: "example.myshopify.com",
      shopifyOrderId: "gid://shopify/Order/104",
      requiresShipping: true,
    },
    {
      prismaClient: {
        shopifyOrderQuarantineHold: {
          async upsert(args) {
            persisted.push(args);
            return args.create;
          },
        },
      },
      graphQL: async ({ query, variables }) => {
        if (query.includes("OrderFulfillmentOrdersForQuarantine")) {
          return {
            data: {
              order: {
                id: variables.id,
                fulfillmentOrders: {
                  nodes: [
                    {
                      id: "gid://shopify/FulfillmentOrder/closed",
                      status: "CLOSED",
                      fulfillmentHolds: [],
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        }
        return {
          data: {
            tagsAdd: { node: { id: variables.id }, userErrors: [] },
          },
        };
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "PARTIAL_FAILURE");
  assert.equal(result.terminalFulfillmentOrderCount, 1);
  assert.equal(persisted[0].create.status, "TERMINAL_UNPROTECTED");
});

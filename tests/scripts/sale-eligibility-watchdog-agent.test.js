import assert from "node:assert/strict";
import test from "node:test";

import {
  enforceDirectShopifyPurchaseBlock,
  runSaleEligibilityWatchdogAgent,
} from "../../scripts/sale-eligibility-watchdog-agent.mjs";

test("watchdog agent calls the authenticated internal endpoint once", async () => {
  const calls = [];
  const result = await runSaleEligibilityWatchdogAgent({
    env: {
      LAUNCH_MONITOR_URL: "https://example.test",
      SALE_ELIGIBILITY_WATCHDOG_TOKEN: "x".repeat(48),
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          ok: true,
          protected: false,
          action: "none",
          status: "healthy",
          code: null,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  });

  assert.equal(result.status, "healthy");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://example.test/internal/sale-eligibility-watchdog",
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${"x".repeat(48)}`);
});

test("watchdog agent fails closed for an invalid endpoint response", async () => {
  await assert.rejects(
    runSaleEligibilityWatchdogAgent({
      env: {
        APP_URL: "https://example.test",
        SALE_ELIGIBILITY_WATCHDOG_TOKEN: "x".repeat(48),
      },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ok: false,
            protected: false,
            action: "emergency_hold_failed",
            status: "critical",
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        ),
    }),
    /sale_eligibility_watchdog_request_failed/,
  );
});

test("independent watchdog unpublishes products and verifies the publication boundary", async () => {
  let productScanCount = 0;
  let unpublishCount = 0;
  const token = "watchdog-token-".repeat(4);

  const result = await enforceDirectShopifyPurchaseBlock({
    env: {
      SHOPIFY_WATCHDOG_SHOP_DOMAIN: "example.myshopify.com",
      SHOPIFY_WATCHDOG_ADMIN_ACCESS_TOKEN: token,
    },
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers["X-Shopify-Access-Token"], token);
      const body = JSON.parse(init.body);
      if (body.query.includes("ExternalWatchdogPurchaseControl")) {
        return Response.json({
          data: {
            shop: {
              id: "gid://shopify/Shop/1",
              metafield: { value: "BLOCKED" },
            },
          },
        });
      }
      if (body.query.includes("ExternalWatchdogProductsForEmergencyStop")) {
        productScanCount += 1;
        return Response.json({
          data: {
            products: {
              nodes:
                productScanCount === 1
                  ? [
                      {
                        id: "gid://shopify/Product/1",
                        appPublications: {
                          nodes: [
                            {
                              isPublished: true,
                              publishDate: null,
                              publication: {
                                id: "gid://shopify/Publication/1",
                              },
                            },
                          ],
                          pageInfo: { hasNextPage: false },
                        },
                        marketPublications: {
                          nodes: [],
                          pageInfo: { hasNextPage: false },
                        },
                        companyLocationPublications: {
                          nodes: [],
                          pageInfo: { hasNextPage: false },
                        },
                        uncatalogedPublications: {
                          nodes: [],
                          pageInfo: { hasNextPage: false },
                        },
                      },
                    ]
                  : [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (body.query.includes("ExternalWatchdogUnpublishProduct")) {
        unpublishCount += 1;
        assert.deepEqual(body.variables.input, [
          { publicationId: "gid://shopify/Publication/1" },
        ]);
        return Response.json({
          data: {
            publishableUnpublish: {
              userErrors: [],
            },
          },
        });
      }
      throw new Error("unexpected GraphQL operation");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.protected, true);
  assert.equal(result.publicationStop.protected, true);
  assert.equal(result.publicationStop.unpublishedProductCount, 1);
  assert.equal(unpublishCount, 1);
});

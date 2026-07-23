import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireShopifyWatchdogAccessToken,
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

test("watchdog obtains a short-lived token and validates its scopes", async () => {
  const calls = [];
  const result = await acquireShopifyWatchdogAccessToken({
    shopDomain: "example.myshopify.com",
    env: {
      SHOPIFY_WATCHDOG_CLIENT_ID: "watchdog-client-id",
      SHOPIFY_WATCHDOG_CLIENT_SECRET: "watchdog-client-secret-value",
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({
        access_token: "short-lived-watchdog-token",
        scope: "read_products,read_publications,write_publications",
        expires_in: 86399,
      });
    },
  });

  assert.equal(
    calls[0].url,
    "https://example.myshopify.com/admin/oauth/access_token",
  );
  assert.equal(
    calls[0].init.headers["Content-Type"],
    "application/x-www-form-urlencoded",
  );
  assert.equal(
    String(calls[0].init.body),
    "grant_type=client_credentials&client_id=watchdog-client-id&client_secret=watchdog-client-secret-value",
  );
  assert.equal(result.accessToken, "short-lived-watchdog-token");
  assert.equal(result.expiresIn, 86399);
});

test("watchdog refuses a token with missing publication scopes", async () => {
  await assert.rejects(
    acquireShopifyWatchdogAccessToken({
      shopDomain: "example.myshopify.com",
      env: {
        SHOPIFY_WATCHDOG_CLIENT_ID: "watchdog-client-id",
        SHOPIFY_WATCHDOG_CLIENT_SECRET: "watchdog-client-secret-value",
      },
      fetchImpl: async () =>
        Response.json({
          access_token: "short-lived-watchdog-token",
          scope: "read_products",
          expires_in: 86399,
        }),
    }),
    /watchdog_scope_set_mismatch/,
  );
});

test("watchdog refuses a token with privileges outside the dedicated scope set", async () => {
  await assert.rejects(
    acquireShopifyWatchdogAccessToken({
      shopDomain: "example.myshopify.com",
      env: {
        SHOPIFY_WATCHDOG_CLIENT_ID: "watchdog-client-id",
        SHOPIFY_WATCHDOG_CLIENT_SECRET: "watchdog-client-secret-value",
      },
      fetchImpl: async () =>
        Response.json({
          access_token: "short-lived-watchdog-token",
          scope:
            "read_products,read_publications,write_publications,write_orders",
          expires_in: 86_399,
        }),
    }),
    /watchdog_scope_set_mismatch/,
  );
});

test("critical unprotected internal status triggers the direct Shopify stop", async () => {
  const calls = [];
  const result = await runSaleEligibilityWatchdogAgent({
    env: {
      LAUNCH_MONITOR_URL: "https://app.example.test",
      SALE_ELIGIBILITY_WATCHDOG_TOKEN: "x".repeat(48),
      SHOPIFY_WATCHDOG_SHOP_DOMAIN: "example.myshopify.com",
      SHOPIFY_WATCHDOG_CLIENT_ID: "watchdog-client-id",
      SHOPIFY_WATCHDOG_CLIENT_SECRET: "watchdog-client-secret-value",
    },
    fetchImpl: async (url, init) => {
      calls.push(String(url));
      if (
        String(url) ===
        "https://app.example.test/internal/sale-eligibility-watchdog"
      ) {
        return Response.json({
          ok: true,
          protected: false,
          action: "emergency_hold_applied",
          status: "critical",
          code: "shopify_control_capability_lost",
        });
      }
      if (String(url).endsWith("/admin/oauth/access_token")) {
        return Response.json({
          access_token: "short-lived-watchdog-token",
          scope: "read_products,read_publications,write_publications",
          expires_in: 86399,
        });
      }
      const body = JSON.parse(init.body);
      if (body.query.includes("ExternalWatchdogPurchaseControl")) {
        return Response.json({
          data: {
            shop: {
              id: "gid://shopify/Shop/1",
              watchdogPurchaseStop: { value: "BLOCKED" },
            },
          },
        });
      }
      if (body.query.includes("ExternalWatchdogProductsForEmergencyStop")) {
        return Response.json({
          data: {
            products: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      throw new Error("unexpected request");
    },
  });

  assert.equal(result.status, "critical");
  assert.equal(result.protected, true);
  assert.equal(result.fallback, true);
  assert.ok(calls.includes("https://example.myshopify.com/admin/oauth/access_token"));
});

test("independent watchdog unpublishes products and verifies the publication boundary", async () => {
  let productScanCount = 0;
  let unpublishCount = 0;
  const token = "short-lived-watchdog-token";

  const result = await enforceDirectShopifyPurchaseBlock({
    env: {
      SHOPIFY_WATCHDOG_SHOP_DOMAIN: "example.myshopify.com",
      SHOPIFY_WATCHDOG_CLIENT_ID: "watchdog-client-id",
      SHOPIFY_WATCHDOG_CLIENT_SECRET: "watchdog-client-secret-value",
    },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/admin/oauth/access_token")) {
        return Response.json({
          access_token: token,
          scope: "read_products,read_publications,write_publications",
          expires_in: 86399,
        });
      }
      assert.equal(init.headers["X-Shopify-Access-Token"], token);
      const body = JSON.parse(init.body);
      if (body.query.includes("ExternalWatchdogPurchaseControl")) {
        return Response.json({
          data: {
            shop: {
              id: "gid://shopify/Shop/1",
              watchdogPurchaseStop: { value: "BLOCKED" },
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
  assert.equal(result.sharedVetoProtected, true);
  assert.equal(result.publicationStop.protected, true);
  assert.equal(result.publicationStop.unpublishedProductCount, 1);
  assert.equal(unpublishCount, 1);
});

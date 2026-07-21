import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETPLACE_CHECKOUT_BOUNDARY_MODE,
  MARKETPLACE_CHECKOUT_POLICY,
  activateMarketplaceCheckoutGate,
  backfillMarketplaceCheckoutPolicies,
  enforceUnresolvedShopifyProductPublicationBoundary,
  resolveMarketplaceCheckoutPolicy,
  syncMarketplaceCheckoutPolicyForProduct,
} from "../../app/services/marketplaceCheckoutGate.server.js";

function createProduct(overrides = {}) {
  return {
    id: "product_1",
    shopDomain: "shop-a.myshopify.com",
    shopifyProductId: "gid://shopify/Product/1",
    vendorStore: {
      id: "store_1",
      isPlatformStore: false,
      isTestStore: false,
    },
    complianceProfile: { legalSellerType: "VENDOR" },
    ...overrides,
  };
}

function createPrismaMock({ products = [], unresolvedIssues = [] } = {}) {
  return {
    product: {
      findMany: async () => products,
      findUnique: async () => products[0] || null,
    },
    shopifyProductSyncIssue: {
      findMany: async () => unresolvedIssues,
    },
  };
}

function publicationResponse() {
  return {
    data: {
      publications: {
        nodes: [
          {
            id: "gid://shopify/Publication/1",
            supportsFuturePublishing: true,
          },
        ],
      },
    },
  };
}

test("resolveMarketplaceCheckoutPolicy only permits explicit platform-direct products", () => {
  assert.equal(
    resolveMarketplaceCheckoutPolicy(createProduct()),
    MARKETPLACE_CHECKOUT_POLICY.GOVERNED,
  );
  assert.equal(
    resolveMarketplaceCheckoutPolicy(
      createProduct({
        vendorStore: {
          id: "platform",
          isPlatformStore: true,
          isTestStore: false,
        },
      }),
    ),
    MARKETPLACE_CHECKOUT_POLICY.PLATFORM_DIRECT,
  );
});

test("governed products are removed from the Online Store publication", async () => {
  const product = createProduct();
  let unpublishVariables = null;
  const result = await syncMarketplaceCheckoutPolicyForProduct(
    { product },
    {
      prismaClient: createPrismaMock({ products: [product] }),
      graphQL: async ({ query, variables }) => {
        if (query.includes("MarketplaceCheckoutPublications")) {
          return publicationResponse();
        }
        if (query.includes("query MarketplaceCheckoutProductPolicy")) {
          return {
            data: {
              product: {
                id: product.shopifyProductId,
                metafield: {
                  value: MARKETPLACE_CHECKOUT_POLICY.GOVERNED,
                },
                publishedOnPublication: true,
              },
            },
          };
        }
        if (query.includes("UnpublishMarketplaceProduct")) {
          unpublishVariables = variables;
          return {
            data: {
              publishableUnpublish: {
                publishable: {
                  availablePublicationsCount: { count: 0 },
                },
                userErrors: [],
              },
            },
          };
        }
        throw new Error("Unexpected GraphQL operation");
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.policyChanged, false);
  assert.equal(result.boundary.publishedOnOnlineStore, false);
  assert.deepEqual(unpublishVariables, {
    id: product.shopifyProductId,
    input: [{ publicationId: "gid://shopify/Publication/1" }],
  });
});

test("platform-direct products keep standard publication eligibility", async () => {
  const product = createProduct({
    vendorStore: {
      id: "platform",
      isPlatformStore: true,
      isTestStore: false,
    },
  });
  let mutationVariables = null;
  const result = await syncMarketplaceCheckoutPolicyForProduct(
    { product },
    {
      prismaClient: createPrismaMock({ products: [product] }),
      graphQL: async ({ query, variables }) => {
        if (query.includes("MarketplaceCheckoutPublications")) {
          return publicationResponse();
        }
        if (query.includes("query MarketplaceCheckoutProductPolicy")) {
          return {
            data: {
              product: {
                id: product.shopifyProductId,
                metafield: null,
                publishedOnPublication: true,
              },
            },
          };
        }
        if (query.includes("SetMarketplaceCheckoutProductPolicy")) {
          mutationVariables = variables;
          return {
            data: {
              metafieldsSet: {
                metafields: [{ id: "gid://shopify/Metafield/1" }],
                userErrors: [],
              },
            },
          };
        }
        throw new Error("Unexpected GraphQL operation");
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.policy, MARKETPLACE_CHECKOUT_POLICY.PLATFORM_DIRECT);
  assert.equal(result.boundary.changed, false);
  assert.equal(result.boundary.publishedOnOnlineStore, true);
  assert.equal(
    mutationVariables.metafields[0].value,
    MARKETPLACE_CHECKOUT_POLICY.PLATFORM_DIRECT,
  );
  assert.equal(mutationVariables.metafields[0].namespace, "$app");
});

test("unresolved Shopify products fail closed by being unpublished", async () => {
  let unpublished = false;
  const result = await enforceUnresolvedShopifyProductPublicationBoundary(
    {
      shopDomain: "shop-a.myshopify.com",
      shopifyProductId: "2",
    },
    {
      graphQL: async ({ query }) => {
        if (query.includes("MarketplaceCheckoutPublications")) {
          return publicationResponse();
        }
        if (query.includes("query MarketplaceCheckoutProductPolicy")) {
          return {
            data: {
              product: {
                id: "gid://shopify/Product/2",
                metafield: null,
                publishedOnPublication: true,
              },
            },
          };
        }
        if (query.includes("UnpublishMarketplaceProduct")) {
          unpublished = true;
          return {
            data: {
              publishableUnpublish: {
                publishable: null,
                userErrors: [],
              },
            },
          };
        }
        throw new Error("Unexpected GraphQL operation");
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(unpublished, true);
});

test("backfill secures unresolved mappings instead of merely counting them", async () => {
  const result = await backfillMarketplaceCheckoutPolicies(
    "shop-a.myshopify.com",
    {
      prismaClient: createPrismaMock({
        unresolvedIssues: [
          { id: "issue_1", shopifyProductId: "gid://shopify/Product/2" },
        ],
      }),
      graphQL: async ({ query }) => {
        if (query.includes("MarketplaceCheckoutPublications")) {
          return publicationResponse();
        }
        if (query.includes("query MarketplaceCheckoutProductPolicy")) {
          return {
            data: {
              product: {
                id: "gid://shopify/Product/2",
                metafield: null,
                publishedOnPublication: false,
              },
            },
          };
        }
        throw new Error("Unexpected GraphQL operation");
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.mode, MARKETPLACE_CHECKOUT_BOUNDARY_MODE);
  assert.equal(result.unresolvedIssueCount, 1);
  assert.equal(result.unresolvedSecuredCount, 1);
});

test("activation verifies the publication boundary after synchronization", async () => {
  const product = createProduct();
  const prismaClient = createPrismaMock({ products: [product] });
  const graphQL = async ({ query }) => {
    if (query.includes("MarketplaceCheckoutPublications")) {
      return publicationResponse();
    }
    if (query.includes("query MarketplaceCheckoutProductPolicy")) {
      return {
        data: {
          product: {
            id: product.shopifyProductId,
            metafield: { value: MARKETPLACE_CHECKOUT_POLICY.GOVERNED },
            publishedOnPublication: false,
          },
        },
      };
    }
    throw new Error("Unexpected GraphQL operation");
  };

  const result = await activateMarketplaceCheckoutGate(
    "shop-a.myshopify.com",
    { prismaClient, graphQL },
  );

  assert.equal(result.ok, true);
  assert.equal(result.boundary.active, true);
  assert.equal(result.boundary.mode, MARKETPLACE_CHECKOUT_BOUNDARY_MODE);
});

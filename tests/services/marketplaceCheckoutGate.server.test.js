import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETPLACE_CHECKOUT_BOUNDARY_MODE,
  MARKETPLACE_CHECKOUT_POLICY,
  activateMarketplaceCheckoutGate,
  backfillMarketplaceCheckoutPolicies,
  enforceShopifyResourcePublicationBoundary,
  enforceUnresolvedShopifyProductPublicationBoundary,
  getMarketplaceCheckoutGateStatus,
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

function publicationConnection(ids = []) {
  return {
    nodes: ids.map((id) => ({
      isPublished: true,
      publishDate: null,
      publication: { id },
    })),
    pageInfo: { hasNextPage: false },
  };
}

function productState(product, ids = [], policy = null) {
  return {
    id: product.shopifyProductId,
    metafield: policy ? { value: policy } : null,
    resourcePublicationsV2: publicationConnection(ids),
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
  assert.equal(
    resolveMarketplaceCheckoutPolicy(
      createProduct({
        vendorStore: {
          id: "test-store",
          isPlatformStore: false,
          isTestStore: true,
        },
      }),
    ),
    MARKETPLACE_CHECKOUT_POLICY.GOVERNED,
  );
  assert.equal(
    resolveMarketplaceCheckoutPolicy(
      createProduct({
        vendorStore: {
          id: "misconfigured-test-store",
          isPlatformStore: true,
          isTestStore: true,
        },
      }),
    ),
    MARKETPLACE_CHECKOUT_POLICY.GOVERNED,
  );
});

test("governed products are removed from every attached publication", async () => {
  const product = createProduct();
  const publicationIds = [
    "gid://shopify/Publication/1",
    "gid://shopify/Publication/2",
  ];
  let publishableReadCount = 0;
  let unpublishVariables = null;

  const result = await syncMarketplaceCheckoutPolicyForProduct(
    { product },
    {
      prismaClient: createPrismaMock({ products: [product] }),
      graphQL: async ({ query, variables }) => {
        if (query.includes("query MarketplaceCheckoutProductPolicy")) {
          return {
            data: {
              product: productState(
                product,
                publicationIds,
                MARKETPLACE_CHECKOUT_POLICY.GOVERNED,
              ),
            },
          };
        }
        if (query.includes("MarketplaceCheckoutPublishableState")) {
          publishableReadCount += 1;
          return {
            data: {
              node: {
                id: product.shopifyProductId,
                resourcePublicationsV2: publicationConnection(
                  publishableReadCount === 1 ? publicationIds : [],
                ),
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
  assert.deepEqual(result.boundary.remainingPublicationIds, []);
  assert.deepEqual(unpublishVariables, {
    id: product.shopifyProductId,
    input: publicationIds.map((publicationId) => ({ publicationId })),
  });
});

test("governed products are removed from app, market, and company catalogs", async () => {
  const product = createProduct();
  const publicationIds = [
    "gid://shopify/Publication/app",
    "gid://shopify/Publication/market",
    "gid://shopify/Publication/company",
  ];
  let publishableReadCount = 0;
  let unpublishInput = null;

  const result = await syncMarketplaceCheckoutPolicyForProduct(
    { product },
    {
      prismaClient: createPrismaMock({ products: [product] }),
      graphQL: async ({ query, variables }) => {
        if (query.includes("query MarketplaceCheckoutProductPolicy")) {
          return {
            data: {
              product: {
                id: product.shopifyProductId,
                metafield: {
                  value: MARKETPLACE_CHECKOUT_POLICY.GOVERNED,
                },
                appPublications: publicationConnection([publicationIds[0]]),
                marketPublications: publicationConnection([
                  publicationIds[1],
                ]),
                companyLocationPublications: publicationConnection([
                  publicationIds[2],
                ]),
              },
            },
          };
        }
        if (query.includes("MarketplaceCheckoutPublishableState")) {
          publishableReadCount += 1;
          return {
            data: {
              node: {
                id: product.shopifyProductId,
                appPublications: publicationConnection(
                  publishableReadCount === 1 ? [publicationIds[0]] : [],
                ),
                marketPublications: publicationConnection(
                  publishableReadCount === 1 ? [publicationIds[1]] : [],
                ),
                companyLocationPublications: publicationConnection(
                  publishableReadCount === 1 ? [publicationIds[2]] : [],
                ),
              },
            },
          };
        }
        if (query.includes("UnpublishMarketplaceProduct")) {
          unpublishInput = variables.input;
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
  assert.deepEqual(unpublishInput, [
    { publicationId: publicationIds[0] },
    { publicationId: publicationIds[1] },
    { publicationId: publicationIds[2] },
  ]);
  assert.deepEqual(result.boundary.remainingPublicationIds, []);
});

test("platform-direct products keep their attached publications", async () => {
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
        if (query.includes("query MarketplaceCheckoutProductPolicy")) {
          return {
            data: {
              product: productState(product, [
                "gid://shopify/Publication/1",
              ]),
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
  assert.deepEqual(result.boundary.publicationIds, [
    "gid://shopify/Publication/1",
  ]);
  assert.equal(
    mutationVariables.metafields[0].value,
    MARKETPLACE_CHECKOUT_POLICY.PLATFORM_DIRECT,
  );
});

test("unresolved Shopify products fail closed across publications", async () => {
  let stateReadCount = 0;
  let unpublishInput = null;
  const result = await enforceUnresolvedShopifyProductPublicationBoundary(
    {
      shopDomain: "shop-a.myshopify.com",
      shopifyProductId: "2",
    },
    {
      graphQL: async ({ query, variables }) => {
        if (query.includes("MarketplaceCheckoutPublishableState")) {
          stateReadCount += 1;
          return {
            data: {
              node: {
                id: "gid://shopify/Product/2",
                resourcePublicationsV2: publicationConnection(
                  stateReadCount === 1
                    ? [
                        "gid://shopify/Publication/1",
                        "gid://shopify/Publication/2",
                      ]
                    : [],
                ),
              },
            },
          };
        }
        if (query.includes("UnpublishMarketplaceProduct")) {
          unpublishInput = variables.input;
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
  assert.equal(unpublishInput.length, 2);
});

test("boundary verification fails when a publication remains attached", async () => {
  await assert.rejects(
    enforceShopifyResourcePublicationBoundary(
      {
        shopDomain: "shop-a.myshopify.com",
        resourceId: "gid://shopify/Product/2",
      },
      {
        graphQL: async ({ query }) => {
          if (query.includes("MarketplaceCheckoutPublishableState")) {
            return {
              data: {
                node: {
                  id: "gid://shopify/Product/2",
                  resourcePublicationsV2: publicationConnection([
                    "gid://shopify/Publication/1",
                  ]),
                },
              },
            };
          }
          if (query.includes("UnpublishMarketplaceProduct")) {
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
    ),
    (error) => error.reason === "publication_boundary_verification_failed",
  );
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
        if (query.includes("MarketplaceCheckoutPublishableState")) {
          return {
            data: {
              node: {
                id: "gid://shopify/Product/2",
                resourcePublicationsV2: publicationConnection([]),
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

test("production gate requires an explicit Online Store publication ID", async () => {
  const status = await getMarketplaceCheckoutGateStatus(
    "shop-a.myshopify.com",
    {
      prismaClient: createPrismaMock(),
      graphQL: async () => {
        throw new Error("GraphQL must not be called");
      },
      env: { NODE_ENV: "production" },
    },
  );

  assert.equal(status.publicationConfigurationReady, false);
  assert.equal(status.active, false);
});

test("activation verifies the all-publication boundary after synchronization", async () => {
  const product = createProduct();
  const prismaClient = createPrismaMock({ products: [product] });
  const graphQL = async ({ query }) => {
    if (query.includes("query MarketplaceCheckoutProductPolicy")) {
      return {
        data: {
          product: productState(
            product,
            [],
            MARKETPLACE_CHECKOUT_POLICY.GOVERNED,
          ),
        },
      };
    }
    if (query.includes("MarketplaceCheckoutPublishableState")) {
      return {
        data: {
          node: {
            id: product.shopifyProductId,
            resourcePublicationsV2: publicationConnection([]),
          },
        },
      };
    }
    if (query.includes("MarketplaceCheckoutPublications")) {
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
    throw new Error("Unexpected GraphQL operation");
  };

  const result = await activateMarketplaceCheckoutGate(
    "shop-a.myshopify.com",
    { prismaClient, graphQL, env: { NODE_ENV: "test" } },
  );

  assert.equal(result.ok, true);
  assert.equal(result.boundary.active, true);
  assert.equal(result.boundary.mode, MARKETPLACE_CHECKOUT_BOUNDARY_MODE);
});

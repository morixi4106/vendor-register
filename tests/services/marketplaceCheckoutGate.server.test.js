import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETPLACE_CHECKOUT_BOUNDARY_MODE,
  MARKETPLACE_CHECKOUT_POLICY,
  activateMarketplaceCheckoutGate,
  backfillMarketplaceCheckoutPolicies,
  clearSharedWatchdogPurchaseVeto,
  enforceShopifyResourcePublicationBoundary,
  enforceUnresolvedShopifyProductPublicationBoundary,
  getMarketplaceCheckoutGateStatus,
  resolveMarketplaceCheckoutPolicy,
  syncMarketplaceCheckoutPolicyForProduct,
} from "../../app/services/marketplaceCheckoutGate.server.js";

test("shared watchdog veto is cleared with compare-and-set verification", async () => {
  const calls = [];
  const responses = [
    {
      data: {
        shop: {
          id: "gid://shopify/Shop/1",
          watchdogPurchaseStop: {
            value: "BLOCKED",
            compareDigest: "digest-before",
          },
        },
      },
    },
    {
      data: {
        metafieldsSet: {
          metafields: [{ id: "gid://shopify/Metafield/1" }],
          userErrors: [],
        },
      },
    },
    {
      data: {
        shop: {
          id: "gid://shopify/Shop/1",
          watchdogPurchaseStop: {
            value: "CLEARED",
            compareDigest: "digest-after",
          },
        },
      },
    },
  ];
  const graphQL = async (input) => {
    calls.push(input);
    return responses.shift();
  };

  const result = await clearSharedWatchdogPurchaseVeto(
    { shopDomain: "shop-a.myshopify.com" },
    { graphQL },
  );

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.state, "CLEARED");
  assert.equal(calls[1].variables.metafields[0].namespace, "vendor_register_watchdog");
  assert.equal(calls[1].variables.metafields[0].key, "purchase_stop");
  assert.equal(calls[1].variables.metafields[0].compareDigest, "digest-before");
});

function createProduct(overrides = {}) {
  return {
    id: "product_1",
    approvalStatus: "approved",
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
  assert.equal(
    resolveMarketplaceCheckoutPolicy(
      createProduct({
        vendorStore: {
          id: "platform",
          isPlatformStore: true,
          isTestStore: false,
        },
        complianceProfile: {
          legalSellerType: "PLATFORM",
          approvalStatus: "HOLD",
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

test("governed products are removed from app, market, company, and uncataloged publications", async () => {
  const product = createProduct();
  const publicationIds = [
    "gid://shopify/Publication/app",
    "gid://shopify/Publication/market",
    "gid://shopify/Publication/company",
    "gid://shopify/Publication/none",
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
                uncatalogedPublications: publicationConnection([
                  publicationIds[3],
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
                uncatalogedPublications: publicationConnection(
                  publishableReadCount === 1 ? [publicationIds[3]] : [],
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
    { publicationId: publicationIds[3] },
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
  assert.equal(mutationVariables.metafields[0].compareDigest, null);
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

test("platform product sync persists and verifies a versioned eligibility projection", async () => {
  const product = createProduct({
    vendorStoreId: "platform-store",
    vendorStore: {
      id: "platform-store",
      isPlatformStore: true,
      isTestStore: false,
    },
    complianceProfile: {
      legalSellerType: "PLATFORM",
      approvalStatus: "PENDING",
    },
    complianceEvidence: [],
    complianceDecisions: [],
  });
  let storedProjection = null;
  let mutationProjectionInput = null;
  let projectionInput = null;
  const prismaClient = {
    ...createPrismaMock({ products: [product] }),
    saleEligibilityProjection: {
      async upsert(args) {
        projectionInput = args;
        return {
          projectionRevision: 7,
          expiresAt: args.create.expiresAt,
        };
      },
    },
  };
  const graphQL = async ({ query, variables }) => {
    if (query.includes("query MarketplaceCheckoutProductPolicy")) {
      return {
        data: {
          product: {
            ...productState(
              product,
              [],
              MARKETPLACE_CHECKOUT_POLICY.PLATFORM_DIRECT,
            ),
            saleEligibilityProjection: storedProjection
              ? { value: storedProjection }
              : null,
          },
        },
      };
    }
    if (query.includes("SetMarketplaceCheckoutProductPolicy")) {
      const projection = variables.metafields.find(
        (entry) => entry.key === "sale_eligibility_projection",
      );
      mutationProjectionInput = projection;
      storedProjection = projection.value;
      return {
        data: {
          metafieldsSet: {
            metafields: variables.metafields.map((entry, index) => ({
              id: `gid://shopify/Metafield/${index + 1}`,
              key: entry.key,
              value: entry.value,
            })),
            userErrors: [],
          },
        },
      };
    }
    throw new Error("Unexpected GraphQL operation");
  };

  const result = await syncMarketplaceCheckoutPolicyForProduct(
    { product },
    {
      prismaClient,
      graphQL,
      env: { MARKETPLACE_GOVERNANCE_GATE_ENABLED: "false" },
      isPlatformCheckoutHoldActiveImpl: async () => false,
    },
  );

  const projection = JSON.parse(storedProjection);
  assert.equal(result.ok, true);
  assert.equal(result.policy, MARKETPLACE_CHECKOUT_POLICY.PLATFORM_DIRECT);
  assert.equal(result.projectionRevision, 7);
  assert.equal(projection.v, 2);
  assert.equal(projection.c, "PLATFORM_DIRECT");
  assert.equal(projection.a, true);
  assert.equal(projection.p, "sale-eligibility-2026-07-v1");
  assert.equal(projection.r, 7);
  assert.match(projection.h, /^[a-f0-9]{64}$/);
  assert.ok(projection.d);
  assert.ok(projection.e);
  assert.equal(mutationProjectionInput.compareDigest, null);
  assert.equal(projectionInput.update.projectionRevision.increment, 1);
});

test("product webhooks reuse same-day projections and refresh stale daily proof", async () => {
  const product = createProduct({
    vendorStoreId: "platform-store",
    vendorStore: {
      id: "platform-store",
      isPlatformStore: true,
      isTestStore: false,
    },
    complianceProfile: {
      legalSellerType: "PLATFORM",
      approvalStatus: "PENDING",
    },
    complianceEvidence: [],
    complianceDecisions: [],
  });
  let currentProjection = null;
  let storedProjection = null;
  let upsertCount = 0;
  let revisionCount = 0;
  let mutationCount = 0;
  const prismaClient = {
    ...createPrismaMock({ products: [product] }),
    async $transaction(callback) {
      return callback(this);
    },
    saleEligibilityProjection: {
      async findUnique() {
        return currentProjection;
      },
      async upsert(args) {
        upsertCount += 1;
        currentProjection = {
          id: "projection-1",
          ...args.create,
          projectionRevision:
            Number(currentProjection?.projectionRevision || 0) + 1,
        };
        return currentProjection;
      },
    },
    saleEligibilityProjectionRevision: {
      async create(args) {
        revisionCount += 1;
        return { id: `revision-${revisionCount}`, ...args.data };
      },
    },
  };
  const graphQL = async ({ query, variables }) => {
    if (query.includes("query MarketplaceCheckoutProductPolicy")) {
      return {
        data: {
          shop: { ianaTimezone: "Asia/Tokyo" },
          product: {
            ...productState(
              product,
              [],
              MARKETPLACE_CHECKOUT_POLICY.PLATFORM_DIRECT,
            ),
            saleEligibilityProjection: storedProjection
              ? { value: storedProjection, compareDigest: "projection-digest" }
              : null,
          },
        },
      };
    }
    if (query.includes("SetMarketplaceCheckoutProductPolicy")) {
      mutationCount += 1;
      const projection = variables.metafields.find(
        (entry) => entry.key === "sale_eligibility_projection",
      );
      storedProjection = projection.value;
      return {
        data: {
          metafieldsSet: {
            metafields: variables.metafields.map((entry, index) => ({
              id: `gid://shopify/Metafield/${index + 1}`,
              key: entry.key,
              value: entry.value,
            })),
            userErrors: [],
          },
        },
      };
    }
    throw new Error("Unexpected GraphQL operation");
  };
  const options = {
    prismaClient,
    graphQL,
    env: { MARKETPLACE_GOVERNANCE_GATE_ENABLED: "false" },
    isPlatformCheckoutHoldActiveImpl: async () => false,
  };

  const first = await syncMarketplaceCheckoutPolicyForProduct(
    { product },
    options,
  );
  const second = await syncMarketplaceCheckoutPolicyForProduct(
    { product },
    options,
  );

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.saleEligibility.projectionReused, true);
  assert.equal(upsertCount, 1);
  assert.equal(revisionCount, 1);
  assert.equal(mutationCount, 1);

  const staleProjection = JSON.parse(storedProjection);
  staleProjection.d = "2000-01-01";
  staleProjection.e = "2000-01-02";
  storedProjection = JSON.stringify(staleProjection);

  const refreshed = await syncMarketplaceCheckoutPolicyForProduct(
    { product },
    options,
  );

  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.saleEligibility.projectionReused, false);
  assert.equal(upsertCount, 2);
  assert.equal(revisionCount, 2);
  assert.equal(mutationCount, 2);
});

test("a stale eligible projection cannot overwrite a newer blocked revision", async () => {
  const product = createProduct({
    vendorStoreId: "platform-store",
    vendorStore: {
      id: "platform-store",
      isPlatformStore: true,
      isTestStore: false,
    },
    complianceProfile: {
      legalSellerType: "PLATFORM",
      approvalStatus: "PENDING",
    },
    complianceEvidence: [],
    complianceDecisions: [],
  });
  let policyMutations = 0;
  const prismaClient = {
    ...createPrismaMock({ products: [product] }),
    saleEligibilityProjection: {
      async upsert(args) {
        return {
          projectionRevision: 10,
          expiresAt: args.create.expiresAt,
        };
      },
      async findUnique() {
        return {
          projectionRevision: 11,
          status: "BLOCKED",
          inputHash: "b".repeat(64),
          policyVersion: "sale-eligibility-2026-07-v1",
          evaluatedAt: new Date("2026-07-24T01:00:00.000Z"),
          expiresAt: new Date("2026-07-25T03:00:00.000Z"),
        };
      },
    },
  };
  const graphQL = async ({ query }) => {
    if (query.includes("query MarketplaceCheckoutProductPolicy")) {
      return {
        data: {
          shop: { ianaTimezone: "Asia/Tokyo" },
          product: {
            ...productState(product, []),
            saleEligibilityProjection: null,
          },
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
    if (query.includes("SetMarketplaceCheckoutProductPolicy")) {
      policyMutations += 1;
      throw new Error("stale job must not write Shopify metafields");
    }
    throw new Error("Unexpected GraphQL operation");
  };

  const result = await syncMarketplaceCheckoutPolicyForProduct(
    { product },
    {
      prismaClient,
      graphQL,
      env: { MARKETPLACE_GOVERNANCE_GATE_ENABLED: "false" },
      isPlatformCheckoutHoldActiveImpl: async () => false,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "stale_projection_job");
  assert.equal(result.projectionRevision, 10);
  assert.equal(result.currentProjectionRevision, 11);
  assert.equal(policyMutations, 0);
});

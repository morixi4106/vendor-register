import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVendorCollectionHandle,
  buildVendorCollectionUrl,
} from "../../app/utils/vendorCollectionHandles.js";
import { syncVendorCollection } from "../../app/utils/vendorCollections.server.js";

function createVendor({ products, storeOverrides = {} }) {
  return {
    id: "vendor_1",
    handle: "vendor",
    storeName: "Test Store",
    status: "active",
    vendorStore: {
      id: "store_1",
      storeName: "Test Store",
      isPlatformStore: true,
      isTestStore: false,
      category: "Cosmetics",
      country: "Japan",
      address: "Tokyo",
      note: "Vendor note",
      products,
      ...storeOverrides,
    },
  };
}

function createPrisma(vendor) {
  return {
    vendor: {
      async findFirst() {
        return vendor;
      },
    },
    product: {
      async findUnique({ where }) {
        const product =
          vendor.vendorStore.products.find((entry) => entry.id === where.id) ||
          null;
        return product
          ? {
              ...product,
              vendorStore: {
                id: vendor.vendorStore.id,
                isPlatformStore: vendor.vendorStore.isPlatformStore,
                isTestStore: vendor.vendorStore.isTestStore,
              },
              complianceProfile: null,
            }
          : null;
      },
    },
  };
}

test("buildVendorCollectionHandle derives stable collection handles", () => {
  assert.equal(buildVendorCollectionHandle("vendor"), "vendor-vendor");
  assert.equal(buildVendorCollectionUrl("Vendor Store"), "/collections/vendor-vendor-store");
});

test("syncVendorCollection creates a manual collection and reports missing publication scopes", async () => {
  const calls = [];
  const vendor = createVendor({
    products: [
      {
        id: "product_1",
        name: "Linked Product",
        approvalStatus: "approved",
        shopifyProductId: "gid://shopify/Product/1",
        shopDomain: "shop-a.myshopify.com",
      },
      {
        id: "product_2",
        name: "Unlinked Product",
        approvalStatus: "approved",
        shopifyProductId: null,
        shopDomain: "shop-a.myshopify.com",
      },
      {
        id: "product_3",
        name: "Pending Product",
        approvalStatus: "pending",
        shopifyProductId: "gid://shopify/Product/3",
        shopDomain: "shop-a.myshopify.com",
      },
    ],
  });

  const result = await syncVendorCollection({
    vendorHandle: "vendor",
    prismaClient: createPrisma(vendor),
    shopifyGraphQLWithOfflineSessionImpl: async ({ query, variables, shopDomain }) => {
      calls.push({ query, variables, shopDomain });

      if (query.includes("CurrentAppInstallationAccessScopes")) {
        return {
          data: {
            currentAppInstallation: {
              accessScopes: [{ handle: "read_products" }, { handle: "write_products" }],
            },
          },
          shopDomain,
        };
      }

      if (query.includes("FindVendorCollection")) {
        return { data: { collections: { nodes: [] } }, shopDomain };
      }

      if (query.includes("CreateVendorCollection")) {
        assert.equal(variables.input.handle, "vendor-vendor");
        assert.deepEqual(variables.input.products, ["gid://shopify/Product/1"]);

        return {
          data: {
            collectionCreate: {
              collection: {
                id: "gid://shopify/Collection/1",
                handle: "vendor-vendor",
                title: "Test Store",
                products: {
                  nodes: [{ id: "gid://shopify/Product/1" }],
                },
              },
              userErrors: [],
            },
          },
          shopDomain,
        };
      }

      if (query.includes("SetVendorCollectionMetafields")) {
        assert.equal(variables.metafields[0].ownerId, "gid://shopify/Collection/1");
        assert.equal(variables.metafields[0].namespace, "custom");

        return {
          data: {
            metafieldsSet: {
              metafields: [],
              userErrors: [],
            },
          },
          shopDomain,
        };
      }

      throw new Error(`Unexpected query: ${query}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.collection.handle, "vendor-vendor");
  assert.equal(result.collection.url, "/collections/vendor-vendor");
  assert.equal(result.productCount, 1);
  assert.deepEqual(result.unsyncedProducts, [
    {
      id: "product_2",
      name: "Unlinked Product",
      reason: "missing_shopify_product_gid",
    },
  ]);
  assert.deepEqual(result.publish.missingScopes, ["read_publications", "write_publications"]);
  assert.deepEqual(result.productPublish.missingScopes, [
    "read_publications",
    "write_publications",
  ]);
  assert.equal(calls.some((call) => call.query.includes("VendorCollectionPublications")), false);
});

test("syncVendorCollection updates existing collection membership and publishes when scopes exist", async () => {
  const observed = {
    addProductIds: null,
    removeProductIds: null,
    publishCalls: [],
  };
  const vendor = createVendor({
    products: [
      {
        id: "product_1",
        name: "Keep Product",
        approvalStatus: "approved",
        shopifyProductId: "gid://shopify/Product/1",
        shopDomain: "shop-a.myshopify.com",
      },
      {
        id: "product_2",
        name: "New Product",
        approvalStatus: "approved",
        shopifyProductId: "gid://shopify/Product/2",
        shopDomain: "shop-a.myshopify.com",
      },
    ],
  });

  const result = await syncVendorCollection({
    vendorHandle: "vendor",
    configuredPublicationId: "gid://shopify/Publication/1",
    prismaClient: createPrisma(vendor),
    shopifyGraphQLWithOfflineSessionImpl: async ({ query, variables, shopDomain }) => {
      if (query.includes("CurrentAppInstallationAccessScopes")) {
        return {
          data: {
            currentAppInstallation: {
              accessScopes: [
                { handle: "read_products" },
                { handle: "write_products" },
                { handle: "read_publications" },
                { handle: "write_publications" },
              ],
            },
          },
          shopDomain,
        };
      }

      if (query.includes("FindVendorCollection")) {
        return {
          data: {
            collections: {
              nodes: [
                {
                  id: "gid://shopify/Collection/1",
                  handle: "vendor-vendor",
                  title: "Old title",
                  products: {
                    nodes: [
                      { id: "gid://shopify/Product/1" },
                      { id: "gid://shopify/Product/999" },
                    ],
                  },
                },
              ],
            },
          },
          shopDomain,
        };
      }

      if (query.includes("UpdateVendorCollection")) {
        return {
          data: {
            collectionUpdate: {
              collection: {
                id: "gid://shopify/Collection/1",
                handle: "vendor-vendor",
                title: "Test Store",
              },
              userErrors: [],
            },
          },
          shopDomain,
        };
      }

      if (query.includes("SetVendorCollectionMetafields")) {
        return {
          data: {
            metafieldsSet: {
              metafields: [],
              userErrors: [],
            },
          },
          shopDomain,
        };
      }

      if (query.includes("AddProductsToVendorCollection")) {
        observed.addProductIds = variables.productIds;
        return {
          data: {
            collectionAddProductsV2: {
              job: { id: "gid://shopify/Job/add", done: false },
              userErrors: [],
            },
          },
          shopDomain,
        };
      }

      if (query.includes("RemoveProductsFromVendorCollection")) {
        observed.removeProductIds = variables.productIds;
        return {
          data: {
            collectionRemoveProducts: {
              job: { id: "gid://shopify/Job/remove", done: false },
              userErrors: [],
            },
          },
          shopDomain,
        };
      }

      if (query.includes("PublishVendorResource")) {
        observed.publishCalls.push({
          id: variables.id,
          input: variables.input,
        });
        return {
          data: {
            publishablePublish: {
              publishable: {
                availablePublicationsCount: { count: 1 },
              },
              userErrors: [],
            },
          },
          shopDomain,
        };
      }

      throw new Error(`Unexpected query: ${query}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.collection.created, false);
  assert.deepEqual(observed.addProductIds, ["gid://shopify/Product/2"]);
  assert.deepEqual(observed.removeProductIds, ["gid://shopify/Product/999"]);
  assert.deepEqual(observed.publishCalls, [
    {
      id: "gid://shopify/Collection/1",
      input: [{ publicationId: "gid://shopify/Publication/1" }],
    },
    {
      id: "gid://shopify/Product/1",
      input: [{ publicationId: "gid://shopify/Publication/1" }],
    },
    {
      id: "gid://shopify/Product/2",
      input: [{ publicationId: "gid://shopify/Publication/1" }],
    },
  ]);
  assert.equal(result.publish.ok, true);
  assert.equal(result.productPublish.ok, true);
  assert.deepEqual(result.productPublish.productIds, [
    "gid://shopify/Product/1",
    "gid://shopify/Product/2",
  ]);
});

test("syncVendorCollection omits blank collection metafields", async () => {
  let metafields = null;
  const vendor = createVendor({
    storeOverrides: {
      category: "",
      country: null,
      address: "   ",
      note: null,
    },
    products: [
      {
        id: "product_1",
        name: "Linked Product",
        approvalStatus: "approved",
        shopifyProductId: "gid://shopify/Product/1",
        shopDomain: "shop-a.myshopify.com",
      },
    ],
  });

  const result = await syncVendorCollection({
    vendorHandle: "vendor",
    prismaClient: createPrisma(vendor),
    shopifyGraphQLWithOfflineSessionImpl: async ({ query, variables, shopDomain }) => {
      if (query.includes("CurrentAppInstallationAccessScopes")) {
        return {
          data: {
            currentAppInstallation: {
              accessScopes: [{ handle: "read_products" }, { handle: "write_products" }],
            },
          },
          shopDomain,
        };
      }

      if (query.includes("FindVendorCollection")) {
        return { data: { collections: { nodes: [] } }, shopDomain };
      }

      if (query.includes("CreateVendorCollection")) {
        return {
          data: {
            collectionCreate: {
              collection: {
                id: "gid://shopify/Collection/1",
                handle: "vendor-vendor",
                title: "Test Store",
                products: {
                  nodes: [{ id: "gid://shopify/Product/1" }],
                },
              },
              userErrors: [],
            },
          },
          shopDomain,
        };
      }

      if (query.includes("SetVendorCollectionMetafields")) {
        metafields = variables.metafields;

        return {
          data: {
            metafieldsSet: {
              metafields: [],
              userErrors: [],
            },
          },
          shopDomain,
        };
      }

      throw new Error(`Unexpected query: ${query}`);
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    metafields.map((metafield) => metafield.key),
    ["vendor_handle", "vendor_store_name"],
  );
  assert.equal(metafields.every((metafield) => metafield.value.trim()), true);
  assert.equal(metafields.some((metafield) => metafield.key === "vendor_note"), false);
});

test("syncVendorCollection keeps test-store collections and products off every sales channel", async () => {
  const unpublishedIds = [];
  const attachedPublicationIds = new Map([
    ["gid://shopify/Product/1", ["gid://shopify/Publication/1", "gid://shopify/Publication/2"]],
    ["gid://shopify/Collection/1", ["gid://shopify/Publication/1", "gid://shopify/Publication/2"]],
  ]);
  const vendor = createVendor({
    storeOverrides: {
      isPlatformStore: true,
      isTestStore: true,
    },
    products: [
      {
        id: "product_1",
        name: "Vendor Product",
        approvalStatus: "approved",
        shopifyProductId: "gid://shopify/Product/1",
        shopDomain: "shop-a.myshopify.com",
      },
    ],
  });

  const result = await syncVendorCollection({
    vendorHandle: "vendor",
    configuredPublicationId: "gid://shopify/Publication/1",
    prismaClient: createPrisma(vendor),
    shopifyGraphQLWithOfflineSessionImpl: async ({ query, variables, shopDomain }) => {
      if (query.includes("CurrentAppInstallationAccessScopes")) {
        return {
          data: {
            currentAppInstallation: {
              accessScopes: [
                { handle: "read_products" },
                { handle: "write_products" },
                { handle: "read_publications" },
                { handle: "write_publications" },
              ],
            },
          },
          shopDomain,
        };
      }
      if (query.includes("FindVendorCollection")) {
        return { data: { collections: { nodes: [] } }, shopDomain };
      }
      if (query.includes("CreateVendorCollection")) {
        return {
          data: {
            collectionCreate: {
              collection: {
                id: "gid://shopify/Collection/1",
                handle: "vendor-vendor",
                products: { nodes: [{ id: "gid://shopify/Product/1" }] },
              },
              userErrors: [],
            },
          },
          shopDomain,
        };
      }
      if (query.includes("SetVendorCollectionMetafields")) {
        return {
          data: { metafieldsSet: { metafields: [], userErrors: [] } },
          shopDomain,
        };
      }
      if (query.includes("MarketplaceCheckoutProductPolicy")) {
        return {
          data: {
            product: {
              id: variables.id,
              metafield: { value: "MARKETPLACE_GOVERNED" },
              resourcePublicationsV2: {
                nodes: (attachedPublicationIds.get(variables.id) || []).map(
                  (publicationId) => ({
                    isPublished: true,
                    publishDate: null,
                    publication: { id: publicationId },
                  }),
                ),
                pageInfo: { hasNextPage: false },
              },
            },
          },
          shopDomain,
        };
      }
      if (query.includes("MarketplaceCheckoutPublishableState")) {
        return {
          data: {
            node: {
              id: variables.id,
              resourcePublicationsV2: {
                nodes: (attachedPublicationIds.get(variables.id) || []).map(
                  (publicationId) => ({
                    isPublished: true,
                    publishDate: null,
                    publication: { id: publicationId },
                  }),
                ),
                pageInfo: { hasNextPage: false },
              },
            },
          },
          shopDomain,
        };
      }
      if (query.includes("UnpublishMarketplaceProduct")) {
        unpublishedIds.push(variables.id);
        attachedPublicationIds.set(variables.id, []);
        return {
          data: {
            publishableUnpublish: {
              publishable: { availablePublicationsCount: { count: 0 } },
              userErrors: [],
            },
          },
          shopDomain,
        };
      }
      throw new Error(`Unexpected query: ${query}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.storefrontMode, "APP_PROXY_DRAFT_ORDER");
  assert.equal(result.collection.url, "/apps/vendors/vendor");
  assert.deepEqual(unpublishedIds, [
    "gid://shopify/Product/1",
    "gid://shopify/Collection/1",
  ]);
});

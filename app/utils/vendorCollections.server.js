import prisma from "../db.server.js";
import {
  resolveShopDomain,
  shopifyGraphQLWithOfflineSession,
} from "./shopifyAdmin.server.js";
import {
  buildVendorCollectionHandle,
  buildVendorCollectionUrl,
  buildVendorProxyStorefrontUrl,
} from "./vendorCollectionHandles.js";
import {
  enforceShopifyResourcePublicationBoundary,
  syncMarketplaceCheckoutPolicyForProduct,
} from "../services/marketplaceCheckoutGate.server.js";
import { isPlatformCheckoutHoldActive } from "../services/operationalReadiness.server.js";

import { SHOPIFY_API_VERSION } from "./shopifyApiVersion.js";
const PRODUCT_PAGE_SIZE = 250;
const REQUIRED_PRODUCT_SCOPES = ["read_products", "write_products"];
const REQUIRED_PUBLICATION_SCOPES = ["read_publications", "write_publications"];

const CURRENT_APP_INSTALLATION_ACCESS_SCOPES_QUERY = `
  query CurrentAppInstallationAccessScopes {
    currentAppInstallation {
      accessScopes {
        handle
      }
    }
  }
`;

const FIND_VENDOR_COLLECTION_QUERY = `
  query FindVendorCollection($query: String!, $first: Int!) {
    collections(first: 1, query: $query) {
      nodes {
        id
        handle
        title
        products(first: $first) {
          nodes {
            id
          }
        }
      }
    }
  }
`;

const CREATE_VENDOR_COLLECTION_MUTATION = `
  mutation CreateVendorCollection($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection {
        id
        handle
        title
        products(first: 250) {
          nodes {
            id
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const UPDATE_VENDOR_COLLECTION_MUTATION = `
  mutation UpdateVendorCollection($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection {
        id
        handle
        title
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const SET_VENDOR_COLLECTION_METAFIELDS_MUTATION = `
  mutation SetVendorCollectionMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        key
        namespace
        value
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ADD_PRODUCTS_TO_COLLECTION_MUTATION = `
  mutation AddProductsToVendorCollection($id: ID!, $productIds: [ID!]!) {
    collectionAddProductsV2(id: $id, productIds: $productIds) {
      job {
        id
        done
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const REMOVE_PRODUCTS_FROM_COLLECTION_MUTATION = `
  mutation RemoveProductsFromVendorCollection($id: ID!, $productIds: [ID!]!) {
    collectionRemoveProducts(id: $id, productIds: $productIds) {
      job {
        id
        done
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const PUBLICATIONS_QUERY = `
  query VendorCollectionPublications {
    publications(first: 20) {
      nodes {
        id
        autoPublish
        supportsFuturePublishing
      }
    }
  }
`;

const PUBLISH_RESOURCE_MUTATION = `
  mutation PublishVendorResource($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      publishable {
        availablePublicationsCount {
          count
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function normalizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeShopifyProductGid(value) {
  const normalized = normalizeText(value);

  if (!normalized) return null;
  if (normalized.startsWith("gid://shopify/Product/")) return normalized;
  if (/^\d+$/.test(normalized)) return `gid://shopify/Product/${normalized}`;

  return null;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function getUserErrors(payload, key) {
  return payload?.[key]?.userErrors || payload?.[key]?.mediaUserErrors || [];
}

function assertNoUserErrors(payload, key) {
  const userErrors = getUserErrors(payload, key);

  if (userErrors.length > 0) {
    throw new Error(`${key} userErrors: ${JSON.stringify(userErrors)}`);
  }
}

function buildCollectionDescription(store) {
  const parts = [
    store?.category ? `カテゴリ: ${store.category}` : null,
    store?.country ? `国: ${store.country}` : null,
    store?.note || null,
  ].filter(Boolean);

  return parts.join("\n");
}

function buildCollectionMetafields({ collectionId, vendor, store }) {
  const fields = [
    ["vendor_handle", vendor.handle],
    ["vendor_store_name", store.storeName || vendor.storeName || vendor.handle],
    ["vendor_category", store.category],
    ["vendor_country", store.country],
    ["vendor_address", store.address],
    ["vendor_note", store.note],
  ];

  return fields.flatMap(([key, value]) => {
    const normalizedValue = normalizeText(value);

    if (!normalizedValue) return [];

    return [
      {
        ownerId: collectionId,
        namespace: "custom",
        key,
        type: "single_line_text_field",
        value: normalizedValue,
      },
    ];
  });
}

function getMissingScopes(grantedScopes, requiredScopes) {
  return requiredScopes.filter((scope) => !grantedScopes.includes(scope));
}

async function listGrantedScopes({
  shopDomain,
  shopifyGraphQLWithOfflineSessionImpl,
}) {
  const { data } = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: CURRENT_APP_INSTALLATION_ACCESS_SCOPES_QUERY,
  });

  return unique(
    (data?.currentAppInstallation?.accessScopes || []).map((scope) =>
      normalizeText(scope?.handle),
    ),
  ).sort();
}

async function loadVendorForCollectionSync({ vendorStoreId, vendorHandle, prismaClient }) {
  const where = vendorStoreId
    ? {
        vendorStore: {
          is: {
            id: vendorStoreId,
          },
        },
      }
    : { handle: vendorHandle };

  const vendor = await prismaClient.vendor.findFirst({
    where,
    include: {
      vendorStore: {
        include: {
          products: {
            include: {
              complianceProfile: {
                select: { approvalStatus: true },
              },
            },
            orderBy: { createdAt: "desc" },
          },
        },
      },
    },
  });

  if (!vendor || !vendor.vendorStore || vendor.status !== "active") {
    return null;
  }

  return vendor;
}

async function resolveCollectionShopDomain({ products, fallbackShopDomain }) {
  const productShopDomains = unique(
    products.map((product) => normalizeText(product.shopDomain)?.toLowerCase()),
  );

  if (productShopDomains.length > 1) {
    return {
      ok: false,
      reason: "ambiguous_shop",
      shopDomains: productShopDomains,
    };
  }

  try {
    return {
      ok: true,
      shopDomain: await resolveShopDomain(productShopDomains[0] || fallbackShopDomain),
      shopDomains: productShopDomains,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "missing_shop",
      error: error instanceof Error ? error.message : String(error),
      shopDomains: productShopDomains,
    };
  }
}

async function findVendorCollection({
  collectionHandle,
  shopDomain,
  shopifyGraphQLWithOfflineSessionImpl,
}) {
  const { data } = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: FIND_VENDOR_COLLECTION_QUERY,
    variables: {
      query: `handle:${collectionHandle}`,
      first: PRODUCT_PAGE_SIZE,
    },
  });

  const collection = data?.collections?.nodes?.[0] || null;

  return collection?.handle === collectionHandle ? collection : null;
}

async function createVendorCollection({
  collectionHandle,
  vendor,
  store,
  productIds,
  shopDomain,
  shopifyGraphQLWithOfflineSessionImpl,
}) {
  const { data } = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: CREATE_VENDOR_COLLECTION_MUTATION,
    variables: {
      input: {
        title: store.storeName || vendor.storeName || collectionHandle,
        handle: collectionHandle,
        descriptionHtml: buildCollectionDescription(store),
        products: productIds.slice(0, PRODUCT_PAGE_SIZE),
      },
    },
  });

  assertNoUserErrors(data, "collectionCreate");

  return data?.collectionCreate?.collection || null;
}

async function updateVendorCollection({
  collection,
  collectionHandle,
  vendor,
  store,
  shopDomain,
  shopifyGraphQLWithOfflineSessionImpl,
}) {
  const { data } = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: UPDATE_VENDOR_COLLECTION_MUTATION,
    variables: {
      input: {
        id: collection.id,
        title: store.storeName || vendor.storeName || collectionHandle,
        handle: collectionHandle,
        descriptionHtml: buildCollectionDescription(store),
      },
    },
  });

  assertNoUserErrors(data, "collectionUpdate");

  return {
    ...collection,
    ...(data?.collectionUpdate?.collection || {}),
    products: collection.products,
  };
}

async function setVendorCollectionMetafields({
  collectionId,
  vendor,
  store,
  shopDomain,
  shopifyGraphQLWithOfflineSessionImpl,
}) {
  const metafields = buildCollectionMetafields({ collectionId, vendor, store });

  if (metafields.length === 0) {
    return;
  }

  const { data } = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: SET_VENDOR_COLLECTION_METAFIELDS_MUTATION,
    variables: {
      metafields,
    },
  });

  assertNoUserErrors(data, "metafieldsSet");
}

async function syncCollectionProducts({
  collection,
  productIds,
  shopDomain,
  shopifyGraphQLWithOfflineSessionImpl,
}) {
  const currentProductIds = unique(
    (collection.products?.nodes || []).map((product) => normalizeShopifyProductGid(product.id)),
  );
  const targetProductIds = unique(productIds);
  const productSet = new Set(targetProductIds);
  const currentSet = new Set(currentProductIds);
  const addProductIds = targetProductIds.filter((productId) => !currentSet.has(productId));
  const removeProductIds = currentProductIds.filter((productId) => !productSet.has(productId));
  let addJob = null;
  let removeJob = null;

  if (addProductIds.length > 0) {
    const { data } = await shopifyGraphQLWithOfflineSessionImpl({
      shopDomain,
      apiVersion: SHOPIFY_API_VERSION,
      query: ADD_PRODUCTS_TO_COLLECTION_MUTATION,
      variables: {
        id: collection.id,
        productIds: addProductIds.slice(0, PRODUCT_PAGE_SIZE),
      },
    });

    assertNoUserErrors(data, "collectionAddProductsV2");
    addJob = data?.collectionAddProductsV2?.job || null;
  }

  if (removeProductIds.length > 0) {
    const { data } = await shopifyGraphQLWithOfflineSessionImpl({
      shopDomain,
      apiVersion: SHOPIFY_API_VERSION,
      query: REMOVE_PRODUCTS_FROM_COLLECTION_MUTATION,
      variables: {
        id: collection.id,
        productIds: removeProductIds.slice(0, PRODUCT_PAGE_SIZE),
      },
    });

    assertNoUserErrors(data, "collectionRemoveProducts");
    removeJob = data?.collectionRemoveProducts?.job || null;
  }

  return {
    addProductIds,
    removeProductIds,
    addJob,
    removeJob,
  };
}

async function findPublicationId({
  shopDomain,
  shopifyGraphQLWithOfflineSessionImpl,
  configuredPublicationId = process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID,
}) {
  const normalizedConfiguredId = normalizeText(configuredPublicationId);

  if (normalizedConfiguredId) {
    return {
      publicationId: normalizedConfiguredId,
      source: "env",
    };
  }

  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    return {
      publicationId: null,
      source: "missing_production_configuration",
    };
  }

  const { data } = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: PUBLICATIONS_QUERY,
  });

  const publications = data?.publications?.nodes || [];
  const publication =
    publications.find((entry) => entry.supportsFuturePublishing) || publications[0] || null;

  return {
    publicationId: publication?.id || null,
    source: publication ? "publications_query" : "none",
  };
}

async function publishVendorCollection({
  collectionId,
  shopDomain,
  shopifyGraphQLWithOfflineSessionImpl,
  configuredPublicationId,
}) {
  const { publicationId, source } = await findPublicationId({
    shopDomain,
    shopifyGraphQLWithOfflineSessionImpl,
    configuredPublicationId,
  });

  if (!publicationId) {
    return {
      ok: false,
      reason: "publication_not_found",
      source,
    };
  }

  const { data } = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: PUBLISH_RESOURCE_MUTATION,
    variables: {
      id: collectionId,
      input: [{ publicationId }],
    },
  });

  assertNoUserErrors(data, "publishablePublish");

  return {
    ok: true,
    publicationId,
    source,
    availablePublicationsCount:
      data?.publishablePublish?.publishable?.availablePublicationsCount?.count ?? null,
  };
}

async function publishVendorProducts({
  productIds,
  publicationId,
  source,
  shopDomain,
  shopifyGraphQLWithOfflineSessionImpl,
}) {
  const normalizedProductIds = unique(productIds);

  if (normalizedProductIds.length === 0) {
    return {
      ok: true,
      publicationId,
      source,
      productIds: [],
      errors: [],
    };
  }

  const publishedProductIds = [];
  const errors = [];

  for (const productId of normalizedProductIds) {
    try {
      const { data } = await shopifyGraphQLWithOfflineSessionImpl({
        shopDomain,
        apiVersion: SHOPIFY_API_VERSION,
        query: PUBLISH_RESOURCE_MUTATION,
        variables: {
          id: productId,
          input: [{ publicationId }],
        },
      });

      assertNoUserErrors(data, "publishablePublish");
      publishedProductIds.push(productId);
    } catch (error) {
      errors.push({
        productId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ok: errors.length === 0,
    reason: errors.length > 0 ? "product_publish_failed" : undefined,
    publicationId,
    source,
    productIds: publishedProductIds,
    errors,
  };
}

async function enforceVendorResourceBoundaries({
  resourceIds,
  shopDomain,
  shopifyGraphQLWithOfflineSessionImpl,
}) {
  const securedResourceIds = [];
  const errors = [];

  for (const resourceId of unique(resourceIds)) {
    try {
      await enforceShopifyResourcePublicationBoundary(
        { shopDomain, resourceId },
        { graphQL: shopifyGraphQLWithOfflineSessionImpl },
      );
      securedResourceIds.push(resourceId);
    } catch (error) {
      errors.push({
        resourceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ok: errors.length === 0,
    reason: errors.length > 0 ? "resource_unpublish_failed" : undefined,
    resourceIds: securedResourceIds,
    errors,
  };
}

export async function syncVendorCollection({
  vendorStoreId,
  vendorHandle,
  shopDomain,
  prismaClient = prisma,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
  configuredPublicationId = process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID,
  isPlatformCheckoutHoldActiveImpl = isPlatformCheckoutHoldActive,
} = {}) {
  const vendor = await loadVendorForCollectionSync({
    vendorStoreId,
    vendorHandle,
    prismaClient,
  });

  if (!vendor) {
    return {
      ok: false,
      reason: "vendor_not_found",
    };
  }

  const store = vendor.vendorStore;
  const usesStandardShopifyStorefront =
    store.isPlatformStore === true && store.isTestStore !== true;
  const checkoutHoldActive = await isPlatformCheckoutHoldActiveImpl({
    prismaClient,
  });
  const publicationBoundaryRequired =
    !usesStandardShopifyStorefront || checkoutHoldActive;
  const collectionHandle = buildVendorCollectionHandle(vendor.handle);
  const collectionUrl = usesStandardShopifyStorefront
    ? buildVendorCollectionUrl(vendor.handle)
    : buildVendorProxyStorefrontUrl(vendor.handle);

  if (!collectionHandle) {
    return {
      ok: false,
      reason: "invalid_vendor_handle",
      vendorHandle: vendor.handle,
    };
  }

  const approvedProducts = store.products.filter(
    (product) =>
      product.approvalStatus === "approved" &&
      product.complianceProfile?.approvalStatus !== "HOLD",
  );
  const heldProducts = store.products.filter(
    (product) =>
      product.approvalStatus === "approved" &&
      product.complianceProfile?.approvalStatus === "HOLD",
  );
  const linkedProducts = approvedProducts
    .map((product) => ({
      ...product,
      shopifyProductId: normalizeShopifyProductGid(product.shopifyProductId),
    }))
    .filter((product) => product.shopifyProductId);
  const unsyncedProducts = approvedProducts
    .filter((product) => !normalizeShopifyProductGid(product.shopifyProductId))
    .map((product) => ({
      id: product.id,
      name: product.name,
      reason: "missing_shopify_product_gid",
    }));
  const productIds = unique(linkedProducts.map((product) => product.shopifyProductId));
  const heldProductIds = unique(
    heldProducts
      .map((product) =>
        normalizeShopifyProductGid(product.shopifyProductId),
      )
      .filter(Boolean),
  );
  const shopDomainResult = await resolveCollectionShopDomain({
    products: linkedProducts.length > 0 ? linkedProducts : store.products,
    fallbackShopDomain: shopDomain,
  });

  if (!shopDomainResult.ok) {
    return {
      ok: false,
      reason: shopDomainResult.reason,
      error: shopDomainResult.error,
      shopDomains: shopDomainResult.shopDomains,
      collectionHandle,
      collectionUrl,
      unsyncedProducts,
    };
  }

  const resolvedShopDomain = shopDomainResult.shopDomain;
  const grantedScopes = await listGrantedScopes({
    shopDomain: resolvedShopDomain,
    shopifyGraphQLWithOfflineSessionImpl,
  });
  const missingProductScopes = getMissingScopes(grantedScopes, REQUIRED_PRODUCT_SCOPES);

  if (missingProductScopes.length > 0) {
    return {
      ok: false,
      reason: "missing_scope",
      missingScopes: missingProductScopes,
      grantedScopes,
      shopDomain: resolvedShopDomain,
      collectionHandle,
      collectionUrl,
      unsyncedProducts,
    };
  }

  const missingPublicationScopes = getMissingScopes(
    grantedScopes,
    REQUIRED_PUBLICATION_SCOPES,
  );
  let governedProductBoundary = null;
  let heldProductBoundary = null;

  if (heldProductIds.length > 0) {
    if (missingPublicationScopes.length > 0) {
      return {
        ok: false,
        reason: "missing_scope",
        missingScopes: missingPublicationScopes,
        grantedScopes,
        shopDomain: resolvedShopDomain,
        collectionHandle,
        collectionUrl,
        unsyncedProducts,
      };
    }
    heldProductBoundary = await enforceVendorResourceBoundaries({
      resourceIds: heldProductIds,
      shopDomain: resolvedShopDomain,
      shopifyGraphQLWithOfflineSessionImpl,
    });
    if (!heldProductBoundary.ok) {
      return {
        ok: false,
        reason: heldProductBoundary.reason,
        shopDomain: resolvedShopDomain,
        collectionHandle,
        collectionUrl,
        unsyncedProducts,
        productPublish: heldProductBoundary,
      };
    }
  }

  if (publicationBoundaryRequired) {
    if (missingPublicationScopes.length > 0) {
      return {
        ok: false,
        reason: "missing_scope",
        missingScopes: missingPublicationScopes,
        grantedScopes,
        shopDomain: resolvedShopDomain,
        collectionHandle,
        collectionUrl,
        unsyncedProducts,
      };
    }

    // Close every Shopify sales-channel path before changing collection membership.
    governedProductBoundary = await enforceVendorResourceBoundaries({
      resourceIds: productIds,
      shopDomain: resolvedShopDomain,
      shopifyGraphQLWithOfflineSessionImpl,
    });
    if (!governedProductBoundary.ok) {
      return {
        ok: false,
        reason: governedProductBoundary.reason,
        shopDomain: resolvedShopDomain,
        collectionHandle,
        collectionUrl,
        unsyncedProducts,
        productPublish: governedProductBoundary,
      };
    }
  }

  let collection = await findVendorCollection({
    collectionHandle,
    shopDomain: resolvedShopDomain,
    shopifyGraphQLWithOfflineSessionImpl,
  });
  const created = !collection;

  if (collection) {
    collection = await updateVendorCollection({
      collection,
      collectionHandle,
      vendor,
      store,
      shopDomain: resolvedShopDomain,
      shopifyGraphQLWithOfflineSessionImpl,
    });
  } else {
    collection = await createVendorCollection({
      collectionHandle,
      vendor,
      store,
      productIds,
      shopDomain: resolvedShopDomain,
      shopifyGraphQLWithOfflineSessionImpl,
    });
  }

  if (!collection?.id) {
    return {
      ok: false,
      reason: "collection_sync_failed",
      shopDomain: resolvedShopDomain,
      collectionHandle,
      collectionUrl,
      unsyncedProducts,
    };
  }

  await setVendorCollectionMetafields({
    collectionId: collection.id,
    vendor,
    store,
    shopDomain: resolvedShopDomain,
    shopifyGraphQLWithOfflineSessionImpl,
  });

  const productSync = created
    ? {
        addProductIds: productIds,
        removeProductIds: [],
        addJob: null,
        removeJob: null,
      }
    : await syncCollectionProducts({
        collection,
        productIds,
        shopDomain: resolvedShopDomain,
        shopifyGraphQLWithOfflineSessionImpl,
      });

  let publishResult;
  let productPublishResult;

  if (missingPublicationScopes.length > 0) {
    publishResult = {
      ok: false,
      reason: "missing_scope",
      missingScopes: missingPublicationScopes,
    };
    productPublishResult = { ...publishResult };
  } else if (usesStandardShopifyStorefront) {
    publishResult = await publishVendorCollection({
      collectionId: collection.id,
      shopDomain: resolvedShopDomain,
      shopifyGraphQLWithOfflineSessionImpl,
      configuredPublicationId,
    });
    productPublishResult =
      publishResult.ok && publishResult.publicationId
        ? await publishVendorProducts({
            productIds,
            publicationId: publishResult.publicationId,
            source: publishResult.source,
            shopDomain: resolvedShopDomain,
            shopifyGraphQLWithOfflineSessionImpl,
          })
        : {
            ok: false,
            reason: publishResult.reason || "collection_publish_failed",
          };
  } else {
    publishResult = await enforceVendorResourceBoundaries({
      resourceIds: [collection.id],
      shopDomain: resolvedShopDomain,
      shopifyGraphQLWithOfflineSessionImpl,
    });
    const finalPolicyResults = [];
    for (const product of linkedProducts) {
      try {
        finalPolicyResults.push(
          await syncMarketplaceCheckoutPolicyForProduct(
            {
              localProductId: product.id,
              shopDomain: resolvedShopDomain,
            },
            {
              prismaClient,
              graphQL: shopifyGraphQLWithOfflineSessionImpl,
            },
          ),
        );
      } catch (error) {
        finalPolicyResults.push({
          ok: false,
          productId: product.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const finalPolicyErrors = finalPolicyResults.filter((entry) => !entry.ok);
    productPublishResult = {
      ok: governedProductBoundary.ok && finalPolicyErrors.length === 0,
      reason:
        !governedProductBoundary.ok || finalPolicyErrors.length > 0
          ? "resource_unpublish_failed"
          : undefined,
      resourceIds: governedProductBoundary.resourceIds,
      errors: [...governedProductBoundary.errors, ...finalPolicyErrors],
      policyResults: finalPolicyResults,
    };
  }

  return {
    ok: true,
    shopDomain: resolvedShopDomain,
    collection: {
      id: collection.id,
      handle: collectionHandle,
      url: collectionUrl,
      created,
    },
    productCount: productIds.length,
    unsyncedProducts,
    productSync,
    publish: publishResult,
    productPublish: productPublishResult,
    heldProductBoundary,
    storefrontMode: checkoutHoldActive
      ? "PLATFORM_EMERGENCY_HOLD"
      : usesStandardShopifyStorefront
        ? "SHOPIFY_STANDARD"
        : "APP_PROXY_DRAFT_ORDER",
    checkoutHoldActive,
    missingScopes: missingPublicationScopes,
  };
}

export async function syncVendorCollectionByStoreId(vendorStoreId, options = {}) {
  return syncVendorCollection({
    ...options,
    vendorStoreId,
  });
}

export async function syncVendorCollectionByHandle(vendorHandle, options = {}) {
  return syncVendorCollection({
    ...options,
    vendorHandle,
  });
}

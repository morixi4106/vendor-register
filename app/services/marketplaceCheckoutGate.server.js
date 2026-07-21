import prisma from "../db.server.js";
import {
  normalizeShopDomain,
  shopifyGraphQLWithOfflineSession,
} from "../utils/shopifyAdmin.server.js";
import { SHOPIFY_API_VERSION } from "../utils/shopifyApiVersion.js";

export const MARKETPLACE_CHECKOUT_POLICY = Object.freeze({
  GOVERNED: "MARKETPLACE_GOVERNED",
  PLATFORM_DIRECT: "PLATFORM_DIRECT",
});

export const MARKETPLACE_CHECKOUT_POLICY_KEY =
  "marketplace_checkout_policy";
export const MARKETPLACE_CHECKOUT_BOUNDARY_MODE =
  "ONLINE_STORE_PUBLICATION_BOUNDARY";

const PUBLICATIONS_QUERY = `#graphql
  query MarketplaceCheckoutPublications {
    publications(first: 20) {
      nodes {
        id
        supportsFuturePublishing
      }
    }
  }
`;

const PRODUCT_POLICY_QUERY = `#graphql
  query MarketplaceCheckoutProductPolicy($id: ID!, $publicationId: ID!) {
    product(id: $id) {
      id
      metafield(namespace: "$app", key: "marketplace_checkout_policy") {
        value
      }
      publishedOnPublication(publicationId: $publicationId)
    }
  }
`;

const PRODUCT_POLICY_MUTATION = `#graphql
  mutation SetMarketplaceCheckoutProductPolicy(
    $metafields: [MetafieldsSetInput!]!
  ) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        key
        value
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const UNPUBLISH_RESOURCE_MUTATION = `#graphql
  mutation UnpublishMarketplaceProduct(
    $id: ID!
    $input: [PublicationInput!]!
  ) {
    publishableUnpublish(id: $id, input: $input) {
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
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function getUserErrors(payload) {
  return Array.isArray(payload?.userErrors) ? payload.userErrors : [];
}

function assertNoUserErrors(payload, operation) {
  const errors = getUserErrors(payload);
  if (errors.length === 0) return;

  const error = new Error(
    `${operation} failed: ${errors.map((entry) => entry.message).join(", ")}`,
  );
  error.userErrors = errors;
  throw error;
}

function normalizeProductId(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  return normalized.startsWith("gid://shopify/Product/")
    ? normalized
    : `gid://shopify/Product/${normalized}`;
}

async function resolveOnlineStorePublicationId(
  shopDomain,
  {
    graphQL = shopifyGraphQLWithOfflineSession,
    configuredPublicationId = process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID,
  } = {},
) {
  const configured = normalizeText(configuredPublicationId);
  if (configured) return configured;

  const { data } = await graphQL({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: PUBLICATIONS_QUERY,
  });
  const publications = data?.publications?.nodes || [];
  const publication =
    publications.find((entry) => entry?.supportsFuturePublishing) ||
    publications[0] ||
    null;

  if (!publication?.id) {
    throw new Error("Online Store publication could not be resolved");
  }

  return publication.id;
}

async function loadProductPublicationState({
  shopDomain,
  shopifyProductId,
  publicationId,
  graphQL,
}) {
  const { data } = await graphQL({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: PRODUCT_POLICY_QUERY,
    variables: { id: shopifyProductId, publicationId },
  });

  return data?.product || null;
}

async function unpublishProductFromOnlineStore({
  shopDomain,
  shopifyProductId,
  publicationId,
  graphQL,
}) {
  const { data } = await graphQL({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: UNPUBLISH_RESOURCE_MUTATION,
    variables: {
      id: shopifyProductId,
      input: [{ publicationId }],
    },
  });
  const payload = data?.publishableUnpublish;
  assertNoUserErrors(payload, "publishableUnpublish marketplace product");

  return {
    ok: true,
    changed: true,
    publicationId,
  };
}

export function resolveMarketplaceCheckoutPolicy(product) {
  const legalSellerType = String(
    product?.complianceProfile?.legalSellerType || "VENDOR",
  )
    .trim()
    .toUpperCase();
  const isPlatformDirect = Boolean(
    product?.vendorStore?.isPlatformStore ||
      (!product?.vendorStore && legalSellerType === "PLATFORM"),
  );

  return isPlatformDirect
    ? MARKETPLACE_CHECKOUT_POLICY.PLATFORM_DIRECT
    : MARKETPLACE_CHECKOUT_POLICY.GOVERNED;
}

export function buildMarketplaceCheckoutPolicyMetafield({
  ownerId,
  product,
} = {}) {
  const normalizedOwnerId = normalizeProductId(ownerId);
  if (!normalizedOwnerId) {
    throw new Error("Shopify product ID is required for checkout policy sync");
  }

  return {
    ownerId: normalizedOwnerId,
    namespace: "$app",
    key: MARKETPLACE_CHECKOUT_POLICY_KEY,
    type: "single_line_text_field",
    value: resolveMarketplaceCheckoutPolicy(product),
  };
}

export async function enforceUnresolvedShopifyProductPublicationBoundary(
  { shopDomain: rawShopDomain, shopifyProductId: rawProductId },
  {
    graphQL = shopifyGraphQLWithOfflineSession,
    configuredPublicationId,
  } = {},
) {
  const shopDomain = normalizeShopDomain(rawShopDomain);
  const shopifyProductId = normalizeProductId(rawProductId);
  if (!shopDomain || !shopifyProductId) {
    return { ok: false, reason: "shopify_product_not_linked" };
  }

  const publicationId = await resolveOnlineStorePublicationId(shopDomain, {
    graphQL,
    configuredPublicationId,
  });
  const state = await loadProductPublicationState({
    shopDomain,
    shopifyProductId,
    publicationId,
    graphQL,
  });

  if (!state) {
    return { ok: true, changed: false, reason: "shopify_product_not_found" };
  }
  if (!state.publishedOnPublication) {
    return { ok: true, changed: false, publicationId };
  }

  return unpublishProductFromOnlineStore({
    shopDomain,
    shopifyProductId,
    publicationId,
    graphQL,
  });
}

export async function syncMarketplaceCheckoutPolicyForProduct(
  {
    localProductId,
    product: providedProduct = null,
    shopDomain: rawShopDomain = null,
  },
  {
    prismaClient = prisma,
    graphQL = shopifyGraphQLWithOfflineSession,
    configuredPublicationId,
  } = {},
) {
  const product =
    providedProduct ||
    (await prismaClient.product.findUnique({
      where: { id: localProductId },
      include: {
        vendorStore: {
          select: { id: true, isPlatformStore: true, isTestStore: true },
        },
        complianceProfile: { select: { legalSellerType: true } },
      },
    }));

  if (!product) return { ok: false, reason: "local_product_not_found" };

  const shopifyProductId = normalizeProductId(product.shopifyProductId);
  const shopDomain = normalizeShopDomain(rawShopDomain || product.shopDomain);
  if (!shopifyProductId || !shopDomain) {
    return { ok: false, reason: "shopify_product_not_linked" };
  }

  const publicationId = await resolveOnlineStorePublicationId(shopDomain, {
    graphQL,
    configuredPublicationId,
  });
  const state = await loadProductPublicationState({
    shopDomain,
    shopifyProductId,
    publicationId,
    graphQL,
  });
  if (!state?.id) return { ok: false, reason: "shopify_product_not_found" };

  const expectedPolicy = resolveMarketplaceCheckoutPolicy(product);
  const currentPolicy = normalizeText(state.metafield?.value);
  let policyChanged = false;

  if (currentPolicy !== expectedPolicy) {
    const { data } = await graphQL({
      shopDomain,
      apiVersion: SHOPIFY_API_VERSION,
      query: PRODUCT_POLICY_MUTATION,
      variables: {
        metafields: [
          buildMarketplaceCheckoutPolicyMetafield({
            ownerId: shopifyProductId,
            product,
          }),
        ],
      },
    });
    const payload = data?.metafieldsSet;
    assertNoUserErrors(payload, "metafieldsSet marketplace checkout policy");
    if (!payload?.metafields?.[0]) {
      throw new Error(
        "metafieldsSet did not return the checkout policy metafield",
      );
    }
    policyChanged = true;
  }

  let boundary = {
    ok: true,
    changed: false,
    publicationId,
    publishedOnOnlineStore: Boolean(state.publishedOnPublication),
  };
  if (
    expectedPolicy === MARKETPLACE_CHECKOUT_POLICY.GOVERNED &&
    state.publishedOnPublication
  ) {
    boundary = {
      ...(await unpublishProductFromOnlineStore({
        shopDomain,
        shopifyProductId,
        publicationId,
        graphQL,
      })),
      publishedOnOnlineStore: false,
    };
  }

  return {
    ok: true,
    changed: policyChanged || boundary.changed,
    policyChanged,
    productId: product.id,
    shopifyProductId,
    policy: expectedPolicy,
    boundary,
  };
}

export async function backfillMarketplaceCheckoutPolicies(
  shopDomain,
  {
    prismaClient = prisma,
    graphQL = shopifyGraphQLWithOfflineSession,
    configuredPublicationId,
  } = {},
) {
  const normalizedShopDomain = normalizeShopDomain(shopDomain);
  const [products, unresolvedIssues] = await Promise.all([
    prismaClient.product.findMany({
      where: {
        shopDomain: normalizedShopDomain,
        shopifyProductId: { not: null },
      },
      include: {
        vendorStore: {
          select: { id: true, isPlatformStore: true, isTestStore: true },
        },
        complianceProfile: { select: { legalSellerType: true } },
      },
      orderBy: { id: "asc" },
    }),
    prismaClient.shopifyProductSyncIssue.findMany({
      where: { shopDomain: normalizedShopDomain, status: "unresolved" },
      select: { id: true, shopifyProductId: true },
      orderBy: { id: "asc" },
    }),
  ]);
  const results = [];

  for (const product of products) {
    try {
      results.push(
        await syncMarketplaceCheckoutPolicyForProduct(
          { product, shopDomain: normalizedShopDomain },
          { prismaClient, graphQL, configuredPublicationId },
        ),
      );
    } catch (error) {
      results.push({
        ok: false,
        reason: "policy_sync_failed",
        productId: product.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const unresolvedResults = [];
  for (const issue of unresolvedIssues) {
    try {
      unresolvedResults.push(
        await enforceUnresolvedShopifyProductPublicationBoundary(
          {
            shopDomain: normalizedShopDomain,
            shopifyProductId: issue.shopifyProductId,
          },
          { graphQL, configuredPublicationId },
        ),
      );
    } catch (error) {
      unresolvedResults.push({
        ok: false,
        reason: "unresolved_product_boundary_failed",
        issueId: issue.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const failed = [...results, ...unresolvedResults].filter(
    (result) => !result.ok,
  );
  return {
    ok: failed.length === 0,
    mode: MARKETPLACE_CHECKOUT_BOUNDARY_MODE,
    shopDomain: normalizedShopDomain,
    productCount: products.length,
    changedCount: results.filter((result) => result.ok && result.changed).length,
    unresolvedIssueCount: unresolvedIssues.length,
    unresolvedSecuredCount: unresolvedResults.filter((result) => result.ok).length,
    failedCount: failed.length,
    failed,
  };
}

export async function getMarketplaceCheckoutGateStatus(
  shopDomain,
  {
    prismaClient = prisma,
    graphQL = shopifyGraphQLWithOfflineSession,
    configuredPublicationId,
  } = {},
) {
  const normalizedShopDomain = normalizeShopDomain(shopDomain);
  const [products, unresolvedIssues] = await Promise.all([
    prismaClient.product.findMany({
      where: {
        shopDomain: normalizedShopDomain,
        shopifyProductId: { not: null },
      },
      include: {
        vendorStore: {
          select: { id: true, isPlatformStore: true, isTestStore: true },
        },
        complianceProfile: { select: { legalSellerType: true } },
      },
    }),
    prismaClient.shopifyProductSyncIssue.findMany({
      where: { shopDomain: normalizedShopDomain, status: "unresolved" },
      select: { shopifyProductId: true },
    }),
  ]);
  const publicationId = await resolveOnlineStorePublicationId(
    normalizedShopDomain,
    { graphQL, configuredPublicationId },
  );
  const governedIds = products
    .filter(
      (product) =>
        resolveMarketplaceCheckoutPolicy(product) ===
        MARKETPLACE_CHECKOUT_POLICY.GOVERNED,
    )
    .map((product) => normalizeProductId(product.shopifyProductId));
  const targetIds = Array.from(
    new Set([
      ...governedIds,
      ...unresolvedIssues.map((issue) =>
        normalizeProductId(issue.shopifyProductId),
      ),
    ].filter(Boolean)),
  );
  const exposedProductIds = [];
  const failedProductIds = [];

  for (const shopifyProductId of targetIds) {
    try {
      const state = await loadProductPublicationState({
        shopDomain: normalizedShopDomain,
        shopifyProductId,
        publicationId,
        graphQL,
      });
      if (state?.publishedOnPublication) exposedProductIds.push(shopifyProductId);
    } catch {
      failedProductIds.push(shopifyProductId);
    }
  }

  return {
    exists: true,
    active: exposedProductIds.length === 0 && failedProductIds.length === 0,
    mode: MARKETPLACE_CHECKOUT_BOUNDARY_MODE,
    publicationId,
    governedProductCount: governedIds.length,
    unresolvedIssueCount: unresolvedIssues.length,
    exposedProductCount: exposedProductIds.length,
    failedProductCount: failedProductIds.length,
  };
}

export async function activateMarketplaceCheckoutGate(
  shopDomain,
  options = {},
) {
  const backfill = await backfillMarketplaceCheckoutPolicies(
    shopDomain,
    options,
  );
  if (!backfill.ok) {
    const error = new Error(
      "商品連携またはOnline Store公開境界の同期に失敗しました。",
    );
    error.reason = "checkout_publication_boundary_incomplete";
    error.backfill = backfill;
    throw error;
  }

  const status = await getMarketplaceCheckoutGateStatus(shopDomain, options);
  if (!status.active) {
    const error = new Error(
      "第三者商品がOnline Storeに残っています。同期結果を確認してください。",
    );
    error.reason = "governed_products_still_published";
    error.status = status;
    throw error;
  }

  return { ok: true, created: false, backfill, boundary: status };
}

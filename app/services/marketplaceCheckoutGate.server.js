import prisma from "../db.server.js";
import {
  normalizeShopDomain,
  shopifyGraphQLWithOfflineSession,
} from "../utils/shopifyAdmin.server.js";
import { SHOPIFY_API_VERSION } from "../utils/shopifyApiVersion.js";
import { isPlatformCheckoutHoldActive } from "./operationalReadiness.server.js";
import {
  SALE_ELIGIBILITY_CHANNEL,
  SALE_ELIGIBILITY_POLICY_VERSION,
  SALE_ELIGIBILITY_PROJECTION_SCHEMA_VERSION,
  SALE_ELIGIBILITY_PRODUCT_INCLUDE,
  evaluateSaleEligibilitySnapshot,
  persistSaleEligibilityProjection,
} from "./saleEligibility.server.js";

export const MARKETPLACE_CHECKOUT_POLICY = Object.freeze({
  GOVERNED: "MARKETPLACE_GOVERNED",
  PLATFORM_DIRECT: "PLATFORM_DIRECT",
});

export const MARKETPLACE_CHECKOUT_POLICY_KEY =
  "marketplace_checkout_policy";
export const SALE_ELIGIBILITY_PROJECTION_KEY =
  "sale_eligibility_projection";
export const OPERATIONAL_PURCHASE_CONTROL_KEY =
  "operational_purchase_control";
export const OPERATIONAL_PURCHASE_CONTROL = Object.freeze({
  ALLOWED: "ALLOWED",
  BLOCKED: "BLOCKED",
});
export const WATCHDOG_PURCHASE_STOP_NAMESPACE =
  "vendor_register_watchdog";
export const WATCHDOG_PURCHASE_STOP_KEY = "purchase_stop";
export const WATCHDOG_PURCHASE_STOP = Object.freeze({
  BLOCKED: "BLOCKED",
  CLEARED: "CLEARED",
});
export const MARKETPLACE_CHECKOUT_BOUNDARY_MODE =
  "ONLINE_STORE_PUBLICATION_BOUNDARY";

const PUBLICATIONS_QUERY = `#graphql
  query MarketplaceCheckoutPublications {
    publications(first: 20) {
      nodes {
        id
        supportsFuturePublishing
        channels(first: 10) {
          nodes {
            id
            name
            handle
          }
        }
      }
    }
  }
`;

const PRODUCT_POLICY_QUERY = `#graphql
  query MarketplaceCheckoutProductPolicy($id: ID!) {
    shop {
      ianaTimezone
    }
    product(id: $id) {
      id
      metafield(namespace: "$app", key: "marketplace_checkout_policy") {
        value
        compareDigest
      }
      saleEligibilityProjection: metafield(
        namespace: "$app"
        key: "sale_eligibility_projection"
      ) {
        value
        compareDigest
      }
      appPublications: resourcePublicationsV2(
        first: 100
        onlyPublished: false
        catalogType: APP
      ) {
        nodes {
          isPublished
          publishDate
          publication {
            id
          }
        }
        pageInfo {
          hasNextPage
        }
      }
      marketPublications: resourcePublicationsV2(
        first: 100
        onlyPublished: false
        catalogType: MARKET
      ) {
        nodes {
          isPublished
          publishDate
          publication {
            id
          }
        }
        pageInfo {
          hasNextPage
        }
      }
      companyLocationPublications: resourcePublicationsV2(
        first: 100
        onlyPublished: false
        catalogType: COMPANY_LOCATION
      ) {
        nodes {
          isPublished
          publishDate
          publication {
            id
          }
        }
        pageInfo {
          hasNextPage
        }
      }
      uncatalogedPublications: resourcePublicationsV2(
        first: 100
        onlyPublished: false
        catalogType: NONE
      ) {
        nodes {
          isPublished
          publishDate
          publication {
            id
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }
`;

const SHOP_OPERATIONAL_CONTROL_QUERY = `#graphql
  query MarketplaceOperationalPurchaseControl {
    shop {
      id
      metafield(namespace: "$app", key: "operational_purchase_control") {
        value
      }
      watchdogPurchaseStop: metafield(
        namespace: "vendor_register_watchdog"
        key: "purchase_stop"
      ) {
        value
        compareDigest
      }
    }
  }
`;

const PUBLISHABLE_PUBLICATION_STATE_QUERY = `#graphql
  query MarketplaceCheckoutPublishableState($id: ID!) {
    node(id: $id) {
      ... on Product {
        id
        appPublications: resourcePublicationsV2(
          first: 100
          onlyPublished: false
          catalogType: APP
        ) {
          nodes {
            isPublished
            publishDate
            publication {
              id
            }
          }
          pageInfo {
            hasNextPage
          }
        }
        marketPublications: resourcePublicationsV2(
          first: 100
          onlyPublished: false
          catalogType: MARKET
        ) {
          nodes {
            isPublished
            publishDate
            publication {
              id
            }
          }
          pageInfo {
            hasNextPage
          }
        }
        companyLocationPublications: resourcePublicationsV2(
          first: 100
          onlyPublished: false
          catalogType: COMPANY_LOCATION
        ) {
          nodes {
            isPublished
            publishDate
            publication {
              id
            }
          }
          pageInfo {
            hasNextPage
          }
        }
        uncatalogedPublications: resourcePublicationsV2(
          first: 100
          onlyPublished: false
          catalogType: NONE
        ) {
          nodes {
            isPublished
            publishDate
            publication {
              id
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
      ... on Collection {
        id
        appPublications: resourcePublicationsV2(
          first: 100
          onlyPublished: false
        ) {
          nodes {
            isPublished
            publishDate
            publication {
              id
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
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
        code
        field
        message
      }
    }
  }
`;

const PUBLISH_RESOURCE_MUTATION = `#graphql
  mutation RestoreMarketplaceProductPublications(
    $id: ID!
    $input: [PublicationInput!]!
  ) {
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

export async function getShopifyPublicationDiagnostics(
  shopDomain,
  { graphQL = shopifyGraphQLWithOfflineSession } = {},
) {
  const normalizedShopDomain = normalizeShopDomain(shopDomain);
  const { data } = await graphQL({
    shopDomain: normalizedShopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: PUBLICATIONS_QUERY,
  });

  return (data?.publications?.nodes || []).map((publication) => ({
    id: normalizeText(publication?.id),
    supportsFuturePublishing: Boolean(
      publication?.supportsFuturePublishing,
    ),
    channels: (publication?.channels?.nodes || []).map((channel) => ({
      id: normalizeText(channel?.id),
      name: normalizeText(channel?.name),
      handle: normalizeText(channel?.handle),
    })),
  }));
}

async function resolveOnlineStorePublicationId(
  shopDomain,
  {
    graphQL = shopifyGraphQLWithOfflineSession,
    configuredPublicationId = process.env.SHOPIFY_ONLINE_STORE_PUBLICATION_ID,
    env = process.env,
  } = {},
) {
  const configured = normalizeText(configuredPublicationId);
  if (configured) return configured;

  if (String(env?.NODE_ENV || "").toLowerCase() === "production") {
    throw new Error(
      "SHOPIFY_ONLINE_STORE_PUBLICATION_ID must be configured in production",
    );
  }

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
  graphQL,
}) {
  const { data } = await graphQL({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: PRODUCT_POLICY_QUERY,
    variables: { id: shopifyProductId },
  });

  return data?.product
    ? {
        ...data.product,
        shopTimeZone: normalizeText(data?.shop?.ianaTimezone) || "UTC",
      }
    : null;
}

function getPublicationIds(state) {
  const connections = [
    state?.appPublications,
    state?.marketPublications,
    state?.companyLocationPublications,
    state?.uncatalogedPublications,
    // Backward-compatible input for tests and older serialized diagnostics.
    state?.resourcePublicationsV2,
  ].filter(Boolean);

  if (
    connections.some((connection) => connection?.pageInfo?.hasNextPage)
  ) {
    throw new Error(
      "Publication boundary is incomplete because more than 100 publications are attached",
    );
  }

  return Array.from(
    new Set(
      connections
        .flatMap((connection) => connection?.nodes || [])
        .map((entry) => normalizeText(entry?.publication?.id))
        .filter(Boolean),
    ),
  );
}

async function loadPublishablePublicationState({
  shopDomain,
  resourceId,
  graphQL,
}) {
  const { data } = await graphQL({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: PUBLISHABLE_PUBLICATION_STATE_QUERY,
    variables: { id: resourceId },
  });

  return data?.node || null;
}

async function unpublishResourceFromPublications({
  shopDomain,
  resourceId,
  publicationIds,
  graphQL,
}) {
  const targets = Array.from(new Set(publicationIds.filter(Boolean)));
  if (targets.length === 0) {
    return {
      ok: true,
      changed: false,
      publicationIds: [],
      remainingPublicationIds: [],
    };
  }

  const { data } = await graphQL({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: UNPUBLISH_RESOURCE_MUTATION,
    variables: {
      id: resourceId,
      input: targets.map((publicationId) => ({ publicationId })),
    },
  });
  const payload = data?.publishableUnpublish;
  assertNoUserErrors(payload, "publishableUnpublish marketplace product");

  return {
    ok: true,
    changed: true,
    publicationIds: targets,
  };
}

export async function enforceShopifyResourcePublicationBoundary(
  { shopDomain: rawShopDomain, resourceId: rawResourceId },
  { graphQL = shopifyGraphQLWithOfflineSession } = {},
) {
  const shopDomain = normalizeShopDomain(rawShopDomain);
  const resourceId = normalizeText(rawResourceId);
  if (!shopDomain || !resourceId) {
    return { ok: false, reason: "shopify_resource_not_linked" };
  }

  const state = await loadPublishablePublicationState({
    shopDomain,
    resourceId,
    graphQL,
  });
  if (!state?.id) {
    return { ok: true, changed: false, reason: "shopify_resource_not_found" };
  }

  const publicationIds = getPublicationIds(state);
  const result = await unpublishResourceFromPublications({
    shopDomain,
    resourceId,
    publicationIds,
    graphQL,
  });

  const verifiedState = await loadPublishablePublicationState({
    shopDomain,
    resourceId,
    graphQL,
  });
  const remainingPublicationIds = verifiedState
    ? getPublicationIds(verifiedState)
    : [];

  if (remainingPublicationIds.length > 0) {
    const error = new Error(
      "Shopify resource remains attached to a publication after unpublish",
    );
    error.reason = "publication_boundary_verification_failed";
    error.publicationIds = remainingPublicationIds;
    throw error;
  }

  return {
    ...result,
    remainingPublicationIds,
  };
}

export function resolveMarketplaceCheckoutPolicy(product) {
  const complianceApprovalStatus = String(
    product?.complianceProfile?.approvalStatus || "",
  )
    .trim()
    .toUpperCase();
  if (complianceApprovalStatus === "HOLD") {
    return MARKETPLACE_CHECKOUT_POLICY.GOVERNED;
  }

  const saleEligibility = evaluateSaleEligibilitySnapshot({
    product,
    salesChannel: "PUBLICATION_SYNC",
    operationalControl: {
      checkoutHold: false,
      checkoutControlState: "IDLE",
    },
  });
  if (!saleEligibility.allowed) {
    return MARKETPLACE_CHECKOUT_POLICY.GOVERNED;
  }

  const legalSellerType = String(
    product?.complianceProfile?.legalSellerType || "VENDOR",
  )
    .trim()
    .toUpperCase();
  const isPlatformDirect = Boolean(
    product?.vendorStore?.isTestStore !== true &&
      (product?.vendorStore?.isPlatformStore ||
        (!product?.vendorStore && legalSellerType === "PLATFORM")),
  );

  return isPlatformDirect
    ? MARKETPLACE_CHECKOUT_POLICY.PLATFORM_DIRECT
    : MARKETPLACE_CHECKOUT_POLICY.GOVERNED;
}

export async function syncShopOperationalPurchaseControl(
  {
    shopDomain: rawShopDomain,
    state = OPERATIONAL_PURCHASE_CONTROL.ALLOWED,
  },
  { graphQL = shopifyGraphQLWithOfflineSession } = {},
) {
  const shopDomain = normalizeShopDomain(rawShopDomain);
  const normalizedState = String(state || "")
    .trim()
    .toUpperCase();
  if (
    !shopDomain ||
    !Object.values(OPERATIONAL_PURCHASE_CONTROL).includes(normalizedState)
  ) {
    return { ok: false, reason: "invalid_shop_operational_control" };
  }

  const currentResponse = await graphQL({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: SHOP_OPERATIONAL_CONTROL_QUERY,
  });
  const shop = currentResponse?.data?.shop || null;
  if (!shop?.id) return { ok: false, reason: "shop_not_found" };
  const beforeState = normalizeText(shop.metafield?.value);

  if (beforeState !== normalizedState) {
    const { data } = await graphQL({
      shopDomain,
      apiVersion: SHOPIFY_API_VERSION,
      query: PRODUCT_POLICY_MUTATION,
      variables: {
        metafields: [
          {
            ownerId: shop.id,
            namespace: "$app",
            key: OPERATIONAL_PURCHASE_CONTROL_KEY,
            type: "single_line_text_field",
            value: normalizedState,
          },
        ],
      },
    });
    const payload = data?.metafieldsSet;
    assertNoUserErrors(payload, "metafieldsSet operational purchase control");
    if (!payload?.metafields?.[0]) {
      throw new Error(
        "metafieldsSet did not return the operational control metafield",
      );
    }
  }

  const verifiedResponse = await graphQL({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: SHOP_OPERATIONAL_CONTROL_QUERY,
  });
  const verifiedState = normalizeText(
    verifiedResponse?.data?.shop?.metafield?.value,
  );
  if (verifiedState !== normalizedState) {
    const error = new Error(
      "Shop operational purchase control verification failed",
    );
    error.reason = "shop_operational_control_verification_failed";
    throw error;
  }

  return {
    ok: true,
    shopDomain,
    changed: beforeState !== normalizedState,
    beforeState,
    state: verifiedState,
  };
}

export async function clearSharedWatchdogPurchaseVeto(
  { shopDomain: rawShopDomain },
  { graphQL = shopifyGraphQLWithOfflineSession } = {},
) {
  const shopDomain = normalizeShopDomain(rawShopDomain);
  if (!shopDomain) {
    return { ok: false, reason: "invalid_shop_domain" };
  }

  const currentResponse = await graphQL({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: SHOP_OPERATIONAL_CONTROL_QUERY,
  });
  const shop = currentResponse?.data?.shop || null;
  if (!shop?.id) return { ok: false, reason: "shop_not_found" };

  const beforeState = normalizeText(shop.watchdogPurchaseStop?.value);
  if (beforeState !== WATCHDOG_PURCHASE_STOP.CLEARED) {
    const { data } = await graphQL({
      shopDomain,
      apiVersion: SHOPIFY_API_VERSION,
      query: PRODUCT_POLICY_MUTATION,
      variables: {
        metafields: [
          {
            ownerId: shop.id,
            namespace: WATCHDOG_PURCHASE_STOP_NAMESPACE,
            key: WATCHDOG_PURCHASE_STOP_KEY,
            type: "single_line_text_field",
            value: WATCHDOG_PURCHASE_STOP.CLEARED,
            compareDigest:
              shop.watchdogPurchaseStop?.compareDigest ?? null,
          },
        ],
      },
    });
    const payload = data?.metafieldsSet;
    assertNoUserErrors(payload, "metafieldsSet watchdog purchase veto");
    if (!payload?.metafields?.[0]) {
      throw new Error(
        "metafieldsSet did not return the watchdog purchase veto metafield",
      );
    }
  }

  const verifiedResponse = await graphQL({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: SHOP_OPERATIONAL_CONTROL_QUERY,
  });
  const verifiedState = normalizeText(
    verifiedResponse?.data?.shop?.watchdogPurchaseStop?.value,
  );
  if (verifiedState !== WATCHDOG_PURCHASE_STOP.CLEARED) {
    const error = new Error(
      "Shared watchdog purchase veto recovery verification failed",
    );
    error.reason = "watchdog_purchase_veto_recovery_failed";
    throw error;
  }

  return {
    ok: true,
    shopDomain,
    changed: beforeState !== WATCHDOG_PURCHASE_STOP.CLEARED,
    beforeState,
    state: verifiedState,
  };
}

export async function restoreShopifyResourcePublications(
  { shopDomain: rawShopDomain, resourceId: rawResourceId, publicationIds = [] },
  { graphQL = shopifyGraphQLWithOfflineSession } = {},
) {
  const shopDomain = normalizeShopDomain(rawShopDomain);
  const resourceId = normalizeProductId(rawResourceId);
  const targetPublicationIds = Array.from(
    new Set(publicationIds.map(normalizeText).filter(Boolean)),
  );
  if (!shopDomain || !resourceId) {
    return { ok: false, reason: "shopify_product_not_linked" };
  }
  if (targetPublicationIds.length === 0) {
    return {
      ok: true,
      changed: false,
      publicationIds: [],
      remainingPublicationIds: [],
    };
  }

  const { data } = await graphQL({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: PUBLISH_RESOURCE_MUTATION,
    variables: {
      id: resourceId,
      input: targetPublicationIds.map((publicationId) => ({ publicationId })),
    },
  });
  assertNoUserErrors(data?.publishablePublish, "publishablePublish");

  const verifiedState = await loadProductPublicationState({
    shopDomain,
    shopifyProductId: resourceId,
    graphQL,
  });
  const restoredIds = getPublicationIds(verifiedState);
  const missingPublicationIds = targetPublicationIds.filter(
    (publicationId) => !restoredIds.includes(publicationId),
  );
  if (missingPublicationIds.length > 0) {
    const error = new Error(
      "Shopify product publication recovery verification failed",
    );
    error.reason = "publication_recovery_verification_failed";
    error.publicationIds = missingPublicationIds;
    throw error;
  }

  return {
    ok: true,
    changed: true,
    publicationIds: targetPublicationIds,
    remainingPublicationIds: restoredIds,
  };
}

export function buildMarketplaceCheckoutPolicyMetafield({
  ownerId,
  product,
  policy = null,
  compareDigest,
} = {}) {
  const normalizedOwnerId = normalizeProductId(ownerId);
  if (!normalizedOwnerId) {
    throw new Error("Shopify product ID is required for checkout policy sync");
  }

  const metafield = {
    ownerId: normalizedOwnerId,
    namespace: "$app",
    key: MARKETPLACE_CHECKOUT_POLICY_KEY,
    type: "single_line_text_field",
    value:
      policy && Object.values(MARKETPLACE_CHECKOUT_POLICY).includes(policy)
        ? policy
        : resolveMarketplaceCheckoutPolicy(product),
  };
  if (compareDigest !== undefined) {
    metafield.compareDigest = compareDigest;
  }
  return metafield;
}

function formatDateInTimeZone(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(
      parts
        .filter((entry) => entry.type !== "literal")
        .map((entry) => [entry.type, entry.value]),
    );
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return null;
  }
}

function addCalendarDays(dateValue, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateValue || ""))) return null;
  const date = new Date(`${dateValue}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function saleEligibilityProjectionNeedsDailyRefresh({
  value,
  evaluatedAt,
  shopTimeZone,
}) {
  const expectedDate = formatDateInTimeZone(evaluatedAt, shopTimeZone);
  if (!expectedDate) return true;

  try {
    const projection = JSON.parse(String(value || ""));
    const evaluatedOn =
      Number(projection?.v) === SALE_ELIGIBILITY_PROJECTION_SCHEMA_VERSION
        ? projection?.d
        : projection?.evaluatedOn;
    return String(evaluatedOn || "") !== expectedDate;
  } catch {
    return true;
  }
}

export function buildSaleEligibilityProjectionMetafield({
  ownerId,
  routingClass,
  projection,
  shopTimeZone = "UTC",
  compareDigest,
} = {}) {
  const normalizedOwnerId = normalizeProductId(ownerId);
  if (!normalizedOwnerId) {
    throw new Error(
      "Shopify product ID is required for sale eligibility projection sync",
    );
  }
  const normalizedRoutingClass = Object.values(
    MARKETPLACE_CHECKOUT_POLICY,
  ).includes(routingClass)
    ? routingClass
    : MARKETPLACE_CHECKOUT_POLICY.GOVERNED;
  const projectionRevision = Number(projection?.projectionRevision);
  const evaluatedOn = formatDateInTimeZone(
    projection?.evaluatedAt,
    shopTimeZone,
  );
  const payload = {
    v: SALE_ELIGIBILITY_PROJECTION_SCHEMA_VERSION,
    c: normalizedRoutingClass,
    a:
      normalizedRoutingClass === MARKETPLACE_CHECKOUT_POLICY.PLATFORM_DIRECT &&
      projection?.allowed === true,
    s: String(projection?.status || "BLOCKED").toUpperCase(),
    p:
      String(projection?.policyVersion || "").trim() ||
      SALE_ELIGIBILITY_POLICY_VERSION,
    h: String(projection?.inputHash || "").trim(),
    d: evaluatedOn,
    e: addCalendarDays(evaluatedOn, 1),
    r:
      Number.isInteger(projectionRevision) && projectionRevision > 0
        ? projectionRevision
        : 1,
  };

  const metafield = {
    ownerId: normalizedOwnerId,
    namespace: "$app",
    key: SALE_ELIGIBILITY_PROJECTION_KEY,
    type: "json",
    value: JSON.stringify(payload),
  };
  if (compareDigest !== undefined) {
    metafield.compareDigest = compareDigest;
  }
  return metafield;
}

async function loadPersistedProjectionState({
  prismaClient,
  shopDomain,
  productId,
}) {
  if (!prismaClient?.saleEligibilityProjection?.findUnique) return null;
  return prismaClient.saleEligibilityProjection.findUnique({
    where: {
      shopDomain_productId_destinationCountry_salesChannel: {
        shopDomain,
        productId,
        destinationCountry: "",
        salesChannel: SALE_ELIGIBILITY_CHANNEL.SHOPIFY_STANDARD_CHECKOUT,
      },
    },
    select: {
      status: true,
      inputHash: true,
      policyVersion: true,
      projectionRevision: true,
      evaluatedAt: true,
      expiresAt: true,
    },
  });
}

function projectionMatchesPersistedState(projection, persisted) {
  if (!persisted) return true;
  return (
    Number(projection?.projectionRevision) ===
      Number(persisted.projectionRevision) &&
    String(projection?.status || "") === String(persisted.status || "") &&
    String(projection?.inputHash || "") === String(persisted.inputHash || "") &&
    String(projection?.policyVersion || "") ===
      String(persisted.policyVersion || "")
  );
}

export async function enforceUnresolvedShopifyProductPublicationBoundary(
  { shopDomain: rawShopDomain, shopifyProductId: rawProductId },
  {
    graphQL = shopifyGraphQLWithOfflineSession,
  } = {},
) {
  const shopDomain = normalizeShopDomain(rawShopDomain);
  const shopifyProductId = normalizeProductId(rawProductId);
  if (!shopDomain || !shopifyProductId) {
    return { ok: false, reason: "shopify_product_not_linked" };
  }

  return enforceShopifyResourcePublicationBoundary({
    shopDomain,
    resourceId: shopifyProductId,
  }, {
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
    isPlatformCheckoutHoldActiveImpl = isPlatformCheckoutHoldActive,
    policyOverride = null,
    env = process.env,
  } = {},
) {
  const product =
    providedProduct ||
    (await prismaClient.product.findUnique({
      where: { id: localProductId },
      include: SALE_ELIGIBILITY_PRODUCT_INCLUDE,
    }));

  if (!product) return { ok: false, reason: "local_product_not_found" };

  const shopifyProductId = normalizeProductId(product.shopifyProductId);
  const shopDomain = normalizeShopDomain(rawShopDomain || product.shopDomain);
  if (!shopifyProductId || !shopDomain) {
    return { ok: false, reason: "shopify_product_not_linked" };
  }

  const state = await loadProductPublicationState({
    shopDomain,
    shopifyProductId,
    graphQL,
  });
  if (!state?.id) return { ok: false, reason: "shopify_product_not_found" };

  const checkoutHoldActive = await isPlatformCheckoutHoldActiveImpl({
    prismaClient,
  });
  const evaluatedAt = new Date();
  const policyFieldAvailable = Object.prototype.hasOwnProperty.call(
    state,
    "metafield",
  );
  const projectionFieldAvailable = Object.prototype.hasOwnProperty.call(
    state,
    "saleEligibilityProjection",
  );
  const saleEligibilitySnapshot = evaluateSaleEligibilitySnapshot({
    product,
    shopDomain,
    vendorStoreId: product.vendorStoreId,
    salesChannel: SALE_ELIGIBILITY_CHANNEL.SHOPIFY_STANDARD_CHECKOUT,
    operationalControl: {
      checkoutHold: checkoutHoldActive,
      checkoutControlState: checkoutHoldActive ? "ACTIVE" : "IDLE",
    },
    env,
    evaluatedAt,
  });
  const persistedProjection = await persistSaleEligibilityProjection(
    saleEligibilitySnapshot,
    {
      prismaClient,
      evaluatedAt,
      forceRefresh:
        projectionFieldAvailable &&
        saleEligibilityProjectionNeedsDailyRefresh({
          value: state.saleEligibilityProjection?.value,
          evaluatedAt,
          shopTimeZone: state.shopTimeZone,
        }),
    },
  );
  const saleEligibility = persistedProjection || {
    ...saleEligibilitySnapshot,
    projectionRevision: 1,
  };
  const expectedPolicy =
    policyOverride &&
    Object.values(MARKETPLACE_CHECKOUT_POLICY).includes(policyOverride)
      ? policyOverride
      : checkoutHoldActive || !saleEligibility.allowed
        ? MARKETPLACE_CHECKOUT_POLICY.GOVERNED
        : resolveMarketplaceCheckoutPolicy(product);
  const currentPolicy = normalizeText(state.metafield?.value);
  const projectionMetafield = buildSaleEligibilityProjectionMetafield({
    ownerId: shopifyProductId,
    routingClass: expectedPolicy,
    projection: saleEligibility,
    shopTimeZone: state.shopTimeZone,
    compareDigest: projectionFieldAvailable
      ? state.saleEligibilityProjection?.compareDigest ?? null
      : undefined,
  });
  const currentProjection = normalizeText(
    state.saleEligibilityProjection?.value,
  );
  let policyChanged = false;

  if (
    currentPolicy !== expectedPolicy ||
    (projectionFieldAvailable &&
      currentProjection !== projectionMetafield.value)
  ) {
    const latestProjection = await loadPersistedProjectionState({
      prismaClient,
      shopDomain,
      productId: product.id,
    });
    if (
      latestProjection &&
      !projectionMatchesPersistedState(saleEligibility, latestProjection)
    ) {
      const staleBoundary =
        String(latestProjection.status || "").toUpperCase() === "ELIGIBLE" ||
        String(latestProjection.status || "").toUpperCase() ===
          "LEGACY_REVIEW_REQUIRED"
          ? { ok: true, changed: false }
          : await enforceShopifyResourcePublicationBoundary(
              { shopDomain, resourceId: shopifyProductId },
              { graphQL },
            );
      return {
        ok: true,
        changed: Boolean(staleBoundary.changed),
        skipped: true,
        reason: "stale_projection_job",
        productId: product.id,
        shopifyProductId,
        projectionRevision: saleEligibility.projectionRevision,
        currentProjectionRevision: latestProjection.projectionRevision,
        boundary: staleBoundary,
      };
    }

    const metafields = [];
    if (currentPolicy !== expectedPolicy) {
      metafields.push(
        buildMarketplaceCheckoutPolicyMetafield({
          ownerId: shopifyProductId,
          product,
          policy: expectedPolicy,
          compareDigest: policyFieldAvailable
            ? state.metafield?.compareDigest ?? null
            : undefined,
        }),
      );
    }
    if (
      projectionFieldAvailable &&
      currentProjection !== projectionMetafield.value
    ) {
      metafields.push(projectionMetafield);
    }
    const { data } = await graphQL({
      shopDomain,
      apiVersion: SHOPIFY_API_VERSION,
      query: PRODUCT_POLICY_MUTATION,
      variables: {
        metafields,
      },
    });
    const payload = data?.metafieldsSet;
    const compareAndSetConflict = getUserErrors(payload).some((entry) =>
      ["STALE_OBJECT", "INVALID_COMPARE_DIGEST"].includes(
        String(entry?.code || "").toUpperCase(),
      ),
    );
    if (compareAndSetConflict) {
      const conflictBoundary =
        await enforceShopifyResourcePublicationBoundary(
          { shopDomain, resourceId: shopifyProductId },
          { graphQL },
        );
      return {
        ok: false,
        changed: Boolean(conflictBoundary.changed),
        reason: "shopify_projection_compare_and_set_conflict",
        productId: product.id,
        shopifyProductId,
        projectionRevision: saleEligibility.projectionRevision,
        boundary: conflictBoundary,
      };
    }
    assertNoUserErrors(payload, "metafieldsSet marketplace checkout policy");
    if (!payload?.metafields?.[0]) {
      throw new Error(
        "metafieldsSet did not return the checkout policy metafield",
      );
    }
    policyChanged = true;

    if (projectionFieldAvailable) {
      const verifiedState = await loadProductPublicationState({
        shopDomain,
        shopifyProductId,
        graphQL,
      });
      const verifiedPolicy = normalizeText(verifiedState?.metafield?.value);
      const verifiedProjection = normalizeText(
        verifiedState?.saleEligibilityProjection?.value,
      );
      const latestProjectionAfterWrite = await loadPersistedProjectionState({
        prismaClient,
        shopDomain,
        productId: product.id,
      });
      if (
        verifiedPolicy !== expectedPolicy ||
        verifiedProjection !== projectionMetafield.value ||
        !projectionMatchesPersistedState(
          saleEligibility,
          latestProjectionAfterWrite,
        )
      ) {
        await enforceShopifyResourcePublicationBoundary(
          { shopDomain, resourceId: shopifyProductId },
          { graphQL },
        );
        const error = new Error(
          "Shopify sale eligibility projection verification failed",
        );
        error.reason = "sale_eligibility_projection_verification_failed";
        throw error;
      }
    }
  }

  let boundary = {
    ok: true,
    changed: false,
    publicationIds: getPublicationIds(state),
    remainingPublicationIds: getPublicationIds(state),
  };
  if (expectedPolicy === MARKETPLACE_CHECKOUT_POLICY.GOVERNED) {
    boundary = await enforceShopifyResourcePublicationBoundary(
      {
        shopDomain,
        resourceId: shopifyProductId,
      },
      { graphQL },
    );
  }

  return {
    ok: true,
    changed: policyChanged || boundary.changed,
    policyChanged,
    productId: product.id,
    shopifyProductId,
    policy: expectedPolicy,
    saleEligibility,
    projectionRevision: saleEligibility.projectionRevision,
    projectionExpiresAt: saleEligibility.expiresAt,
    checkoutHoldActive,
    boundary,
  };
}

export async function backfillMarketplaceCheckoutPolicies(
  shopDomain,
  {
    prismaClient = prisma,
    graphQL = shopifyGraphQLWithOfflineSession,
  } = {},
) {
  const normalizedShopDomain = normalizeShopDomain(shopDomain);
  const [products, unresolvedIssues] = await Promise.all([
    prismaClient.product.findMany({
      where: {
        shopDomain: normalizedShopDomain,
        shopifyProductId: { not: null },
      },
      include: SALE_ELIGIBILITY_PRODUCT_INCLUDE,
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
          { prismaClient, graphQL },
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
          { graphQL },
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
    env = process.env,
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
        complianceProfile: {
          select: { legalSellerType: true, approvalStatus: true },
        },
      },
    }),
    prismaClient.shopifyProductSyncIssue.findMany({
      where: { shopDomain: normalizedShopDomain, status: "unresolved" },
      select: { shopifyProductId: true },
    }),
  ]);
  const configuredOnlineStorePublicationId = normalizeText(
    configuredPublicationId ?? env?.SHOPIFY_ONLINE_STORE_PUBLICATION_ID,
  );
  const publicationConfigurationReady =
    Boolean(configuredOnlineStorePublicationId) ||
    String(env?.NODE_ENV || "").toLowerCase() !== "production";
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
        graphQL,
      });
      if (state && getPublicationIds(state).length > 0) {
        exposedProductIds.push(shopifyProductId);
      }
    } catch {
      failedProductIds.push(shopifyProductId);
    }
  }

  return {
    exists: true,
    active:
      publicationConfigurationReady &&
      exposedProductIds.length === 0 &&
      failedProductIds.length === 0,
    mode: MARKETPLACE_CHECKOUT_BOUNDARY_MODE,
    publicationId:
      configuredOnlineStorePublicationId ||
      (String(env?.NODE_ENV || "").toLowerCase() !== "production"
        ? await resolveOnlineStorePublicationId(normalizedShopDomain, {
            graphQL,
            configuredPublicationId,
            env,
          })
        : null),
    publicationConfigurationReady,
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

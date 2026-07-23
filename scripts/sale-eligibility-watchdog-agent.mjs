import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 120_000;
const SHOPIFY_API_VERSION = "2026-04";
const SHOPIFY_CONTROL_QUERY = `#graphql
  query ExternalWatchdogPurchaseControl {
    shop {
      id
      metafield(namespace: "$app", key: "operational_purchase_control") {
        value
      }
    }
  }
`;
const SHOPIFY_CONTROL_MUTATION = `#graphql
  mutation ExternalWatchdogBlockPurchases($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        value
      }
      userErrors {
        field
        message
      }
    }
  }
`;
const SHOPIFY_PRODUCTS_PUBLICATION_QUERY = `#graphql
  query ExternalWatchdogProductsForEmergencyStop(
    $first: Int!
    $after: String
  ) {
    products(first: $first, after: $after) {
      nodes {
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
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;
const SHOPIFY_UNPUBLISH_PRODUCT_MUTATION = `#graphql
  mutation ExternalWatchdogUnpublishProduct(
    $id: ID!
    $input: [PublicationInput!]!
  ) {
    publishableUnpublish(id: $id, input: $input) {
      userErrors {
        field
        message
      }
    }
  }
`;
const PUBLICATION_CONNECTION_KEYS = [
  "appPublications",
  "marketPublications",
  "companyLocationPublications",
  "uncatalogedPublications",
];

export async function runSaleEligibilityWatchdogAgent({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const baseUrl = String(
    env.SALE_ELIGIBILITY_WATCHDOG_URL ||
      env.LAUNCH_MONITOR_URL ||
      env.APP_URL ||
      "",
  ).trim();
  const token = String(env.SALE_ELIGIBILITY_WATCHDOG_TOKEN || "").trim();
  if (!baseUrl || token.length < 32) {
    const direct = await enforceDirectShopifyPurchaseBlock({
      env,
      fetchImpl,
    });
    return buildDirectFallbackResult(direct);
  }

  try {
    const endpoint = new URL("/internal/sale-eligibility-watchdog", baseUrl);
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      redirect: "error",
    });
    const payload = await readJsonResponse(response);
    if (!response.ok || !isWatchdogResponse(payload)) {
      throw new Error("sale_eligibility_watchdog_request_failed");
    }
    return payload;
  } catch (internalError) {
    const direct = await enforceDirectShopifyPurchaseBlock({
      env,
      fetchImpl,
    }).catch(() => null);
    if (direct?.ok === true && direct.protected === true) {
      return buildDirectFallbackResult(direct);
    }
    const error = new Error("sale_eligibility_watchdog_request_failed");
    error.cause = internalError;
    throw error;
  }
}

function buildDirectFallbackResult(direct) {
  return {
    ok: true,
    protected: true,
    status: "critical",
    action: direct.changed
      ? "external_emergency_hold_applied"
      : "external_already_protected",
    fallback: true,
  };
}

export async function enforceDirectShopifyPurchaseBlock({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const shopDomain = String(
    env.SHOPIFY_WATCHDOG_SHOP_DOMAIN || env.SHOPIFY_PRIMARY_SHOP_DOMAIN || "",
  )
    .trim()
    .toLowerCase();
  const accessToken = String(
    env.SHOPIFY_WATCHDOG_ADMIN_ACCESS_TOKEN || "",
  ).trim();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain)) {
    throw new Error("watchdog_shop_domain_invalid");
  }
  if (accessToken.length < 32) {
    throw new Error("watchdog_admin_access_token_invalid");
  }

  const graphQLEndpoint = new URL(
    `/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    `https://${shopDomain}`,
  );
  const graphQL = async (query, variables = {}) => {
    const response = await fetchImpl(graphQLEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    const payload = await readJsonResponse(response);
    if (!response.ok || payload?.errors?.length) {
      throw new Error("watchdog_shopify_graphql_failed");
    }
    return payload.data;
  };

  const current = await graphQL(SHOPIFY_CONTROL_QUERY);
  const shop = current?.shop;
  if (!shop?.id) throw new Error("watchdog_shop_not_found");
  let controlChanged = false;
  let appControlProtected =
    String(shop.metafield?.value || "").toUpperCase() === "BLOCKED";
  let appControlError = null;
  try {
    if (!appControlProtected) {
      const updated = await graphQL(SHOPIFY_CONTROL_MUTATION, {
        metafields: [
          {
            ownerId: shop.id,
            namespace: "$app",
            key: "operational_purchase_control",
            type: "single_line_text_field",
            value: "BLOCKED",
          },
        ],
      });
      if (
        updated?.metafieldsSet?.userErrors?.length ||
        updated?.metafieldsSet?.metafields?.[0]?.value !== "BLOCKED"
      ) {
        throw new Error("watchdog_shopify_block_failed");
      }
      controlChanged = true;
    }
    const verified = await graphQL(SHOPIFY_CONTROL_QUERY);
    appControlProtected =
      String(verified?.shop?.metafield?.value || "").toUpperCase() ===
      "BLOCKED";
  } catch (error) {
    appControlProtected = false;
    appControlError = String(error?.message || "watchdog_app_control_failed");
  }

  const publicationStop = await enforceDirectShopifyPublicationStop({
    graphQL,
  });
  if (!publicationStop.protected) {
    throw new Error("watchdog_shopify_publication_stop_failed");
  }
  return {
    ok: true,
    protected: true,
    changed: controlChanged || publicationStop.changed,
    appControlProtected,
    appControlError,
    publicationStop,
  };
}

function publicationIdsForProduct(product) {
  const ids = [];
  for (const key of PUBLICATION_CONNECTION_KEYS) {
    const connection = product?.[key];
    if (connection?.pageInfo?.hasNextPage) {
      throw new Error("watchdog_publication_pagination_incomplete");
    }
    for (const row of Array.isArray(connection?.nodes)
      ? connection.nodes
      : []) {
      if ((row?.isPublished || row?.publishDate) && row?.publication?.id) {
        ids.push(row.publication.id);
      }
    }
  }
  return [...new Set(ids)];
}

async function loadPublishedProducts(graphQL) {
  const products = [];
  let after = null;
  for (let page = 0; page < 10; page += 1) {
    const data = await graphQL(SHOPIFY_PRODUCTS_PUBLICATION_QUERY, {
      first: 50,
      after,
    });
    const connection = data?.products;
    for (const product of Array.isArray(connection?.nodes)
      ? connection.nodes
      : []) {
      const publicationIds = publicationIdsForProduct(product);
      if (publicationIds.length > 0) {
        products.push({ id: product.id, publicationIds });
      }
    }
    if (!connection?.pageInfo?.hasNextPage) {
      return products;
    }
    after = String(connection?.pageInfo?.endCursor || "").trim();
    if (!after) {
      throw new Error("watchdog_product_pagination_incomplete");
    }
  }
  throw new Error("watchdog_product_scan_limit_exceeded");
}

async function enforceDirectShopifyPublicationStop({ graphQL }) {
  let changed = false;
  let unpublishedProductCount = 0;

  for (let pass = 0; pass < 3; pass += 1) {
    const publishedProducts = await loadPublishedProducts(graphQL);
    if (publishedProducts.length === 0) {
      return {
        protected: true,
        changed,
        unpublishedProductCount,
        verificationPasses: pass + 1,
      };
    }

    for (const product of publishedProducts) {
      const data = await graphQL(SHOPIFY_UNPUBLISH_PRODUCT_MUTATION, {
        id: product.id,
        input: product.publicationIds.map((publicationId) => ({
          publicationId,
        })),
      });
      if (data?.publishableUnpublish?.userErrors?.length) {
        throw new Error("watchdog_product_unpublish_failed");
      }
      changed = true;
      unpublishedProductCount += 1;
    }
  }

  const remaining = await loadPublishedProducts(graphQL);
  return {
    protected: remaining.length === 0,
    changed,
    unpublishedProductCount,
    remainingPublishedProductCount: remaining.length,
    verificationPasses: 3,
  };
}

async function readJsonResponse(response) {
  const contentType = String(response.headers?.get?.("content-type") || "");
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("sale_eligibility_watchdog_invalid_response");
  }
  return response.json();
}

function isWatchdogResponse(payload) {
  return Boolean(
    payload &&
    typeof payload === "object" &&
    payload.ok === true &&
    typeof payload.protected === "boolean" &&
    ["none", "already_protected", "emergency_hold_applied"].includes(
      payload.action,
    ) &&
    ["healthy", "warning", "critical"].includes(payload.status),
  );
}

if (isDirectExecution()) {
  runSaleEligibilityWatchdogAgent()
    .then((result) => {
      console.log(
        `Sale eligibility watchdog succeeded: status=${result.status}, action=${result.action}, protected=${result.protected}`,
      );
    })
    .catch((error) => {
      console.error(
        `Sale eligibility watchdog failed: ${String(
          error?.message || "watchdog_failed",
        )}`,
      );
      process.exitCode = 1;
    });
}

function isDirectExecution() {
  const scriptPath = process.argv[1];
  return Boolean(
    scriptPath && import.meta.url === pathToFileURL(scriptPath).href,
  );
}

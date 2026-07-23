const DEFAULT_LIMIT = 250;
const DEFAULT_TIMEOUT_MS = 60_000;

export async function runShopifyProductCatalogSyncAgent({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const baseUrl = String(
    env.SHOPIFY_PRODUCT_CATALOG_SYNC_URL ||
      env.LAUNCH_MONITOR_URL ||
      env.APP_URL ||
      "",
  ).trim();
  const token = String(env.SHOPIFY_PRODUCT_CATALOG_SYNC_TOKEN || "").trim();

  if (!baseUrl) {
    throw new Error("catalog_sync_url_missing");
  }
  if (token.length < 32) {
    throw new Error("catalog_sync_token_invalid");
  }

  const endpoint = new URL("/internal/shopify-product-catalog-sync", baseUrl);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ limit: String(DEFAULT_LIMIT) }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    redirect: "error",
  });

  const payload = await readJsonResponse(response);
  if (!response.ok || payload?.ok !== true) {
    throw new Error("catalog_sync_request_failed");
  }

  const unresolved = toCount(payload?.result?.unresolved);
  const failed = toCount(payload?.checkoutPolicies?.failedCount);
  if (unresolved > 0 || failed > 0) {
    throw new Error("catalog_sync_incomplete");
  }

  return {
    scanned: toCount(payload?.result?.scanned),
    updated: toCount(payload?.result?.updated),
    unresolved,
    failed,
  };
}

async function readJsonResponse(response) {
  const contentType = String(response.headers?.get?.("content-type") || "");
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("catalog_sync_invalid_response");
  }
  return response.json();
}

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

if (isDirectExecution()) {
  runShopifyProductCatalogSyncAgent()
    .then((result) => {
      console.log(
        `Shopify catalog sync succeeded: scanned=${result.scanned}, updated=${result.updated}, unresolved=${result.unresolved}, failed=${result.failed}`,
      );
    })
    .catch((error) => {
      console.error(
        `Shopify catalog sync failed: ${String(
          error?.message || "catalog_sync_failed",
        )}`,
      );
      process.exitCode = 1;
    });
}

function isDirectExecution() {
  const scriptPath = process.argv[1];
  if (!scriptPath) return false;
  return import.meta.url === pathToFileURL(scriptPath).href;
}
import { pathToFileURL } from "node:url";

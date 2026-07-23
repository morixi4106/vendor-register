import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 90_000;

export async function runShopifyOrderIntegrityAgent({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const baseUrl = String(
    env.SHOPIFY_ORDER_INTEGRITY_URL ||
      env.LAUNCH_MONITOR_URL ||
      env.APP_URL ||
      "",
  ).trim();
  const token = String(env.SHOPIFY_PRODUCT_CATALOG_SYNC_TOKEN || "").trim();
  if (!baseUrl) throw new Error("order_integrity_url_missing");
  if (token.length < 32) throw new Error("order_integrity_token_invalid");

  const endpoint = new URL(
    "/internal/shopify-order-integrity-reconcile",
    baseUrl,
  );
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ limit: "100", lookbackHours: "48" }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    redirect: "error",
  });
  const contentType = String(response.headers?.get?.("content-type") || "");
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("order_integrity_invalid_response");
  }
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) {
    throw new Error("order_integrity_reconciliation_failed");
  }
  return {
    scanned: Number(payload.scanned || 0),
    quarantinedCount: Number(payload.quarantinedCount || 0),
    failedCount: Number(payload.failedCount || 0),
  };
}

if (isDirectExecution()) {
  runShopifyOrderIntegrityAgent()
    .then((result) => {
      console.log(
        `Shopify order integrity succeeded: scanned=${result.scanned}, quarantined=${result.quarantinedCount}, failed=${result.failedCount}`,
      );
    })
    .catch((error) => {
      console.error(
        `Shopify order integrity failed: ${String(
          error?.message || "order_integrity_reconciliation_failed",
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

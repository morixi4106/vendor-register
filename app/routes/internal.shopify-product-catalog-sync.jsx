import { json } from "@remix-run/node";
import crypto from "node:crypto";

import { reconcileShopifyProductCatalog } from "../services/shopifyProductSync.server.js";
import {
  backfillMarketplaceCheckoutPolicies,
  getShopifyPublicationDiagnostics,
} from "../services/marketplaceCheckoutGate.server.js";
import {
  evaluateShopifyProductCatalogSyncRun,
  recordOperationalHeartbeatSafely,
  SHOPIFY_PRODUCT_CATALOG_SYNC_HEARTBEAT_KEY,
} from "../services/operationalHealth.server.js";
import { resolveShopDomain } from "../utils/shopifyAdmin.server.js";

export async function action({ request }) {
  const configuredToken = String(
    process.env.SHOPIFY_PRODUCT_CATALOG_SYNC_TOKEN || "",
  ).trim();
  const providedToken = String(
    request.headers.get("authorization") || "",
  ).replace(/^Bearer\s+/i, "");

  if (!configuredToken || !tokensMatch(providedToken, configuredToken)) {
    return json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const formData = await request.formData().catch(() => new FormData());
  const requestedLimit = Number(formData.get("limit") || 250);
  const limit = Math.max(
    1,
    Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 250, 1000),
  );

  await recordOperationalHeartbeatSafely({
    key: SHOPIFY_PRODUCT_CATALOG_SYNC_HEARTBEAT_KEY,
    status: "started",
    metadataJson: { limit },
  });

  try {
    const shopDomain = await resolveShopDomain(
      process.env.SHOPIFY_PRIMARY_SHOP_DOMAIN || null,
    );
    const result = await reconcileShopifyProductCatalog(shopDomain, { limit });
    const checkoutPolicies =
      await backfillMarketplaceCheckoutPolicies(shopDomain);
    const publications = await getShopifyPublicationDiagnostics(shopDomain);
    const completion = evaluateShopifyProductCatalogSyncRun({
      result,
      checkoutPolicies,
    });

    await recordOperationalHeartbeatSafely({
      key: SHOPIFY_PRODUCT_CATALOG_SYNC_HEARTBEAT_KEY,
      status: completion.complete ? "succeeded" : "failed",
      errorCode: completion.errorCode,
      metadataJson: {
        shopDomain,
        scanned: result.scanned,
        unresolved: completion.unresolved,
        checkoutPolicyFailedCount: completion.checkoutPolicyFailedCount,
      },
    });

    return json({
      ok: completion.complete,
      shopDomain,
      scanned: result.scanned,
      created: result.created,
      updated: result.updated,
      unresolved: result.unresolved,
      checkoutPolicies,
      publications,
    });
  } catch (error) {
    console.error("Internal Shopify product catalog sync failed:", error);
    await recordOperationalHeartbeatSafely({
      key: SHOPIFY_PRODUCT_CATALOG_SYNC_HEARTBEAT_KEY,
      status: "failed",
      errorCode: "shopify_product_catalog_sync_failed",
    });
    return json(
      { ok: false, error: "shopify_product_catalog_sync_failed" },
      { status: 500 },
    );
  }
}

function tokensMatch(provided, expected) {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

export async function loader() {
  return json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}

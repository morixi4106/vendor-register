import crypto from "node:crypto";
import {
  acquireLaunchMonitorRunLock,
  releaseLaunchMonitorRunLock,
} from "../services/launchMonitor.server.js";
import { requirePostRequest } from "../utils/routeSecurity.server.js";
import {
  protectLegacyVendorContacts,
  runPrivacyMaintenance,
} from "../services/privacyOperations.server.js";

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
  requirePostRequest(request);
  const configuredToken = String(
    process.env.SHOPIFY_PRODUCT_CATALOG_SYNC_TOKEN || "",
  ).trim();
  const providedToken = String(
    request.headers.get("authorization") || "",
  ).replace(/^Bearer\s+/i, "");

  if (!configuredToken || !tokensMatch(providedToken, configuredToken)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const formData = await request.formData().catch(() => new FormData());
  const owner = await acquireLaunchMonitorRunLock({
    key: "shopify_catalog_sync_lock",
    ttlMinutes: 10,
  });
  if (!owner)
    return Response.json(
      { ok: false, error: "catalog_sync_in_progress" },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  try {
    try {
      await runPrivacyMaintenance();
      if (
        process.env.PRIVACY_LEGACY_ENCRYPTION_ENABLED === "true" &&
        /^[a-f0-9]{64}$/i.test(String(process.env.PRIVACY_ENCRYPTION_KEY || ""))
      )
        await protectLegacyVendorContacts();
    } catch {
      console.error("privacy maintenance failed", {
        code: "privacy_maintenance_failed",
      });
      await recordOperationalHeartbeatSafely({
        key: "privacy_maintenance",
        status: "failed",
        errorCode: "privacy_maintenance_failed",
      });
    }
    const requestedLimit = Number(formData.get("limit") || 10000);
    const limit = Math.max(
      1,
      Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 10000, 10000),
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
      const result = await reconcileShopifyProductCatalog(shopDomain, {
        limit,
      });
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
          catalogComplete: completion.catalogComplete,
          incompleteReason: completion.incompleteReason,
          unresolved: completion.unresolved,
          checkoutPolicyFailedCount: completion.checkoutPolicyFailedCount,
        },
      });

      return Response.json({
        ok: completion.complete,
        shopDomain,
        scanned: result.scanned,
        created: result.created,
        updated: result.updated,
        unresolved: result.unresolved,
        complete: result.complete,
        incompleteReason: result.incompleteReason,
        nextCursor: result.nextCursor,
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
      return Response.json(
        { ok: false, error: "shopify_product_catalog_sync_failed" },
        { status: 500 },
      );
    }
  } finally {
    await releaseLaunchMonitorRunLock({
      key: "shopify_catalog_sync_lock",
      owner,
    }).catch(() => {});
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
  return Response.json(
    { ok: false, error: "method_not_allowed" },
    { status: 405 },
  );
}

import {
  recordShopifyProductPolicySyncFailure,
  syncShopifyProductPayload,
} from "./shopifyProductSync.server.js";
import {
  enforceUnresolvedShopifyProductPublicationBoundary,
  syncMarketplaceCheckoutPolicyForProduct,
} from "./marketplaceCheckoutGate.server.js";
import {
  recordOperationalHeartbeatSafely,
  SHOPIFY_PRODUCT_CATALOG_SYNC_HEARTBEAT_KEY,
} from "./operationalHealth.server.js";

const POLICY_SYNC_FAILURE_REASON =
  "marketplace_checkout_policy_sync_failed";
const UNRESOLVED_BOUNDARY_FAILURE_REASON =
  "unresolved_product_boundary_failed";

function errorMessage(error) {
  return String(error?.message || error || "unknown_error").slice(0, 500);
}

async function recordDeferredSyncHeartbeat({
  topic,
  shop,
  productId,
  reason,
  error,
  recordHeartbeat,
}) {
  await recordHeartbeat({
    key: SHOPIFY_PRODUCT_CATALOG_SYNC_HEARTBEAT_KEY,
    status: "failed",
    errorCode: reason,
    metadataJson: {
      source: "shopify_product_webhook",
      topic,
      shop,
      productId,
      error: errorMessage(error),
    },
  });
}

export async function processShopifyProductWebhook(
  { payload, topic, shop },
  {
    syncPayload = syncShopifyProductPayload,
    syncPolicy = syncMarketplaceCheckoutPolicyForProduct,
    enforceUnresolvedBoundary =
      enforceUnresolvedShopifyProductPublicationBoundary,
    recordPolicyFailure = recordShopifyProductPolicySyncFailure,
    recordHeartbeat = recordOperationalHeartbeatSafely,
  } = {},
) {
  const productId = payload?.admin_graphql_api_id || payload?.id || null;
  const syncResult = await syncPayload(payload, { shopDomain: shop });

  if (!syncResult.ok) {
    try {
      await enforceUnresolvedBoundary({
        shopDomain: shop,
        shopifyProductId: productId,
      });
      return {
        ok: false,
        deferred: false,
        reason: syncResult.reason,
        syncResult,
      };
    } catch (error) {
      await recordDeferredSyncHeartbeat({
        topic,
        shop,
        productId,
        reason: UNRESOLVED_BOUNDARY_FAILURE_REASON,
        error,
        recordHeartbeat,
      });
      console.error("Shopify unresolved product boundary deferred:", {
        topic,
        shop,
        productId,
        reason: syncResult.reason,
        error: errorMessage(error),
      });
      return {
        ok: false,
        deferred: true,
        reason: UNRESOLVED_BOUNDARY_FAILURE_REASON,
        syncResult,
      };
    }
  }

  try {
    const policyResult = await syncPolicy({
      localProductId: syncResult.product.id,
      shopDomain: shop,
    });
    if (policyResult?.ok !== true) {
      const error = new Error(
        String(policyResult?.reason || POLICY_SYNC_FAILURE_REASON),
      );
      error.policyResult = policyResult;
      throw error;
    }
    return {
      ok: true,
      deferred: false,
      syncResult,
      policyResult,
    };
  } catch (error) {
    // The local product snapshot is already durable. Persist a recovery marker
    // before acknowledging the webhook so the scheduled catalog sync can retry
    // without Shopify amplifying a transient Admin API failure.
    await recordPolicyFailure(
      {
        payload,
        shopDomain: shop,
        localProductId: syncResult.product.id,
        vendorStoreId: syncResult.product.vendorStoreId,
        reason: POLICY_SYNC_FAILURE_REASON,
      },
    );
    await recordDeferredSyncHeartbeat({
      topic,
      shop,
      productId,
      reason: POLICY_SYNC_FAILURE_REASON,
      error,
      recordHeartbeat,
    });
    console.error("Shopify product checkout policy sync deferred:", {
      topic,
      shop,
      productId,
      localProductId: syncResult.product.id,
      error: errorMessage(error),
    });
    return {
      ok: false,
      deferred: true,
      reason: POLICY_SYNC_FAILURE_REASON,
      syncResult,
    };
  }
}

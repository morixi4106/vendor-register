import prisma from "../db.server.js";
import { inspectShopifyProductCatalogSyncFreshness } from "./operationalHealth.server.js";
import {
  inspectCriticalShopifyScopes,
  SHOPIFY_APP_CONTROL_HEARTBEAT_KEY,
} from "./shopifyAppControlLoss.server.js";
import { inspectMarketplaceCheckoutValidation } from "./shopifyCheckoutValidation.server.js";
import {
  applyPlatformCheckoutEmergencyHold,
  getPlatformOperationalControl,
  OPERATIONAL_CONTROL_STATE,
  PLATFORM_OPERATIONAL_CONTROL_KEY,
} from "./operationalReadiness.server.js";

const WATCHDOG_ACTOR = "system:catalog-sync-watchdog";
const CAPABILITY_LOSS_CODE = "shopify_control_capability_lost";

function normalizeShopDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function heartbeatFailedAfterLastSuccess(heartbeat) {
  if (!heartbeat?.lastFailedAt) return false;
  if (!heartbeat.lastSucceededAt) return true;
  return (
    new Date(heartbeat.lastFailedAt).getTime() >=
    new Date(heartbeat.lastSucceededAt).getTime()
  );
}

export async function inspectShopifyControlCapability({
  prismaClient = prisma,
  now = new Date(),
  env = process.env,
  inspectValidation = inspectMarketplaceCheckoutValidation,
} = {}) {
  const shopDomain = normalizeShopDomain(
    env.SHOPIFY_PRIMARY_SHOP_DOMAIN || env.SHOPIFY_SHOP,
  );
  const [control, heartbeat, offlineSession] = await Promise.all([
    getPlatformOperationalControl({ prismaClient }),
    prismaClient?.operationalHeartbeat?.findUnique
      ? prismaClient.operationalHeartbeat.findUnique({
          where: { key: SHOPIFY_APP_CONTROL_HEARTBEAT_KEY },
        })
      : Promise.resolve(null),
    shopDomain && prismaClient?.session?.findFirst
      ? prismaClient.session.findFirst({
          where: { shop: shopDomain, isOnline: false },
          orderBy: { expires: "desc" },
        })
      : Promise.resolve(null),
  ]);
  const failures = [];
  const controlState = String(
    control?.checkoutControlState || "IDLE",
  ).toUpperCase();
  if (
    control?.available !== true ||
    control?.checkoutHold === true ||
    !["IDLE", "RECOVERED"].includes(controlState)
  ) {
    failures.push("platform_operational_control_not_allowed");
  }
  if (heartbeatFailedAfterLastSuccess(heartbeat)) {
    failures.push("shopify_app_control_heartbeat_failed");
  }
  if (!shopDomain) {
    failures.push("shopify_primary_shop_missing");
  }
  if (
    !offlineSession ||
    (offlineSession.expires &&
      new Date(offlineSession.expires).getTime() <= now.getTime())
  ) {
    failures.push("shopify_offline_session_missing");
  }

  const scopeInspection = inspectCriticalShopifyScopes(
    offlineSession?.scope || "",
  );
  if (!scopeInspection.ready) {
    failures.push("shopify_required_scope_missing");
  }

  let validation = null;
  if (shopDomain && offlineSession) {
    try {
      validation = await inspectValidation(shopDomain);
    } catch {
      validation = {
        ok: false,
        active: false,
        reason: "validation_inspection_failed",
      };
    }
  }
  if (
    !validation ||
    validation.ok !== true ||
    validation.active !== true ||
    validation.validationCount !== 1 ||
    validation.runtimeErrorDetected === true
  ) {
    failures.push("shopify_checkout_validation_unavailable");
  }

  return {
    ok: failures.length === 0,
    code: failures.length === 0 ? null : CAPABILITY_LOSS_CODE,
    failures,
    shopDomain,
    controlState,
    missingScopes: scopeInspection.missingScopes,
    offlineSessionPresent: Boolean(offlineSession),
    validationReason: validation?.reason || null,
  };
}

export async function enforceCatalogSyncSaleEligibilityFailSafe({
  prismaClient = prisma,
  now = new Date(),
  env = process.env,
  inspectFreshness = inspectShopifyProductCatalogSyncFreshness,
  inspectCapability = inspectShopifyControlCapability,
  applyEmergencyHold = applyPlatformCheckoutEmergencyHold,
} = {}) {
  const capability = await inspectCapability({ prismaClient, now, env });
  if (capability.ok !== true) {
    const existingControl =
      await prismaClient.platformOperationalControl.findUnique({
        where: { key: PLATFORM_OPERATIONAL_CONTROL_KEY },
      });
    const alreadyProtected = isCheckoutProtectionActive(existingControl);
    const result = alreadyProtected
      ? { ok: true, reason: "purchase_stop_already_active" }
      : await applyEmergencyHold(
          {
            reason: `${CAPABILITY_LOSS_CODE}: ${capability.failures.join(",")}`,
            changedBy: WATCHDOG_ACTOR,
            shopDomain: capability.shopDomain || null,
          },
          { prismaClient, now, env },
        );
    const localHoldApplied =
      result?.ok === true ||
      result?.reason === "purchase_stop_already_active";
    return {
      ok: localHoldApplied,
      protected: false,
      action: alreadyProtected
        ? "already_protected"
        : localHoldApplied
          ? "emergency_hold_applied"
          : "emergency_hold_failed",
      status: "critical",
      capability,
      reason: CAPABILITY_LOSS_CODE,
      requiresExternalProtection: true,
    };
  }

  const freshness = await inspectFreshness({ prismaClient, now, env });
  if (freshness.status !== "critical") {
    return {
      ok: true,
      protected: false,
      action: "none",
      status: freshness.status,
      capability,
      freshness,
    };
  }

  const existingControl =
    await prismaClient.platformOperationalControl.findUnique({
      where: { key: PLATFORM_OPERATIONAL_CONTROL_KEY },
    });
  if (isCheckoutProtectionActive(existingControl)) {
    return {
      ok: true,
      protected: true,
      action: "already_protected",
      status: "critical",
      capability,
      freshness,
      controlState: existingControl.checkoutControlState,
    };
  }

  const reason = [
    "Catalog synchronization freshness exceeded the purchase-safety limit.",
    `code=${freshness.reason || "catalog_sync_critical"}`,
    `criticalMinutes=${freshness.criticalMinutes}`,
    `ageMinutes=${
      freshness.ageMinutes == null
        ? "unknown"
        : Math.floor(freshness.ageMinutes)
    }`,
  ].join(" ");
  const result = await applyEmergencyHold(
    {
      reason,
      changedBy: WATCHDOG_ACTOR,
      shopDomain: env.SHOPIFY_PRIMARY_SHOP_DOMAIN || null,
    },
    { prismaClient, now, env },
  );
  const protectedByConcurrentRun =
    result?.reason === "purchase_stop_already_active";
  const protectedSuccessfully = result?.ok === true || protectedByConcurrentRun;

  return {
    ok: protectedSuccessfully,
    protected: protectedSuccessfully,
    action: protectedByConcurrentRun
      ? "already_protected"
      : result?.ok === true
        ? "emergency_hold_applied"
        : "emergency_hold_failed",
    freshness,
    capability,
    status: "critical",
    controlState:
      result?.control?.checkoutControlState ||
      result?.operationalControl?.state ||
      null,
    failureCount: Number(result?.failureCount || 0),
    reason: protectedSuccessfully
      ? null
      : result?.reason || "catalog_sync_fail_safe_failed",
  };
}

function isCheckoutProtectionActive(control) {
  if (control?.checkoutHold === true) return true;
  return [
    OPERATIONAL_CONTROL_STATE.REQUESTED,
    OPERATIONAL_CONTROL_STATE.ACTIVATING,
    OPERATIONAL_CONTROL_STATE.ACTIVE,
    OPERATIONAL_CONTROL_STATE.PARTIAL_FAILURE,
    OPERATIONAL_CONTROL_STATE.RECOVERY_REQUESTED,
    OPERATIONAL_CONTROL_STATE.RECOVERING,
    OPERATIONAL_CONTROL_STATE.RECOVERY_FAILED,
  ].includes(String(control?.checkoutControlState || "").toUpperCase());
}

export const SALE_ELIGIBILITY_WATCHDOG = Object.freeze({
  actor: WATCHDOG_ACTOR,
});

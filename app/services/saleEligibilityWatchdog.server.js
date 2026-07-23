import prisma from "../db.server.js";
import { inspectShopifyProductCatalogSyncFreshness } from "./operationalHealth.server.js";
import {
  applyPlatformCheckoutEmergencyHold,
  OPERATIONAL_CONTROL_STATE,
  PLATFORM_OPERATIONAL_CONTROL_KEY,
} from "./operationalReadiness.server.js";

const WATCHDOG_ACTOR = "system:catalog-sync-watchdog";

export async function enforceCatalogSyncSaleEligibilityFailSafe({
  prismaClient = prisma,
  now = new Date(),
  env = process.env,
  inspectFreshness = inspectShopifyProductCatalogSyncFreshness,
  applyEmergencyHold = applyPlatformCheckoutEmergencyHold,
} = {}) {
  const freshness = await inspectFreshness({ prismaClient, now, env });
  if (freshness.status !== "critical") {
    return {
      ok: true,
      protected: false,
      action: "none",
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

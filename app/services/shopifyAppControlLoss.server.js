import prisma from "../db.server.js";
import { createMarketplaceOperationalCase } from "./marketplaceGovernance.server.js";
import { recordOperationalHeartbeatSafely } from "./operationalHealth.server.js";

export const SHOPIFY_APP_CONTROL_HEARTBEAT_KEY =
  "shopify_app_control_capability";

export const CRITICAL_SHOPIFY_SCOPES = Object.freeze([
  "read_orders",
  "read_products",
  "read_publications",
  "write_publications",
  "read_validations",
  "write_validations",
  "read_merchant_managed_fulfillment_orders",
  "write_merchant_managed_fulfillment_orders",
]);

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeScopeList(value) {
  const candidates = Array.isArray(value)
    ? value
    : normalizeText(value).split(",");
  return new Set(
    candidates
      .map((scope) => normalizeText(scope).toLowerCase())
      .filter(Boolean),
  );
}

export function inspectCriticalShopifyScopes(scopes) {
  const current = normalizeScopeList(scopes);
  const missingScopes = CRITICAL_SHOPIFY_SCOPES.filter(
    (scope) => !current.has(scope),
  );
  return {
    ready: missingScopes.length === 0,
    missingScopes,
    grantedScopeCount: current.size,
  };
}

export async function activateShopifyControlLossHold(
  { shopDomain, reason, missingScopes = [], eventType },
  { prismaClient = prisma, now = new Date() } = {},
) {
  const normalizedShop = normalizeText(shopDomain).toLowerCase();
  const normalizedReason =
    normalizeText(reason) || "shopify_control_capability_lost";
  const metadataJson = {
    shopDomain: normalizedShop,
    eventType: normalizeText(eventType),
    missingScopes,
    detectedAt: now.toISOString(),
    recoveryRequiresIndependentShopifyVerification: true,
  };

  if (prismaClient?.platformOperationalControl?.upsert) {
    await prismaClient.platformOperationalControl.upsert({
      where: { key: "GLOBAL" },
      create: {
        key: "GLOBAL",
        checkoutHold: true,
        checkoutControlState: "PARTIAL_FAILURE",
        holdReason: normalizedReason,
        changedBy: "system:shopify_control_loss",
        changedAt: now,
        metadataJson,
      },
      update: {
        checkoutHold: true,
        checkoutControlState: "PARTIAL_FAILURE",
        holdReason: normalizedReason,
        changedBy: "system:shopify_control_loss",
        changedAt: now,
        releaseEvidenceReference: null,
        metadataJson,
      },
    });
  }

  await recordOperationalHeartbeatSafely(
    {
      key: SHOPIFY_APP_CONTROL_HEARTBEAT_KEY,
      status: "failed",
      errorCode: normalizedReason,
      metadataJson,
    },
    { prismaClient },
  );

  let operationalCaseId = null;
  if (
    prismaClient?.marketplaceOperationalCase?.create &&
    prismaClient?.marketplaceOperationalCaseEvent?.create
  ) {
    const created = await createMarketplaceOperationalCase(
      {
        caseType: "OTHER",
        priority: "CRITICAL",
        summary:
          "Shopify app control capability was lost. Keep checkout blocked until independent verification succeeds.",
        detailsJson: metadataJson,
        assignedTo: "INCIDENT_COMMANDER",
        dueAt: new Date(now.getTime() + 15 * 60 * 1000),
      },
      {
        prismaClient,
        actor: "system:shopify_control_loss",
      },
    ).catch(() => null);
    operationalCaseId = created?.case?.id || null;
  }

  return {
    ok: true,
    held: true,
    reason: normalizedReason,
    operationalCaseId,
  };
}

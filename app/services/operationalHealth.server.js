import prisma from "../db.server.js";
import { resolveOperationalTimingPolicy } from "./operationalTimingPolicy.js";

export const WITHDRAWAL_EMAIL_OUTBOX_HEARTBEAT_KEY = "withdrawal_email_outbox";
export const SHOPIFY_PRODUCT_CATALOG_SYNC_HEARTBEAT_KEY =
  "shopify_product_catalog_sync";

export function evaluateShopifyProductCatalogSyncFreshness({
  heartbeat,
  now = new Date(),
  env = process.env,
} = {}) {
  const policy = resolveOperationalTimingPolicy(env);
  const lastSucceededAt = heartbeat?.lastSucceededAt
    ? new Date(heartbeat.lastSucceededAt)
    : null;
  const validLastSuccess = Boolean(
    lastSucceededAt && Number.isFinite(lastSucceededAt.getTime()),
  );
  const ageMinutes = validLastSuccess
    ? Math.max(0, (now.getTime() - lastSucceededAt.getTime()) / 60_000)
    : null;
  const critical =
    policy.valid !== true ||
    !validLastSuccess ||
    ageMinutes >= policy.catalogSyncCriticalMinutes;
  const warning =
    !critical && ageMinutes >= policy.catalogSyncWarningMinutes;

  return {
    ok: !critical,
    status: critical ? "critical" : warning ? "warning" : "healthy",
    reason:
      policy.valid !== true
        ? "catalog_sync_timing_policy_invalid"
        : !validLastSuccess
          ? "catalog_sync_success_missing"
          : critical
            ? "catalog_sync_critical_stale"
            : warning
              ? "catalog_sync_warning_stale"
              : null,
    lastSucceededAt: validLastSuccess ? lastSucceededAt : null,
    ageMinutes,
    warningMinutes: policy.catalogSyncWarningMinutes,
    criticalMinutes: policy.catalogSyncCriticalMinutes,
    policyValid: policy.valid,
  };
}

export async function inspectShopifyProductCatalogSyncFreshness(
  {
    prismaClient = prisma,
    now = new Date(),
    env = process.env,
  } = {},
) {
  const heartbeat =
    await prismaClient.operationalHeartbeat.findUnique({
      where: { key: SHOPIFY_PRODUCT_CATALOG_SYNC_HEARTBEAT_KEY },
    });
  return evaluateShopifyProductCatalogSyncFreshness({
    heartbeat,
    now,
    env,
  });
}

export function evaluateShopifyProductCatalogSyncRun({
  result,
  checkoutPolicies,
} = {}) {
  const unresolved = Number(result?.unresolved || 0);
  const checkoutPolicyFailedCount = Number(checkoutPolicies?.failedCount || 0);
  const complete =
    result?.ok === true &&
    result?.complete === true &&
    unresolved === 0 &&
    checkoutPolicies?.ok === true &&
    checkoutPolicyFailedCount === 0;

  return {
    complete,
    errorCode: complete ? null : "shopify_product_catalog_sync_incomplete",
    unresolved,
    checkoutPolicyFailedCount,
    catalogComplete: result?.complete === true,
    incompleteReason: result?.incompleteReason || null,
  };
}

export async function recordOperationalHeartbeat(
  { key, status, errorCode = null, metadataJson = null },
  { prismaClient = prisma, now = new Date() } = {},
) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) {
    throw new Error("operational_heartbeat_key_required");
  }

  const normalizedStatus = String(status || "")
    .trim()
    .toLowerCase();
  if (!["started", "succeeded", "failed"].includes(normalizedStatus)) {
    throw new Error("operational_heartbeat_status_invalid");
  }

  const data = {
    metadataJson,
    ...(normalizedStatus === "started" ? { lastStartedAt: now } : {}),
    ...(normalizedStatus === "succeeded"
      ? {
          lastSucceededAt: now,
          lastErrorCode: null,
        }
      : {}),
    ...(normalizedStatus === "failed"
      ? {
          lastFailedAt: now,
          lastErrorCode: String(errorCode || "operation_failed").slice(0, 500),
        }
      : {}),
  };

  return prismaClient.operationalHeartbeat.upsert({
    where: { key: normalizedKey },
    create: {
      key: normalizedKey,
      ...data,
    },
    update: data,
  });
}

export async function recordOperationalHeartbeatSafely(input, options = {}) {
  try {
    return await recordOperationalHeartbeat(input, options);
  } catch (error) {
    console.error("operational heartbeat update failed:", {
      key: input?.key,
      status: input?.status,
      error: String(error?.message || error || "unknown_error"),
    });
    return null;
  }
}

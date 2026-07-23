import prisma from "../db.server.js";

export const WITHDRAWAL_EMAIL_OUTBOX_HEARTBEAT_KEY = "withdrawal_email_outbox";
export const SHOPIFY_PRODUCT_CATALOG_SYNC_HEARTBEAT_KEY =
  "shopify_product_catalog_sync";

export function evaluateShopifyProductCatalogSyncRun({
  result,
  checkoutPolicies,
} = {}) {
  const unresolved = Number(result?.unresolved || 0);
  const checkoutPolicyFailedCount = Number(checkoutPolicies?.failedCount || 0);
  const complete =
    unresolved === 0 &&
    checkoutPolicies?.ok === true &&
    checkoutPolicyFailedCount === 0;

  return {
    complete,
    errorCode: complete ? null : "shopify_product_catalog_sync_incomplete",
    unresolved,
    checkoutPolicyFailedCount,
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

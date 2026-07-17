import prisma from "../db.server.js";

export const WITHDRAWAL_EMAIL_OUTBOX_HEARTBEAT_KEY = "withdrawal_email_outbox";

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

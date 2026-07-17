import crypto from "node:crypto";

import prisma from "../db.server.js";

export function hashPublicRateLimitKey(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

export function getRequestClientIp(request) {
  return String(
    request?.headers?.get?.("cf-connecting-ip") ||
      request?.headers?.get?.("x-real-ip") ||
      request?.headers?.get?.("x-forwarded-for") ||
      "unknown",
  )
    .split(",")[0]
    .trim();
}

export async function consumePublicEndpointRateLimit({
  endpoint,
  key,
  limit,
  windowMs,
  prismaClient = prisma,
  now = new Date(),
} = {}) {
  const boundedLimit = Math.max(1, Number(limit) || 1);
  const boundedWindowMs = Math.max(1_000, Number(windowMs) || 60_000);
  const windowStart = new Date(
    Math.floor(now.getTime() / boundedWindowMs) * boundedWindowMs,
  );
  const expiresAt = new Date(windowStart.getTime() + boundedWindowMs * 2);
  const keyHash = hashPublicRateLimitKey(key);
  const record = await prismaClient.publicEndpointRateLimit.upsert({
    where: {
      endpoint_keyHash_windowStart: { endpoint, keyHash, windowStart },
    },
    create: { endpoint, keyHash, windowStart, expiresAt, count: 1 },
    update: { count: { increment: 1 }, expiresAt },
  });

  return {
    ok: record.count <= boundedLimit,
    count: record.count,
    limit: boundedLimit,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((windowStart.getTime() + boundedWindowMs - now.getTime()) / 1000),
    ),
  };
}

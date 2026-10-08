import crypto from "node:crypto";

import prisma from "../db.server.js";
import { hashPrivateIdentifier } from "../utils/privacyHash.server.js";
import {
  readVendorContacts,
  vendorEmailLookupWhere,
} from "../utils/privateData.server.js";
import {
  consumePublicEndpointRateLimit,
  getRequestClientIp,
} from "./publicEndpointRateLimit.server.js";

export function hashVendorSessionToken(token) {
  return `sha256:${crypto.createHash("sha256").update(String(token)).digest("hex")}`;
}

export async function findVendorAdminSession(
  token,
  { prismaClient = prisma, include, now = new Date() } = {},
) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ""))) return null;
  let session = await prismaClient.vendorAdminSession.findUnique({
    where: { sessionToken: hashVendorSessionToken(token) },
    include,
  });
  // Existing raw-token sessions expire after the original eight-hour window.
  if (!session)
    session = await prismaClient.vendorAdminSession.findUnique({
      where: { sessionToken: token },
      include,
    });
  if (!session || new Date(session.expiresAt) <= now) return null;
  return readVendorContacts(session);
}

export async function enforceVendorAuthenticationRateLimit({
  request,
  email,
  intent,
  prismaClient = prisma,
  env = process.env,
  now = new Date(),
}) {
  const limits = intent === "send-code" ? [5, 3, 100] : [30, 15, 2000];
  const keys = [
    `ip:${getRequestClientIp(request)}`,
    `email:${String(email).toLowerCase()}`,
    "global",
  ];
  const results = await Promise.all(
    keys.map((key, index) =>
      consumePublicEndpointRateLimit({
        endpoint: `vendor-auth:${intent}`,
        key: hashPrivateIdentifier(key, { env }),
        limit: limits[index],
        windowMs:
          index === 2 && intent === "send-code" ? 86400_000 : 10 * 60_000,
        prismaClient,
        now,
      }),
    ),
  );
  const denied = results.filter((result) => !result.ok);
  if (denied.length)
    throw Response.json(
      { ok: false, step: "email", error: "時間を置いて再度お試しください。" },
      {
        status: 429,
        headers: {
          "Retry-After": String(
            Math.max(...denied.map((result) => result.retryAfterSeconds)),
          ),
          "Cache-Control": "no-store",
        },
      },
    );
}

export async function findVendorForAuthentication({
  email,
  vendorId,
  isAdmin = false,
  prismaClient = prisma,
  env = process.env,
}) {
  const vendor = await prismaClient.vendor.findFirst({
    where: {
      status: "active",
      ...(vendorId ? { id: vendorId } : {}),
      ...(!isAdmin
        ? vendorEmailLookupWhere(email, { management: true, env })
        : {}),
    },
  });
  return readVendorContacts(vendor, { env });
}

function codeDigest(vendorId, email, code, env) {
  return `hmac:${hashPrivateIdentifier(`vendor-code:${vendorId}:${String(email).toLowerCase()}:${code}`, { env })}`;
}

async function serializable(prismaClient, callback) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prismaClient.$transaction(callback, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      if (error?.code !== "P2034" || attempt >= 2) throw error;
    }
  }
}

export async function issueVendorLoginCode({
  vendorId,
  email,
  prismaClient = prisma,
  env = process.env,
  now = new Date(),
}) {
  const code = String(crypto.randomInt(100000, 1000000));
  const emailHash = hashPrivateIdentifier(
    `vendor-code-email:${String(email).toLowerCase()}`,
    { env },
  );
  const record = await serializable(prismaClient, async (tx) => {
    await tx.vendorLoginCode.updateMany({
      where: { vendorId, usedAt: null },
      data: { usedAt: now },
    });
    return tx.vendorLoginCode.create({
      data: {
        vendorId,
        email: emailHash,
        code: codeDigest(vendorId, email, code, env),
        attempts: 0,
        expiresAt: new Date(now.getTime() + 10 * 60_000),
      },
    });
  });
  return { code, id: record.id };
}

export async function consumeVendorLoginCode({
  vendorId,
  email,
  code,
  prismaClient = prisma,
  env = process.env,
  now = new Date(),
}) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const emailHash = hashPrivateIdentifier(
    `vendor-code-email:${String(email).toLowerCase()}`,
    { env },
  );
  return serializable(prismaClient, async (tx) => {
    const challenge = await tx.vendorLoginCode.findFirst({
      where: {
        vendorId,
        email: emailHash,
        usedAt: null,
        expiresAt: { gt: now },
        attempts: { lt: 5 },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (!challenge) return null;
    const expected = Buffer.from(codeDigest(vendorId, email, code, env));
    const actual = Buffer.from(challenge.code);
    const matches =
      actual.length === expected.length &&
      crypto.timingSafeEqual(actual, expected);
    const update = await tx.vendorLoginCode.updateMany({
      where: {
        id: challenge.id,
        usedAt: null,
        attempts: challenge.attempts,
        expiresAt: { gt: now },
      },
      data: {
        attempts: { increment: 1 },
        ...(matches || challenge.attempts >= 4 ? { usedAt: now } : {}),
      },
    });
    if (update.count !== 1 || !matches) return null;
    const sessionToken = crypto.randomBytes(32).toString("hex");
    await tx.vendorAdminSession.create({
      data: {
        vendorId,
        sessionToken: hashVendorSessionToken(sessionToken),
        expiresAt: new Date(now.getTime() + 8 * 60 * 60_000),
      },
    });
    return { sessionToken };
  });
}

export async function revokeVendorAdminSessions(
  vendorId,
  { prismaClient = prisma } = {},
) {
  const now = new Date();
  return prismaClient.vendorAdminSession.updateMany({
    where: { vendorId },
    data: { expiresAt: now },
  });
}

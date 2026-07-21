import prisma from "../db.server.js";
import { authenticate } from "../shopify.server.js";
import { hashPrivateIdentifier } from "./privacyHash.server.js";

export const MARKETPLACE_OPERATOR_ROLES = Object.freeze({
  ADMIN: "MARKETPLACE_ADMIN",
  FINANCE_PREPARER: "FINANCE_PREPARER",
  FINANCE_APPROVER: "FINANCE_APPROVER",
  FINANCE_EXECUTOR: "FINANCE_EXECUTOR",
});

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeUserId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function parseAllowlist(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map(normalizeEmail)
      .filter(Boolean),
  );
}

function getClientIp(request) {
  return String(
    request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-forwarded-for") ||
      request.headers.get("x-real-ip") ||
      "",
  )
    .split(",")[0]
    .trim();
}

function getRoleAllowlist(role, env) {
  const common = parseAllowlist(env.MARKETPLACE_ADMIN_EMAILS);
  const roleSpecific = parseAllowlist(env[`${role}_EMAILS`]);
  const adminEmail = normalizeEmail(env.ADMIN_EMAIL);
  if (adminEmail) common.add(adminEmail);
  return new Set([...common, ...roleSpecific]);
}

async function resolveAssociatedUser(session, prismaClient) {
  const associatedUser = session?.onlineAccessInfo?.associated_user || null;
  if (associatedUser) {
    return {
      userId: normalizeUserId(associatedUser.id),
      email: normalizeEmail(associatedUser.email),
      accountOwner: Boolean(associatedUser.account_owner),
    };
  }

  const storedSession = session?.id
    ? await prismaClient.session.findUnique({
        where: { id: session.id },
        select: { userId: true, email: true, accountOwner: true },
      })
    : null;
  return {
    userId: normalizeUserId(storedSession?.userId),
    email: normalizeEmail(storedSession?.email),
    accountOwner: Boolean(storedSession?.accountOwner),
  };
}

export async function requireMarketplaceOperator(
  request,
  {
    role = MARKETPLACE_OPERATOR_ROLES.ADMIN,
    roles = null,
    env = process.env,
    prismaClient = prisma,
  } = {},
) {
  const context = await authenticate.admin(request);
  const identity = await resolveAssociatedUser(context.session, prismaClient);
  const requestedRoles = Array.from(
    new Set(
      (Array.isArray(roles) && roles.length > 0 ? roles : [role]).filter(
        Boolean,
      ),
    ),
  );
  const matchedRole = requestedRoles.find((requestedRole) =>
    getRoleAllowlist(requestedRole, env).has(identity.email),
  );
  const authorized =
    identity.accountOwner || Boolean(identity.email && matchedRole);

  if (!authorized) {
    throw new Response("Forbidden", {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const ipHash = hashPrivateIdentifier(getClientIp(request), { env });
  const actorKey = identity.userId
    ? `shopify_user:${identity.userId}`
    : `shopify_email:${identity.email}`;

  return {
    ...context,
    operator: {
      role: matchedRole || requestedRoles[0],
      actorKey,
      userId: identity.userId,
      email: identity.email || null,
      accountOwner: identity.accountOwner,
      ipHash,
      occurredAt: new Date().toISOString(),
    },
  };
}

export function operatorAuditSnapshot(operator) {
  if (!operator) return null;
  return {
    role: operator.role || null,
    actorKey: operator.actorKey || null,
    userId: operator.userId || null,
    email: operator.email || null,
    accountOwner: Boolean(operator.accountOwner),
    ipHash: operator.ipHash || null,
    occurredAt: operator.occurredAt || new Date().toISOString(),
  };
}

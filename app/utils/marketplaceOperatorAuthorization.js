import { hashPrivateIdentifier } from "./privacyHash.server.js";
import { MARKETPLACE_OPERATOR_ROLES } from "./marketplaceOperatorRoles.js";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeUserId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function parseAllowlist(value, normalize) {
  return new Set(
    String(value || "")
      .split(",")
      .map(normalize)
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

function getRoleEmailAllowlist(role, env) {
  const common = parseAllowlist(
    env.MARKETPLACE_ADMIN_EMAILS,
    normalizeEmail,
  );
  const roleSpecific = parseAllowlist(
    env[`${role}_EMAILS`],
    normalizeEmail,
  );
  const adminEmail = normalizeEmail(env.ADMIN_EMAIL);
  if (adminEmail) common.add(adminEmail);
  return new Set([...common, ...roleSpecific]);
}

function getRoleUserIdAllowlist(role, env) {
  const common = parseAllowlist(
    env.MARKETPLACE_ADMIN_USER_IDS,
    normalizeUserId,
  );
  const roleSpecific = parseAllowlist(
    env[`${role}_USER_IDS`],
    normalizeUserId,
  );
  return new Set([...common, ...roleSpecific]);
}

async function resolveAssociatedUser(context, prismaClient) {
  const session = context?.session;
  const associatedUser = session?.onlineAccessInfo?.associated_user || null;
  const storedSession =
    !associatedUser && session?.id
      ? await prismaClient.session.findUnique({
          where: { id: session.id },
          select: { userId: true, email: true, accountOwner: true },
        })
      : null;
  const persistedUserId = normalizeUserId(
    associatedUser?.id ?? storedSession?.userId,
  );
  const tokenUserId = normalizeUserId(context?.sessionToken?.sub);

  return {
    userId: tokenUserId || persistedUserId,
    email: normalizeEmail(associatedUser?.email ?? storedSession?.email),
    accountOwner: Boolean(
      associatedUser?.account_owner ?? storedSession?.accountOwner,
    ),
    identityMismatch: Boolean(
      tokenUserId && persistedUserId && tokenUserId !== persistedUserId,
    ),
  };
}

function matchesRole(role, identity, env) {
  const emailMatch =
    identity.email &&
    getRoleEmailAllowlist(role, env).has(identity.email);
  const userIdMatch =
    identity.userId &&
    getRoleUserIdAllowlist(role, env).has(identity.userId);
  return Boolean(emailMatch || userIdMatch);
}

export function createMarketplaceOperatorAuthorizer({
  authenticateAdminImpl,
  defaultPrismaClient,
  defaultEnv = process.env,
}) {
  if (typeof authenticateAdminImpl !== "function") {
    throw new TypeError("authenticateAdminImpl must be a function");
  }
  if (!defaultPrismaClient?.session?.findUnique) {
    throw new TypeError("defaultPrismaClient must provide session.findUnique");
  }

  return async function requireMarketplaceOperator(
    request,
    {
      role = MARKETPLACE_OPERATOR_ROLES.ADMIN,
      roles = null,
      env = defaultEnv,
      prismaClient = defaultPrismaClient,
    } = {},
  ) {
    const context = await authenticateAdminImpl(request);
    const identity = await resolveAssociatedUser(context, prismaClient);
    const requestedRoles = Array.from(
      new Set(
        (Array.isArray(roles) && roles.length > 0 ? roles : [role]).filter(
          Boolean,
        ),
      ),
    );
    const matchedRole = requestedRoles.find((requestedRole) =>
      matchesRole(requestedRole, identity, env),
    );
    const authorized =
      !identity.identityMismatch &&
      (identity.accountOwner || Boolean(matchedRole));

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

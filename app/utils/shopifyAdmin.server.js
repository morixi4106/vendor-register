import prisma from "../db.server.js";

function createMissingOfflineSessionError(shopDomain) {
  return new Error(`Offline session not found for shop: ${shopDomain}`);
}

function isMissingOfflineSessionMessage(message = "") {
  return (
    message.includes("Offline session not found") ||
    message.includes("Could not find a session for shop")
  );
}

function isShopifyAuthenticationFailureMessage(message = "") {
  return (
    message.includes("Invalid API key or access token") ||
    message.includes("401") ||
    message.includes("Unauthorized") ||
    message.includes("unauthorized")
  );
}

async function loadOfflineAdminContext(shopDomain) {
  const { unauthenticated } = await import("../shopify.server.js");
  return unauthenticated.admin(shopDomain);
}

export function normalizeShopDomain(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || null;
}

export async function listOfflineShopDomains(prismaClient = prisma) {
  const sessions = await prismaClient.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
  });

  return Array.from(
    new Set(sessions.map((session) => normalizeShopDomain(session.shop)).filter(Boolean))
  ).sort();
}

export async function resolveShopDomain(
  preferredShopDomain,
  { listOfflineShopDomainsImpl = listOfflineShopDomains } = {},
) {
  const normalized = normalizeShopDomain(preferredShopDomain);

  if (normalized) {
    return normalized;
  }

  const offlineShops = await listOfflineShopDomainsImpl();

  if (offlineShops.length === 1) {
    return offlineShops[0];
  }

  if (offlineShops.length === 0) {
    throw new Error("Offline session not found");
  }

  throw new Error("Shop context is ambiguous for this product");
}

export function createGetOfflineAdminContextForShopDomain({
  resolveShopDomainImpl = resolveShopDomain,
  loadOfflineAdminContextImpl = loadOfflineAdminContext,
} = {}) {
  return async function getOfflineAdminContextForShopDomainImpl(preferredShopDomain) {
    const shopDomain = await resolveShopDomainImpl(preferredShopDomain);

    try {
      const context = await loadOfflineAdminContextImpl(shopDomain);

      if (!context?.admin || !context?.session?.accessToken) {
        throw createMissingOfflineSessionError(shopDomain);
      }

      return {
        shopDomain,
        session: context.session,
        admin: context.admin,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (isMissingOfflineSessionMessage(message)) {
        throw createMissingOfflineSessionError(shopDomain);
      }

      throw error;
    }
  };
}

export const getOfflineAdminContextForShopDomain =
  createGetOfflineAdminContextForShopDomain();

export async function getOfflineSessionForShopDomain(
  preferredShopDomain,
  { getOfflineAdminContextForShopDomainImpl = getOfflineAdminContextForShopDomain } = {},
) {
  const context = await getOfflineAdminContextForShopDomainImpl(preferredShopDomain);

  if (!context?.session?.accessToken) {
    throw createMissingOfflineSessionError(context?.shopDomain || preferredShopDomain);
  }

  return {
    shopDomain: context.shopDomain,
    accessToken: context.session.accessToken,
  };
}

export function createShopifyGraphQLWithOfflineSession({
  getOfflineAdminContextForShopDomainImpl = getOfflineAdminContextForShopDomain,
} = {}) {
  return async function shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion,
    query,
    variables = {},
  }) {
    const context = await getOfflineAdminContextForShopDomainImpl(shopDomain);

    try {
      const response = await context.admin.graphql(query, {
        apiVersion,
        variables,
      });
      const payload = await response.json();

      if (payload.errors?.length) {
        throw new Error(`Shopify GraphQL errors: ${JSON.stringify(payload.errors)}`);
      }

      return {
        data: payload.data,
        shopDomain: context.shopDomain,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (isMissingOfflineSessionMessage(message)) {
        throw createMissingOfflineSessionError(context.shopDomain);
      }

      if (isShopifyAuthenticationFailureMessage(message)) {
        throw new Error(
          `Shopify Admin authentication failed for shop ${context.shopDomain}: ${message}`,
        );
      }

      throw error;
    }
  };
}

export const shopifyGraphQLWithOfflineSession = createShopifyGraphQLWithOfflineSession();

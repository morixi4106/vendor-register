import prisma from "../db.server.js";

export function normalizeShopDomain(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || null;
}

export async function listOfflineShopDomains() {
  const sessions = await prisma.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
  });

  return Array.from(
    new Set(sessions.map((session) => normalizeShopDomain(session.shop)).filter(Boolean))
  ).sort();
}

export async function resolveShopDomain(preferredShopDomain) {
  const normalized = normalizeShopDomain(preferredShopDomain);

  if (normalized) {
    return normalized;
  }

  const offlineShops = await listOfflineShopDomains();

  if (offlineShops.length === 1) {
    return offlineShops[0];
  }

  if (offlineShops.length === 0) {
    throw new Error("Offline session not found");
  }

  throw new Error("Shop context is ambiguous for this product");
}

export async function getOfflineSessionForShopDomain(preferredShopDomain) {
  const shopDomain = await resolveShopDomain(preferredShopDomain);

  const session = await prisma.session.findFirst({
    where: {
      shop: shopDomain,
      isOnline: false,
    },
  });

  if (!session?.accessToken) {
    throw new Error(`Offline session not found for shop: ${shopDomain}`);
  }

  return {
    shopDomain,
    accessToken: session.accessToken,
  };
}

export async function shopifyGraphQLWithOfflineSession({
  shopDomain,
  apiVersion,
  query,
  variables = {},
}) {
  const session = await getOfflineSessionForShopDomain(shopDomain);

  const res = await fetch(
    `https://${session.shopDomain}/admin/api/${apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      `Shopify GraphQL request failed: ${res.status} ${JSON.stringify(data)}`
    );
  }

  if (data.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  return {
    data: data.data,
    shopDomain: session.shopDomain,
  };
}

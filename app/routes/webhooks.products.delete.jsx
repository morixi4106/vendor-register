import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  listOfflineShopDomains,
  normalizeShopDomain,
} from "../utils/shopifyAdmin.server";

function buildProductIdCandidates(payload) {
  const rawId = payload?.id;
  const numericId = rawId == null ? null : String(rawId).trim();
  const gid =
    typeof payload?.admin_graphql_api_id === "string" && payload.admin_graphql_api_id
      ? payload.admin_graphql_api_id
      : numericId
        ? `gid://shopify/Product/${numericId}`
        : null;

  return [gid, numericId].filter(Boolean);
}

export const action = async ({ request }) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  const shopDomain = normalizeShopDomain(shop);
  const offlineShopDomains = await listOfflineShopDomains();
  const allowNullShopFallback = offlineShopDomains.length <= 1;

  console.log(`Received ${topic} webhook for ${shop}`);

  const candidates = buildProductIdCandidates(payload);

  if (candidates.length === 0) {
    console.error("products/delete webhook payload did not include a usable product id");
    return new Response("Bad Request", { status: 400 });
  }

  const matchers = [];

  if (shopDomain) {
    matchers.push(
      ...candidates.map((shopifyProductId) => ({
        shopifyProductId,
        shopDomain,
      }))
    );
  }

  if (allowNullShopFallback) {
    matchers.push(
      ...candidates.map((shopifyProductId) => ({
        shopifyProductId,
        shopDomain: null,
      }))
    );
  }

  if (matchers.length === 0) {
    console.error("products/delete webhook could not resolve a safe local match scope");
    return new Response("Bad Request", { status: 400 });
  }

  const deleted = await db.product.deleteMany({
    where: {
      OR: matchers,
    },
  });

  console.log(
    `products/delete webhook removed ${deleted.count} local product(s) for ids: ${candidates.join(", ")}`
  );

  return new Response();
};

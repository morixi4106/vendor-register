import { requireMarketplaceOperator } from "./marketplaceOperator.server.js";

export async function requirePrivacyOperator(request) {
  const context = await requireMarketplaceOperator(request);
  const primary = String(process.env.SHOPIFY_PRIMARY_SHOP_DOMAIN || "")
    .trim()
    .toLowerCase();
  if (!primary || String(context.session.shop).toLowerCase() !== primary)
    throw new Response("Forbidden", {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    });
  return context;
}

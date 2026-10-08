import { authenticate } from "../shopify.server.js";
import { receivePrivacyRightsRequest } from "../services/privacyRights.server.js";

export const loader = () =>
  new Response(null, {
    status: 405,
    headers: { Allow: "POST", "Cache-Control": "no-store" },
  });

export async function action({ request }) {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const primary = String(process.env.SHOPIFY_PRIMARY_SHOP_DOMAIN || "")
    .trim()
    .toLowerCase();
  if (shop !== primary)
    return new Response(null, {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    });
  await receivePrivacyRightsRequest({
    shopDomain: shop,
    topic,
    payload,
    webhookId: request.headers.get("x-shopify-webhook-id"),
  });
  return new Response(null, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}

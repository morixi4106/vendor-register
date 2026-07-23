import { authenticate } from "../shopify.server";
import { processShopifyProductWebhook } from "../services/shopifyProductWebhook.server.js";

export const action = async ({ request }) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  const result = await processShopifyProductWebhook({
    payload,
    topic,
    shop,
  });

  if (!result.ok && !result.deferred) {
    console.warn("Shopify product update requires store assignment:", {
      topic,
      shop,
      productId: payload?.admin_graphql_api_id || payload?.id,
      reason: result.syncResult?.reason || result.reason,
    });
  }

  return new Response("OK", { status: 200 });
};

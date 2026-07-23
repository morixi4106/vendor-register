import { authenticate } from "../shopify.server";
import db from "../db.server";
import { activateShopifyControlLossHold } from "../services/shopifyAppControlLoss.server.js";
import { withShopifyWebhookReceipt } from "../services/shopifyWebhookInbox.server.js";

export const action = async ({ request }) => {
  const { payload, shop, session, topic } = await authenticate.webhook(request);

  await withShopifyWebhookReceipt(
    {
      request,
      payload,
      topic,
      shop,
      handler: async () => {
        await activateShopifyControlLossHold({
          shopDomain: shop,
          reason: "shopify_app_uninstalled",
          eventType: topic,
        });
        if (session) {
          await db.session.deleteMany({ where: { shop } });
        }
        return { ok: true, reason: "shopify_app_uninstalled" };
      },
    },
    { prismaClient: db },
  );

  return new Response();
};

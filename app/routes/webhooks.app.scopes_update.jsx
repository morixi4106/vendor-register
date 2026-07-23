import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  activateShopifyControlLossHold,
  inspectCriticalShopifyScopes,
} from "../services/shopifyAppControlLoss.server.js";
import { withShopifyWebhookReceipt } from "../services/shopifyWebhookInbox.server.js";

export const action = async ({ request }) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);

  await withShopifyWebhookReceipt(
    {
      request,
      payload,
      topic,
      shop,
      handler: async () => {
        const current = payload.current || [];
        const inspection = inspectCriticalShopifyScopes(current);
        if (session) {
          await db.session.update({
            where: { id: session.id },
            data: { scope: current.toString() },
          });
        }
        if (!inspection.ready) {
          await activateShopifyControlLossHold({
            shopDomain: shop,
            reason: "critical_shopify_scope_missing",
            missingScopes: inspection.missingScopes,
            eventType: topic,
          });
        }
        return {
          ok: inspection.ready,
          reason: inspection.ready ? null : "critical_shopify_scope_missing",
        };
      },
    },
    { prismaClient: db },
  );

  return new Response();
};

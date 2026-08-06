import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { syncShopifyOrderPaymentAttempts } from "../services/paymentOperations.server.js";
import { withShopifyWebhookReceipt } from "../services/shopifyWebhookInbox.server.js";

export const action = async ({ request }) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  const delivery = await withShopifyWebhookReceipt({
    request,
    payload,
    topic,
    shop,
    handler: () =>
      syncShopifyOrderPaymentAttempts({
        payload,
        shop,
        sourceTopic: topic || "ORDERS_CREATE",
      }),
  });
  return json({
    ok: true,
    duplicate: delivery.duplicate,
    paymentTracking: delivery.result
      ? {
          tracked: Boolean(delivery.result.tracked),
          attemptCount: Number(delivery.result.attemptCount || 0),
          multipleAttempts: Boolean(delivery.result.multipleAttempts),
          reason: delivery.result.reason || null,
        }
      : null,
  });
};

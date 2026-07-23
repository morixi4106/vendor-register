import { json } from "@remix-run/node";

import { processShopifyDisputeSettlement } from "../services/sellerPayments.server.js";
import { withShopifyWebhookReceipt } from "../services/shopifyWebhookInbox.server.js";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  const delivery = await withShopifyWebhookReceipt({
    request,
    payload,
    topic,
    shop,
    handler: () =>
      processShopifyDisputeSettlement({
        payload,
        shop,
        topic,
      }),
  });
  const result = delivery.result || {
    ok: true,
    duplicate: true,
    reason: delivery.reason,
  };

  if (!result.ok) {
    console.warn("disputes/update settlement skipped:", {
      topic,
      shop,
      reason: result.reason,
      sellerIds: result.sellerIds,
    });
  }

  return json({
    ok: true,
    settlement: {
      ok: Boolean(result.ok),
      duplicate: Boolean(result.duplicate),
      deliveryDuplicate: Boolean(delivery.duplicate),
      reason: result.reason || null,
      sellerId: result.sellerId || null,
      amount: result.amount || null,
      currencyCode: result.currencyCode || null,
    },
  });
};

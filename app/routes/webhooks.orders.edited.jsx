import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { reconcileShopifyOrderIntegrity } from "../services/shopifyOrderIntegrity.server.js";
import { POST_ORDER_ELIGIBILITY_TRIGGER } from "../services/saleEligibility.server.js";
import { withShopifyWebhookReceipt } from "../services/shopifyWebhookInbox.server.js";

function getOrderId(payload) {
  return (
    payload?.admin_graphql_api_id ||
    (payload?.id ? `gid://shopify/Order/${payload.id}` : null)
  );
}

export const action = async ({ request }) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  const delivery = await withShopifyWebhookReceipt({
    request,
    payload,
    topic,
    shop,
    handler: () =>
      reconcileShopifyOrderIntegrity({
        shopDomain: shop,
        shopifyOrderId: getOrderId(payload),
        triggerType: POST_ORDER_ELIGIBILITY_TRIGGER.ORDERS_EDITED,
      }),
  });

  return json({
    ok: true,
    duplicate: delivery.duplicate,
    integrity: delivery.result
      ? {
          ok: delivery.result.ok,
          skipped: Boolean(delivery.result.skipped),
          quarantined: Boolean(delivery.result.quarantined),
          reason: delivery.result.reason || null,
        }
      : null,
  });
};

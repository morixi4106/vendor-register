import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { processShopifyOrderPaidSettlement } from "../services/sellerPayments.server.js";
import { syncShopifyOrderPaymentAttempts } from "../services/paymentOperations.server.js";
import { withShopifyWebhookReceipt } from "../services/shopifyWebhookInbox.server.js";
import { shopifyGraphQLWithOfflineSession } from "../utils/shopifyAdmin.server.js";

export const action = async ({ request }) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  const delivery = await withShopifyWebhookReceipt({
    request,
    payload,
    topic,
    shop,
    handler: async () => {
      let paymentTracking = null;
      try {
        paymentTracking = await syncShopifyOrderPaymentAttempts({
          payload,
          shop,
          sourceTopic: topic || "ORDERS_PAID",
        });
      } catch (error) {
        console.error("orders/paid payment tracking failed:", {
          shop,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const settlement = await processShopifyOrderPaidSettlement(
        { payload, shop },
        {
          shopifyGraphQLWithOfflineSessionImpl:
            shopifyGraphQLWithOfflineSession,
        },
      );
      return { ...settlement, paymentTracking };
    },
  });
  const result = delivery.result || {
    ok: true,
    duplicate: true,
    reason: delivery.reason,
  };

  if (!result.ok) {
    console.warn("orders/paid settlement skipped:", {
      topic,
      shop,
      reason: result.reason,
      sellerIds: result.sellerIds,
      unmatchedProductIds: result.unmatchedProductIds,
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
      paymentTracking: result.paymentTracking
        ? {
            tracked: Boolean(result.paymentTracking.tracked),
            attemptCount: Number(result.paymentTracking.attemptCount || 0),
            multipleAttempts: Boolean(result.paymentTracking.multipleAttempts),
          }
        : null,
    },
  });
};

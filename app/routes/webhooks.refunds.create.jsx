import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { processShopifyRefundSettlement } from "../services/sellerPayments.server.js";
import { withShopifyWebhookReceipt } from "../services/shopifyWebhookInbox.server.js";
import { reconcileWithdrawalRefundWebhook } from "../services/withdrawalDirectReturns.server.js";

export const action = async ({ request }) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  let withdrawalReconciliation = null;
  const delivery = await withShopifyWebhookReceipt({
    request,
    payload,
    topic,
    shop,
    handler: async () => {
      const result = await processShopifyRefundSettlement({ payload, shop });
      withdrawalReconciliation = await reconcileWithdrawalRefundWebhook({
        payload,
        shop,
      });
      return result;
    },
  });
  const result = delivery.result || {
    ok: true,
    duplicate: true,
    reason: delivery.reason,
  };

  if (!result.ok) {
    console.warn("refunds/create settlement skipped:", {
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
    },
    withdrawalReconciliation: {
      ok: Boolean(withdrawalReconciliation?.ok),
      duplicate: Boolean(withdrawalReconciliation?.duplicate),
      skipped: Boolean(withdrawalReconciliation?.skipped),
      reason: withdrawalReconciliation?.reason || null,
    },
  });
};

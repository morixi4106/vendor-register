import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { processShopifyOrderCancelledSettlement } from "../services/sellerPayments.server.js";
import { withShopifyWebhookReceipt } from "../services/shopifyWebhookInbox.server.js";
import { reconcileWithdrawalCancellationWebhook } from "../services/withdrawalDirectReturns.server.js";

export const action = async ({ request }) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  let withdrawalReconciliation = null;
  const delivery = await withShopifyWebhookReceipt({
    request,
    payload,
    topic,
    shop,
    handler: async () => {
      const result = await processShopifyOrderCancelledSettlement({
        payload,
        shop,
      });
      withdrawalReconciliation = await reconcileWithdrawalCancellationWebhook({
        payload,
        shop,
      });
      if (
        withdrawalReconciliation?.ok === false &&
        withdrawalReconciliation?.skipped !== true
      ) {
        return {
          ok: false,
          retryable: true,
          reason:
            withdrawalReconciliation.reason ||
            "withdrawal_cancellation_reconciliation_failed",
        };
      }
      return result;
    },
  });
  const result = delivery.result || {
    ok: true,
    duplicate: true,
    reason: delivery.reason,
  };

  if (!result.ok) {
    console.warn("orders/cancelled settlement skipped:", {
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
    withdrawalReconciliation: {
      ok: Boolean(withdrawalReconciliation?.ok),
      requestCount: withdrawalReconciliation?.requestCount || 0,
      reason: withdrawalReconciliation?.reason || null,
    },
  });
};

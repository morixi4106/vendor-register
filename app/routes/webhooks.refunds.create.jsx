import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { processShopifyRefundSettlement } from "../services/sellerPayments.server.js";
import {
  markPaymentRefundLedgerApplied,
  observeShopifyRefundOperation,
} from "../services/paymentOperations.server.js";
import { withShopifyWebhookReceipt } from "../services/shopifyWebhookInbox.server.js";
import { reconcileWithdrawalRefundWebhook } from "../services/withdrawalDirectReturns.server.js";
import { refreshKomojuLimitedLaunchControl } from "../services/komojuLimitedLaunchControl.server.js";

export const action = async ({ request }) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  let withdrawalReconciliation = null;
  const delivery = await withShopifyWebhookReceipt({
    request,
    payload,
    topic,
    shop,
    handler: async () => {
      const paymentRefund = await observeShopifyRefundOperation({
        payload,
        shop,
      });
      if (!paymentRefund.ok) return paymentRefund;
      if (!paymentRefund.allowLedger) {
        return {
          ok: true,
          terminal: true,
          expectedSkip: true,
          reason: paymentRefund.reason,
          paymentRefundOperationId: paymentRefund.operation?.id || null,
          paymentRefundHeld: true,
        };
      }
      const result = await processShopifyRefundSettlement({ payload, shop });
      if (paymentRefund.operation?.id) {
        await markPaymentRefundLedgerApplied(
          paymentRefund.operation.id,
          result,
        );
      }
      withdrawalReconciliation = await reconcileWithdrawalRefundWebhook({
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
            "withdrawal_refund_reconciliation_failed",
        };
      }
      const limitedLaunchControl = await refreshKomojuLimitedLaunchControl({
        shopDomain: shop,
        applyEmergencyHold: true,
      });
      if (limitedLaunchControl?.ok === false) {
        return {
          ok: false,
          retryable: true,
          reason:
            limitedLaunchControl.reason ||
            "komoju_limited_launch_refresh_failed",
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
      paymentRefundHeld: Boolean(result.paymentRefundHeld),
      paymentRefundOperationId: result.paymentRefundOperationId || null,
    },
    withdrawalReconciliation: {
      ok: Boolean(withdrawalReconciliation?.ok),
      duplicate: Boolean(withdrawalReconciliation?.duplicate),
      skipped: Boolean(withdrawalReconciliation?.skipped),
      reason: withdrawalReconciliation?.reason || null,
    },
  });
};

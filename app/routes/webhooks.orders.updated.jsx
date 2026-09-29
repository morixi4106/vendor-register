

import { authenticate } from "../shopify.server";
import { reconcileShopifyOrderIntegrity } from "../services/shopifyOrderIntegrity.server.js";
import { syncShopifyOrderPaymentAttempts } from "../services/paymentOperations.server.js";
import { POST_ORDER_ELIGIBILITY_TRIGGER } from "../services/saleEligibility.server.js";
import { withShopifyWebhookReceipt } from "../services/shopifyWebhookInbox.server.js";
import { runDomesticAutonomousLaunchGuard } from "../services/domesticAutonomousLaunchGuard.server.js";

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
    handler: async () => {
      let paymentTracking = null;
      try {
        paymentTracking = await syncShopifyOrderPaymentAttempts({
          payload,
          shop,
          sourceTopic: topic || "ORDERS_UPDATED",
        });
      } catch (error) {
        console.error("orders/updated payment tracking failed:", {
          shop,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const integrity = await reconcileShopifyOrderIntegrity({
        shopDomain: shop,
        shopifyOrderId: getOrderId(payload),
        triggerType: POST_ORDER_ELIGIBILITY_TRIGGER.ORDERS_UPDATED,
      });
      const autonomousLaunchGuard = await runDomesticAutonomousLaunchGuard({
        shopDomain: shop,
        testOrder: payload?.test === true,
      });
      if (
        autonomousLaunchGuard?.ok === false &&
        autonomousLaunchGuard?.secured !== true
      ) {
        throw new Error(
          `domestic_autonomous_launch_guard_failed:${autonomousLaunchGuard.reason}`,
        );
      }
      return { ...integrity, paymentTracking, autonomousLaunchGuard };
    },
  });

  return Response.json({
    ok: true,
    duplicate: delivery.duplicate,
    integrity: delivery.result
      ? {
          ok: delivery.result.ok,
          skipped: Boolean(delivery.result.skipped),
          quarantined: Boolean(delivery.result.quarantined),
          reason: delivery.result.reason || null,
          paymentTracking: delivery.result.paymentTracking
            ? {
                tracked: Boolean(delivery.result.paymentTracking.tracked),
                attemptCount: Number(
                  delivery.result.paymentTracking.attemptCount || 0,
                ),
                multipleAttempts: Boolean(
                  delivery.result.paymentTracking.multipleAttempts,
                ),
              }
            : null,
          autonomousLaunchGuard: delivery.result.autonomousLaunchGuard
            ? {
                ok: Boolean(delivery.result.autonomousLaunchGuard.ok),
                active: Boolean(delivery.result.autonomousLaunchGuard.active),
                secured: Boolean(
                  delivery.result.autonomousLaunchGuard.secured,
                ),
                pending: Boolean(
                  delivery.result.autonomousLaunchGuard.pending,
                ),
                verified: Boolean(
                  delivery.result.autonomousLaunchGuard.verified,
                ),
                reason:
                  delivery.result.autonomousLaunchGuard.reason || null,
              }
            : null,
        }
      : null,
  });
};

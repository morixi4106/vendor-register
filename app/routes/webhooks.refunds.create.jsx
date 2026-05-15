import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { processShopifyRefundSettlement } from "../services/sellerPayments.server.js";

export const action = async ({ request }) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  const result = await processShopifyRefundSettlement({ payload, shop });

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
      reason: result.reason || null,
      sellerId: result.sellerId || null,
      amount: result.amount || null,
      currencyCode: result.currencyCode || null,
    },
  });
};

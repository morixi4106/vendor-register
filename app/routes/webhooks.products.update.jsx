import { authenticate } from "../shopify.server";
import { syncShopifyProductPayload } from "../services/shopifyProductSync.server.js";
import {
  enforceUnresolvedShopifyProductPublicationBoundary,
  syncMarketplaceCheckoutPolicyForProduct,
} from "../services/marketplaceCheckoutGate.server.js";

export const action = async ({ request }) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  const result = await syncShopifyProductPayload(payload, {
    shopDomain: shop,
  });

  if (!result.ok) {
    console.warn("Shopify product update requires store assignment:", {
      topic,
      shop,
      productId: payload?.admin_graphql_api_id || payload?.id,
      reason: result.reason,
    });
    await enforceUnresolvedShopifyProductPublicationBoundary({
      shopDomain: shop,
      shopifyProductId: payload?.admin_graphql_api_id || payload?.id,
    });
  } else {
    await syncMarketplaceCheckoutPolicyForProduct({
      localProductId: result.product.id,
      shopDomain: shop,
    });
  }

  return new Response("OK", { status: 200 });
};

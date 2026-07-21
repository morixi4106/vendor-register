import { authenticate } from "../shopify.server";
import { Resend } from "resend";
import { syncShopifyProductPayload } from "../services/shopifyProductSync.server.js";
import {
  enforceUnresolvedShopifyProductPublicationBoundary,
  syncMarketplaceCheckoutPolicyForProduct,
} from "../services/marketplaceCheckoutGate.server.js";

const resend = new Resend(process.env.RESEND_API_KEY);

export const action = async ({ request }) => {
  const { payload, topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const syncResult = await syncShopifyProductPayload(payload, {
    shopDomain: shop,
  });

  if (!syncResult.ok) {
    console.warn("Shopify product requires store assignment:", {
      shop,
      productId: payload?.admin_graphql_api_id || payload?.id,
      reason: syncResult.reason,
    });
    await enforceUnresolvedShopifyProductPublicationBoundary({
      shopDomain: shop,
      shopifyProductId: payload?.admin_graphql_api_id || payload?.id,
    });
  } else {
    await syncMarketplaceCheckoutPolicyForProduct({
      localProductId: syncResult.product.id,
      shopDomain: shop,
    });
  }

  try {
    const { error } = await resend.emails.send({
      from: process.env.MAIL_FROM,
      to: [process.env.ADMIN_EMAIL],
      subject: "新しい商品が作成されました",
      text: `商品名: ${payload?.title}\nベンダー: ${payload?.vendor}`,
    });

    if (error) {
      console.error("❌ resend error:", error);
    } else {
      console.log("📧 mail sent:", payload?.title);
    }
  } catch (e) {
    console.error("❌ mail error:", e);
  }

  return new Response("OK", { status: 200 });
};

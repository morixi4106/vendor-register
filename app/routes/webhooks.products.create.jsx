import { authenticate } from "../shopify.server";
import { Resend } from "resend";
import { isAutomatedEmailHoldActive } from "../services/operationalReadiness.server.js";
import { processShopifyProductWebhook } from "../services/shopifyProductWebhook.server.js";

const resend = new Resend(process.env.RESEND_API_KEY);

export const action = async ({ request }) => {
  const { payload, topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const syncResult = await processShopifyProductWebhook({
    payload,
    topic,
    shop,
  });

  if (!syncResult.ok && !syncResult.deferred) {
    console.warn("Shopify product requires store assignment:", {
      shop,
      productId: payload?.admin_graphql_api_id || payload?.id,
      reason: syncResult.syncResult?.reason || syncResult.reason,
    });
  }

  try {
    if (await isAutomatedEmailHoldActive()) {
      return new Response("OK", { status: 200 });
    }
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

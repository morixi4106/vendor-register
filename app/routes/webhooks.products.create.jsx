import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  try {
    const { shop, topic, payload } = await authenticate.webhook(request);

    console.log("🔥 webhook hit");
    console.log(`Received ${topic} webhook for ${shop}`);
    console.log("📦 product:", payload?.title);

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("❌ webhook error:", error);
    return new Response("Webhook error", { status: 500 });
  }
};
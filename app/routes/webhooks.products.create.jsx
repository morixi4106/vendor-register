import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log("🔥 webhook hit");
  console.log(`Received ${topic} webhook for ${shop}`);
  console.log("📦 product:", payload?.title);

  return new Response();
};
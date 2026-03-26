import crypto from "crypto";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

function verifyShopifyWebhook(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_API_SECRET || "";

  if (!secret || !hmacHeader) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  const digestBuffer = Buffer.from(digest, "utf8");
  const hmacBuffer = Buffer.from(hmacHeader, "utf8");

  if (digestBuffer.length !== hmacBuffer.length) return false;

  return crypto.timingSafeEqual(digestBuffer, hmacBuffer);
}

export const action = async ({ request }) => {
  const rawBody = await request.text();
  const hmacHeader = request.headers.get("x-shopify-hmac-sha256");

  const isValid = verifyShopifyWebhook(rawBody, hmacHeader);

  if (!isValid) {
    console.error("❌ Invalid webhook signature");
    return new Response("Unauthorized", { status: 401 });
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (error) {
    console.error("❌ Invalid JSON payload:", error);
    return new Response("Bad Request", { status: 400 });
  }

  try {
    const { error } = await resend.emails.send({
      from: process.env.MAIL_FROM,
      to: [process.env.ADMIN_EMAIL],
      subject: "新しい商品が作成されました",
      text: `商品名: ${data.title}\nベンダー: ${data.vendor}`,
    });

    if (error) {
      console.error("❌ resend error:", error);
    } else {
      console.log("📧 mail sent:", data.title);
    }
  } catch (e) {
    console.error("❌ mail error:", e);
  }

  return new Response("OK", { status: 200 });
};
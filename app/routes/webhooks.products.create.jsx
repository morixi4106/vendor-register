import { authenticate } from "../shopify.server";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export const action = async ({ request }) => {
  const { payload, topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

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

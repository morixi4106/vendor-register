import { Client } from "postmark";

export const action = async ({ request }) => {
  const body = await request.text();
  const data = JSON.parse(body);

  const client = new Client(process.env.POSTMARK_API_TOKEN);

  try {
    await client.sendEmail({
      From: process.env.MAIL_FROM,
      To: process.env.ADMIN_EMAIL,
      Subject: "新しい商品が作成されました",
      TextBody: `商品名: ${data.title}\nベンダー: ${data.vendor}`,
    });

    console.log("📧 mail sent:", data.title);
  } catch (e) {
    console.error("❌ mail error:", e);
  }

  return new Response("OK", { status: 200 });
};
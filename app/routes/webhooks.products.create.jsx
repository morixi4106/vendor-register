import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const action = async ({ request }) => {
  try {
    const body = await request.text();
    const data = JSON.parse(body);

    if (!process.env.RESEND_API_KEY) {
      console.error("❌ RESEND_API_KEY is missing");
      return new Response("RESEND_API_KEY is missing", { status: 500 });
    }

    if (!process.env.MAIL_FROM || !process.env.ADMIN_EMAIL) {
      console.error("❌ MAIL_FROM or ADMIN_EMAIL is missing");
      return new Response("MAIL_FROM or ADMIN_EMAIL is missing", { status: 500 });
    }

    const { data: result, error } = await resend.emails.send({
      from: process.env.MAIL_FROM,
      to: [process.env.ADMIN_EMAIL],
      subject: "新しい商品が作成されました",
      html: `
        <h2>新しい商品が作成されました</h2>
        <p><strong>商品名:</strong> ${escapeHtml(data.title)}</p>
        <p><strong>ベンダー:</strong> ${escapeHtml(data.vendor)}</p>
      `,
      text: `商品名: ${data.title}\nベンダー: ${data.vendor}`,
    });

    if (error) {
      console.error("❌ resend error:", error);
      return new Response("Mail send failed", { status: 500 });
    }

    console.log("📧 resend mail sent:", result?.id, data.title);
    return new Response("OK", { status: 200 });
  } catch (e) {
    console.error("❌ mail error:", e);
    return new Response("Server Error", { status: 500 });
  }
};
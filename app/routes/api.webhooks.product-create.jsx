import { json } from "@remix-run/node";

export const action = async ({ request }) => {
  console.log("🔥 webhook hit");

  try {
    const body = await request.json();

    console.log("📦 product:", body.title);

    // 後でここにメール処理入れる

    return json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return json({ ok: false }, { status: 500 });
  }
};
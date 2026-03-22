import { json } from "@remix-run/node";
import prisma from "../db.server";

export const action = async ({ request }) => {
  console.log("🔥 product create hit");

  const formData = await request.formData();

  const name = String(formData.get("name") || "").trim();
  const price = parseInt(formData.get("price"), 10);
  const vendorStoreId = String(formData.get("vendorStoreId") || "").trim();

  if (!name || !price || !vendorStoreId) {
    return json({ error: "missing fields" }, { status: 400 });
  }

  const product = await prisma.product.create({
    data: {
      name,
      price,
      vendorStoreId,
    },
  });

  const store = await prisma.vendorStore.findUnique({
    where: { id: vendorStoreId },
  });

  try {
    const response = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "X-Postmark-Server-Token": process.env.POSTMARK_API_TOKEN || "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        From: process.env.MAIL_FROM,
        To: process.env.ADMIN_EMAIL,
        Subject: `【商品申請】${name}`,
        TextBody: `新しい商品が登録されました。

■ 商品名
${name}

■ 価格
${price}

■ 店舗名
${store?.storeName || ""}

■ 店舗メール
${store?.email || ""}
`,
      }),
    });

    const resultText = await response.text();
    console.log("📨 postmark status:", response.status);
    console.log("📨 postmark body:", resultText);
  } catch (error) {
    console.error("Mail send error:", error);
  }

  return json({ success: true, product });
};
import { json } from "@remix-run/node";
import prisma from "../db.server";
import axios from "axios";

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

  // 👇 店舗情報取得
  const store = await prisma.vendorStore.findUnique({
    where: { id: vendorStoreId },
  });

  // 👇 メール送信（Postmark）
  try {
    await axios.post(
      "https://api.postmarkapp.com/email",
      {
        From: process.env.MAIL_FROM,
        To: process.env.ADMIN_EMAIL,
        Subject: `【商品申請】${name}`,
        TextBody: `
新しい商品が登録されました。

■ 商品名
${name}

■ 価格
${price}

■ 店舗名
${store?.storeName}

■ 店舗メール
${store?.email}
        `,
      },
      {
        headers: {
          "X-Postmark-Server-Token": process.env.POSTMARK_API_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("Mail send error:", err?.response?.data || err.message);
  }

  return json({ success: true, product });
};
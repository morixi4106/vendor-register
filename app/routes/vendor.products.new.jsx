import { createCookie, json, redirect } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import prisma from "../db.server";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);
async function uploadImageToCloudinary(file) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;

  if (!cloudName || !uploadPreset) {
    throw new Error("Cloudinaryの環境変数が足りません。");
  }

  if (!file || typeof file.arrayBuffer !== "function" || file.size === 0) {
    return null;
  }

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);

  const form = new FormData();
  form.append("file", new Blob([buffer]), file.name || "upload.jpg");
  form.append("upload_preset", uploadPreset);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    {
      method: "POST",
      body: form,
    }
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Cloudinary upload failed: ${JSON.stringify(data)}`);
  }

  return data.secure_url || null;
}

const vendorAdminSessionCookie = createCookie("vendor_admin_session", {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 8,
});

async function getVendorSessionOrRedirect(request) {
  const cookieHeader = request.headers.get("Cookie");
  const sessionToken = await vendorAdminSessionCookie.parse(cookieHeader);

  if (!sessionToken) {
    throw redirect("https://vendor-register-pbjl.onrender.com/vendor/verify");
  }

  const vendorSession = await prisma.vendorAdminSession.findUnique({
    where: { sessionToken },
    include: {
      vendor: {
        include: {
          vendorStore: true,
        },
      },
    },
  });

  if (!vendorSession || vendorSession.expiresAt < new Date()) {
    throw redirect("https://vendor-register-pbjl.onrender.com/vendor/verify", {
      headers: {
        "Set-Cookie": await vendorAdminSessionCookie.serialize("", {
          maxAge: 0,
        }),
      },
    });
  }

  return vendorSession;
}

export const loader = async ({ request }) => {
  await getVendorSessionOrRedirect(request);
  return json({ ok: true });
};

export const action = async ({ request }) => {
  const vendorSession = await getVendorSessionOrRedirect(request);
  const store = vendorSession.vendor?.vendorStore;

  if (!store) {
    return json(
      { ok: false, error: "店舗情報が見つかりません。" },
      { status: 404 }
    );
  }

  const formData = await request.formData();

  const imageFile = formData.get("image");
let imageUrl = null;

if (imageFile && typeof imageFile.size === "number" && imageFile.size > 0) {
  imageUrl = await uploadImageToCloudinary(imageFile);
}

  const name = String(formData.get("name") || "").trim();
  const description = String(formData.get("description") || "").trim();
  const category = String(formData.get("category") || "").trim();
  const priceRaw = String(formData.get("price") || "").trim();
  const url = String(formData.get("url") || "").trim();

  if (!name) {
    return json(
      { ok: false, error: "商品名を入力してください。" },
      { status: 400 }
    );
  }

  if (!priceRaw) {
    return json(
      { ok: false, error: "価格を入力してください。" },
      { status: 400 }
    );
  }

  const price = Number(priceRaw);

  if (!Number.isInteger(price) || price < 0) {
  return json(
    { ok: false, error: "価格は0以上の整数で入力してください。" },
    { status: 400 }
  );
}

const createdProduct = await prisma.product.create({
  data: {
    name,
    description: description || null,
    imageUrl: imageUrl,
    category: category || null,
    price,
    url: url || null,
    vendorStoreId: store.id,
    approvalStatus: "pending",
  },
});

try {
  const adminUrl = `https://vendor-register-pbjl.onrender.com/admin/products/${createdProduct.id}`;

  await resend.emails.send({
    from: process.env.MAIL_FROM,
    to: [process.env.ADMIN_EMAIL],
    subject: "新しい商品申請があります",
    text: `商品名: ${createdProduct.name}
店舗: ${store.storeName}

管理画面で確認:
${adminUrl}`,
  });

  console.log("📧 管理者通知送信:", createdProduct.name);
} catch (e) {
  console.error("❌ メール送信失敗:", e);
}

return redirect("https://vendor-register-pbjl.onrender.com/vendor/dashboard");
};
export default function VendorProductsNew() {
  const actionData = useActionData();

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f3f4f6",
        padding: "40px 20px",
        boxSizing: "border-box",
        fontFamily: 'Arial, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif',
      }}
    >
      <div
        style={{
          maxWidth: "760px",
          margin: "0 auto",
          background: "#ffffff",
          border: "1px solid #e5e7eb",
          borderRadius: "16px",
          padding: "28px",
          boxSizing: "border-box",
        }}
      >
        <h1
          style={{
            margin: "0 0 8px",
            fontSize: "32px",
            fontWeight: 700,
            color: "#111827",
          }}
        >
          新規商品登録
        </h1>

        <p
          style={{
            margin: "0 0 24px",
            color: "#6b7280",
            fontSize: "14px",
            lineHeight: 1.8,
          }}
        >
          登録した商品は申請中として保存され、管理者承認後にShopifyへ反映されます。
        </p>

        {actionData?.error ? (
          <div
            style={{
              marginBottom: "20px",
              padding: "14px 16px",
              borderRadius: "10px",
              border: "1px solid #fecaca",
              background: "#fef2f2",
              color: "#b91c1c",
              fontSize: "14px",
              lineHeight: 1.7,
              whiteSpace: "pre-wrap",
            }}
          >
            {actionData.error}
          </div>
        ) : null}

        <Form method="post" encType="multipart/form-data">
          <div style={{ display: "grid", gap: "20px" }}>
            <div>
              <label
                htmlFor="name"
                style={{
                  display: "block",
                  marginBottom: "8px",
                  fontSize: "14px",
                  fontWeight: 700,
                  color: "#111827",
                }}
              >
                商品名
              </label>
              <input
                id="name"
                name="name"
                type="text"
                placeholder="例：NEOBEAUTE バランシングローション"
                style={{
                  width: "100%",
                  height: "48px",
                  border: "1px solid #d1d5db",
                  borderRadius: "10px",
                  padding: "0 14px",
                  fontSize: "14px",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div>
              <label
                htmlFor="description"
                style={{
                  display: "block",
                  marginBottom: "8px",
                  fontSize: "14px",
                  fontWeight: 700,
                  color: "#111827",
                }}
              >
                商品説明
              </label>
              <textarea
                id="description"
                name="description"
                rows={8}
                placeholder="商品説明を入力してください"
                style={{
                  width: "100%",
                  border: "1px solid #d1d5db",
                  borderRadius: "10px",
                  padding: "14px",
                  fontSize: "14px",
                  lineHeight: 1.8,
                  boxSizing: "border-box",
                  resize: "vertical",
                }}
              />
            </div>

            <div>
              <label
                style={{
                  display: "block",
                  marginBottom: "8px",
                  fontSize: "14px",
                  fontWeight: 700,
                  color: "#111827",
                }}
              >
                商品画像
              </label>
              <div
                style={{
                  border: "1px dashed #d1d5db",
                  borderRadius: "10px",
                  padding: "20px",
                  textAlign: "center",
                  background: "#f9fafb",
                  fontSize: "14px",
                  color: "#6b7280",
                }}
              >
                <input type="file" name="image" accept="image/*" />
              </div>
            </div>

            <div>
              <label
                htmlFor="category"
                style={{
                  display: "block",
                  marginBottom: "8px",
                  fontSize: "14px",
                  fontWeight: 700,
                  color: "#111827",
                }}
              >
                カテゴリ
              </label>
              <input
                id="category"
                name="category"
                type="text"
                placeholder="例：スキンケア"
                style={{
                  width: "100%",
                  height: "48px",
                  border: "1px solid #d1d5db",
                  borderRadius: "10px",
                  padding: "0 14px",
                  fontSize: "14px",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div>
              <label
                htmlFor="price"
                style={{
                  display: "block",
                  marginBottom: "8px",
                  fontSize: "14px",
                  fontWeight: 700,
                  color: "#111827",
                }}
              >
                原価
              </label>
              <input
              id="price"
                name="price"
                type="number"
                min="0"
                step="1"
                placeholder="1000（原価）"
                style={{
                  width: "100%",
                  height: "48px",
                  border: "1px solid #d1d5db",
                  borderRadius: "10px",
                  padding: "0 14px",
                  fontSize: "14px",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div>
              <label
                htmlFor="url"
                style={{
                  display: "block",
                  marginBottom: "8px",
                  fontSize: "14px",
                  fontWeight: 700,
                  color: "#111827",
                }}
              >
                参考URL（任意）
              </label>
              <input
                id="url"
                name="url"
                type="text"
                placeholder="https://..."
                style={{
                  width: "100%",
                  height: "48px",
                  border: "1px solid #d1d5db",
                  borderRadius: "10px",
                  padding: "0 14px",
                  fontSize: "14px",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div
              style={{
                display: "flex",
                gap: "10px",
                flexWrap: "wrap",
                marginTop: "8px",
              }}
            >
              <button
                type="submit"
                style={{
                  height: "46px",
                  padding: "0 18px",
                  borderRadius: "10px",
                  border: "1px solid #111827",
                  background: "#111827",
                  color: "#ffffff",
                  fontSize: "14px",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                商品を登録する
              </button>

              <a
                href="https://vendor-register-pbjl.onrender.com/vendor/dashboard"
                style={{
                  height: "46px",
                  padding: "0 18px",
                  borderRadius: "10px",
                  border: "1px solid #d1d5db",
                  background: "#ffffff",
                  color: "#111827",
                  fontSize: "14px",
                  fontWeight: 700,
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  boxSizing: "border-box",
                }}
              >
                ダッシュボードへ戻る
              </a>
            </div>
          </div>
        </Form>
      </div>
    </div>
  );
}
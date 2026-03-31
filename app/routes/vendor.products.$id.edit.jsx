import { createCookie, json, redirect } from "@remix-run/node";
import {
  Form,
  useLoaderData,
  useActionData,
  useNavigation,
} from "@remix-run/react";
import prisma from "../db.server";

const vendorAdminSessionCookie = createCookie("vendor_admin_session", {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 8,
});

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

async function getVendorSession(request) {
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

export const loader = async ({ request, params }) => {
  const vendorSession = await getVendorSession(request);
  const store = vendorSession.vendor?.vendorStore;

  if (!store) {
    throw new Response("店舗情報が見つかりません。", { status: 404 });
  }

  const productId = String(params.id || "");

  if (!productId) {
    throw new Response("商品IDがありません。", { status: 400 });
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
  });

  if (!product || product.vendorStoreId !== store.id) {
    throw new Response("商品が見つかりません。", { status: 404 });
  }

  return json({
    product,
    store: {
      id: store.id,
      storeName: store.storeName,
    },
  });
};

export const action = async ({ request, params }) => {
  try {
    const vendorSession = await getVendorSession(request);
    const store = vendorSession.vendor?.vendorStore;

    if (!store) {
      return json(
        { ok: false, error: "店舗情報が見つかりません。" },
        { status: 404 }
      );
    }

    const productId = String(params.id || "");

    if (!productId) {
      return json(
        { ok: false, error: "商品IDがありません。" },
        { status: 400 }
      );
    }

    const product = await prisma.product.findUnique({
      where: { id: productId },
    });

    if (!product || product.vendorStoreId !== store.id) {
      return json(
        { ok: false, error: "商品が見つかりません。" },
        { status: 404 }
      );
    }

    const formData = await request.formData();

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

    const imageFile = formData.get("image");
    let imageUrl = product.imageUrl || null;

    if (
      imageFile &&
      typeof imageFile.size === "number" &&
      imageFile.size > 0
    ) {
      imageUrl = await uploadImageToCloudinary(imageFile);
    }

    const updatedProduct = await prisma.product.update({
      where: { id: productId },
      data: {
        name,
        description: description || null,
        category: category || null,
        price,
        url: url || null,
        imageUrl: imageUrl || null,
        approvalStatus: "pending",
      },
    });

    if (product.shopifyProductId) {
      const shop = process.env.SHOPIFY_SHOP;
      const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

      const res = await fetch(
        `https://${shop}/admin/api/2026-04/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": token,
          },
          body: JSON.stringify({
            query: `
              mutation productUpdate($input: ProductInput!) {
                productUpdate(input: $input) {
                  product {
                    id
                    status
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }
            `,
            variables: {
              input: {
                id: product.shopifyProductId,
                title: updatedProduct.name,
                descriptionHtml: updatedProduct.description || "",
                productType: updatedProduct.category || "",
                status: "DRAFT",
              },
            },
          }),
        }
      );

      const jsonRes = await res.json();

      if (jsonRes.errors) {
        console.error("Shopify error:", jsonRes.errors);
        throw new Error("Shopify更新失敗");
      }

      const userErrors = jsonRes?.data?.productUpdate?.userErrors || [];

      if (userErrors.length > 0) {
        console.error("userErrors:", userErrors);
        throw new Error(userErrors.map((e) => e.message).join(", "));
      }
    }

    return redirect("https://vendor-register-pbjl.onrender.com/vendor/dashboard");
  } catch (error) {
    console.error("vendor product edit error:", error);

    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "不明なエラーです。",
      },
      { status: 500 }
    );
  }
};

export default function EditPage() {
  const { product, store } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();

  const isSubmitting = navigation.state === "submitting";

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
          商品編集
        </h1>

        <p
          style={{
            margin: "0 0 6px",
            color: "#6b7280",
            fontSize: "14px",
            lineHeight: 1.8,
          }}
        >
          店舗: {store?.storeName || "-"}
        </p>

        <p
          style={{
            margin: "0 0 24px",
            color: "#6b7280",
            fontSize: "14px",
            lineHeight: 1.8,
          }}
        >
          編集して更新すると、商品内容は保存されます。承認済みの商品も再確認しやすいように、更新時は申請中に戻します。
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
                defaultValue={product.name || ""}
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
                defaultValue={product.description || ""}
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

              {product.imageUrl ? (
                <div
                  style={{
                    marginBottom: "12px",
                    border: "1px solid #e5e7eb",
                    borderRadius: "12px",
                    overflow: "hidden",
                    background: "#fff",
                  }}
                >
                  <img
                    src={product.imageUrl}
                    alt={product.name || "商品画像"}
                    style={{
                      width: "100%",
                      maxHeight: "320px",
                      objectFit: "contain",
                      display: "block",
                      background: "#fff",
                    }}
                  />
                </div>
              ) : (
                <div
                  style={{
                    marginBottom: "12px",
                    border: "1px dashed #d1d5db",
                    borderRadius: "12px",
                    padding: "20px",
                    textAlign: "center",
                    fontSize: "14px",
                    color: "#6b7280",
                    background: "#f9fafb",
                  }}
                >
                  現在の画像はありません
                </div>
              )}

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
                <div style={{ marginTop: "10px" }}>
                  新しい画像を選ぶと上書きされます
                </div>
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
                defaultValue={product.category || ""}
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
                価格
              </label>
              <input
                id="price"
                name="price"
                type="number"
                min="0"
                step="1"
                defaultValue={product.price ?? 0}
                placeholder="1000"
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
                defaultValue={product.url || ""}
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
                disabled={isSubmitting}
                style={{
                  height: "46px",
                  padding: "0 18px",
                  borderRadius: "10px",
                  border: "1px solid #111827",
                  background: isSubmitting ? "#374151" : "#111827",
                  color: "#ffffff",
                  fontSize: "14px",
                  fontWeight: 700,
                  cursor: isSubmitting ? "default" : "pointer",
                }}
              >
                {isSubmitting ? "更新中..." : "商品を更新する"}
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
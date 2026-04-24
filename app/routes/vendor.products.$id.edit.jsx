import { resolveDutyCategory } from "../utils/dutyCategory";
import { createCookie, json, redirect } from "@remix-run/node";
import {
  Form,
  useLoaderData,
  useActionData,
  useNavigation,
} from "@remix-run/react";
import prisma from "../db.server";
import { PRICE_SYNC_STATUS } from "../utils/priceSyncStatus";
import { shopifyGraphQLWithOfflineSession } from "../utils/shopifyAdmin.server";

const SHOPIFY_API_VERSION = "2026-01";
const ALLOWED_CURRENCIES = ["JPY", "USD", "EUR", "GBP", "CNY", "KRW"];

const vendorAdminSessionCookie = createCookie("vendor_admin_session", {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 8,
});

const COPY = {
  storeNotFound: "店舗情報が見つかりません。",
  productIdRequired: "商品IDがありません。",
  productNotFound: "商品が見つかりません。",
  unsupportedCurrency: "対応していない通貨です。",
  productNameRequired: "商品名を入力してください。",
  priceRequired: "価格を入力してください。",
  invalidPrice: "価格は0以上の数値で入力してください。",
  reconnectRequired: "Shopifyとの接続を確認してから、もう一度お試しください。",
  updateFailed: "商品の更新に失敗しました。時間を置いて再度お試しください。",
  title: "商品編集",
  storeLabel: "店舗",
  intro:
    "商品情報を更新します。保存後は申請中となり、内容確認後にShopifyへ反映されます。",
  nameLabel: "商品名",
  namePlaceholder: "例: EOBEAUTE バランシングローション",
  descriptionLabel: "商品説明",
  descriptionPlaceholder: "商品の説明を入力してください",
  imageLabel: "商品画像",
  imageAlt: "商品画像",
  noImage: "現在の画像は登録されていません。",
  uploadHint:
    "新しい画像を選択すると、保存時に現在の画像へ上書きされます。",
  categoryLabel: "カテゴリー",
  categoryPlaceholder: "例: スキンケア",
  priceLabel: "価格",
  currencyLabel: "価格通貨",
  urlLabel: "参考URL・販売ページ",
  submit: "商品を更新する",
  submitting: "更新中...",
  backToDashboard: "ダッシュボードへ戻る",
};

function isReconnectableShopifyError(message = "") {
  return (
    message.includes("Shopify authentication is required") ||
    message.includes("Invalid API key or access token") ||
    message.includes("401") ||
    message.includes("Offline session not found")
  );
}

async function shopifyGraphQL(shopDomain, query, variables = {}) {
  return shopifyGraphQLWithOfflineSession({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query,
    variables,
  });
}

async function uploadImageToCloudinary(file) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;

  if (!cloudName || !uploadPreset) {
    throw new Error("Cloudinary environment variables are missing");
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
    throw new Response(COPY.storeNotFound, { status: 404 });
  }

  const productId = String(params.id || "");

  if (!productId) {
    throw new Response(COPY.productIdRequired, { status: 400 });
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
  });

  if (!product || product.vendorStoreId !== store.id) {
    throw new Response(COPY.productNotFound, { status: 404 });
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
          { ok: false, error: COPY.storeNotFound },
          { status: 404 }
        );
      }

    const productId = String(params.id || "");

      if (!productId) {
        return json(
          { ok: false, error: COPY.productIdRequired },
          { status: 400 }
        );
      }

    const product = await prisma.product.findUnique({
      where: { id: productId },
    });

      if (!product || product.vendorStoreId !== store.id) {
        return json(
          { ok: false, error: COPY.productNotFound },
          { status: 404 }
        );
      }

    const formData = await request.formData();

    const name = String(formData.get("name") || "").trim();
    const description = String(formData.get("description") || "").trim();
    const category = String(formData.get("category") || "").trim();
    const priceRaw = String(formData.get("price") || "").trim();
    const url = String(formData.get("url") || "").trim();
    const costCurrency = String(formData.get("costCurrency") || "JPY").trim().toUpperCase();

    if (!ALLOWED_CURRENCIES.includes(costCurrency)) {
      return json(
        { ok: false, error: COPY.unsupportedCurrency },
        { status: 400 }
      );
    }

    if (!name) {
      return json(
        { ok: false, error: COPY.productNameRequired },
        { status: 400 }
      );
    }

    if (!priceRaw) {
      return json(
        { ok: false, error: COPY.priceRequired },
        { status: 400 }
      );
    }

    const costAmount = Number(priceRaw);

    if (!Number.isFinite(costAmount) || costAmount < 0) {
      return json(
        { ok: false, error: COPY.invalidPrice },
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

    const nextProductData = {
      name,
      description: description || null,
      category: category || null,
      price: costAmount,
      costAmount,
      costCurrency,
      url: url || null,
      imageUrl: imageUrl || null,
      approvalStatus: "pending",
      priceSyncStatus: PRICE_SYNC_STATUS.CALCULATED_NOT_APPLIED,
      priceSyncError: null,
    };

    if (product.shopifyProductId) {
  const { data: result, shopDomain } = await shopifyGraphQL(
    product.shopDomain,
    `
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
    {
      input: {
        id: product.shopifyProductId,
        title: nextProductData.name,
        descriptionHtml: nextProductData.description || "",
        productType: nextProductData.category || "",
        status: "DRAFT",
      },
    }
  );

  const userErrors = result?.productUpdate?.userErrors || [];

  if (userErrors.length > 0) {
    console.error("userErrors:", userErrors);
    throw new Error(userErrors.map((e) => e.message).join(", "));
  }

  const metafields = [
    {
      ownerId: product.shopifyProductId,
      namespace: "pricing",
      key: "cost_amount",
      type: "number_decimal",
      value: String(costAmount),
    },
    {
      ownerId: product.shopifyProductId,
      namespace: "pricing",
      key: "cost_currency",
      type: "single_line_text_field",
      value: costCurrency,
    },
  ];

  const dutyCategory = resolveDutyCategory(category);

  if (dutyCategory) {
    metafields.push({
      ownerId: product.shopifyProductId,
      namespace: "pricing",
      key: "duty_category",
      type: "single_line_text_field",
      value: dutyCategory,
    });
  }

  const { data: metafieldsResult } = await shopifyGraphQL(
    shopDomain,
    `
      mutation UpdateMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            key
            namespace
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      metafields,
    }
  );

  const metafieldErrors = metafieldsResult?.metafieldsSet?.userErrors || [];

  if (metafieldErrors.length > 0) {
    console.error("metafieldErrors:", metafieldErrors);
    throw new Error(metafieldErrors.map((e) => e.message).join(", "));
  }

  await prisma.product.update({
    where: { id: productId },
    data: {
      ...nextProductData,
      shopDomain,
    },
  });
} else {
  await prisma.product.update({
    where: { id: productId },
    data: nextProductData,
  });
}

    return redirect("https://vendor-register-pbjl.onrender.com/vendor/dashboard");
  } catch (error) {
    console.error("vendor product edit error:", error);
    const message = error instanceof Error ? error.message : "";
    const safeError = isReconnectableShopifyError(message)
      ? "Shopifyとの接続を確認してから、もう一度お試しください。"
      : "商品の更新に失敗しました。時間を置いて再度お試しください。";

    return json(
      {
        ok: false,
        error: safeError,
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
          {COPY.title}
        </h1>

        <p
          style={{
            margin: "0 0 6px",
            color: "#6b7280",
            fontSize: "14px",
            lineHeight: 1.8,
          }}
        >
          {COPY.storeLabel}: {store?.storeName || "-"}
        </p>

        <p
          style={{
            margin: "0 0 24px",
            color: "#6b7280",
            fontSize: "14px",
            lineHeight: 1.8,
          }}
        >
          {COPY.intro}
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
                {COPY.nameLabel}
              </label>
              <input
                id="name"
                name="name"
                type="text"
                defaultValue={product.name || ""}
                placeholder={COPY.namePlaceholder}
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
                {COPY.descriptionLabel}
              </label>
              <textarea
                id="description"
                name="description"
                rows={8}
                defaultValue={product.description || ""}
                placeholder={COPY.descriptionPlaceholder}
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
                {COPY.imageLabel}
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
                    alt={product.name || COPY.imageAlt}
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
                  {COPY.noImage}
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
                <div style={{ marginTop: "10px" }}>{COPY.uploadHint}</div>
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
                {COPY.categoryLabel}
              </label>
              <input
                id="category"
                name="category"
                type="text"
                defaultValue={product.category || ""}
                placeholder={COPY.categoryPlaceholder}
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
                {COPY.priceLabel}
              </label>
              <input
                id="price"
                name="price"
                type="number"
                min="0"
                step="0.01"
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
                htmlFor="costCurrency"
                style={{
                  display: "block",
                  marginBottom: "8px",
                  fontSize: "14px",
                  fontWeight: 700,
                  color: "#111827",
                }}
              >
                {COPY.currencyLabel}
              </label>
              <select
              id="costCurrency"
              name="costCurrency"
              defaultValue={product.costCurrency || "JPY"}
              style={{
                width: "100%",
                height: "48px",
                border: "1px solid #d1d5db",
                borderRadius: "10px",
                padding: "0 14px",
                fontSize: "14px",
                boxSizing: "border-box",
                background: "#ffffff",
              }}
            >
              <option value="JPY">JPY</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="GBP">GBP</option>
              <option value="CNY">CNY</option>
              <option value="KRW">KRW</option>
            </select>
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
                {COPY.urlLabel}
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
                {isSubmitting ? COPY.submitting : COPY.submit}
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
                {COPY.backToDashboard}
              </a>
            </div>
          </div>
        </Form>
      </div>
    </div>
  );
}


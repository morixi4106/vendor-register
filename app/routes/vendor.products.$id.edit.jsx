import { createCookie, json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import VendorManagementShell from "../components/vendor/VendorManagementShell";
import VendorProductForm from "../components/vendor/VendorProductForm";
import prisma from "../db.server";
import { shopifyGraphQLWithOfflineSession } from "../utils/shopifyAdmin.server";
import { resolveDutyCategory } from "../utils/dutyCategory";
import { PRICE_SYNC_STATUS } from "../utils/priceSyncStatus";

const SHOPIFY_API_VERSION = "2026-01";
const ALLOWED_CURRENCIES = ["JPY", "USD", "EUR", "GBP", "CNY", "KRW"];

const COPY = {
  storeNotFound: "店舗情報が見つかりません。",
  productIdRequired: "商品IDがありません。",
  productNotFound: "商品が見つかりません。",
  unsupportedCurrency: "対応していない通貨です。",
  productNameRequired: "商品名を入力してください。",
  priceRequired: "価格を入力してください。",
  invalidPrice: "価格は0以上の数値で入力してください。",
  reconnectRequired:
    "Shopify との接続を確認してから、もう一度お試しください。",
  updateFailed:
    "商品の更新に失敗しました。時間を置いて再度お試しください。",
  shellTitle: "商品管理",
  pageTitle: "商品編集",
  intro:
    "商品情報を更新します。保存後は申請中となり、内容確認後に Shopify へ反映されます。",
  submit: "商品を更新する",
  submitting: "更新中...",
  backToDashboard: "ダッシュボードへ戻る",
  noImage: "現在の画像は登録されていません。",
  uploadHint:
    "新しい画像を選択すると、保存時に現在の画像が更新されます。",
  imageAlt: "商品画像",
  cloudinaryMissing: "Cloudinary の環境変数が足りません。",
};

const vendorAdminSessionCookie = createCookie("vendor_admin_session", {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 8,
});

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
    throw new Error(COPY.cloudinaryMissing);
  }

  if (!file || typeof file.arrayBuffer !== "function" || file.size === 0) {
    return null;
  }

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);

  const form = new FormData();
  form.append("file", new Blob([buffer]), file.name || "upload.jpg");
  form.append("upload_preset", uploadPreset);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    {
      method: "POST",
      body: form,
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Cloudinary upload failed: ${JSON.stringify(data)}`);
  }

  return data.secure_url || null;
}

async function getVendorSession(request) {
  const cookieHeader = request.headers.get("Cookie");
  const sessionToken = await vendorAdminSessionCookie.parse(cookieHeader);

  if (!sessionToken) {
    throw redirect("/vendor/verify");
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
    throw redirect("/vendor/verify", {
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
      return json({ ok: false, error: COPY.storeNotFound }, { status: 404 });
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
      return json({ ok: false, error: COPY.productNotFound }, { status: 404 });
    }

    const formData = await request.formData();
    const name = String(formData.get("name") || "").trim();
    const description = String(formData.get("description") || "").trim();
    const category = String(formData.get("category") || "").trim();
    const priceRaw = String(formData.get("price") || "").trim();
    const url = String(formData.get("url") || "").trim();
    const costCurrency = String(formData.get("costCurrency") || "JPY")
      .trim()
      .toUpperCase();

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
      return json({ ok: false, error: COPY.priceRequired }, { status: 400 });
    }

    const costAmount = Number(priceRaw);

    if (!Number.isFinite(costAmount) || costAmount < 0) {
      return json({ ok: false, error: COPY.invalidPrice }, { status: 400 });
    }

    const imageFile = formData.get("image");
    let imageUrl = product.imageUrl || null;

    if (imageFile && typeof imageFile.size === "number" && imageFile.size > 0) {
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
      const { data: productUpdateResult, shopDomain } = await shopifyGraphQL(
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

      const userErrors = productUpdateResult?.productUpdate?.userErrors || [];

      if (userErrors.length > 0) {
        throw new Error(userErrors.map((entry) => entry.message).join(", "));
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
        { metafields }
      );

      const metafieldErrors = metafieldsResult?.metafieldsSet?.userErrors || [];

      if (metafieldErrors.length > 0) {
        throw new Error(metafieldErrors.map((entry) => entry.message).join(", "));
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

    return redirect("/vendor/products");
  } catch (error) {
    console.error("vendor product edit error:", error);
    const message = error instanceof Error ? error.message : "";
    const safeError = isReconnectableShopifyError(message)
      ? COPY.reconnectRequired
      : COPY.updateFailed;

    return json({ ok: false, error: safeError }, { status: 500 });
  }
};

export default function EditPage() {
  const { product, store } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();

  const isSubmitting = navigation.state === "submitting";

  return (
    <VendorManagementShell
      activeItem="products"
      storeName={store.storeName}
      title={COPY.shellTitle}
    >
      <VendorProductForm
        backLabel="商品一覧へ戻る"
        backTo="/vendor/products"
        currentImageAlt={product.name || COPY.imageAlt}
        currentImageUrl={product.imageUrl || null}
        error={actionData?.error}
        imageEmptyText={COPY.noImage}
        initialValues={product}
        intro={COPY.intro}
        isSubmitting={isSubmitting}
        storeName={store.storeName}
        submitLabel={COPY.submit}
        submittingLabel={COPY.submitting}
        title={COPY.pageTitle}
        uploadHint={COPY.uploadHint}
      />
    </VendorManagementShell>
  );
}

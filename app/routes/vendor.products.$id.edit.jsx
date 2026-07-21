import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import VendorManagementShell from "../components/vendor/VendorManagementShell";
import VendorProductForm from "../components/vendor/VendorProductForm";
import prisma from "../db.server";
import {
  appendVendorIdToPath,
  requireVendorContext,
} from "../services/vendorManagement.server";
import { shopifyGraphQLWithOfflineSession } from "../utils/shopifyAdmin.server";
import { resolveDutyCategory } from "../utils/dutyCategory";
import { normalizeProductCategory } from "../utils/productCategories";
import { PRICE_SYNC_STATUS } from "../utils/priceSyncStatus";
import {
  buildConfirmedShippingProfileData,
  parseProductShippingProfileFormData,
} from "../utils/productShippingProfile";
import { syncVendorCollectionByStoreId } from "../utils/vendorCollections.server";
import { syncAndRecordShopifyVariantWeight } from "../services/shopifyInventoryWeight.server";
import {
  productComplianceProfileFromFormData,
  upsertProductComplianceProfile,
} from "../services/marketplaceGovernance.server.js";

import { SHOPIFY_API_VERSION } from "../utils/shopifyApiVersion.js";
const ALLOWED_CURRENCIES = ["JPY", "USD", "EUR", "GBP", "CNY", "KRW"];

const COPY = {
  storeNotFound: "店舗情報が見つかりません。",
  productIdRequired: "商品IDがありません。",
  productNotFound: "商品が見つかりません。",
  unsupportedCurrency: "対応していない通貨です。",
  productNameRequired: "商品名を入力してください。",
  categoryRequired: "カテゴリを選択してください。",
  priceRequired: "価格を入力してください。",
  invalidPrice: "価格は0以上の数値で入力してください。",
  reconnectRequired:
    "公開ストアとの接続を確認してから、もう一度お試しください。",
  updateFailed:
    "商品の更新に失敗しました。時間を置いて再度お試しください。",
  shellTitle: "商品管理",
  pageTitle: "商品編集",
  intro:
    "商品情報を更新します。保存後は申請中となり、内容確認後に公開ストアへ反映されます。",
  submit: "商品を更新する",
  submitting: "更新中...",
  backToDashboard: "ダッシュボードへ戻る",
  noImage: "現在の画像は登録されていません。",
  uploadHint:
    "新しい画像を選択すると、保存時に現在の画像が更新されます。",
  imageAlt: "商品画像",
  cloudinaryMissing: "Cloudinary の環境変数が足りません。",
};

function isCheckedInput(value) {
  return value === "on" || value === "true" || value === true;
}

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

export const loader = async ({ request, params }) => {
  const { vendor, store } = await requireVendorContext(request);

  if (!store) {
    throw new Response(COPY.storeNotFound, { status: 404 });
  }

  const productId = String(params.id || "");

  if (!productId) {
    throw new Response(COPY.productIdRequired, { status: 400 });
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { complianceProfile: true },
  });

  if (!product || product.vendorStoreId !== store.id) {
    throw new Response(COPY.productNotFound, { status: 404 });
  }

  return json({
    vendor: {
      id: vendor.id,
    },
    product,
    store: {
      id: store.id,
      storeName: store.storeName,
    },
  });
};

export const action = async ({ request, params }) => {
  try {
    const { vendor, store } = await requireVendorContext(request);

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
      include: { complianceProfile: true },
    });

    if (!product || product.vendorStoreId !== store.id) {
      return json({ ok: false, error: COPY.productNotFound }, { status: 404 });
    }

    const formData = await request.formData();
    const name = String(formData.get("name") || "").trim();
    const description = String(formData.get("description") || "").trim();
    const category = normalizeProductCategory(formData.get("category"));
    const priceRaw = String(formData.get("price") || "").trim();
    const url = String(formData.get("url") || "").trim();
    const costCurrency = String(formData.get("costCurrency") || "JPY")
      .trim()
      .toUpperCase();
    const regulatorySelfCertified = isCheckedInput(
      formData.get("regulatorySelfCertified")
    );
    const hadEuReview =
      Boolean(product.euSaleRequested) ||
      String(product.productEuStatus || "DISABLED").toUpperCase() !== "DISABLED";
    const euSaleRequested = hadEuReview;
    const productEuStatus = hadEuReview ? "PENDING_REVIEW" : "DISABLED";
    const shippingProfile = parseProductShippingProfileFormData(formData, {
      variantCount:
        product.shopifyVariantCount ?? (product.shopifyVariantId ? 1 : null),
    });
    const complianceProfile = productComplianceProfileFromFormData(formData);

    if (!shippingProfile.ok) {
      return json({ ok: false, error: shippingProfile.error }, { status: 400 });
    }

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

    if (!category) {
      return json(
        { ok: false, error: COPY.categoryRequired },
        { status: 400 },
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
      euSaleRequested,
      productEuStatus,
      regulatorySelfCertificationJson: {
        version: "seller-product-self-cert-v1",
        regulatorySelfCertified,
        certifiedAt: regulatorySelfCertified
          ? new Date().toISOString()
          : product.regulatorySelfCertificationJson?.certifiedAt || null,
      },
      priceSyncStatus: PRICE_SYNC_STATUS.CALCULATED_NOT_APPLIED,
      priceSyncError: null,
      ...buildConfirmedShippingProfileData(shippingProfile.data, {
        isShopifyLinked: Boolean(product.shopifyVariantId),
      }),
      shopifyVariantCount:
        product.shopifyVariantCount ?? (product.shopifyVariantId ? 1 : null),
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

      const { buildMarketplaceCheckoutPolicyMetafield } =
        await import("../services/marketplaceCheckoutGate.server.js");
      metafields.push(
        buildMarketplaceCheckoutPolicyMetafield({
          ownerId: product.shopifyProductId,
          product: {
            ...product,
            vendorStore: product.vendorStore,
            complianceProfile: product.complianceProfile,
          },
        }),
      );

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

      if (product.shopifyVariantId) {
        await syncAndRecordShopifyVariantWeight({
          productId,
          shopDomain,
          variantId: product.shopifyVariantId,
          weightGrams: shippingProfile.data.shippingWeightGrams,
        });
      }

      try {
        await syncVendorCollectionByStoreId(product.vendorStoreId, { shopDomain });
      } catch (error) {
        console.error("vendor collection sync after product edit failed:", error);
      }
    } else {
      await prisma.product.update({
        where: { id: productId },
        data: nextProductData,
      });
    }

    await upsertProductComplianceProfile({
      productId,
      values: complianceProfile,
    });

    return redirect(appendVendorIdToPath("/vendor/products", vendor.id));
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

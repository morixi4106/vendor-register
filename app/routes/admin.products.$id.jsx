import { resolveDutyCategory } from "../utils/dutyCategory";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { useMemo, useState } from "react";
import prisma from "../db.server";
import { calculateProductPriceResult } from "../utils/buildCalculatedPrice";
import { buildPriceSnapshot } from "../utils/priceSnapshot";
import {
  getAdminPriceSyncLabel,
  getEffectivePriceSyncStatus,
} from "../utils/priceSyncStatus";
import { getShopPricingSettings } from "../utils/shopPricingSettings";
import {
  CATEGORY_DELIVERY_POLICY_TEMPLATES,
  DELIVERY_COUNTRY_GROUPS,
  getDeliveryPolicyTemplateByKey,
  getRecommendedDeliveryPolicyTemplate,
  normalizeProductCountryPolicy,
  parseCountryCodeSelection,
} from "../utils/productCountryPolicy";
import { saveProductCountryPolicy } from "../utils/productCountryPolicy.server";
import {
  resolveShopDomain,
  shopifyGraphQLWithOfflineSession,
} from "../utils/shopifyAdmin.server";
import { ensureApprovedProductPublished } from "../services/productPublication.server";

const SHOPIFY_API_VERSION = "2026-01";
const SHOPIFY_PRODUCT_CREATE_IN_PROGRESS_STATUS = "publishing";
const SHOPIFY_PRODUCT_CREATE_CLAIMABLE_STATUSES = [
  "pending",
  "review",
  "rejected",
  "approved",
];
const PRODUCT_EU_STATUS_OPTIONS = [
  { value: "DISABLED", label: "EU販売なし" },
  { value: "PENDING_REVIEW", label: "EU審査待ち" },
  { value: "APPROVED_LOW_RISK", label: "EU低リスク承認" },
  { value: "REJECTED_HIGH_RISK", label: "EU高リスク却下" },
  { value: "REQUIRES_ADDITIONAL_DOCS", label: "追加資料待ち" },
];

const PRODUCT_EU_STATUS_VALUES = new Set(
  PRODUCT_EU_STATUS_OPTIONS.map((option) => option.value),
);

function parseCountryCodeList(value) {
  return String(value || "")
    .split(/[\s,、]+/)
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);
}

function formatCountryCodeList(value) {
  if (!Array.isArray(value)) {
    return "";
  }

  return value.join(", ");
}

function parseCountryPolicyFormData(formData) {
  return {
    allowedCountries: parseCountryCodeSelection(formData.getAll("allowedCountries")),
    blockedCountries: parseCountryCodeSelection(formData.getAll("blockedCountries")),
    requiresWarningCountries: parseCountryCodeSelection(
      formData.getAll("requiresWarningCountries"),
    ),
  };
}

function getPresetTemplateValue(template) {
  return `preset:${template.key}`;
}

function getCustomTemplateValue(template) {
  return `custom:${template.id}`;
}

function serializeCustomDeliveryTemplate(template) {
  const policy = normalizeProductCountryPolicy(template);

  return {
    id: template.id,
    value: getCustomTemplateValue(template),
    source: "custom",
    label: template.name,
    name: template.name,
    categoryName: template.categoryName || null,
    description: template.description || "",
    productEuStatus: template.productEuStatus || "DISABLED",
    allowedCountries: policy.allowedCountries,
    blockedCountries: policy.blockedCountries,
    requiresWarningCountries: policy.requiresWarningCountries,
  };
}

function serializePresetDeliveryTemplate(template) {
  const policy = normalizeProductCountryPolicy(template);

  return {
    key: template.key,
    value: getPresetTemplateValue(template),
    source: "preset",
    label: template.label || template.name,
    name: template.name || template.label,
    categoryName: template.name || template.label,
    description: template.description || "",
    productEuStatus: template.productEuStatus || "DISABLED",
    allowedCountries: policy.allowedCountries,
    blockedCountries: policy.blockedCountries,
    requiresWarningCountries: policy.requiresWarningCountries,
  };
}

async function resolveDeliveryPolicyTemplate(templateValue) {
  const rawValue = String(templateValue || "");

  if (rawValue.startsWith("preset:")) {
    return getDeliveryPolicyTemplateByKey(rawValue.slice("preset:".length));
  }

  if (rawValue.startsWith("custom:")) {
    const templateId = rawValue.slice("custom:".length);

    return prisma.deliveryCountryPolicyTemplate.findFirst({
      where: {
        id: templateId,
        isActive: true,
      },
    });
  }

  return getDeliveryPolicyTemplateByKey(rawValue);
}

function getProductEuStatusLabel(status) {
  return (
    PRODUCT_EU_STATUS_OPTIONS.find((option) => option.value === status)?.label ||
    status ||
    "-"
  );
}

function CountryCheckboxSelector({
  name,
  title,
  description,
  selectedCountries = [],
  defaultOpen = false,
  tone = "neutral",
}) {
  const selectedCountrySet = new Set(selectedCountries);
  const toneColor =
    tone === "danger" ? "#b91c1c" : tone === "success" ? "#047857" : "#92400e";

  return (
    <details
      open={defaultOpen}
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: "8px",
        background: "#fff",
        padding: "10px 12px",
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          fontWeight: 800,
          color: toneColor,
        }}
      >
        {title}
      </summary>
      <p style={{ margin: "8px 0 12px", color: "#6b7280", fontSize: "13px" }}>
        {description}
      </p>
      <div style={{ display: "grid", gap: "12px" }}>
        {DELIVERY_COUNTRY_GROUPS.map((group) => (
          <div key={`${name}-${group.key}`}>
            <div style={{ fontWeight: 800, fontSize: "13px", marginBottom: "8px" }}>
              {group.label}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                gap: "8px",
              }}
            >
              {group.options.map((country) => (
                <label
                  key={`${name}-${country.code}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr auto",
                    gap: "8px",
                    alignItems: "center",
                    minHeight: "34px",
                    padding: "7px 9px",
                    border: "1px solid #e5e7eb",
                    borderRadius: "8px",
                    background: "#f9fafb",
                    fontSize: "13px",
                    fontWeight: 700,
                  }}
                >
                  <input
                    defaultChecked={selectedCountrySet.has(country.code)}
                    name={name}
                    type="checkbox"
                    value={country.code}
                  />
                  <span>{country.label}</span>
                  <small style={{ color: "#6b7280", fontWeight: 800 }}>
                    {country.code}
                  </small>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

function getAdminCountryLabel(code) {
  return (
    DELIVERY_COUNTRY_OPTIONS.find((country) => country.code === code)?.label || code
  );
}

function CountryChipList({
  countries = [],
  emptyLabel = "なし",
  limit = 24,
  tone = "neutral",
}) {
  const normalizedCountries = normalizeProductCountryPolicy({
    allowedCountries: countries,
  }).allowedCountries;
  const visibleCountries = normalizedCountries.slice(0, limit);
  const remainingCount = normalizedCountries.length - visibleCountries.length;
  const colors =
    tone === "danger"
      ? { border: "#fecaca", background: "#fff1f2", color: "#991b1b" }
      : tone === "warning"
        ? { border: "#fed7aa", background: "#fff7ed", color: "#9a3412" }
        : tone === "success"
          ? { border: "#bbf7d0", background: "#f0fdf4", color: "#166534" }
          : { border: "#d1d5db", background: "#f9fafb", color: "#374151" };

  if (normalizedCountries.length === 0) {
    return <p style={{ margin: 0, color: "#6b7280" }}>{emptyLabel}</p>;
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
      {visibleCountries.map((countryCode) => (
        <span
          key={countryCode}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            minHeight: "30px",
            padding: "4px 9px",
            borderRadius: "999px",
            border: `1px solid ${colors.border}`,
            background: colors.background,
            color: colors.color,
            fontSize: "13px",
            fontWeight: 800,
          }}
        >
          {getAdminCountryLabel(countryCode)}
          <small style={{ color: "#6b7280", fontWeight: 800 }}>
            {countryCode}
          </small>
        </span>
      ))}
      {remainingCount > 0 ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            minHeight: "30px",
            padding: "4px 9px",
            borderRadius: "999px",
            border: "1px solid #d1d5db",
            background: "#ffffff",
            color: "#374151",
            fontSize: "13px",
            fontWeight: 800,
          }}
        >
          ほか{remainingCount}件
        </span>
      ) : null}
    </div>
  );
}

function DeliveryTemplateSummary({ template, title = "選択中テンプレート" }) {
  if (!template) {
    return null;
  }

  const policy = normalizeProductCountryPolicy(template);

  return (
    <div
      style={{
        display: "grid",
        gap: "12px",
        padding: "12px",
        borderRadius: "8px",
        border: "1px solid #d1d5db",
        background: "#f8fafc",
      }}
    >
      <div>
        <div style={{ fontSize: "13px", color: "#64748b", fontWeight: 800 }}>
          {title}
        </div>
        <div style={{ marginTop: "3px", fontSize: "16px", fontWeight: 900 }}>
          {template.label || template.name}
        </div>
        {template.description ? (
          <p style={{ margin: "6px 0 0", color: "#64748b", lineHeight: 1.6 }}>
            {template.description}
          </p>
        ) : null}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "12px",
        }}
      >
        <div>
          <div style={{ marginBottom: "7px", fontWeight: 900 }}>
            販売できる国
          </div>
          <CountryChipList
            countries={policy.allowedCountries}
            emptyLabel="国を限定しない設定です"
            tone="success"
          />
        </div>

        <div>
          <div style={{ marginBottom: "7px", fontWeight: 900 }}>
            購入できない国
          </div>
          <CountryChipList countries={policy.blockedCountries} tone="danger" />
        </div>

        <div>
          <div style={{ marginBottom: "7px", fontWeight: 900 }}>
            注意確認が必要な国
          </div>
          <CountryChipList
            countries={policy.requiresWarningCountries}
            tone="warning"
          />
        </div>
      </div>

      <div style={{ color: "#475569", fontSize: "13px", fontWeight: 800 }}>
        EU販売ステータス: {getProductEuStatusLabel(template.productEuStatus)}
      </div>
    </div>
  );
}

function isReconnectableShopifyError(message = "") {
  return (
    message.includes("Shopify authentication is required") ||
    message.includes("Invalid API key or access token") ||
    message.includes("401") ||
    message.includes("Offline session not found")
  );
}

function shouldShowInternalPriceDebug() {
  return process.env.NODE_ENV !== "production";
}

function getPublicShopifyReconnectNotice() {
  return "Shopify連携の確認が必要です。必要に応じて再接続してください。";
}

function getPublicAdminActionErrorMessage(needsReconnect) {
  if (needsReconnect) {
    return getPublicShopifyReconnectNotice();
  }

  return "商品の処理に失敗しました。時間を置いて再度お試しください。";
}

function formatDateTime(value) {
  if (!value) return "-";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleString("ja-JP");
}

function getApplyLogStatusLabel(status = "") {
  switch (status) {
    case "success":
      return "Success";
    case "invalid":
      return "Invalid";
    case "apply_failed":
      return "Apply failed";
    default:
      return status || "-";
  }
}

function getApplyLogStatusColor(status = "") {
  switch (status) {
    case "success":
      return "#065f46";
    case "invalid":
      return "#b45309";
    case "apply_failed":
      return "#b91c1c";
    default:
      return "#374151";
  }
}

async function shopifyGraphQL(shopDomain, query, variables = {}) {
  return shopifyGraphQLWithOfflineSession({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query,
    variables,
  });
}

async function createShopifyProductFromDbProduct(product) {
  const createMutation = `
    mutation CreateProduct($product: ProductCreateInput!) {
      productCreate(product: $product) {
        product {
          id
          title
          status
          descriptionHtml
          variants(first: 1) {
            nodes {
              id
              price
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const dutyCategory = resolveDutyCategory(product.category);

  const metafields = [
    {
      namespace: "pricing",
      key: "cost_amount",
      type: "number_decimal",
      value: String(product.costAmount ?? product.price ?? 0),
    },
    {
      namespace: "pricing",
      key: "cost_currency",
      type: "single_line_text_field",
      value: product.costCurrency || "JPY",
    },
  ];

  if (dutyCategory) {
    metafields.push({
      namespace: "pricing",
      key: "duty_category",
      type: "single_line_text_field",
      value: dutyCategory,
    });
  }

  const createVariables = {
    product: {
      title: product.name,
      descriptionHtml: product.description || "",
      vendor: product.vendorStore?.storeName || "Vendor",
      productType: product.category || "",
      status: "ACTIVE",
      metafields,
    },
  };

  const { data: createResult, shopDomain } = await shopifyGraphQL(
    product.shopDomain,
    createMutation,
    createVariables
  );
  const createPayload = createResult?.productCreate;

  if (!createPayload) {
    throw new Error("Shopify productCreate response is empty");
  }

  if (createPayload.userErrors?.length) {
    throw new Error(
      `productCreate userErrors: ${JSON.stringify(createPayload.userErrors)}`
    );
  }

  const createdProduct = createPayload.product;
  const createdVariant = createdProduct?.variants?.nodes?.[0];

  if (!createdProduct?.id) {
    throw new Error("Shopify product ID was not returned");
  }

  if (!createdVariant?.id) {
    throw new Error("Shopify initial variant ID was not returned");
  }

  const updateVariantMutation = `
    mutation UpdateVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        product {
          id
        }
        productVariants {
          id
          price
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const updateVariantVariables = {
    productId: createdProduct.id,
    variants: [
      {
        id: createdVariant.id,
        price: String(product.costAmount ?? product.price ?? 0),
      },
    ],
  };

  const { data: updateVariantResult } = await shopifyGraphQL(
    shopDomain,
    updateVariantMutation,
    updateVariantVariables
  );

  const updateVariantPayload = updateVariantResult?.productVariantsBulkUpdate;

  if (!updateVariantPayload) {
    throw new Error("Shopify productVariantsBulkUpdate response is empty");
  }

  if (updateVariantPayload.userErrors?.length) {
    throw new Error(
      `productVariantsBulkUpdate userErrors: ${JSON.stringify(
        updateVariantPayload.userErrors
      )}`
    );
  }

  if (product.imageUrl) {
    const createMediaMutation = `
      mutation CreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media {
            alt
            mediaContentType
            status
          }
          mediaUserErrors {
            field
            message
          }
          product {
            id
          }
        }
      }
    `;

    const createMediaVariables = {
      productId: createdProduct.id,
      media: [
        {
          alt: product.name || "Product image",
          mediaContentType: "IMAGE",
          originalSource: product.imageUrl,
        },
      ],
    };

    const { data: createMediaResult } = await shopifyGraphQL(
      shopDomain,
      createMediaMutation,
      createMediaVariables
    );

    const createMediaPayload = createMediaResult?.productCreateMedia;

    if (!createMediaPayload) {
      throw new Error("Shopify productCreateMedia response is empty");
    }

    if (createMediaPayload.mediaUserErrors?.length) {
      throw new Error(
        `productCreateMedia mediaUserErrors: ${JSON.stringify(
          createMediaPayload.mediaUserErrors
        )}`
      );
    }
  }

  const { applyProductPrice } = await import("../utils/applyProductPrice.server");
  await applyProductPrice(createdProduct.id, {
    shopDomain,
    localProductId: product.id,
  });

  return {
    shopifyProductId: createdProduct.id,
    shopDomain,
  };
}

async function claimShopifyProductCreation(productId) {
  const result = await prisma.product.updateMany({
    where: {
      id: productId,
      shopifyProductId: null,
      approvalStatus: {
        in: SHOPIFY_PRODUCT_CREATE_CLAIMABLE_STATUSES,
      },
    },
    data: {
      approvalStatus: SHOPIFY_PRODUCT_CREATE_IN_PROGRESS_STATUS,
    },
  });

  return result.count === 1;
}

async function resetShopifyProductCreationClaim(productId, approvalStatus) {
  await prisma.product.updateMany({
    where: {
      id: productId,
      shopifyProductId: null,
      approvalStatus: SHOPIFY_PRODUCT_CREATE_IN_PROGRESS_STATUS,
    },
    data: {
      approvalStatus: approvalStatus || "pending",
    },
  });
}

export const loader = async ({ params }) => {
  const id = String(params.id || "");
  const showInternalPriceDebug = shouldShowInternalPriceDebug();

  if (!id) {
    throw new Response("IDがありません", { status: 400 });
  }

  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      vendorStore: true,
      countryPolicy: true,
    },
  });

  if (!product) {
    throw new Response("商品が見つかりません", { status: 404 });
  }

  const customDeliveryTemplates =
    await prisma.deliveryCountryPolicyTemplate.findMany({
      where: {
        isActive: true,
      },
      orderBy: {
        name: "asc",
      },
    });

  let shopifyPrice = null;
  let needsReconnect = false;
  let rawShopifyError = null;
  let priceBreakdown = null;
  let previewPriceSnapshot = null;
  let priceCalculationState = {
    status: "calculable",
    reason: null,
  };
  let usedShopifyPricingInput = false;
  let usedShopifySettings = false;
  let reconnectShopDomain = product.shopDomain || null;

  const costAmount = Number(product.costAmount ?? product.price ?? 0);
  const costCurrency = String(product.costCurrency || "JPY").trim().toUpperCase();
  const dutyCategory = resolveDutyCategory(product.category);
  let previewPricingInput = {
    costAmount,
    costCurrency,
    dutyCategory,
    shopDomain: reconnectShopDomain,
  };

  let pricingSettings = {
    shopDomain: reconnectShopDomain,
  };

  // Shopifyのglobal_pricingを読めれば使う。読めなくても表示は止めない
  try {
    pricingSettings = await getShopPricingSettings({
      shopDomain: product.shopDomain,
      apiVersion: SHOPIFY_API_VERSION,
    });
    usedShopifySettings = true;
    reconnectShopDomain = reconnectShopDomain || pricingSettings.shopDomain;
  } catch (error) {
    const message = error instanceof Error ? error.message : "不明なエラーです";

    if (isReconnectableShopifyError(message)) {
      needsReconnect = true;
      rawShopifyError = message;
    } else {
      console.error("shop pricing settings read error:", error);
    }
  }

  // Shopify接続が死んでいても、価格プレビューは可能な限り出す
  if (product.shopifyProductId) {
    try {
      const { data: shopifyData, shopDomain } = await shopifyGraphQL(
        product.shopDomain,
        `
          query ReadProductPrice($id: ID!) {
            product(id: $id) {
              id
              costAmountMetafield: metafield(namespace: "pricing", key: "cost_amount") {
                value
              }
              costCurrencyMetafield: metafield(namespace: "pricing", key: "cost_currency") {
                value
              }
              dutyCategoryMetafield: metafield(namespace: "pricing", key: "duty_category") {
                value
              }
              variants(first: 1) {
                nodes {
                  id
                  price
                }
              }
            }
          }
        `,
        {
          id: product.shopifyProductId,
        }
      );

      shopifyPrice =
        shopifyData?.product?.variants?.nodes?.[0]?.price || null;
      reconnectShopDomain = reconnectShopDomain || shopDomain;
      previewPricingInput = {
        costAmount:
          shopifyData?.product?.costAmountMetafield?.value ?? previewPricingInput.costAmount,
        costCurrency:
          shopifyData?.product?.costCurrencyMetafield?.value ??
          previewPricingInput.costCurrency,
        dutyCategory:
          shopifyData?.product?.dutyCategoryMetafield?.value ??
          previewPricingInput.dutyCategory,
        shopDomain: reconnectShopDomain || shopDomain,
      };
      usedShopifyPricingInput = true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "不明なエラーです";

      rawShopifyError = message;

      if (isReconnectableShopifyError(message)) {
        needsReconnect = true;
      } else {
        throw error;
      }
    }
  }

  // Shopify謗･邯壹′豁ｻ繧薙〒縺・※繧ゅ∽ｾ｡譬ｼ繝励Ξ繝薙Η繝ｼ縺ｯ蜿ｯ閭ｽ縺ｪ髯舌ｊ蜃ｺ縺・
  const previewResult = await calculateProductPriceResult(previewPricingInput, {
    settings: pricingSettings,
    shopDomain: previewPricingInput.shopDomain,
  });

  if (previewResult.ok) {
    const priceResult = previewResult.value;
    priceBreakdown = priceResult.breakdown;
    if (showInternalPriceDebug) {
      previewPriceSnapshot = buildPriceSnapshot(priceResult, {
        calculatedAt: new Date(),
        localProductId: product.id,
        shopifyProductId: product.shopifyProductId,
        shopDomain: priceResult.shopDomain || previewPricingInput.shopDomain,
        snapshotType: "preview",
        source: {
          pricingInput: usedShopifyPricingInput
            ? "shopify_product_metafields"
            : "local_product_fallback",
          shopSettings: usedShopifySettings
            ? "shopify_shop_metafields"
            : "default_pricing_settings",
          fxRate: "fx_rate_table",
        },
      });
    }
    reconnectShopDomain = reconnectShopDomain || priceResult.shopDomain;
  } else {
    priceCalculationState = {
      status: "invalid",
      reason: previewResult.error.message,
    };
  }

  const effectivePriceSyncStatus = getEffectivePriceSyncStatus(product);
  const priceState = showInternalPriceDebug
    ? {
        syncStatus: effectivePriceSyncStatus,
        syncLabel: getAdminPriceSyncLabel(effectivePriceSyncStatus),
        syncError: product.priceSyncError || null,
        priceAppliedAt: product.priceAppliedAt || product.calculatedAt || null,
        lastPriceApplyAttemptAt: product.lastPriceApplyAttemptAt || null,
        calculationStatus: priceCalculationState.status,
        calculationReason: priceCalculationState.reason,
      }
    : null;

  let priceApplyLogs = [];

  if (showInternalPriceDebug) {
    const directPriceApplyLogs = await prisma.productPriceApplyLog.findMany({
      where: {
        productId: product.id,
      },
      orderBy: {
        attemptedAt: "desc",
      },
      take: 10,
    });

    priceApplyLogs = directPriceApplyLogs;

    if (product.shopifyProductId) {
      const unresolvedPriceApplyLogs = await prisma.productPriceApplyLog.findMany({
        where: {
          productId: null,
          shopifyProductId: product.shopifyProductId,
          ...(product.shopDomain
            ? {
                OR: [{ shopDomain: product.shopDomain }, { shopDomain: null }],
              }
            : {}),
        },
        orderBy: {
          attemptedAt: "desc",
        },
        take: 10,
      });

      priceApplyLogs = Array.from(
        new Map(
          [...directPriceApplyLogs, ...unresolvedPriceApplyLogs]
            .sort((a, b) => new Date(b.attemptedAt) - new Date(a.attemptedAt))
            .map((log) => [log.id, log])
        ).values()
      ).slice(0, 10);
    }
  }

  return json({
    product,
    shopifyPrice,
    needsReconnect,
    shopifyNotice: needsReconnect ? getPublicShopifyReconnectNotice() : null,
    priceBreakdown,
    customDeliveryTemplates: customDeliveryTemplates.map(
      serializeCustomDeliveryTemplate,
    ),
    reconnectShopDomain,
    showInternalPriceDebug,
    priceDebug: showInternalPriceDebug
      ? {
          shopifyError: rawShopifyError,
          previewPriceSnapshot,
          priceState,
          priceApplyLogs,
        }
      : null,
  });
};

export const action = async ({ request }) => {
  try {
    const formData = await request.formData();

    const intent = String(formData.get("intent") || "");
    const productId = String(formData.get("productId") || "");

    if (!productId) {
      return json({ ok: false, error: "productId がありません" }, { status: 400 });
    }

    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        vendorStore: true,
        countryPolicy: true,
      },
    });

    if (!product) {
      return json({ ok: false, error: "商品が見つかりません" }, { status: 404 });
    }

    if (intent === "apply-country-template") {
      const template = await resolveDeliveryPolicyTemplate(
        formData.get("countryPolicyTemplate"),
      );

      if (!template) {
        return json(
          { ok: false, error: "配送先テンプレートが不正です" },
          { status: 400 },
        );
      }

      await prisma.$transaction(async (tx) => {
        await tx.product.update({
          where: { id: productId },
          data: {
            productEuStatus: template.productEuStatus,
            euSaleRequested: template.productEuStatus !== "DISABLED",
          },
        });

        await saveProductCountryPolicy({
          productId,
          productEuStatus: template.productEuStatus,
          policyInput: template,
          prismaClient: tx,
        });
      });

      return redirect(`/admin/products/${productId}`);
    }

    if (intent === "save-country-template") {
      const templateName = String(formData.get("templateName") || "").trim();
      const templateDescription = String(
        formData.get("templateDescription") || "",
      ).trim();
      const productEuStatus = String(
        formData.get("productEuStatus") || "DISABLED",
      )
        .trim()
        .toUpperCase();

      if (!templateName) {
        return json(
          { ok: false, error: "テンプレート名を入力してください" },
          { status: 400 },
        );
      }

      if (!PRODUCT_EU_STATUS_VALUES.has(productEuStatus)) {
        return json(
          { ok: false, error: "EU販売ステータスが不正です" },
          { status: 400 },
        );
      }

      const policyInput = parseCountryPolicyFormData(formData);

      await prisma.deliveryCountryPolicyTemplate.upsert({
        where: {
          name: templateName,
        },
        create: {
          name: templateName,
          categoryName: templateName,
          description: templateDescription || null,
          productEuStatus,
          allowedCountries: policyInput.allowedCountries,
          blockedCountries: policyInput.blockedCountries,
          requiresWarningCountries: policyInput.requiresWarningCountries,
        },
        update: {
          categoryName: templateName,
          description: templateDescription || null,
          productEuStatus,
          allowedCountries: policyInput.allowedCountries,
          blockedCountries: policyInput.blockedCountries,
          requiresWarningCountries: policyInput.requiresWarningCountries,
          isActive: true,
        },
      });

      return redirect(`/admin/products/${productId}`);
    }

    if (intent === "update-eu-policy") {
      const productEuStatus = String(
        formData.get("productEuStatus") || "DISABLED",
      )
        .trim()
        .toUpperCase();

      if (!PRODUCT_EU_STATUS_VALUES.has(productEuStatus)) {
        return json(
          { ok: false, error: "EU販売ステータスが不正です" },
          { status: 400 },
        );
      }

      const policyInput = parseCountryPolicyFormData(formData);

      await prisma.$transaction(async (tx) => {
        await tx.product.update({
          where: { id: productId },
          data: {
            productEuStatus,
            euSaleRequested: productEuStatus !== "DISABLED",
          },
        });

        await saveProductCountryPolicy({
          productId,
          productEuStatus,
          policyInput,
          prismaClient: tx,
        });
      });

      return redirect(`/admin/products/${productId}`);
    }

    let productWithResolvedShopDomain = product;

    if (
      (intent === "approve" || intent === "apply-price") &&
      !product.shopDomain
    ) {
      productWithResolvedShopDomain = {
        ...product,
        shopDomain: await resolveShopDomain(),
      };
    }

    if (intent === "apply-price") {
      if (!productWithResolvedShopDomain.shopifyProductId) {
        return json(
          { ok: false, error: "Shopify商品IDがありません" },
          { status: 400 }
        );
      }

      const refreshRes = await fetch(
        `${new URL(request.url).origin}/api/refresh-fx`,
        {
          method: "POST",
        }
      );

      const refreshData = await refreshRes.json();

      if (!refreshRes.ok || !refreshData?.ok) {
        return json(
          {
            ok: false,
            error: refreshData?.error || "為替更新に失敗しました",
          },
          { status: 500 }
        );
      }

      const { applyProductPrice } = await import("../utils/applyProductPrice.server");
      const result = await applyProductPrice(productWithResolvedShopDomain.shopifyProductId, {
        shopDomain: productWithResolvedShopDomain.shopDomain,
        localProductId: productWithResolvedShopDomain.id,
      });

      return json({
        ok: true,
        message: `為替更新後に価格を更新しました（¥${result.oldPrice} → ¥${result.newPrice}）`,
        priceApplied: true,
        fxRates: refreshData.fxRates || [],
        result,
      });
    }

    if (intent === "approve") {
      if (productWithResolvedShopDomain.shopifyProductId) {
        const updateMutation = `
          mutation UpdateProductStatus($input: ProductInput!) {
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
        `;

        const { data: updateResult, shopDomain } = await shopifyGraphQL(
          productWithResolvedShopDomain.shopDomain,
          updateMutation,
          {
            input: {
              id: productWithResolvedShopDomain.shopifyProductId,
              title: productWithResolvedShopDomain.name,
              descriptionHtml: productWithResolvedShopDomain.description || "",
              productType: productWithResolvedShopDomain.category || "",
              status: "ACTIVE",
            },
          }
        );

        const updatePayload = updateResult?.productUpdate;

        if (!updatePayload) {
          throw new Error("Shopify productUpdate response is empty");
        }

        if (updatePayload.userErrors?.length) {
          throw new Error(
            `productUpdate userErrors: ${JSON.stringify(updatePayload.userErrors)}`
          );
        }

        await prisma.product.update({
          where: { id: productId },
          data: {
            approvalStatus: "approved",
            shopDomain,
          },
        });

        await ensureApprovedProductPublished(productId);

        return redirect(`/admin/products/${productId}`);
      }

      const originalApprovalStatus =
        productWithResolvedShopDomain.approvalStatus || "pending";
      const claimedCreation = await claimShopifyProductCreation(productId);

      if (!claimedCreation) {
        const latestProduct = await prisma.product.findUnique({
          where: { id: productId },
          select: {
            approvalStatus: true,
            shopifyProductId: true,
          },
        });

        if (latestProduct?.shopifyProductId) {
          await prisma.product.update({
            where: { id: productId },
            data: {
              approvalStatus: "approved",
            },
          });

          await ensureApprovedProductPublished(productId);
        }

        return redirect(`/admin/products/${productId}`);
      }

      let result;

      try {
        result = await createShopifyProductFromDbProduct({
          ...productWithResolvedShopDomain,
          approvalStatus: SHOPIFY_PRODUCT_CREATE_IN_PROGRESS_STATUS,
        });
      } catch (error) {
        await resetShopifyProductCreationClaim(productId, originalApprovalStatus);
        throw error;
      }

      await prisma.product.update({
        where: { id: productId },
        data: {
          approvalStatus: "approved",
          shopifyProductId: result.shopifyProductId,
          shopDomain: result.shopDomain,
        },
      });

      await ensureApprovedProductPublished(productId);

      return redirect(`/admin/products/${productId}`);
    }

    if (intent === "reject") {
      await prisma.product.update({
        where: { id: productId },
        data: {
          approvalStatus: "rejected",
        },
      });

      return redirect(`/admin/products/${productId}`);
    }

    return json({ ok: false, error: "不明な intent です" }, { status: 400 });
  } catch (error) {
    console.error("admin approve error:", error);

    const message =
      error instanceof Error ? error.message : "不明なエラーです";

    const needsReconnect = isReconnectableShopifyError(message);
    const showInternalPriceDebug = shouldShowInternalPriceDebug();

    return json(
      {
        ok: false,
        error: showInternalPriceDebug
          ? message
          : getPublicAdminActionErrorMessage(needsReconnect),
        needsReconnect,
      },
      { status: 500 }
    );
  }
};

export default function AdminProductDetail() {
  const {
    product,
    shopifyPrice,
    needsReconnect,
    shopifyNotice,
    priceBreakdown,
    customDeliveryTemplates = [],
    reconnectShopDomain,
    showInternalPriceDebug,
    priceDebug,
  } = useLoaderData();
  const actionData = useActionData();
  const priceState = priceDebug?.priceState || null;
  const priceApplyLogs = priceDebug?.priceApplyLogs || [];
  const publicReconnectMessage =
    shopifyNotice || getPublicShopifyReconnectNotice();
  const reconnectMessage = showInternalPriceDebug
    ? priceDebug?.shopifyError || publicReconnectMessage
    : publicReconnectMessage;
  const actionErrorMessage = actionData?.error;
  const recommendedDeliveryTemplate = getRecommendedDeliveryPolicyTemplate(product);
  const presetDeliveryTemplates = useMemo(
    () => CATEGORY_DELIVERY_POLICY_TEMPLATES.map(serializePresetDeliveryTemplate),
    [],
  );
  const deliveryTemplateOptions = useMemo(
    () => [...presetDeliveryTemplates, ...customDeliveryTemplates],
    [presetDeliveryTemplates, customDeliveryTemplates],
  );
  const recommendedDeliveryTemplateValue = getPresetTemplateValue(
    recommendedDeliveryTemplate,
  );
  const [selectedDeliveryTemplateValue, setSelectedDeliveryTemplateValue] =
    useState(recommendedDeliveryTemplateValue);
  const selectedDeliveryTemplate = useMemo(
    () =>
      deliveryTemplateOptions.find(
        (template) => template.value === selectedDeliveryTemplateValue,
      ) ||
      deliveryTemplateOptions.find(
        (template) => template.value === recommendedDeliveryTemplateValue,
      ) ||
      deliveryTemplateOptions[0],
    [
      deliveryTemplateOptions,
      recommendedDeliveryTemplateValue,
      selectedDeliveryTemplateValue,
    ],
  );
  const currentCountryPolicy = normalizeProductCountryPolicy(
    product.countryPolicy,
  );
  const currentDeliveryPolicySummary = {
    label: "現在の商品設定",
    description: "保存済みの商品別配送設定です。",
    productEuStatus: product.productEuStatus || "DISABLED",
    ...currentCountryPolicy,
  };

  return (
    <div style={{ padding: "40px", maxWidth: "1000px", margin: "0 auto" }}>
      <h1>{product.name}</h1>

      <p style={{ color: "#666" }}>
        店舗: {product.vendorStore?.storeName || "-"}
      </p>

      {actionErrorMessage ? (
        <div
          style={{
            marginTop: "20px",
            marginBottom: "20px",
            padding: "14px",
            borderRadius: "8px",
            background: "#fff1f2",
            border: "1px solid #fecdd3",
            color: "#9f1239",
            whiteSpace: "pre-wrap",
          }}
        >
          <strong>エラー:</strong>
          <div style={{ marginTop: "8px" }}>{actionErrorMessage}</div>

          {actionData?.needsReconnect ? (
            <div style={{ marginTop: "14px" }}>
              <div style={{ marginBottom: "10px" }}>
                Shopifyとの接続を確認してください。
              </div>

              <Form method="post" action="/admin/shopify-reconnect">
                <input type="hidden" name="returnTo" value={`/admin/products/${product.id}`} />
                <input type="hidden" name="shopDomain" value={reconnectShopDomain || ""} />
                <button
                  type="submit"
                  style={{
                    height: "40px",
                    padding: "0 14px",
                    borderRadius: "8px",
                    border: "1px solid #111827",
                    background: "#111827",
                    color: "#fff",
                    cursor: "pointer",
                    fontWeight: 700,
                  }}
                >
                  Shopify再接続
                </button>
              </Form>
            </div>
          ) : null}
        </div>
      ) : null}

      {needsReconnect ? (
        <div
          style={{
            marginTop: "20px",
            marginBottom: "20px",
            padding: "14px",
            borderRadius: "8px",
            background: "#fff7ed",
            border: "1px solid #fdba74",
            color: "#9a3412",
            whiteSpace: "pre-wrap",
          }}
        >
          <strong>Shopify接続エラー:</strong>
          <div style={{ marginTop: "8px" }}>{reconnectMessage}</div>

          <div style={{ marginTop: "14px" }}>
            <Form method="post" action="/admin/shopify-reconnect">
              <input
                type="hidden"
                name="returnTo"
                value={`/admin/products/${product.id}`}
              />
              <input type="hidden" name="shopDomain" value={reconnectShopDomain || ""} />
              <button
                type="submit"
                style={{
                  height: "40px",
                  padding: "0 14px",
                  borderRadius: "8px",
                  border: "1px solid #111827",
                  background: "#111827",
                  color: "#fff",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                Shopify再接続
              </button>
            </Form>
          </div>
        </div>
      ) : null}

      {actionData?.ok && actionData?.message ? (
        <div
          style={{
            marginTop: "20px",
            marginBottom: "20px",
            padding: "14px",
            borderRadius: "8px",
            background: "#ecfdf5",
            border: "1px solid #a7f3d0",
            color: "#065f46",
            whiteSpace: "pre-wrap",
          }}
        >
          <strong>成功:</strong>
          <div style={{ marginTop: "8px" }}>{actionData.message}</div>
        </div>
      ) : null}

      {showInternalPriceDebug && priceDebug && priceState ? (
        <>
          <div
            style={{
              marginTop: "20px",
              padding: "14px",
              borderRadius: "8px",
              background: "#f9fafb",
              border: "1px solid #e5e7eb",
            }}
          >
            <strong>Price State</strong>
            <div style={{ marginTop: "8px", display: "grid", gap: "6px" }}>
              <div>Calculation state: {priceState.calculationStatus}</div>
              <div>Price sync status: {priceState.syncLabel}</div>
              <div>Last applied: {formatDateTime(priceState.priceAppliedAt)}</div>
              <div>Last apply attempt: {formatDateTime(priceState.lastPriceApplyAttemptAt)}</div>
              {priceState.calculationReason ? (
                <div style={{ color: "#b45309" }}>
                  Calculation issue: {priceState.calculationReason}
                </div>
              ) : null}
              {priceState.syncError ? (
                <div style={{ color: "#b91c1c" }}>
                  Last apply failure: {priceState.syncError}
                </div>
              ) : null}
              {priceState.syncStatus === "apply_failed" ? (
                <div style={{ color: "#1d4ed8" }}>
                  Retry from the apply button below after reconnecting Shopify if needed.
                </div>
              ) : null}
              {priceState.syncStatus === "invalid" ? (
                <div style={{ color: "#1d4ed8" }}>
                  Fix the pricing inputs, then run apply again from the button below.
                </div>
              ) : null}
            </div>
          </div>

          <div
            style={{
              marginTop: "20px",
              padding: "14px",
              borderRadius: "8px",
              background: "#f9fafb",
              border: "1px solid #e5e7eb",
            }}
          >
            <strong>Recent Apply Attempts</strong>
            {priceApplyLogs?.length ? (
              <div style={{ marginTop: "12px", display: "grid", gap: "10px" }}>
                {priceApplyLogs.map((log) => {
                  const logInput = log?.priceSnapshotJson?.input || null;
                  const logSource = log?.priceSnapshotJson?.source || null;

                  return (
                    <div
                      key={log.id}
                      style={{
                        padding: "12px",
                        borderRadius: "8px",
                        background: "#ffffff",
                        border: "1px solid #e5e7eb",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          gap: "10px",
                          flexWrap: "wrap",
                          alignItems: "center",
                        }}
                      >
                        <strong style={{ color: getApplyLogStatusColor(log.status) }}>
                          {getApplyLogStatusLabel(log.status)}
                        </strong>
                        <span>{formatDateTime(log.attemptedAt)}</span>
                        <span>Shop: {log.shopDomain || "-"}</span>
                        <span>
                          Attempted price:{" "}
                          {typeof log.attemptedPrice === "number"
                            ? `¥${log.attemptedPrice}`
                            : "-"}
                        </span>
                        <span>Formula: {log.priceFormulaVersion || "-"}</span>
                      </div>

                      {logInput ? (
                        <div style={{ marginTop: "8px", color: "#4b5563", fontSize: "14px" }}>
                          Input: {logInput.costAmount ?? "-"} {logInput.costCurrency || "-"} /
                          duty {logInput.dutyCategory || "-"}
                        </div>
                      ) : null}

                      {logSource ? (
                        <div style={{ marginTop: "4px", color: "#6b7280", fontSize: "13px" }}>
                          Source: {logSource.pricingInput || "-"} /{" "}
                          {logSource.shopSettings || "-"} / {logSource.fxRate || "-"}
                        </div>
                      ) : null}

                      {log.errorSummary ? (
                        <div style={{ marginTop: "8px", color: "#b91c1c" }}>
                          Error: {log.errorSummary}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ marginTop: "12px", color: "#6b7280" }}>
                No apply attempts yet.
              </div>
            )}
          </div>
        </>
      ) : null}

      <div style={{ display: "grid", gap: "20px", marginTop: "20px" }}>
        <div>
          <h3>EU販売審査</h3>
          <div
            style={{
              marginTop: "10px",
              padding: "14px",
              borderRadius: "8px",
              background: "#f9fafb",
              border: "1px solid #e5e7eb",
            }}
          >
            <p>現在: {getProductEuStatusLabel(product.productEuStatus)}</p>
            <p>
              出店者希望: {product.euSaleRequested ? "あり" : "なし"}
            </p>
            <p style={{ color: "#6b7280", fontSize: "14px" }}>
              高リスク商品は承認せず、低リスク商品だけEU向けcheckoutを許可します。
            </p>

            <Form
              method="post"
              style={{
                display: "grid",
                gap: "10px",
                marginTop: "14px",
                padding: "12px",
                borderRadius: "8px",
                background: "#ffffff",
                border: "1px solid #e5e7eb",
              }}
            >
              <input type="hidden" name="intent" value="apply-country-template" />
              <input type="hidden" name="productId" value={product.id} />

              <label style={{ display: "grid", gap: "6px", fontWeight: 700 }}>
                カテゴリ別配送先テンプレート
                <select
                  name="countryPolicyTemplate"
                  value={selectedDeliveryTemplateValue}
                  onChange={(event) =>
                    setSelectedDeliveryTemplateValue(event.currentTarget.value)
                  }
                  style={{
                    height: "40px",
                    borderRadius: "8px",
                    border: "1px solid #d1d5db",
                    padding: "0 10px",
                  }}
                >
                  {deliveryTemplateOptions.map((template) => (
                    <option key={template.value} value={template.value}>
                      {template.source === "custom" ? "追加: " : ""}
                      {template.label}
                    </option>
                  ))}
                </select>
              </label>

              <DeliveryTemplateSummary template={selectedDeliveryTemplate} />

              <div style={{ color: "#6b7280", fontSize: "13px", lineHeight: 1.7 }}>
                推奨: {recommendedDeliveryTemplate.label}
                <br />
                {recommendedDeliveryTemplate.description}
              </div>

              <button
                type="submit"
                style={{
                  minHeight: "40px",
                  padding: "0 14px",
                  borderRadius: "8px",
                  border: "1px solid #111827",
                  background: "#111827",
                  color: "#fff",
                  cursor: "pointer",
                  fontWeight: 700,
                  justifySelf: "start",
                }}
              >
                テンプレを適用して保存
              </button>
            </Form>

            <Form method="post" style={{ display: "grid", gap: "12px", marginTop: "14px" }}>
              <input type="hidden" name="productId" value={product.id} />

              <DeliveryTemplateSummary
                template={currentDeliveryPolicySummary}
                title="保存済みの商品設定"
              />

              <label style={{ display: "grid", gap: "6px", fontWeight: 700 }}>
                EU販売ステータス
                <select
                  name="productEuStatus"
                  defaultValue={product.productEuStatus || "DISABLED"}
                  style={{
                    height: "40px",
                    borderRadius: "8px",
                    border: "1px solid #d1d5db",
                    padding: "0 10px",
                  }}
                >
                  {PRODUCT_EU_STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <CountryCheckboxSelector
                defaultOpen={currentCountryPolicy.allowedCountries.length > 0}
                description="選択した場合、この商品は選択した国だけで購入できます。未選択なら国を限定しません。"
                name="allowedCountries"
                selectedCountries={currentCountryPolicy.allowedCountries}
                title="配送できる国を限定する"
                tone="success"
              />

              <CountryCheckboxSelector
                defaultOpen={currentCountryPolicy.blockedCountries.length > 0}
                description="選択した国では購入できません。配送できる国と重なった場合は、購入できない国が優先されます。"
                name="blockedCountries"
                selectedCountries={currentCountryPolicy.blockedCountries}
                title="購入できない国"
                tone="danger"
              />

              <CountryCheckboxSelector
                defaultOpen={currentCountryPolicy.requiresWarningCountries.length > 0}
                description="購入前に関税・輸入VAT・通関手数料などの注意確認を表示したい国です。EU宛は承認後も自動で注意確認が必要になります。"
                name="requiresWarningCountries"
                selectedCountries={currentCountryPolicy.requiresWarningCountries}
                title="注意確認が必要な国"
                tone="warning"
              />

              <div
                style={{
                  display: "grid",
                  gap: "10px",
                  padding: "12px",
                  borderRadius: "8px",
                  border: "1px solid #e5e7eb",
                  background: "#ffffff",
                }}
              >
                <label style={{ display: "grid", gap: "6px", fontWeight: 700 }}>
                  新しいテンプレート名
                  <input
                    name="templateName"
                    placeholder="例: 化粧品 EU書類確認済み"
                    style={{
                      height: "40px",
                      borderRadius: "8px",
                      border: "1px solid #d1d5db",
                      padding: "0 10px",
                    }}
                  />
                </label>
                <label style={{ display: "grid", gap: "6px", fontWeight: 700 }}>
                  テンプレート説明
                  <input
                    name="templateDescription"
                    placeholder="任意。あとで選ぶ管理者向けのメモです。"
                    style={{
                      height: "40px",
                      borderRadius: "8px",
                      border: "1px solid #d1d5db",
                      padding: "0 10px",
                    }}
                  />
                </label>
              </div>

              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                <button
                  name="intent"
                  type="submit"
                  value="update-eu-policy"
                  style={{
                    minHeight: "40px",
                    padding: "0 14px",
                    borderRadius: "8px",
                    border: "1px solid #111827",
                    background: "#111827",
                    color: "#fff",
                    cursor: "pointer",
                    fontWeight: 700,
                  }}
                >
                  商品の配送設定を保存
                </button>
                <button
                  name="intent"
                  type="submit"
                  value="save-country-template"
                  style={{
                    minHeight: "40px",
                    padding: "0 14px",
                    borderRadius: "8px",
                    border: "1px solid #d1d5db",
                    background: "#ffffff",
                    color: "#111827",
                    cursor: "pointer",
                    fontWeight: 700,
                  }}
                >
                  この設定をテンプレートとして保存
                </button>
              </div>
            </Form>
          </div>
        </div>

        <div>
          <h3>基本情報</h3>
          {priceBreakdown ? (
            <div
              style={{
                marginTop: "10px",
                padding: "10px",
                background: "#f9fafb",
                borderRadius: "8px",
              }}
            >
              <p>原価(JPY換算): ¥{Math.round(priceBreakdown.costFx)}</p>
              <p>関税: ¥{Math.round(priceBreakdown.duty)}</p>
              <p>関税込原価: ¥{Math.round(priceBreakdown.landed)}</p>
              <p>安全原価: ¥{Math.round(priceBreakdown.safeCost)}</p>
              <p>目標価格: ¥{Math.round(priceBreakdown.target)}</p>
              <p>計算前価格: ¥{Math.round(priceBreakdown.rawPrice)}</p>
              <p><strong>最終価格: ¥{priceBreakdown.finalPrice}</strong></p>
            </div>
          ) : null}
          <p>
            原価: {product.costCurrency || "JPY"} {product.costAmount ?? product.price}
          </p>
          <p>
            基準販売価格（JPY）: {priceBreakdown?.finalPrice != null
              ? `¥${priceBreakdown.finalPrice}`
              : typeof product.calculatedPrice === "number"
                ? `¥${product.calculatedPrice}`
                : "-"}
          </p>
          <p>
            Shopify基準価格: {shopifyPrice ? `¥${shopifyPrice}` : "-"}
          </p>
          <p>状態: {product.approvalStatus}</p>
          <p>Shopify商品ID: {product.shopifyProductId || "-"}</p>
          <p style={{ color: "#6b7280", fontSize: "14px", marginTop: "8px" }}>
            ※ 原価・通貨・関税設定をもとに基準販売価格（JPY）が計算されます。
          </p>
        </div>

        <div>
          <h3>商品説明</h3>
          <div style={{ whiteSpace: "pre-wrap" }}>
            {product.description || "説明なし"}
          </div>
        </div>

        <div>
          <h3>追加情報</h3>
          <p>カテゴリ: {product.category || "未設定"}</p>
          <p>画像URL: {product.imageUrl || "なし"}</p>
        </div>

        {product.imageUrl ? (
          <div>
            <h3>商品画像</h3>
            <img
              src={product.imageUrl}
              alt={product.name}
              style={{
                width: "320px",
                maxWidth: "100%",
                border: "1px solid #e5e7eb",
                borderRadius: "12px",
                display: "block",
              }}
            />
          </div>
        ) : null}

        <div style={{ display: "flex", gap: "10px", marginTop: "20px", flexWrap: "wrap" }}>
          <Form method="post">
            <input type="hidden" name="intent" value="approve" />
            <input type="hidden" name="productId" value={product.id} />
            <button type="submit">承認する</button>
          </Form>

          <Form method="post">
            <input type="hidden" name="intent" value="reject" />
            <input type="hidden" name="productId" value={product.id} />
            <button type="submit">却下する</button>
          </Form>

          <Form method="post">
            <input type="hidden" name="intent" value="apply-price" />
            <input type="hidden" name="productId" value={product.id} />
            <button
              type="submit"
              style={{
                height: "40px",
                padding: "0 14px",
                borderRadius: "8px",
                border: "1px solid #2563eb",
                background: "#2563eb",
                color: "#fff",
                cursor: "pointer",
                fontWeight: 700,
              }}
            >
              価格更新
            </button>
          </Form>

          <a href="/admin/products">← 戻る</a>
        </div>
      </div>
    </div>
  );
}

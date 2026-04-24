import { resolveDutyCategory } from "../utils/dutyCategory";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import prisma from "../db.server";
import { calculateProductPriceResult } from "../utils/buildCalculatedPrice";
import { buildPriceSnapshot } from "../utils/priceSnapshot";
import {
  getAdminPriceSyncLabel,
  getEffectivePriceSyncStatus,
} from "../utils/priceSyncStatus";
import { getShopPricingSettings } from "../utils/shopPricingSettings";
import { shopifyGraphQLWithOfflineSession } from "../utils/shopifyAdmin.server";

const SHOPIFY_API_VERSION = "2026-01";

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
    },
  });

  if (!product) {
    throw new Response("商品が見つかりません", { status: 404 });
  }

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
      },
    });

    if (!product) {
      return json({ ok: false, error: "商品が見つかりません" }, { status: 404 });
    }

    if (intent === "apply-price") {
      if (!product.shopifyProductId) {
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
      const result = await applyProductPrice(product.shopifyProductId, {
        shopDomain: product.shopDomain,
        localProductId: product.id,
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
      if (product.shopifyProductId) {
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
          product.shopDomain,
          updateMutation,
          {
            input: {
              id: product.shopifyProductId,
              title: product.name,
              descriptionHtml: product.description || "",
              productType: product.category || "",
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

        return redirect(`/admin/products/${productId}`);
      }

      const result = await createShopifyProductFromDbProduct(product);

      await prisma.product.update({
        where: { id: productId },
        data: {
          approvalStatus: "approved",
          shopifyProductId: result.shopifyProductId,
          shopDomain: result.shopDomain,
        },
      });

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
              : typeof product.price === "number"
                ? `¥${product.price}`
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

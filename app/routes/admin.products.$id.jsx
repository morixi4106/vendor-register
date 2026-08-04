import { resolveDutyCategory } from "../utils/dutyCategory";
import { json, redirect } from "@remix-run/node";
import prisma from "../db.server";
import { calculateProductPriceResult } from "../utils/buildCalculatedPrice";
import { buildPriceSnapshot } from "../utils/priceSnapshot";
import { getAdminPriceSyncLabel, getEffectivePriceSyncStatus } from "../utils/priceSyncStatus";
import { getShopPricingSettings } from "../utils/shopPricingSettings";
import { saveProductCountryPolicy } from "../utils/productCountryPolicy.server";
import { resolveShopDomain } from "../utils/shopifyAdmin.server";
import { ensureApprovedProductPublished } from "../services/productPublication.server";
import { syncAndRecordShopifyVariantWeight } from "../services/shopifyInventoryWeight.server";
import { requireShopifyAdmin } from "../utils/routeSecurity.server.js";
import { SHOPIFY_API_VERSION } from "../utils/shopifyApiVersion.js";
import { buildConfirmedShippingProfileData, parseProductShippingProfileFormData } from "../utils/productShippingProfile";
import { SHOPIFY_PRODUCT_CREATE_IN_PROGRESS_STATUS, claimShopifyProductCreation, createShopifyProductFromDbProduct, findActiveCustomDeliveryTemplates, getPublicAdminActionErrorMessage, isMissingDeliveryTemplateTableError, isReconnectableShopifyError, parseCountryPolicyFormData, resetShopifyProductCreationClaim, resolveDeliveryPolicyTemplate, serializeCustomDeliveryTemplate, shopifyGraphQL, shouldShowInternalPriceDebug } from "../services/adminProductDetail.server.js";
import { PRODUCT_EU_STATUS_VALUES, getPublicShopifyReconnectNotice } from "../services/adminProductDetail.js";
export const loader = async ({
  params,
  request
}) => {
  await requireShopifyAdmin(request);
  const id = String(params.id || "");
  const showInternalPriceDebug = shouldShowInternalPriceDebug();
  if (!id) {
    throw new Response("IDがありません", {
      status: 400
    });
  }
  const product = await prisma.product.findUnique({
    where: {
      id
    },
    include: {
      vendorStore: true,
      countryPolicy: true
    }
  });
  if (!product) {
    throw new Response("商品が見つかりません", {
      status: 404
    });
  }
  const customDeliveryTemplates = await findActiveCustomDeliveryTemplates();
  let shopifyPrice = null;
  let needsReconnect = false;
  let rawShopifyError = null;
  let priceBreakdown = null;
  let previewPriceSnapshot = null;
  let priceCalculationState = {
    status: "calculable",
    reason: null
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
    shopDomain: reconnectShopDomain
  };
  let pricingSettings = {
    shopDomain: reconnectShopDomain
  };

  // Shopifyのglobal_pricingを読めれば使う。読めなくても表示は止めない
  try {
    pricingSettings = await getShopPricingSettings({
      shopDomain: product.shopDomain,
      apiVersion: SHOPIFY_API_VERSION
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
      const {
        data: shopifyData,
        shopDomain
      } = await shopifyGraphQL(product.shopDomain, `
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
        `, {
        id: product.shopifyProductId
      });
      shopifyPrice = shopifyData?.product?.variants?.nodes?.[0]?.price || null;
      reconnectShopDomain = reconnectShopDomain || shopDomain;
      previewPricingInput = {
        costAmount: shopifyData?.product?.costAmountMetafield?.value ?? previewPricingInput.costAmount,
        costCurrency: shopifyData?.product?.costCurrencyMetafield?.value ?? previewPricingInput.costCurrency,
        dutyCategory: shopifyData?.product?.dutyCategoryMetafield?.value ?? previewPricingInput.dutyCategory,
        shopDomain: reconnectShopDomain || shopDomain
      };
      usedShopifyPricingInput = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      rawShopifyError = message;
      if (isReconnectableShopifyError(message)) {
        needsReconnect = true;
      } else {
        throw error;
      }
    }
  }

  // Keep the price preview available when Shopify reconnect data is unavailable.
  const previewResult = await calculateProductPriceResult(previewPricingInput, {
    settings: pricingSettings,
    shopDomain: previewPricingInput.shopDomain
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
          pricingInput: usedShopifyPricingInput ? "shopify_product_metafields" : "local_product_fallback",
          shopSettings: usedShopifySettings ? "shopify_shop_metafields" : "default_pricing_settings",
          fxRate: "fx_rate_table"
        }
      });
    }
    reconnectShopDomain = reconnectShopDomain || priceResult.shopDomain;
  } else {
    priceCalculationState = {
      status: "invalid",
      reason: previewResult.error.message
    };
  }
  const effectivePriceSyncStatus = getEffectivePriceSyncStatus(product);
  const priceState = showInternalPriceDebug ? {
    syncStatus: effectivePriceSyncStatus,
    syncLabel: getAdminPriceSyncLabel(effectivePriceSyncStatus),
    syncError: product.priceSyncError || null,
    priceAppliedAt: product.priceAppliedAt || product.calculatedAt || null,
    lastPriceApplyAttemptAt: product.lastPriceApplyAttemptAt || null,
    calculationStatus: priceCalculationState.status,
    calculationReason: priceCalculationState.reason
  } : null;
  let priceApplyLogs = [];
  if (showInternalPriceDebug) {
    const directPriceApplyLogs = await prisma.productPriceApplyLog.findMany({
      where: {
        productId: product.id
      },
      orderBy: {
        attemptedAt: "desc"
      },
      take: 10
    });
    priceApplyLogs = directPriceApplyLogs;
    if (product.shopifyProductId) {
      const unresolvedPriceApplyLogs = await prisma.productPriceApplyLog.findMany({
        where: {
          productId: null,
          shopifyProductId: product.shopifyProductId,
          ...(product.shopDomain ? {
            OR: [{
              shopDomain: product.shopDomain
            }, {
              shopDomain: null
            }]
          } : {})
        },
        orderBy: {
          attemptedAt: "desc"
        },
        take: 10
      });
      priceApplyLogs = Array.from(new Map([...directPriceApplyLogs, ...unresolvedPriceApplyLogs].sort((a, b) => new Date(b.attemptedAt) - new Date(a.attemptedAt)).map(log => [log.id, log])).values()).slice(0, 10);
    }
  }
  return json({
    product,
    shopifyPrice,
    needsReconnect,
    shopifyNotice: needsReconnect ? getPublicShopifyReconnectNotice() : null,
    priceBreakdown,
    customDeliveryTemplates: customDeliveryTemplates.map(serializeCustomDeliveryTemplate),
    reconnectShopDomain,
    showInternalPriceDebug,
    priceDebug: showInternalPriceDebug ? {
      shopifyError: rawShopifyError,
      previewPriceSnapshot,
      priceState,
      priceApplyLogs
    } : null
  });
};
export const action = async ({
  request
}) => {
  await requireShopifyAdmin(request);
  try {
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "");
    const productId = String(formData.get("productId") || "");
    if (!productId) {
      return json({
        ok: false,
        error: "productId がありません"
      }, {
        status: 400
      });
    }
    const product = await prisma.product.findUnique({
      where: {
        id: productId
      },
      include: {
        vendorStore: true,
        countryPolicy: true,
        complianceProfile: true
      }
    });
    if (!product) {
      return json({
        ok: false,
        error: "商品が見つかりません"
      }, {
        status: 404
      });
    }
    if (intent === "save-shipping-profile") {
      const shippingProfile = parseProductShippingProfileFormData(formData, {
        variantCount: product.shopifyVariantCount ?? (product.shopifyVariantId ? 1 : null)
      });
      if (!shippingProfile.ok) {
        return json({
          ok: false,
          error: shippingProfile.error
        }, {
          status: 400
        });
      }
      let shopDomain = product.shopDomain;
      if (product.shopifyVariantId) {
        shopDomain = shopDomain || (await resolveShopDomain());
      }
      await prisma.product.update({
        where: {
          id: productId
        },
        data: {
          ...buildConfirmedShippingProfileData(shippingProfile.data, {
            isShopifyLinked: Boolean(product.shopifyVariantId)
          }),
          shopifyVariantCount: product.shopifyVariantCount ?? (product.shopifyVariantId ? 1 : null),
          ...(shopDomain ? {
            shopDomain
          } : {})
        }
      });
      if (product.shopifyVariantId) {
        await syncAndRecordShopifyVariantWeight({
          productId,
          shopDomain,
          variantId: product.shopifyVariantId,
          weightGrams: shippingProfile.data.shippingWeightGrams
        });
      }
      return redirect(`/admin/products/${productId}`);
    }
    if (intent === "apply-country-template") {
      const template = await resolveDeliveryPolicyTemplate(formData.get("countryPolicyTemplate"));
      if (!template) {
        return json({
          ok: false,
          error: "配送先テンプレートが不正です"
        }, {
          status: 400
        });
      }
      await prisma.$transaction(async tx => {
        await tx.product.update({
          where: {
            id: productId
          },
          data: {
            productEuStatus: template.productEuStatus,
            euSaleRequested: template.productEuStatus !== "DISABLED"
          }
        });
        await saveProductCountryPolicy({
          productId,
          productEuStatus: template.productEuStatus,
          policyInput: template,
          prismaClient: tx
        });
      });
      return redirect(`/admin/products/${productId}`);
    }
    if (intent === "save-country-template") {
      const templateName = String(formData.get("templateName") || "").trim();
      const templateDescription = String(formData.get("templateDescription") || "").trim();
      const productEuStatus = String(formData.get("productEuStatus") || "DISABLED").trim().toUpperCase();
      if (!templateName) {
        return json({
          ok: false,
          error: "テンプレート名を入力してください"
        }, {
          status: 400
        });
      }
      if (!PRODUCT_EU_STATUS_VALUES.has(productEuStatus)) {
        return json({
          ok: false,
          error: "EU販売ステータスが不正です"
        }, {
          status: 400
        });
      }
      const policyInput = parseCountryPolicyFormData(formData);
      try {
        await prisma.deliveryCountryPolicyTemplate.upsert({
          where: {
            name: templateName
          },
          create: {
            name: templateName,
            categoryName: templateName,
            description: templateDescription || null,
            productEuStatus,
            allowedCountries: policyInput.allowedCountries,
            blockedCountries: policyInput.blockedCountries,
            requiresWarningCountries: policyInput.requiresWarningCountries
          },
          update: {
            categoryName: templateName,
            description: templateDescription || null,
            productEuStatus,
            allowedCountries: policyInput.allowedCountries,
            blockedCountries: policyInput.blockedCountries,
            requiresWarningCountries: policyInput.requiresWarningCountries,
            isActive: true
          }
        });
      } catch (error) {
        if (isMissingDeliveryTemplateTableError(error)) {
          return json({
            ok: false,
            error: "配送先テンプレート用のDBマイグレーションがまだ反映されていません。Renderのpre-deployでマイグレーションを通してから再度保存してください。"
          }, {
            status: 500
          });
        }
        throw error;
      }
      return redirect(`/admin/products/${productId}`);
    }
    if (intent === "update-eu-policy") {
      const productEuStatus = String(formData.get("productEuStatus") || "DISABLED").trim().toUpperCase();
      if (!PRODUCT_EU_STATUS_VALUES.has(productEuStatus)) {
        return json({
          ok: false,
          error: "EU販売ステータスが不正です"
        }, {
          status: 400
        });
      }
      const policyInput = parseCountryPolicyFormData(formData);
      await prisma.$transaction(async tx => {
        await tx.product.update({
          where: {
            id: productId
          },
          data: {
            productEuStatus,
            euSaleRequested: productEuStatus !== "DISABLED"
          }
        });
        await saveProductCountryPolicy({
          productId,
          productEuStatus,
          policyInput,
          prismaClient: tx
        });
      });
      return redirect(`/admin/products/${productId}`);
    }
    let productWithResolvedShopDomain = product;
    if ((intent === "approve" || intent === "apply-price") && !product.shopDomain) {
      productWithResolvedShopDomain = {
        ...product,
        shopDomain: await resolveShopDomain()
      };
    }
    if (intent === "apply-price") {
      if (!productWithResolvedShopDomain.shopifyProductId) {
        return json({
          ok: false,
          error: "Shopify商品IDがありません"
        }, {
          status: 400
        });
      }
      const refreshRes = await fetch(`${new URL(request.url).origin}/api/refresh-fx`, {
        method: "POST"
      });
      const refreshData = await refreshRes.json();
      if (!refreshRes.ok || !refreshData?.ok) {
        return json({
          ok: false,
          error: refreshData?.error || "為替更新に失敗しました"
        }, {
          status: 500
        });
      }
      const {
        applyProductPrice
      } = await import("../utils/applyProductPrice.server");
      const result = await applyProductPrice(productWithResolvedShopDomain.shopifyProductId, {
        shopDomain: productWithResolvedShopDomain.shopDomain,
        localProductId: productWithResolvedShopDomain.id
      });
      return json({
        ok: true,
        message: `為替更新後に価格を更新しました（¥${result.oldPrice} → ¥${result.newPrice}）`,
        priceApplied: true,
        fxRates: refreshData.fxRates || [],
        result
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
        const {
          data: updateResult,
          shopDomain
        } = await shopifyGraphQL(productWithResolvedShopDomain.shopDomain, updateMutation, {
          input: {
            id: productWithResolvedShopDomain.shopifyProductId,
            title: productWithResolvedShopDomain.name,
            descriptionHtml: productWithResolvedShopDomain.description || "",
            productType: productWithResolvedShopDomain.category || "",
            status: "ACTIVE"
          }
        });
        const updatePayload = updateResult?.productUpdate;
        if (!updatePayload) {
          throw new Error("Shopify productUpdate response is empty");
        }
        if (updatePayload.userErrors?.length) {
          throw new Error(`productUpdate userErrors: ${JSON.stringify(updatePayload.userErrors)}`);
        }
        if (productWithResolvedShopDomain.shopifyVariantId && productWithResolvedShopDomain.shippingWeightGrams) {
          await syncAndRecordShopifyVariantWeight({
            productId,
            shopDomain,
            variantId: productWithResolvedShopDomain.shopifyVariantId,
            weightGrams: productWithResolvedShopDomain.shippingWeightGrams
          });
        }
        await prisma.product.update({
          where: {
            id: productId
          },
          data: {
            approvalStatus: "approved",
            shopDomain
          }
        });
        const {
          syncMarketplaceCheckoutPolicyForProduct
        } = await import("../services/marketplaceCheckoutGate.server.js");
        await syncMarketplaceCheckoutPolicyForProduct({
          localProductId: productId,
          shopDomain
        });
        await ensureApprovedProductPublished(productId);
        return redirect(`/admin/products/${productId}`);
      }
      const originalApprovalStatus = productWithResolvedShopDomain.approvalStatus || "pending";
      const claimedCreation = await claimShopifyProductCreation(productId);
      if (!claimedCreation) {
        const latestProduct = await prisma.product.findUnique({
          where: {
            id: productId
          },
          select: {
            approvalStatus: true,
            shopifyProductId: true,
            shopifyVariantId: true
          }
        });
        if (latestProduct?.shopifyProductId) {
          await prisma.product.update({
            where: {
              id: productId
            },
            data: {
              approvalStatus: "approved"
            }
          });
          await ensureApprovedProductPublished(productId);
        }
        return redirect(`/admin/products/${productId}`);
      }
      let result;
      try {
        result = await createShopifyProductFromDbProduct({
          ...productWithResolvedShopDomain,
          approvalStatus: SHOPIFY_PRODUCT_CREATE_IN_PROGRESS_STATUS
        });
      } catch (error) {
        await resetShopifyProductCreationClaim(productId, originalApprovalStatus);
        throw error;
      }
      await prisma.product.update({
        where: {
          id: productId
        },
        data: {
          approvalStatus: "approved",
          shopifyProductId: result.shopifyProductId,
          shopifyVariantId: result.shopifyVariantId,
          shopifyVariantCount: 1,
          shopDomain: result.shopDomain
        }
      });
      await ensureApprovedProductPublished(productId);
      return redirect(`/admin/products/${productId}`);
    }
    if (intent === "reject") {
      await prisma.product.update({
        where: {
          id: productId
        },
        data: {
          approvalStatus: "rejected"
        }
      });
      return redirect(`/admin/products/${productId}`);
    }
    return json({
      ok: false,
      error: "不明な intent です"
    }, {
      status: 400
    });
  } catch (error) {
    console.error("admin approve error:", error);
    const message = error instanceof Error ? error.message : "不明なエラーです";
    const needsReconnect = isReconnectableShopifyError(message);
    const showInternalPriceDebug = shouldShowInternalPriceDebug();
    return json({
      ok: false,
      error: showInternalPriceDebug ? message : getPublicAdminActionErrorMessage(needsReconnect),
      needsReconnect
    }, {
      status: 500
    });
  }
};
export { default } from "../components/products/AdminProductDetailPage.jsx";

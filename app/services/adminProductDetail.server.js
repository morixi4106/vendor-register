import { resolveDutyCategory } from "../utils/dutyCategory";
import prisma from "../db.server";
import { getDeliveryPolicyTemplateByKey, normalizeProductCountryPolicy, parseCountryCodeSelection } from "../utils/productCountryPolicy";
import { shopifyGraphQLWithOfflineSession } from "../utils/shopifyAdmin.server";
import { syncAndRecordShopifyVariantWeight } from "./shopifyInventoryWeight.server";
import { SHOPIFY_API_VERSION } from "../utils/shopifyApiVersion.js";
import { getPublicShopifyReconnectNotice } from "./adminProductDetail.js";
export const SHOPIFY_PRODUCT_CREATE_IN_PROGRESS_STATUS = "publishing";
const SHOPIFY_PRODUCT_CREATE_CLAIMABLE_STATUSES = ["pending", "review", "rejected", "approved"];
export function parseCountryPolicyFormData(formData) {
  return {
    allowedCountries: parseCountryCodeSelection(formData.getAll("allowedCountries")),
    blockedCountries: parseCountryCodeSelection(formData.getAll("blockedCountries")),
    requiresWarningCountries: parseCountryCodeSelection(formData.getAll("requiresWarningCountries"))
  };
}
function getCustomTemplateValue(template) {
  return `custom:${template.id}`;
}
export function serializeCustomDeliveryTemplate(template) {
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
    requiresWarningCountries: policy.requiresWarningCountries
  };
}
export function isMissingDeliveryTemplateTableError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return error?.code === "P2021" || message.includes("delivery_country_policy_templates") || message.includes("DeliveryCountryPolicyTemplate") || message.includes("relation") && message.includes("does not exist");
}
export async function findActiveCustomDeliveryTemplates() {
  try {
    return await prisma.deliveryCountryPolicyTemplate.findMany({
      where: {
        isActive: true
      },
      orderBy: {
        name: "asc"
      }
    });
  } catch (error) {
    if (isMissingDeliveryTemplateTableError(error)) {
      console.warn("delivery country policy template table is not ready; using preset templates only");
      return [];
    }
    throw error;
  }
}
export async function resolveDeliveryPolicyTemplate(templateValue) {
  const rawValue = String(templateValue || "");
  if (rawValue.startsWith("preset:")) {
    return getDeliveryPolicyTemplateByKey(rawValue.slice("preset:".length));
  }
  if (rawValue.startsWith("custom:")) {
    const templateId = rawValue.slice("custom:".length);
    try {
      return await prisma.deliveryCountryPolicyTemplate.findFirst({
        where: {
          id: templateId,
          isActive: true
        }
      });
    } catch (error) {
      if (isMissingDeliveryTemplateTableError(error)) {
        return null;
      }
      throw error;
    }
  }
  return getDeliveryPolicyTemplateByKey(rawValue);
}
export function isReconnectableShopifyError(message = "") {
  return message.includes("Shopify authentication is required") || message.includes("Invalid API key or access token") || message.includes("401") || message.includes("Offline session not found");
}
export function shouldShowInternalPriceDebug() {
  return process.env.NODE_ENV !== "production";
}
export function getPublicAdminActionErrorMessage(needsReconnect) {
  if (needsReconnect) {
    return getPublicShopifyReconnectNotice();
  }
  return "商品の処理に失敗しました。時間を置いて再度お試しください。";
}
export async function shopifyGraphQL(shopDomain, query, variables = {}) {
  return shopifyGraphQLWithOfflineSession({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query,
    variables
  });
}
export async function createShopifyProductFromDbProduct(product) {
  const {
    resolveMarketplaceCheckoutPolicy
  } = await import("../services/marketplaceCheckoutGate.server.js");
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
              inventoryItem { id }
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
  const metafields = [{
    namespace: "pricing",
    key: "cost_amount",
    type: "number_decimal",
    value: String(product.costAmount ?? product.price ?? 0)
  }, {
    namespace: "pricing",
    key: "cost_currency",
    type: "single_line_text_field",
    value: product.costCurrency || "JPY"
  }, {
    key: "marketplace_checkout_policy",
    type: "single_line_text_field",
    value: resolveMarketplaceCheckoutPolicy(product)
  }];
  if (dutyCategory) {
    metafields.push({
      namespace: "pricing",
      key: "duty_category",
      type: "single_line_text_field",
      value: dutyCategory
    });
  }
  const createVariables = {
    product: {
      title: product.name,
      descriptionHtml: product.description || "",
      vendor: product.vendorStore?.storeName || "Vendor",
      productType: product.category || "",
      status: "ACTIVE",
      metafields
    }
  };
  const {
    data: createResult,
    shopDomain
  } = await shopifyGraphQL(product.shopDomain, createMutation, createVariables);
  const createPayload = createResult?.productCreate;
  if (!createPayload) {
    throw new Error("Shopify productCreate response is empty");
  }
  if (createPayload.userErrors?.length) {
    throw new Error(`productCreate userErrors: ${JSON.stringify(createPayload.userErrors)}`);
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
    variants: [{
      id: createdVariant.id,
      inventoryPolicy: "DENY",
      price: String(product.costAmount ?? product.price ?? 0)
    }]
  };
  const {
    data: updateVariantResult
  } = await shopifyGraphQL(shopDomain, updateVariantMutation, updateVariantVariables);
  const updateVariantPayload = updateVariantResult?.productVariantsBulkUpdate;
  if (!updateVariantPayload) {
    throw new Error("Shopify productVariantsBulkUpdate response is empty");
  }
  if (updateVariantPayload.userErrors?.length) {
    throw new Error(`productVariantsBulkUpdate userErrors: ${JSON.stringify(updateVariantPayload.userErrors)}`);
  }
  if (product.shippingWeightGrams) {
    try {
      await syncAndRecordShopifyVariantWeight({
        productId: product.id,
        shopDomain,
        variantId: createdVariant.id,
        inventoryItemId: createdVariant.inventoryItem?.id || null,
        weightGrams: product.shippingWeightGrams
      });
    } catch (error) {
      console.error("Shopify weight sync after product creation failed:", error);
    }
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
      media: [{
        alt: product.name || "Product image",
        mediaContentType: "IMAGE",
        originalSource: product.imageUrl
      }]
    };
    const {
      data: createMediaResult
    } = await shopifyGraphQL(shopDomain, createMediaMutation, createMediaVariables);
    const createMediaPayload = createMediaResult?.productCreateMedia;
    if (!createMediaPayload) {
      throw new Error("Shopify productCreateMedia response is empty");
    }
    if (createMediaPayload.mediaUserErrors?.length) {
      throw new Error(`productCreateMedia mediaUserErrors: ${JSON.stringify(createMediaPayload.mediaUserErrors)}`);
    }
  }
  const {
    applyProductPrice
  } = await import("../utils/applyProductPrice.server");
  await applyProductPrice(createdProduct.id, {
    shopDomain,
    localProductId: product.id
  });
  return {
    shopifyProductId: createdProduct.id,
    shopifyVariantId: createdVariant.id,
    shopDomain
  };
}
export async function claimShopifyProductCreation(productId) {
  const result = await prisma.product.updateMany({
    where: {
      id: productId,
      shopifyProductId: null,
      approvalStatus: {
        in: SHOPIFY_PRODUCT_CREATE_CLAIMABLE_STATUSES
      }
    },
    data: {
      approvalStatus: SHOPIFY_PRODUCT_CREATE_IN_PROGRESS_STATUS
    }
  });
  return result.count === 1;
}
export async function resetShopifyProductCreationClaim(productId, approvalStatus) {
  await prisma.product.updateMany({
    where: {
      id: productId,
      shopifyProductId: null,
      approvalStatus: SHOPIFY_PRODUCT_CREATE_IN_PROGRESS_STATUS
    },
    data: {
      approvalStatus: approvalStatus || "pending"
    }
  });
}

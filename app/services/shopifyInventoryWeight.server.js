import { shopifyGraphQLWithOfflineSession } from "../utils/shopifyAdmin.server.js";
import { SHOPIFY_API_VERSION } from "../utils/shopifyApiVersion.js";
import prisma from "../db.server.js";
import { SHOPIFY_WEIGHT_SYNC_STATUS } from "../utils/productShippingProfile.js";

function normalizePositiveInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

export async function syncShopifyVariantWeight({
  shopDomain,
  variantId,
  weightGrams,
  inventoryItemId = null,
  graphQL = shopifyGraphQLWithOfflineSession,
} = {}) {
  const normalizedWeight = normalizePositiveInteger(weightGrams);

  if (!shopDomain || !variantId || !normalizedWeight) {
    return { ok: false, reason: "missing_weight_sync_input" };
  }

  let resolvedInventoryItemId = inventoryItemId;

  if (!resolvedInventoryItemId) {
    const { data } = await graphQL({
      shopDomain,
      apiVersion: SHOPIFY_API_VERSION,
      query: `#graphql
        query ProductVariantInventoryItem($id: ID!) {
          productVariant(id: $id) {
            inventoryItem { id }
          }
        }
      `,
      variables: { id: variantId },
    });
    resolvedInventoryItemId = data?.productVariant?.inventoryItem?.id || null;
  }

  if (!resolvedInventoryItemId) {
    return { ok: false, reason: "shopify_inventory_item_not_found" };
  }

  const { data } = await graphQL({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: `#graphql
      mutation UpdateInventoryItemWeight($id: ID!, $input: InventoryItemInput!) {
        inventoryItemUpdate(id: $id, input: $input) {
          inventoryItem {
            id
            measurement { weight { value unit } }
          }
          userErrors { field message }
        }
      }
    `,
    variables: {
      id: resolvedInventoryItemId,
      input: {
        requiresShipping: true,
        measurement: {
          weight: {
            value: normalizedWeight,
            unit: "GRAMS",
          },
        },
      },
    },
  });
  const payload = data?.inventoryItemUpdate;
  const errors = payload?.userErrors || [];

  if (!payload || errors.length > 0) {
    throw new Error(
      `inventoryItemUpdate userErrors: ${JSON.stringify(errors)}`,
    );
  }

  return {
    ok: true,
    inventoryItemId: resolvedInventoryItemId,
    weightGrams: normalizedWeight,
  };
}

export async function syncAndRecordShopifyVariantWeight({
  productId,
  shopDomain,
  variantId,
  weightGrams,
  inventoryItemId = null,
  prismaClient = prisma,
  graphQL = shopifyGraphQLWithOfflineSession,
} = {}) {
  if (!productId) {
    throw new Error("productId is required to record Shopify weight sync");
  }

  try {
    const result = await syncShopifyVariantWeight({
      shopDomain,
      variantId,
      weightGrams,
      inventoryItemId,
      graphQL,
    });

    if (!result.ok) {
      throw new Error(result.reason || "shopify_weight_sync_failed");
    }

    const syncedAt = new Date();
    await prismaClient.product.update({
      where: { id: productId },
      data: {
        shopifyWeightSyncStatus: SHOPIFY_WEIGHT_SYNC_STATUS.SYNCED,
        shopifyWeightSyncedAt: syncedAt,
        shopifyWeightSyncError: null,
      },
    });

    return { ...result, syncedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prismaClient.product.update({
      where: { id: productId },
      data: {
        shopifyWeightSyncStatus: SHOPIFY_WEIGHT_SYNC_STATUS.ERROR,
        shopifyWeightSyncError: message.slice(0, 1000),
      },
    });
    throw error;
  }
}

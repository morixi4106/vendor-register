import prisma from "../db.server.js";
import {
  normalizeShopDomain,
  shopifyGraphQLWithOfflineSession,
} from "../utils/shopifyAdmin.server.js";
import {
  SHIPPING_WEIGHT_SOURCE,
  SHOPIFY_WEIGHT_SYNC_STATUS,
} from "../utils/productShippingProfile.js";

import { SHOPIFY_API_VERSION } from "../utils/shopifyApiVersion.js";
const DIRECT_IMPORT_FORMULA_VERSION = "shopify_direct_import_v1";
const RESOLVED_ISSUE_STATUS = "resolved";
const UNRESOLVED_ISSUE_STATUS = "unresolved";
const DEFAULT_PLATFORM_VENDOR_LABEL = "Oja Immanuel Bacchus";

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeShopifyGid(type, value) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return null;
  }

  if (normalized.startsWith(`gid://shopify/${type}/`)) {
    return normalized;
  }

  const numericId = normalized.match(/\d+/)?.[0];
  return numericId ? `gid://shopify/${type}/${numericId}` : null;
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseTags(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean);
  }

  return String(value || "")
    .split(",")
    .map(normalizeText)
    .filter(Boolean);
}

function getExplicitStoreReference(payload) {
  for (const tag of parseTags(payload?.tags)) {
    const match = tag.match(/^vendor[-_]store[-_]id\s*:\s*(.+)$/i);
    if (match?.[1]) {
      return normalizeText(match[1]);
    }
  }

  return null;
}

function getVariants(payload) {
  if (Array.isArray(payload?.variants)) {
    return payload.variants;
  }

  if (Array.isArray(payload?.variants?.nodes)) {
    return payload.variants.nodes;
  }

  return [];
}

function getPrimaryVariant(payload) {
  const variants = getVariants(payload);
  return variants.length === 1 ? variants[0] : null;
}

function getVariantPrice(payload) {
  const variant = getVariants(payload)[0];
  const amount = Number(variant?.price ?? payload?.price);

  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  return Math.round(amount);
}

function getInventoryQuantity(payload) {
  const quantities = getVariants(payload)
    .map((variant) => Number(variant?.inventory_quantity ?? variant?.inventoryQuantity))
    .filter(Number.isFinite);

  if (quantities.length === 0) {
    return null;
  }

  return quantities.reduce((total, quantity) => total + Math.trunc(quantity), 0);
}

function convertWeightToGrams(value, unit) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  switch (String(unit || "GRAMS").trim().toUpperCase()) {
    case "KILOGRAMS":
    case "KG":
      return Math.ceil(numeric * 1000);
    case "OUNCES":
    case "OZ":
      return Math.ceil(numeric * 28.349523125);
    case "POUNDS":
    case "LB":
    case "LBS":
      return Math.ceil(numeric * 453.59237);
    default:
      return Math.ceil(numeric);
  }
}

function getShippingWeightGrams(payload) {
  const variant = getPrimaryVariant(payload);
  const directGrams = Number(variant?.grams);

  if (Number.isFinite(directGrams) && directGrams > 0) {
    return Math.ceil(directGrams);
  }

  const measurementWeight = variant?.inventoryItem?.measurement?.weight;
  if (measurementWeight) {
    return convertWeightToGrams(measurementWeight.value, measurementWeight.unit);
  }

  return convertWeightToGrams(
    variant?.weight,
    variant?.weight_unit || variant?.weightUnit,
  );
}

function getImageUrl(payload) {
  return normalizeText(
    payload?.image?.src ||
      payload?.featuredMedia?.preview?.image?.url ||
      payload?.images?.[0]?.src ||
      payload?.images?.nodes?.[0]?.url,
  );
}

function getApprovalStatus(payload) {
  const status = String(payload?.status || "").trim().toLowerCase();

  if (status === "active") return "approved";
  if (status === "archived") return "rejected";
  return "pending";
}

export function createShopifyProductSnapshot(payload) {
  const productId = normalizeShopifyGid(
    "Product",
    payload?.admin_graphql_api_id || payload?.id,
  );
  const variant = getPrimaryVariant(payload);

  return {
    id: productId,
    title: normalizeText(payload?.title),
    description: stripHtml(payload?.body_html ?? payload?.descriptionHtml),
    vendor: normalizeText(payload?.vendor),
    productType: normalizeText(payload?.product_type ?? payload?.productType),
    status: normalizeText(payload?.status),
    tags: parseTags(payload?.tags),
    imageUrl: getImageUrl(payload),
    price: getVariantPrice(payload),
    inventoryQuantity: getInventoryQuantity(payload),
    shippingWeightGrams: getShippingWeightGrams(payload),
    variantId: normalizeShopifyGid(
      "ProductVariant",
      variant?.admin_graphql_api_id || variant?.id,
    ),
    variantCount: getVariants(payload).length,
  };
}

function uniqueStores(stores) {
  return Array.from(
    new Map(stores.filter(Boolean).map((store) => [store.id, store])).values(),
  );
}

export async function resolveVendorStoreForShopifyProduct(
  payload,
  {
    prismaClient = prisma,
    vendorStoreIdOverride = null,
    platformVendorLabel = process.env.SHOPIFY_PLATFORM_VENDOR_LABEL,
  } = {},
) {
  const explicitStoreId =
    normalizeText(vendorStoreIdOverride) || getExplicitStoreReference(payload);

  if (explicitStoreId) {
    const store = await prismaClient.vendorStore.findUnique({
      where: { id: explicitStoreId },
      select: { id: true, storeName: true, isPlatformStore: true },
    });

    return store
      ? { ok: true, store, source: "explicit_store_id" }
      : {
          ok: false,
          reason: "explicit_store_not_found",
          candidateStores: [],
        };
  }

  const vendorLabel = normalizeText(payload?.vendor);
  if (!vendorLabel) {
    return { ok: false, reason: "vendor_label_missing", candidateStores: [] };
  }

  const normalizedPlatformVendorLabel =
    normalizeText(platformVendorLabel) || DEFAULT_PLATFORM_VENDOR_LABEL;
  if (
    vendorLabel.localeCompare(normalizedPlatformVendorLabel, undefined, {
      sensitivity: "accent",
    }) === 0
  ) {
    const platformStore = await prismaClient.vendorStore.findFirst({
      where: { isPlatformStore: true },
      select: { id: true, storeName: true, isPlatformStore: true },
    });

    return platformStore
      ? { ok: true, store: platformStore, source: "platform_vendor_label" }
      : {
          ok: false,
          reason: "platform_store_not_configured",
          candidateStores: [],
        };
  }

  const [vendors, stores] = await Promise.all([
    prismaClient.vendor.findMany({
      where: {
        OR: [
          { handle: { equals: vendorLabel, mode: "insensitive" } },
          { storeName: { equals: vendorLabel, mode: "insensitive" } },
        ],
      },
      select: {
        vendorStore: {
          select: { id: true, storeName: true, isPlatformStore: true },
        },
      },
    }),
    prismaClient.vendorStore.findMany({
      where: { storeName: { equals: vendorLabel, mode: "insensitive" } },
      select: { id: true, storeName: true, isPlatformStore: true },
    }),
  ]);
  const candidateStores = uniqueStores([
    ...vendors.map((vendor) => vendor.vendorStore),
    ...stores,
  ]);

  if (candidateStores.length === 1) {
    return { ok: true, store: candidateStores[0], source: "vendor_label" };
  }

  return {
    ok: false,
    reason:
      candidateStores.length > 1
        ? "vendor_label_ambiguous"
        : "vendor_label_not_found",
    candidateStores,
  };
}

async function findExistingProduct(prismaClient, shopDomain, snapshot) {
  const productIdCandidates = [
    snapshot.id,
    snapshot.id?.replace("gid://shopify/Product/", ""),
  ].filter(Boolean);

  return prismaClient.product.findFirst({
    where: {
      shopifyProductId: { in: productIdCandidates },
      OR: [{ shopDomain }, { shopDomain: null }],
    },
    include: {
      vendorStore: {
        select: { id: true, isPlatformStore: true },
      },
    },
  });
}

async function recordSyncIssue({
  prismaClient,
  shopDomain,
  snapshot,
  payload,
  reason,
  candidateStores = [],
}) {
  return prismaClient.shopifyProductSyncIssue.upsert({
    where: {
      shopDomain_shopifyProductId: {
        shopDomain,
        shopifyProductId: snapshot.id,
      },
    },
    create: {
      shopDomain,
      shopifyProductId: snapshot.id,
      productTitle: snapshot.title,
      vendorLabel: snapshot.vendor,
      status: UNRESOLVED_ISSUE_STATUS,
      reason,
      candidateStoreIdsJson: candidateStores.map((store) => store.id),
      payloadJson: payload,
      lastAttemptAt: new Date(),
    },
    update: {
      productTitle: snapshot.title,
      vendorLabel: snapshot.vendor,
      status: UNRESOLVED_ISSUE_STATUS,
      reason,
      candidateStoreIdsJson: candidateStores.map((store) => store.id),
      payloadJson: payload,
      resolvedVendorStoreId: null,
      localProductId: null,
      resolvedAt: null,
      lastAttemptAt: new Date(),
    },
  });
}

export async function recordShopifyProductPolicySyncFailure(
  {
    payload,
    shopDomain: rawShopDomain,
    localProductId,
    vendorStoreId,
    reason = "marketplace_checkout_policy_sync_failed",
  },
  { prismaClient = prisma } = {},
) {
  const shopDomain = normalizeShopDomain(rawShopDomain);
  const snapshot = createShopifyProductSnapshot(payload);

  if (!shopDomain || !snapshot.id) {
    throw new Error("invalid_shopify_product_identity");
  }

  return prismaClient.shopifyProductSyncIssue.upsert({
    where: {
      shopDomain_shopifyProductId: {
        shopDomain,
        shopifyProductId: snapshot.id,
      },
    },
    create: {
      shopDomain,
      shopifyProductId: snapshot.id,
      productTitle: snapshot.title,
      vendorLabel: snapshot.vendor,
      status: UNRESOLVED_ISSUE_STATUS,
      reason,
      candidateStoreIdsJson: [],
      payloadJson: payload,
      resolvedVendorStoreId: vendorStoreId || null,
      localProductId: localProductId || null,
      lastAttemptAt: new Date(),
    },
    update: {
      productTitle: snapshot.title,
      vendorLabel: snapshot.vendor,
      status: UNRESOLVED_ISSUE_STATUS,
      reason,
      candidateStoreIdsJson: [],
      payloadJson: payload,
      resolvedVendorStoreId: vendorStoreId || null,
      localProductId: localProductId || null,
      resolvedAt: null,
      lastAttemptAt: new Date(),
    },
  });
}

async function resolveSyncIssue({
  prismaClient,
  shopDomain,
  snapshot,
  payload,
  vendorStoreId,
  localProductId,
}) {
  return prismaClient.shopifyProductSyncIssue.upsert({
    where: {
      shopDomain_shopifyProductId: {
        shopDomain,
        shopifyProductId: snapshot.id,
      },
    },
    create: {
      shopDomain,
      shopifyProductId: snapshot.id,
      productTitle: snapshot.title,
      vendorLabel: snapshot.vendor,
      status: RESOLVED_ISSUE_STATUS,
      reason: "synced",
      payloadJson: payload,
      resolvedVendorStoreId: vendorStoreId,
      localProductId,
      lastAttemptAt: new Date(),
      resolvedAt: new Date(),
    },
    update: {
      productTitle: snapshot.title,
      vendorLabel: snapshot.vendor,
      status: RESOLVED_ISSUE_STATUS,
      reason: "synced",
      payloadJson: payload,
      resolvedVendorStoreId: vendorStoreId,
      localProductId,
      resolvedAt: new Date(),
      lastAttemptAt: new Date(),
    },
  });
}

export async function syncShopifyProductPayload(
  payload,
  {
    prismaClient = prisma,
    shopDomain: rawShopDomain,
    vendorStoreIdOverride = null,
  } = {},
) {
  const shopDomain = normalizeShopDomain(rawShopDomain);
  const snapshot = createShopifyProductSnapshot(payload);

  if (!shopDomain || !snapshot.id) {
    return { ok: false, reason: "invalid_shopify_product_identity" };
  }

  const existingProduct = await findExistingProduct(
    prismaClient,
    shopDomain,
    snapshot,
  );

  if (existingProduct) {
    const isPlatformProduct = Boolean(
      existingProduct.vendorStore?.isPlatformStore,
    );
    const now = new Date();
    const updateData = {
      name: snapshot.title || existingProduct.name,
      description: snapshot.description || existingProduct.description,
      imageUrl: snapshot.imageUrl || existingProduct.imageUrl,
      category: snapshot.productType || existingProduct.category,
      shopifyProductId: snapshot.id,
      shopifyVariantId: snapshot.variantId || existingProduct.shopifyVariantId,
      shopifyVariantCount: snapshot.variantCount,
      shopDomain,
    };

    if (isPlatformProduct && snapshot.price != null) {
      Object.assign(updateData, {
        price: snapshot.price,
        calculatedPrice: snapshot.price,
        calculatedAt: now,
        approvalStatus: getApprovalStatus(payload),
        priceSyncStatus: "applied",
        priceSyncError: null,
        priceAppliedAt: now,
        priceFormulaVersion: DIRECT_IMPORT_FORMULA_VERSION,
        priceSnapshotJson: {
          source: "shopify_admin_platform_product",
          shopifyPrice: snapshot.price,
          vendorLabel: snapshot.vendor,
          variantCount: snapshot.variantCount,
          syncedAt: now.toISOString(),
        },
      });
    }

    if (snapshot.inventoryQuantity != null) {
      updateData.inventoryQuantity = snapshot.inventoryQuantity;
      updateData.inventorySyncedAt = new Date();
      updateData.inventorySyncError = null;
    }

    if (snapshot.shippingWeightGrams != null) {
      const currentWeight = Number(existingProduct.shippingWeightGrams);
      const hasCurrentWeight = Number.isInteger(currentWeight) && currentWeight > 0;
      const weightChanged =
        hasCurrentWeight && currentWeight !== snapshot.shippingWeightGrams;

      updateData.shippingWeightGrams = snapshot.shippingWeightGrams;
      if (!hasCurrentWeight || weightChanged) {
        updateData.shippingWeightConfirmedAt = null;
        updateData.shippingWeightSource = SHIPPING_WEIGHT_SOURCE.SHOPIFY_UNVERIFIED;
        updateData.shopifyWeightSyncStatus = weightChanged
          ? SHOPIFY_WEIGHT_SYNC_STATUS.EXTERNAL_CHANGE
          : SHOPIFY_WEIGHT_SYNC_STATUS.UNVERIFIED;
        updateData.shopifyWeightSyncedAt = null;
        updateData.shopifyWeightSyncError = weightChanged
          ? "Shopifyで重量が変更されたため、梱包後重量の再確認が必要です。"
          : null;
      }
    }

    const product = await prismaClient.product.update({
      where: { id: existingProduct.id },
      data: updateData,
    });

    await resolveSyncIssue({
      prismaClient,
      shopDomain,
      snapshot,
      payload,
      vendorStoreId: product.vendorStoreId,
      localProductId: product.id,
    });

    return { ok: true, created: false, product, source: "existing_mapping" };
  }

  const storeResolution = await resolveVendorStoreForShopifyProduct(payload, {
    prismaClient,
    vendorStoreIdOverride,
  });

  if (!storeResolution.ok) {
    const issue = await recordSyncIssue({
      prismaClient,
      shopDomain,
      snapshot,
      payload,
      reason: storeResolution.reason,
      candidateStores: storeResolution.candidateStores,
    });

    return { ok: false, reason: storeResolution.reason, issue };
  }

  if (snapshot.price == null) {
    const issue = await recordSyncIssue({
      prismaClient,
      shopDomain,
      snapshot,
      payload,
      reason: "shopify_price_missing",
    });
    return { ok: false, reason: "shopify_price_missing", issue };
  }

  const currencyCode = String(
    process.env.SHOPIFY_STORE_CURRENCY || "JPY",
  ).toUpperCase();
  const now = new Date();
  const isPlatformProduct = Boolean(storeResolution.store.isPlatformStore);
  const product = await prismaClient.product.create({
    data: {
      name: snapshot.title || "Shopify商品",
      description: snapshot.description || null,
      imageUrl: snapshot.imageUrl,
      category: snapshot.productType,
      price: snapshot.price,
      costAmount: isPlatformProduct ? null : snapshot.price,
      costCurrency: currencyCode,
      vendorStoreId: storeResolution.store.id,
      approvalStatus: getApprovalStatus(payload),
      shopifyProductId: snapshot.id,
      shopifyVariantId: snapshot.variantId,
      shopDomain,
      calculatedPrice: snapshot.price,
      calculatedAt: now,
      priceSyncStatus: "applied",
      priceAppliedAt: now,
      priceFormulaVersion: DIRECT_IMPORT_FORMULA_VERSION,
      priceSnapshotJson: {
        source: isPlatformProduct
          ? "shopify_admin_platform_product"
          : "shopify_admin",
        shopifyPrice: snapshot.price,
        vendorLabel: snapshot.vendor,
        variantCount: snapshot.variantCount,
        importedAt: now.toISOString(),
      },
      inventoryQuantity: snapshot.inventoryQuantity,
      inventorySyncedAt:
        snapshot.inventoryQuantity == null ? null : now,
      inventorySyncError: null,
      shippingWeightGrams: snapshot.shippingWeightGrams,
      shippingWeightConfirmedAt: null,
      shippingWeightSource: snapshot.shippingWeightGrams
        ? SHIPPING_WEIGHT_SOURCE.SHOPIFY_UNVERIFIED
        : SHIPPING_WEIGHT_SOURCE.UNSET,
      shopifyVariantCount: snapshot.variantCount,
      shopifyWeightSyncStatus: snapshot.shippingWeightGrams
        ? SHOPIFY_WEIGHT_SYNC_STATUS.UNVERIFIED
        : SHOPIFY_WEIGHT_SYNC_STATUS.NOT_LINKED,
      internationalShippingMethod: "UNCONFIGURED",
    },
  });

  await resolveSyncIssue({
    prismaClient,
    shopDomain,
    snapshot,
    payload,
    vendorStoreId: product.vendorStoreId,
    localProductId: product.id,
  });

  return {
    ok: true,
    created: true,
    product,
    source: storeResolution.source,
  };
}

function graphQlProductToPayload(product) {
  return {
    id: product.id,
    admin_graphql_api_id: product.id,
    title: product.title,
    body_html: product.descriptionHtml,
    vendor: product.vendor,
    product_type: product.productType,
    status: product.status,
    tags: product.tags,
    image: product.featuredMedia?.preview?.image
      ? { src: product.featuredMedia.preview.image.url }
      : null,
    variants: (product.variants?.nodes || []).map((variant) => ({
      id: variant.id,
      admin_graphql_api_id: variant.id,
      price: variant.price,
      inventory_quantity: variant.inventoryQuantity,
      inventoryItem: variant.inventoryItem,
    })),
  };
}

export async function reconcileShopifyProductCatalog(
  shopDomain,
  {
    prismaClient = prisma,
    graphQL = shopifyGraphQLWithOfflineSession,
    limit = 250,
  } = {},
) {
  const normalizedShopDomain = normalizeShopDomain(shopDomain);
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 250, 10000));
  const results = [];
  let cursor = null;
  let hasNextPage = true;
  let pageCount = 0;

  while (hasNextPage && results.length < normalizedLimit) {
    pageCount += 1;
    const first = Math.min(100, normalizedLimit - results.length);
    const { data } = await graphQL({
      shopDomain: normalizedShopDomain,
      apiVersion: SHOPIFY_API_VERSION,
      query: `
        query ProductCatalogForVendorSync($first: Int!, $after: String) {
          products(first: $first, after: $after, sortKey: UPDATED_AT) {
            nodes {
              id
              title
              descriptionHtml
              vendor
              productType
              status
              tags
              featuredMedia {
                preview { image { url } }
              }
              variants(first: 100) {
                nodes {
                  id
                  price
                  inventoryQuantity
                  inventoryItem {
                    measurement { weight { value unit } }
                  }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `,
      variables: { first, after: cursor },
    });
    const connection = data?.products;

    for (const product of connection?.nodes || []) {
      results.push(
        await syncShopifyProductPayload(graphQlProductToPayload(product), {
          prismaClient,
          shopDomain: normalizedShopDomain,
        }),
      );
    }

    hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
    cursor = connection?.pageInfo?.endCursor || null;
    if (!cursor) hasNextPage = false;
  }

  return {
    ok: !hasNextPage,
    complete: !hasNextPage,
    incompleteReason: hasNextPage ? "catalog_scan_limit_reached" : null,
    nextCursor: hasNextPage ? cursor : null,
    pageCount,
    scanned: results.length,
    created: results.filter((result) => result.ok && result.created).length,
    updated: results.filter((result) => result.ok && !result.created).length,
    unresolved: results.filter((result) => !result.ok).length,
    results,
  };
}

export async function resolveShopifyProductSyncIssue(
  { issueId, vendorStoreId },
  { prismaClient = prisma } = {},
) {
  const issue = await prismaClient.shopifyProductSyncIssue.findUnique({
    where: { id: issueId },
  });

  if (!issue) {
    return { ok: false, reason: "sync_issue_not_found" };
  }

  return syncShopifyProductPayload(issue.payloadJson, {
    prismaClient,
    shopDomain: issue.shopDomain,
    vendorStoreIdOverride: vendorStoreId,
  });
}

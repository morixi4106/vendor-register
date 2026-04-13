import prisma from '../db.server.js';
import { calculateProductPrice } from './buildCalculatedPrice.js';
import {
  buildPriceSnapshot,
  buildPriceSnapshotUpdate,
  PRICE_FORMULA_VERSION,
} from './priceSnapshot.js';
import {
  normalizePriceSyncFailure,
  PRICE_SYNC_STATUS,
} from './priceSyncStatus.js';
import {
  normalizeShopDomain,
  shopifyGraphQLWithOfflineSession,
} from './shopifyAdmin.server.js';

const API_VERSION = '2026-04';
const PRICE_APPLY_LOG_STATUS = {
  SUCCESS: 'success',
  INVALID: PRICE_SYNC_STATUS.INVALID,
  APPLY_FAILED: PRICE_SYNC_STATUS.APPLY_FAILED,
};

function resolveLinkedProductContext(
  linkedProducts,
  requestedShopDomain,
  normalizeShopDomainImpl = normalizeShopDomain,
) {
  const normalizedRequestedShopDomain = normalizeShopDomainImpl(requestedShopDomain);
  const productsByKnownShop = new Map();

  for (const linkedProduct of linkedProducts) {
    const linkedShopDomain = normalizeShopDomainImpl(linkedProduct.shopDomain);

    if (!linkedShopDomain) {
      continue;
    }

    const current = productsByKnownShop.get(linkedShopDomain) || [];
    current.push(linkedProduct);
    productsByKnownShop.set(linkedShopDomain, current);
  }

  if (productsByKnownShop.size === 1) {
    const [shopDomain, products] = Array.from(productsByKnownShop.entries())[0];

    if (products.length !== 1) {
      throw new Error('Local product linkage is duplicated for this Shopify product');
    }

    return {
      linkedProduct: products[0],
      preferredShopDomain: shopDomain,
    };
  }

  if (productsByKnownShop.size > 1) {
    if (!normalizedRequestedShopDomain) {
      throw new Error('Shop context is ambiguous for this product');
    }

    const matchedProducts = productsByKnownShop.get(normalizedRequestedShopDomain) || [];

    if (matchedProducts.length !== 1) {
      throw new Error('Shop context is ambiguous for this product');
    }

    return {
      linkedProduct: matchedProducts[0],
      preferredShopDomain: normalizedRequestedShopDomain,
    };
  }

  if (linkedProducts.length === 1) {
    return {
      linkedProduct: linkedProducts[0],
      preferredShopDomain: normalizedRequestedShopDomain,
    };
  }

  if (linkedProducts.length > 1 && normalizedRequestedShopDomain) {
    return {
      linkedProduct: null,
      preferredShopDomain: normalizedRequestedShopDomain,
    };
  }

  return {
    linkedProduct: linkedProducts[0] || null,
    preferredShopDomain: normalizedRequestedShopDomain,
  };
}

function getBackfillTarget(
  linkedProducts,
  linkedProduct,
  normalizeShopDomainImpl = normalizeShopDomain,
) {
  if (linkedProduct && !normalizeShopDomainImpl(linkedProduct.shopDomain)) {
    return linkedProduct;
  }

  const productsWithoutShop = linkedProducts.filter(
    (product) => !normalizeShopDomainImpl(product.shopDomain),
  );

  return productsWithoutShop.length === 1 ? productsWithoutShop[0] : null;
}

async function resolveSnapshotTarget({
  shopifyProductId,
  linkedProducts,
  linkedProduct,
  localProductId,
}, prismaClient = prisma) {
  if (localProductId) {
    const localProduct = await prismaClient.product.findUnique({
      where: { id: localProductId },
      select: {
        id: true,
        shopDomain: true,
        shopifyProductId: true,
      },
    });

    if (!localProduct) {
      throw new Error('Local product not found for snapshot persistence');
    }

    if (localProduct.shopifyProductId && localProduct.shopifyProductId !== shopifyProductId) {
      throw new Error('Local product does not match the requested Shopify product');
    }

    return localProduct;
  }

  if (linkedProduct) {
    return linkedProduct;
  }

  const backfillTarget = getBackfillTarget(linkedProducts, linkedProduct);

  if (backfillTarget) {
    return backfillTarget;
  }

  return linkedProducts.length === 1 ? linkedProducts[0] : null;
}

function buildPriceApplyLogData({
  attemptedAt,
  status,
  productId,
  shopifyProductId,
  shopDomain,
  attemptedPrice,
  priceFormulaVersion,
  errorSummary,
  priceSnapshot,
}, normalizeShopDomainImpl = normalizeShopDomain) {
  return {
    productId: productId || null,
    shopifyProductId: shopifyProductId || null,
    shopDomain: normalizeShopDomainImpl(shopDomain),
    attemptedPrice:
      attemptedPrice != null && Number.isFinite(Number(attemptedPrice))
        ? Number(attemptedPrice)
        : null,
    priceFormulaVersion: priceFormulaVersion || PRICE_FORMULA_VERSION,
    status,
    errorSummary: errorSummary || null,
    priceSnapshotJson: priceSnapshot || null,
    attemptedAt,
  };
}

async function createPriceApplyLog(prismaClient, logData) {
  try {
    await prismaClient.productPriceApplyLog.create({
      data: logData,
    });
  } catch (error) {
    console.error('price apply log create error:', error);
  }
}

async function resolvePriceApplyLogProductId(
  prismaClient,
  { snapshotTarget, linkedProduct, localProductId },
) {
  if (snapshotTarget?.id) {
    return snapshotTarget.id;
  }

  if (linkedProduct?.id) {
    return linkedProduct.id;
  }

  if (!localProductId) {
    return null;
  }

  const localProduct = await prismaClient.product.findUnique({
    where: { id: localProductId },
    select: { id: true },
  });

  return localProduct?.id || null;
}

export function createApplyCalculatedPriceToShopify({
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
} = {}) {
  return async function applyCalculatedPriceToShopifyImpl({
    shopDomain,
    productId,
    variantId,
    finalPrice,
    apiVersion = API_VERSION,
  }) {
    const mutation = `
      mutation UpdateVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          product { id }
          productVariants { id price }
          userErrors { field message }
        }
      }
    `;

    const { data } = await shopifyGraphQLWithOfflineSessionImpl({
      shopDomain,
      apiVersion,
      query: mutation,
      variables: {
        productId,
        variants: [
          {
            id: variantId,
            price: String(finalPrice),
          },
        ],
      },
    });

    return data?.productVariantsBulkUpdate;
  };
}

export const applyCalculatedPriceToShopify = createApplyCalculatedPriceToShopify();

export function createApplyProductPrice({
  prismaClient = prisma,
  calculateProductPriceImpl = calculateProductPrice,
  buildPriceSnapshotImpl = buildPriceSnapshot,
  buildPriceSnapshotUpdateImpl = buildPriceSnapshotUpdate,
  normalizePriceSyncFailureImpl = normalizePriceSyncFailure,
  normalizeShopDomainImpl = normalizeShopDomain,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
  applyCalculatedPriceToShopifyImpl = createApplyCalculatedPriceToShopify({
    shopifyGraphQLWithOfflineSessionImpl,
  }),
} = {}) {
  return async function applyProductPriceImpl(productId, options = {}) {
    if (!productId) {
      throw new Error('productId is required');
    }

    const attemptedAt = new Date();
    let linkedProducts = [];
    let linkedProduct = null;
    let preferredShopDomain = normalizeShopDomainImpl(options.shopDomain);
    let snapshotTarget = null;
    let resolvedShopDomain = preferredShopDomain;
    let priceSnapshot = null;
    let attemptedPrice = null;

    try {
      linkedProducts = await prismaClient.product.findMany({
      where: {
        shopifyProductId: productId,
      },
      select: {
        id: true,
        shopDomain: true,
        shopifyProductId: true,
      },
    });

      ({
        linkedProduct,
        preferredShopDomain,
      } = resolveLinkedProductContext(
        linkedProducts,
        options.shopDomain,
        normalizeShopDomainImpl,
      ));

      snapshotTarget = await resolveSnapshotTarget(
        {
          shopifyProductId: productId,
          linkedProducts,
          linkedProduct,
          localProductId: options.localProductId,
        },
        prismaClient,
      );

      const readQuery = `
        query ReadProductAndShop($id: ID!) {
          product(id: $id) {
            id
            title
            costAmountMetafield: metafield(namespace: "pricing", key: "cost_amount") { value }
            costCurrencyMetafield: metafield(namespace: "pricing", key: "cost_currency") { value }
            dutyCategoryMetafield: metafield(namespace: "pricing", key: "duty_category") { value }
            variants(first: 1) {
              nodes {
                id
                title
                price
              }
            }
          }
          shop {
            marginRate: metafield(namespace: "global_pricing", key: "default_margin_rate") { value }
            paymentFeeRate: metafield(namespace: "global_pricing", key: "payment_fee_rate") { value }
            paymentFeeFixed: metafield(namespace: "global_pricing", key: "payment_fee_fixed") { value }
            bufferRate: metafield(namespace: "global_pricing", key: "buffer_rate") { value }
          }
        }
      `;

      const { data: readData, shopDomain } = await shopifyGraphQLWithOfflineSessionImpl({
        shopDomain: preferredShopDomain,
        apiVersion: API_VERSION,
        query: readQuery,
        variables: { id: productId },
      });
      resolvedShopDomain = shopDomain;

      const product = readData?.product;

      if (!product) {
        throw new Error('Product not found on Shopify');
      }

      const variant = product.variants?.nodes?.[0];

      if (!variant?.id) {
        throw new Error('Variant not found');
      }

      const priceResult = await calculateProductPriceImpl(
        {
          costAmount: product.costAmountMetafield?.value,
          costCurrency: product.costCurrencyMetafield?.value,
          dutyCategory: product.dutyCategoryMetafield?.value,
          shopDomain,
        },
        {
          requirePositiveCostAmount: true,
          shopDomain,
          settings: {
            shopDomain,
            defaultMarginRate: readData?.shop?.marginRate?.value,
            paymentFeeRate: readData?.shop?.paymentFeeRate?.value,
            paymentFeeFixed: readData?.shop?.paymentFeeFixed?.value,
            bufferRate: readData?.shop?.bufferRate?.value,
          },
          fxRate: options.fxRate,
          dutyRate: options.dutyRate,
        },
      );
      attemptedPrice = priceResult.finalPrice;

      if (!snapshotTarget) {
        throw new Error('Local product not found for snapshot persistence');
      }

      priceSnapshot = buildPriceSnapshotImpl(priceResult, {
        calculatedAt: attemptedAt,
        localProductId: snapshotTarget.id,
        shopifyProductId: product.id,
        shopDomain,
        snapshotType: 'applied',
        source: {
          pricingInput: 'shopify_product_metafields',
          shopSettings: 'shopify_shop_metafields',
          fxRate: options.fxRate != null ? 'override' : 'fx_rate_table',
        },
      });

      const updatePayload = await applyCalculatedPriceToShopifyImpl({
        shopDomain,
        productId: product.id,
        variantId: variant.id,
        finalPrice: priceResult.finalPrice,
        apiVersion: API_VERSION,
      });

      const userErrors = updatePayload?.userErrors || [];

      if (userErrors.length) {
        throw new Error(`productVariantsBulkUpdate failed: ${JSON.stringify(userErrors)}`);
      }

      await prismaClient.product.update({
        where: { id: snapshotTarget.id },
        data: {
          shopDomain,
          shopifyProductId: product.id,
          priceSyncStatus: PRICE_SYNC_STATUS.APPLIED,
          priceSyncError: null,
          priceAppliedAt: attemptedAt,
          lastPriceApplyAttemptAt: attemptedAt,
          ...buildPriceSnapshotUpdateImpl(priceSnapshot),
        },
      });

      await createPriceApplyLog(
        prismaClient,
        buildPriceApplyLogData(
          {
            attemptedAt,
            status: PRICE_APPLY_LOG_STATUS.SUCCESS,
            productId: await resolvePriceApplyLogProductId(prismaClient, {
              snapshotTarget,
              linkedProduct,
              localProductId: options.localProductId,
            }),
            shopifyProductId: product.id,
            shopDomain,
            attemptedPrice: priceResult.finalPrice,
            priceFormulaVersion: priceSnapshot.priceFormulaVersion,
            priceSnapshot,
          },
          normalizeShopDomainImpl,
        ),
      );

      return {
        ok: true,
        productId: product.id,
        title: product.title,
        variantId: variant.id,
        oldPrice: variant.price,
        newPrice: String(priceResult.finalPrice),
        shopDomain,
        priceSyncStatus: PRICE_SYNC_STATUS.APPLIED,
        input: priceResult.input,
        breakdown: priceResult.breakdown,
        priceSnapshot,
      };
    } catch (error) {
      const failure = normalizePriceSyncFailureImpl(error);

      if (snapshotTarget?.id) {
        try {
          await prismaClient.product.update({
            where: { id: snapshotTarget.id },
            data: {
              priceSyncStatus: failure.status,
              priceSyncError: failure.message,
              lastPriceApplyAttemptAt: attemptedAt,
            },
          });
        } catch (updateError) {
          console.error('price sync failure update error:', updateError);
        }
      }

      await createPriceApplyLog(
        prismaClient,
        buildPriceApplyLogData(
          {
            attemptedAt,
            status:
              failure.status === PRICE_SYNC_STATUS.INVALID
                ? PRICE_APPLY_LOG_STATUS.INVALID
                : PRICE_APPLY_LOG_STATUS.APPLY_FAILED,
            productId: await resolvePriceApplyLogProductId(prismaClient, {
              snapshotTarget,
              linkedProduct,
              localProductId: options.localProductId,
            }),
            shopifyProductId: priceSnapshot?.shopifyProductId || productId,
            shopDomain:
              priceSnapshot?.shopDomain ||
              resolvedShopDomain ||
              snapshotTarget?.shopDomain ||
              linkedProduct?.shopDomain ||
              preferredShopDomain,
            attemptedPrice:
              attemptedPrice != null ? attemptedPrice : priceSnapshot?.calculatedPrice,
            priceFormulaVersion: priceSnapshot?.priceFormulaVersion || PRICE_FORMULA_VERSION,
            errorSummary: failure.message,
            priceSnapshot,
          },
          normalizeShopDomainImpl,
        ),
      );

      if (error instanceof Error) {
        error.priceSyncFailure = failure;
        error.message = failure.message;
      }

      throw error;
    }
  };
}

export const applyProductPrice = createApplyProductPrice();

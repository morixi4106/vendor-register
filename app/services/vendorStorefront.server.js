import { randomUUID } from 'node:crypto';

import { json, redirect } from '@remix-run/node';

import prisma from '../db.server.js';
import { draftOrderCheckout } from './draftOrderCheckout.server.js';
import {
  authorizeSalesCreditOffset,
  markSalesCreditOffsetCheckoutCreated,
  releaseSalesCreditOffset,
} from './sellerPayments.server.js';
import { vendorAdminSessionCookie } from './vendorManagement.server.js';
import { shopifyGraphQLWithOfflineSession } from '../utils/shopifyAdmin.server.js';
import {
  BUYER_IMPORT_WARNING_VERSION,
  evaluateCartDeliveryEligibility,
} from '../utils/deliveryEligibility.js';
import { normalizeProductCategory } from '../utils/productCategories.js';
import { SHOPIFY_API_VERSION } from '../utils/shopifyApiVersion.js';
import { hashPrivateIdentifier } from '../utils/privacyHash.server.js';
import {
  buildProductComplianceSnapshot,
  buildSellerGovernanceSnapshot,
  evaluateProductGovernanceReadiness,
  evaluateSellerGovernanceReadiness,
  getCurrentSellerAgreementDocumentHash,
  getCurrentSellerAgreementUrl,
  getCurrentBuyerTermsDocumentHash,
  getCurrentBuyerTermsUrl,
  getCurrentBuyerTermsVersion,
  getCurrentSellerAgreementVersion,
  getSellerAgreementReadinessOptions,
  getShopifyMarketplacePaymentsApproval,
  isMarketplaceGovernanceGateEnabled,
} from './marketplaceGovernance.server.js';

const GENERIC_CHECKOUT_ERROR_MESSAGE =
  '注文の作成に失敗しました。入力内容を確認して、もう一度お試しください。';
const GENERIC_SHIPPING_ERROR_MESSAGE =
  '送料の計算に失敗しました。配送先を確認して、もう一度お試しください。';
const CHECKOUT_UNAVAILABLE_MESSAGE =
  '購入設定を確認できませんでした。時間をおいて、もう一度お試しください。';
const INVALID_SELECTION_MESSAGE =
  '選択した商品を確認できませんでした。もう一度商品を選び直してください。';
const INVALID_CART_MESSAGE = '商品を1点以上選択してください。';
const INVALID_QUANTITY_MESSAGE = '商品の数量を確認してください。';
const UNAVAILABLE_PRODUCT_MESSAGE =
  '選択した商品は購入できません。内容を確認して、もう一度お試しください。';
const OUT_OF_STOCK_MESSAGE =
  '選択した商品の在庫数を確認してください。数量を変更して、もう一度お試しください。';
const INVALID_EMAIL_MESSAGE = 'メールアドレスの形式を確認してください。';
const SALES_CREDIT_UNAVAILABLE_MESSAGE =
  '売上金を利用できません。利用額と登録メールアドレスを確認してください。';
const SALES_CREDIT_SELF_PURCHASE_MESSAGE =
  '自分の商品には売上金を利用できません。';
const SALES_CREDIT_LIMIT_MESSAGE =
  '売上金は商品代金まで利用できます。';
const SALES_CREDIT_PRODUCT_RESTRICTED_MESSAGE =
  'この商品では売上金を利用できません。ほかの支払い方法で購入してください。';
const MULTI_SELLER_SALES_CREDIT_UNAVAILABLE_MESSAGE =
  '複数店舗の商品を含むため、売上金は利用できません。店舗ごとに分けて購入してください。';
const VARIANT_REQUIRED_ERROR = 'variant_required';
const PUBLIC_CHECKOUT_SOURCE = 'vendor_storefront';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_ADMIN_API_VERSION = SHOPIFY_API_VERSION;
const SALES_CREDIT_SUPPORTED_CURRENCY_CODE = 'jpy';
const MULTI_SELLER_STOREFRONT_CHECKOUT_FLAGS = [
  'MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED',
  'MULTI_SELLER_SHOPIFY_ORDER_SETTLEMENT_ENABLED',
  'MULTI_SELLER_SHOPIFY_REFUND_SETTLEMENT_ENABLED',
  'MULTI_SELLER_SHOPIFY_CANCELLED_SETTLEMENT_ENABLED',
  'MULTI_SELLER_SHOPIFY_DISPUTE_SETTLEMENT_ENABLED',
  'VENDOR_ORDERS_USE_SELLER_ORDERS',
];
const SALES_CREDIT_ALLOWED_CATEGORY_NAMES = new Set([
  'ファッション',
  'レディース服',
  'メンズ服',
  '着物・浴衣',
  '靴・鞄',
  '雑貨・小物',
  'アクセサリー',
  'ハンドメイド',
  '日用品',
]);
const SALES_CREDIT_RESTRICTED_CATEGORY_KEYWORDS = [
  'ギフトカード',
  '金券',
  'チケット',
  'プリペイド',
  '商品券',
  'カード',
  'フィギュア',
  '電子機器',
  'サプリ',
];

const PRODUCT_FOR_CHECKOUT_QUERY = `#graphql
  query ProductForDraftOrderCheckout($id: ID!) {
    product(id: $id) {
      id
      title
      variants(first: 2) {
        nodes {
          id
          title
          price
          inventoryItem {
            requiresShipping
          }
        }
      }
    }
  }
`;

const VARIANT_FOR_CHECKOUT_QUERY = `#graphql
  query VariantForDraftOrderCheckout($id: ID!) {
    productVariant(id: $id) {
      id
      title
      price
      product {
        id
        title
      }
      inventoryItem {
        requiresShipping
      }
    }
  }
`;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeEmail(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeBooleanInput(value) {
  if (typeof value === 'boolean') return value;
  if (value == null) return false;

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function getMissingMultiSellerStorefrontCheckoutFlags(env = process.env) {
  return MULTI_SELLER_STOREFRONT_CHECKOUT_FLAGS.filter(
    (flag) => !normalizeBooleanInput(env?.[flag]),
  );
}

function isMultiSellerStorefrontCheckoutEnabled(env = process.env) {
  return getMissingMultiSellerStorefrontCheckoutFlags(env).length === 0;
}

function normalizeCountryCode(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toUpperCase() : null;
}

function normalizeShopDomain(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeInventoryQuantity(value) {
  const numericValue = Number(value);

  if (!Number.isInteger(numericValue) || numericValue < 0) {
    return null;
  }

  return numericValue;
}

function normalizeShopifyGid(value, resourceType) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return null;
  }

  if (normalized.startsWith(`gid://shopify/${resourceType}/`)) {
    return normalized;
  }

  if (/^\d+$/.test(normalized)) {
    return `gid://shopify/${resourceType}/${normalized}`;
  }

  return null;
}

function isValidEmail(value) {
  return Boolean(value) && EMAIL_PATTERN.test(value);
}

function parseQuantityInput(value) {
  const normalized = String(value ?? '').trim();

  if (!normalized) {
    return {
      value: 0,
      isValid: true,
      isSelected: false,
    };
  }

  const numeric = Number(normalized);

  if (!Number.isInteger(numeric) || numeric < 0) {
    return {
      value: null,
      isValid: false,
      isSelected: false,
    };
  }

  return {
    value: numeric,
    isValid: true,
    isSelected: numeric > 0,
  };
}

function parsePositiveIntegerInput(value) {
  const normalized = String(value ?? '').trim();

  if (!normalized) {
    return null;
  }

  const numeric = Number(normalized);

  if (!Number.isInteger(numeric) || numeric <= 0) {
    return null;
  }

  return numeric;
}

function normalizeSalesCreditRequest({
  enabled,
  amount,
  idempotencyKey,
} = {}) {
  const isEnabled = normalizeBooleanInput(enabled);
  const normalizedAmount = parsePositiveIntegerInput(amount);

  if (!isEnabled && normalizedAmount == null) {
    return {
      ok: true,
      salesCredit: null,
    };
  }

  if (normalizedAmount == null) {
    return {
      ok: false,
      error: SALES_CREDIT_UNAVAILABLE_MESSAGE,
    };
  }

  return {
    ok: true,
    salesCredit: {
      amount: normalizedAmount,
      idempotencyKey: normalizeText(idempotencyKey),
    },
  };
}

function toDisplayPrice(product) {
  const calculatedPrice = Number(product?.calculatedPrice);

  if (Number.isFinite(calculatedPrice) && calculatedPrice > 0) {
    return Math.round(calculatedPrice);
  }

  const basePrice = Number(product?.price);

  if (Number.isFinite(basePrice) && basePrice > 0) {
    return Math.round(basePrice);
  }

  return 0;
}

function buildServerTrustedCheckoutLine(product, quantity) {
  const originalUnitPrice = toDisplayPrice(product);
  const vendorName =
    normalizeText(product.vendorStoreName) ||
    normalizeText(product.vendorHandle) ||
    normalizeText(product.vendor);
  const directShipGroup =
    normalizeText(product.vendorStoreId) || normalizeText(product.directShipGroup);

  return {
    lineId: product.id,
    ...(normalizeText(product.shopifyVariantId)
      ? { variantId: normalizeText(product.shopifyVariantId) }
      : {}),
    ...(normalizeText(product.shopifyProductId)
      ? { productId: normalizeText(product.shopifyProductId) }
      : {}),
    title: product.name,
    originalUnitPrice,
    amountAfterItemDiscountBeforeOrderCoupon: originalUnitPrice * quantity,
    quantity,
    requiresShipping: product.requiresShipping !== false,
    grams: product.shippingWeightGrams ?? null,
    shippingLengthMm: product.shippingLengthMm ?? null,
    shippingWidthMm: product.shippingWidthMm ?? null,
    shippingHeightMm: product.shippingHeightMm ?? null,
    internationalShippingMethod:
      product.internationalShippingMethod || "UNCONFIGURED",
    shippingWeightConfirmed: Boolean(product.shippingWeightConfirmedAt),
    shippingWeightSource: product.shippingWeightSource || "UNSET",
    shopifyVariantCount: product.shopifyVariantCount ?? null,
    shopifyWeightSyncStatus: product.shopifyWeightSyncStatus || "NOT_LINKED",
    ...(vendorName ? { vendor: vendorName } : {}),
    ...(directShipGroup ? { directShipGroup } : {}),
  };
}

function getRequestedShopifyProductGid(item) {
  return (
    normalizeShopifyGid(item?.shopifyProductGid, 'Product') ||
    normalizeShopifyGid(item?.shopifyProductId, 'Product')
  );
}

function getRequestedShopifyVariantGid(item) {
  return (
    normalizeShopifyGid(item?.shopifyVariantGid, 'ProductVariant') ||
    normalizeShopifyGid(item?.shopifyVariantId, 'ProductVariant')
  );
}

function hasRequestedShopifyReference(item) {
  return Boolean(getRequestedShopifyProductGid(item) || getRequestedShopifyVariantGid(item));
}

function buildCheckoutMetadata(
  vendorContext,
  checkoutSource = PUBLIC_CHECKOUT_SOURCE,
  { isMultiSeller = false } = {},
) {
  const tags = [checkoutSource.replaceAll('_', '-')];

  if (isMultiSeller) {
    tags.push('multi-seller');
    return { tags };
  }

  return {
    tags: [...tags, `vendor:${vendorContext.vendor.handle}`],
  };
}

function evaluateCheckoutCountryPolicy({
  vendorContext,
  products,
  shippingCountry,
  importResponsibilityAccepted,
}) {
  const result = evaluateCartDeliveryEligibility({
    vendorContext,
    products,
    deliveryCountry: shippingCountry,
    importResponsibilityAccepted,
  });

  if (result.acceptance) {
    result.acceptance.metadataJson = {
      sellerId: vendorContext?.vendor?.sellerId || null,
      vendorId: vendorContext?.vendor?.id || null,
      vendorHandle: vendorContext?.vendor?.handle || null,
    };
  }

  return result;
}

function evaluateMultiSellerCheckoutCountryPolicy({
  selectedProducts,
  shippingCountry,
  importResponsibilityAccepted,
}) {
  const products = selectedProducts.map(({ product }) => product);
  const result = evaluateCartDeliveryEligibility({
    products,
    deliveryCountry: shippingCountry,
    importResponsibilityAccepted,
  });

  if (result.acceptance) {
    result.acceptance.metadataJson = {
      sellerIds: Array.from(
        new Set(
          selectedProducts
            .map(({ vendorContext }) => normalizeText(vendorContext?.vendor?.sellerId))
            .filter(Boolean),
        ),
      ),
      vendorIds: Array.from(
        new Set(
          selectedProducts
            .map(({ vendorContext }) => normalizeText(vendorContext?.vendor?.id))
            .filter(Boolean),
        ),
      ),
      vendorHandles: Array.from(
        new Set(
          selectedProducts
            .map(({ vendorContext }) => normalizeText(vendorContext?.vendor?.handle))
            .filter(Boolean),
        ),
      ),
      multiSeller: true,
    };
  }

  return result;
}

function buildCheckoutCustomAttributes(
  vendorContext,
  countryPolicy,
  {
    isMultiSeller = false,
    selectedProducts = [],
    checkoutReference = null,
    presentedAt = null,
    env = process.env,
  } = {},
) {
  const attributes = isMultiSeller
    ? [
        { key: 'seller_of_record', value: 'marketplace_seller' },
        { key: 'marketplace_order_mode', value: 'multi_seller' },
        {
          key: 'seller_count',
          value: String(
            new Set(
              selectedProducts
                .map(({ vendorContext: itemVendorContext }) =>
                  normalizeText(itemVendorContext?.vendor?.sellerId),
                )
                .filter(Boolean),
            ).size || selectedProducts.length,
          ),
        },
      ]
    : [
        { key: 'seller_name', value: vendorContext.vendor.storeName },
        { key: 'seller_country', value: vendorContext.store.country || '' },
        { key: 'seller_of_record', value: 'marketplace_seller' },
      ];

  const sellerAgreementVersion = getCurrentSellerAgreementVersion(env);
  const sellerAgreementDocumentHash =
    getCurrentSellerAgreementDocumentHash(env);
  const sellerAgreementUrl = getCurrentSellerAgreementUrl(env);
  const buyerTermsVersion = getCurrentBuyerTermsVersion(env);
  const buyerTermsDocumentHash = getCurrentBuyerTermsDocumentHash(env);
  const buyerTermsUrl = getCurrentBuyerTermsUrl(env);
  if (
    sellerAgreementVersion !== 'UNCONFIGURED' ||
    buyerTermsVersion !== 'UNCONFIGURED'
  ) {
    attributes.push({
      key: 'marketplace_governance_snapshot_version',
      value: 'marketplace-governance-v1',
    });
    if (sellerAgreementVersion !== 'UNCONFIGURED') {
      attributes.push({
        key: 'seller_agreement_version',
        value: sellerAgreementVersion,
      });
    }
    if (sellerAgreementDocumentHash) {
      attributes.push({
        key: 'seller_agreement_hash',
        value: sellerAgreementDocumentHash,
      });
    }
    if (sellerAgreementUrl) {
      attributes.push({ key: 'seller_agreement_url', value: sellerAgreementUrl });
    }
    if (buyerTermsVersion !== 'UNCONFIGURED') {
      attributes.push({
        key: 'buyer_terms_version',
        value: buyerTermsVersion,
      });
    }
    if (buyerTermsDocumentHash) {
      attributes.push({ key: 'buyer_terms_hash', value: buyerTermsDocumentHash });
    }
    if (buyerTermsUrl) {
      attributes.push({ key: 'buyer_terms_url', value: buyerTermsUrl });
    }
    attributes.push(
      {
        key: 'buyer_terms_locale',
        value: normalizeText(env.BUYER_TERMS_LOCALE) || 'ja-JP',
      },
      {
        key: 'buyer_terms_presented_at',
        value: (presentedAt || new Date()).toISOString(),
      },
      {
        key: 'checkout_reference',
        value: checkoutReference || `checkout:${randomUUID()}`,
      },
    );
  }

  if (countryPolicy?.requiresWarning) {
    attributes.push(
      { key: 'buyer_import_warning_version', value: countryPolicy.acceptance.warningVersion },
      { key: 'buyer_import_responsibility_accepted', value: 'true' },
    );
  }

  return attributes;
}

async function recordMarketplaceCheckoutEvidence(
  {
    checkoutReference,
    shopDomain,
    presentedAt,
    selectedProducts,
    env,
  },
  { prismaClient = prisma } = {},
) {
  if (!prismaClient?.marketplaceCheckoutEvidence?.create) {
    throw new Error('Marketplace checkout evidence storage is unavailable.');
  }

  const sellerAgreementVersion = getCurrentSellerAgreementVersion(env);
  const buyerTermsVersion = getCurrentBuyerTermsVersion(env);
  const sellerSnapshots = new Map();

  for (const { product } of selectedProducts) {
    const seller =
      product.vendorStore?.seller || product.vendorStore?.vendorAuth?.seller || null;
    if (!seller?.id || sellerSnapshots.has(seller.id)) continue;
    sellerSnapshots.set(seller.id, {
      sellerId: seller.id,
      vendorStoreId: product.vendorStoreId || product.vendorStore?.id || null,
      snapshot: buildSellerGovernanceSnapshot(
        {
          ...seller,
          vendorStore: product.vendorStore,
        },
        { agreementVersion: sellerAgreementVersion, buyerTermsVersion },
      ),
    });
  }

  const productSnapshots = selectedProducts.map(({ product, quantity }) => ({
    productId: product.id,
    sellerId:
      product.vendorStore?.seller?.id ||
      product.vendorStore?.vendorAuth?.seller?.id ||
      null,
    quantity,
    snapshot: buildProductComplianceSnapshot(product),
  }));

  return prismaClient.marketplaceCheckoutEvidence.create({
    data: {
      checkoutReference,
      shopDomain,
      sellerAgreementVersion,
      sellerAgreementHash: getCurrentSellerAgreementDocumentHash(env),
      sellerAgreementUrl: getCurrentSellerAgreementUrl(env),
      buyerTermsVersion,
      buyerTermsHash: getCurrentBuyerTermsDocumentHash(env),
      buyerTermsUrl: getCurrentBuyerTermsUrl(env),
      buyerTermsLocale: normalizeText(env.BUYER_TERMS_LOCALE) || 'ja-JP',
      presentedAt,
      sellerSnapshotsJson: Array.from(sellerSnapshots.values()),
      productSnapshotsJson: productSnapshots,
    },
  });
}

function calculateSelectedProductSubtotal(selectedProducts = []) {
  return selectedProducts.reduce(
    (total, { product, quantity }) =>
      total + toDisplayPrice(product) * Number(quantity || 0),
    0,
  );
}

function getSalesCreditProductCategory(product, vendorContext) {
  const rawCategory =
    normalizeText(product?.category) ||
    normalizeText(vendorContext?.store?.category);

  return normalizeProductCategory(rawCategory) || null;
}

function getSalesCreditRawProductCategory(product, vendorContext) {
  return (
    normalizeText(product?.category) ||
    normalizeText(vendorContext?.store?.category) ||
    null
  );
}

function evaluateSalesCreditProductRisk(product, vendorContext) {
  const category = getSalesCreditProductCategory(product, vendorContext);
  const rawCategory = getSalesCreditRawProductCategory(product, vendorContext);
  const comparable = `${category || ''} ${normalizeText(product?.name) || ''}`;

  if (product?.salesCreditEligible === false) {
    return {
      ok: false,
      reason: 'local_product_required',
      category,
      rawCategory,
    };
  }

  if (!category) {
    return {
      ok: false,
      reason: rawCategory ? 'category_unsupported' : 'category_required',
      category: null,
      rawCategory,
    };
  }

  if (
    !SALES_CREDIT_ALLOWED_CATEGORY_NAMES.has(category) ||
    SALES_CREDIT_RESTRICTED_CATEGORY_KEYWORDS.some((keyword) =>
      comparable.includes(keyword),
    )
  ) {
    return {
      ok: false,
      reason: 'restricted_category',
      category,
      rawCategory,
    };
  }

  return {
    ok: true,
    reason: null,
    category,
    rawCategory,
  };
}

function evaluateSalesCreditProducts(selectedProducts, vendorContext) {
  const restrictedProducts = [];

  for (const { product } of selectedProducts) {
    const risk = evaluateSalesCreditProductRisk(product, vendorContext);

    if (!risk.ok) {
      restrictedProducts.push({
        productId: normalizeText(product?.id),
        name: normalizeText(product?.name),
        category: risk.category,
        rawCategory: risk.rawCategory,
        reason: risk.reason,
      });
    }
  }

  return {
    ok: restrictedProducts.length === 0,
    restrictedProducts,
  };
}

async function getAuthenticatedSalesCreditSeller({
  request,
  email,
  prismaClient = prisma,
}) {
  const cookieHeader = request?.headers?.get?.('Cookie');
  const sessionToken = await vendorAdminSessionCookie.parse(cookieHeader);

  if (!sessionToken) {
    return null;
  }

  if (typeof prismaClient.vendorAdminSession?.findUnique !== 'function') {
    return null;
  }

  const vendorSession = await prismaClient.vendorAdminSession.findUnique({
    where: { sessionToken },
    include: {
      vendor: {
        include: {
          seller: {
            select: {
              id: true,
            },
          },
        },
      },
    },
  });

  if (!vendorSession || vendorSession.expiresAt < new Date()) {
    return null;
  }

  const sessionEmail = normalizeEmail(vendorSession.vendor?.managementEmail);

  if (!sessionEmail || sessionEmail !== normalizeEmail(email)) {
    return null;
  }

  return vendorSession.vendor?.seller || null;
}

function buildSalesCreditAppliedDiscount(amount) {
  return {
    title: 'Sales credit',
    description: 'Monthly settlement offset',
    value: amount,
    valueType: 'FIXED_AMOUNT',
  };
}

function buildSalesCreditCustomAttributes({ offset, amount, buyerSellerId }) {
  return [
    { key: 'sales_credit_offset_id', value: offset.id },
    { key: 'sales_credit_offset_amount', value: String(amount) },
    { key: 'sales_credit_buyer_seller_id', value: buyerSellerId },
    { key: 'sales_credit_mode', value: 'monthly_settlement_offset' },
  ];
}

async function prepareCheckoutSalesCredit({
  request,
  submission,
  vendorContext,
  selectedProducts,
  prismaClient = prisma,
}) {
  if (!submission.salesCredit) {
    return {
      ok: true,
      appliedDiscount: null,
      customAttributes: [],
      offset: null,
    };
  }

  const amount = submission.salesCredit.amount;
  const subtotal = calculateSelectedProductSubtotal(selectedProducts);
  const currencyCode = SALES_CREDIT_SUPPORTED_CURRENCY_CODE;

  if (amount > subtotal) {
    return {
      ok: false,
      error: SALES_CREDIT_LIMIT_MESSAGE,
    };
  }

  const productRisk = evaluateSalesCreditProducts(
    selectedProducts,
    vendorContext,
  );

  if (!productRisk.ok) {
    return {
      ok: false,
      error: SALES_CREDIT_PRODUCT_RESTRICTED_MESSAGE,
      productRisk,
    };
  }

  const targetSellerId = normalizeText(vendorContext?.vendor?.sellerId);

  if (!targetSellerId) {
    return {
      ok: false,
      error: SALES_CREDIT_UNAVAILABLE_MESSAGE,
    };
  }

  const buyerSeller = await getAuthenticatedSalesCreditSeller({
    request,
    email: submission.customer.email,
    prismaClient,
  });
  const buyerSellerId = normalizeText(buyerSeller?.id);

  if (!buyerSellerId) {
    return {
      ok: false,
      error: SALES_CREDIT_UNAVAILABLE_MESSAGE,
    };
  }

  if (buyerSellerId === targetSellerId) {
    return {
      ok: false,
      error: SALES_CREDIT_SELF_PURCHASE_MESSAGE,
    };
  }

  const idempotencyKey =
    normalizeText(submission.salesCredit.idempotencyKey) ||
    `sales-credit:${buyerSellerId}:${randomUUID()}`;
  const checkoutReference = `draft-order:${randomUUID()}`;
  const authorization = await authorizeSalesCreditOffset(
    {
      sellerId: buyerSellerId,
      amount,
      currencyCode,
      checkoutReference,
      idempotencyKey,
      metadataJson: {
        salesCreditMode: 'monthly_settlement_offset',
        checkoutLockMinutes: 30,
        currencyCode,
        itemSubtotalAmount: subtotal,
        buyerEmail: submission.customer.email,
        targetSellerId,
        targetVendorHandle: vendorContext.vendor.handle,
        targetVendorStoreName: vendorContext.vendor.storeName,
        productRiskPolicy: {
          allowed: true,
          allowedCategoryNames: Array.from(SALES_CREDIT_ALLOWED_CATEGORY_NAMES),
        },
        lineItems: selectedProducts.map(({ product, quantity }) => ({
          productId: normalizeText(product?.id),
          name: normalizeText(product?.name),
          category: getSalesCreditProductCategory(product, vendorContext),
          quantity: Number(quantity || 0),
          subtotalAmount: toDisplayPrice(product) * Number(quantity || 0),
        })),
      },
    },
    { prismaClient },
  );

  if (!authorization.ok) {
    return {
      ok: false,
      error: SALES_CREDIT_UNAVAILABLE_MESSAGE,
      authorization,
    };
  }

  return {
    ok: true,
    appliedDiscount: buildSalesCreditAppliedDiscount(
      authorization.offset.amount,
    ),
    customAttributes: buildSalesCreditCustomAttributes({
      offset: authorization.offset,
      amount: authorization.offset.amount,
      buyerSellerId,
    }),
    offset: authorization.offset,
  };
}

async function releaseCheckoutSalesCreditOffset({
  salesCreditOffset,
  prismaClient = prisma,
  reason = 'checkout_failed',
}) {
  if (!salesCreditOffset?.id) {
    return null;
  }

  try {
    return await releaseSalesCreditOffset(
      {
        offsetId: salesCreditOffset.id,
        reason,
      },
      { prismaClient },
    );
  } catch (error) {
    console.error('sales credit offset release failed:', error);
    return null;
  }
}

async function markCheckoutSalesCreditOffsetCreated({
  salesCreditOffset,
  checkoutResult,
  prismaClient = prisma,
}) {
  if (!salesCreditOffset?.id) {
    return null;
  }

  try {
    return await markSalesCreditOffsetCheckoutCreated(
      {
        offsetId: salesCreditOffset.id,
        draftOrderId: checkoutResult?.draftOrder?.id,
        invoiceUrl:
          checkoutResult?.invoiceUrl || checkoutResult?.draftOrder?.invoiceUrl,
      },
      { prismaClient },
    );
  } catch (error) {
    console.error('sales credit offset checkout mark failed:', error);
    return null;
  }
}

export async function recordBuyerWarningAcceptance({
  prismaClient = prisma,
  acceptance,
  orderId = null,
  request = null,
} = {}) {
  if (!acceptance || !prismaClient?.buyerWarningAcceptance?.create) {
    return null;
  }

  try {
    return await prismaClient.buyerWarningAcceptance.create({
      data: {
        orderId: normalizeText(orderId),
        selectedCountry: normalizeCountryCode(acceptance.selectedCountry),
        shippingCountry: normalizeCountryCode(acceptance.shippingCountry),
        productIds: acceptance.productIds || [],
        warningVersion: acceptance.warningVersion || BUYER_IMPORT_WARNING_VERSION,
        importResponsibilityAccepted: Boolean(
          acceptance.importResponsibilityAccepted,
        ),
        ipAddress: null,
        userAgent: null,
        ipHash: hashPrivateIdentifier(
          normalizeText(request?.headers?.get?.('cf-connecting-ip')) ||
            normalizeText(request?.headers?.get?.('x-forwarded-for'))?.split(',')[0],
        ),
        userAgentHash: hashPrivateIdentifier(
          normalizeText(request?.headers?.get?.('user-agent')),
        ),
        metadataJson: acceptance.metadataJson || null,
      },
    });
  } catch (error) {
    console.error('buyer warning acceptance record failed:', error);
    return null;
  }
}

function buildNotFoundResponse() {
  return new Response('Not Found', { status: 404 });
}

function buildMethodNotAllowedResponse() {
  return json(
    {
      ok: false,
      reason: 'method_not_allowed',
      errors: ['Method not allowed'],
    },
    {
      status: 405,
      headers: {
        Allow: 'POST',
      },
    },
  );
}

function buildDefaultFieldErrors() {
  return {
    cart: null,
    firstName: null,
    lastName: null,
    email: null,
    phone: null,
    address1: null,
    city: null,
    province: null,
    postalCode: null,
    country: null,
    importResponsibility: null,
    salesCredit: null,
  };
}

function buildInvalidPayloadResponse(fieldErrors) {
  return json(
    {
      ok: false,
      reason: 'invalid_payload',
      error: '入力内容を確認してください。',
      fieldErrors,
    },
    { status: 400 },
  );
}

function buildJsonInvalidPayloadResponse(errors) {
  return json(
    {
      ok: false,
      reason: 'invalid_payload',
      errors,
    },
    { status: 400 },
  );
}

function buildInternalErrorResponse(message, status = 500) {
  return json(
    {
      ok: false,
      reason: 'internal_error',
      error: message,
    },
    { status },
  );
}

function buildPublicCheckoutErrorResponse(error) {
  if (error?.reason === 'shipping_quote_failed') {
    return buildInternalErrorResponse(GENERIC_SHIPPING_ERROR_MESSAGE, 422);
  }

  if (error?.reason === 'invalid_payload' && Array.isArray(error?.errors)) {
    return buildInvalidPayloadResponse({
      ...buildDefaultFieldErrors(),
      cart: GENERIC_CHECKOUT_ERROR_MESSAGE,
    });
  }

  return buildInternalErrorResponse(GENERIC_CHECKOUT_ERROR_MESSAGE);
}

function buildPublicApiCheckoutErrorResponse(error) {
  if (error?.reason === 'shipping_quote_failed') {
    return buildInternalErrorResponse(GENERIC_SHIPPING_ERROR_MESSAGE, 422);
  }

  if (error?.reason === 'invalid_payload' && Array.isArray(error?.errors)) {
    return buildJsonInvalidPayloadResponse(['入力内容を確認してください。']);
  }

  return buildInternalErrorResponse(GENERIC_CHECKOUT_ERROR_MESSAGE);
}

async function getActiveVendorContextByHandle(handle, prismaClient = prisma) {
  const normalizedHandle = normalizeText(handle);

  if (!normalizedHandle) {
    return null;
  }

  const vendor = await prismaClient.vendor.findUnique({
    where: { handle: normalizedHandle },
    include: {
      vendorStore: {
        select: {
          id: true,
          storeName: true,
          ownerName: true,
          country: true,
          category: true,
          note: true,
        },
      },
      seller: {
        select: {
          id: true,
          euSellerStatus: true,
        },
      },
    },
  });

  if (!vendor || vendor.status !== 'active' || !vendor.vendorStore) {
    return null;
  }

  return {
    vendor: {
      id: vendor.id,
      handle: vendor.handle,
      storeName: vendor.storeName,
      managementEmail: vendor.managementEmail || null,
      sellerId: vendor.seller?.id || null,
      euSellerStatus: vendor.seller?.euSellerStatus || 'DISABLED',
    },
    store: {
      id: vendor.vendorStore.id,
      storeName: vendor.vendorStore.storeName,
      ownerName: vendor.vendorStore.ownerName,
      country: vendor.vendorStore.country,
      category: vendor.vendorStore.category,
      note: vendor.vendorStore.note || null,
    },
  };
}

function buildVendorContextForCheckoutProduct(product, fallbackVendorContext) {
  const store = product?.vendorStore || null;
  const vendor = store?.vendorAuth || null;
  const seller = vendor?.seller || store?.seller || null;

  if (!store || !vendor) {
    if (
      fallbackVendorContext &&
      normalizeText(product?.vendorStoreId) === normalizeText(fallbackVendorContext.store?.id)
    ) {
      return fallbackVendorContext;
    }

    return null;
  }

  if (vendor.status && vendor.status !== 'active') {
    return null;
  }

  return {
    vendor: {
      id: vendor.id,
      handle: vendor.handle,
      storeName: vendor.storeName,
      managementEmail: vendor.managementEmail || null,
      sellerId: seller?.id || null,
      euSellerStatus: seller?.euSellerStatus || 'DISABLED',
    },
    store: {
      id: store.id,
      storeName: store.storeName,
      ownerName: store.ownerName || null,
      country: store.country,
      category: store.category,
      note: store.note || null,
    },
  };
}

async function getVendorStorefrontByHandle(handle, prismaClient = prisma) {
  const vendorContext = await getActiveVendorContextByHandle(handle, prismaClient);

  if (!vendorContext) {
    return null;
  }

  const products = await prismaClient.product.findMany({
    where: {
      vendorStoreId: vendorContext.store.id,
      approvalStatus: 'approved',
    },
    orderBy: { createdAt: 'desc' },
  });

  return {
    vendor: vendorContext.vendor,
    store: vendorContext.store,
    products: products.map((product) => {
      const shopDomain = normalizeShopDomain(product.shopDomain);
      const price = toDisplayPrice(product);

      return {
        id: product.id,
        name: product.name,
        description: product.description || '',
        imageUrl: product.imageUrl || null,
        price,
        inventoryQuantity: normalizeInventoryQuantity(product.inventoryQuantity),
        shopDomain,
        shopifyProductId: normalizeText(product.shopifyProductId),
        approvalStatus: product.approvalStatus || 'approved',
        productEuStatus: product.productEuStatus || 'DISABLED',
        countryPolicy: product.countryPolicy || null,
        euSaleRequested: Boolean(product.euSaleRequested),
        isPurchasable: Boolean(shopDomain && price > 0),
      };
    }),
  };
}

async function resolveVendorStoreShopDomain({ vendorStoreId, prismaClient = prisma }) {
  const products = await prismaClient.product.findMany({
    where: {
      vendorStoreId,
      shopDomain: {
        not: null,
      },
    },
    select: {
      shopDomain: true,
    },
  });
  const shopDomains = Array.from(
    new Set(products.map((product) => normalizeShopDomain(product.shopDomain)).filter(Boolean)),
  );

  return shopDomains.length === 1 ? shopDomains[0] : null;
}

function buildShopifyOnlyProductFromVariant({ variant, product, quantity }) {
  const price = Number(variant?.price);
  const productTitle = normalizeText(product?.title);
  const variantTitle = normalizeText(variant?.title);
  const title =
    variantTitle && variantTitle !== 'Default Title' && productTitle
      ? `${productTitle} - ${variantTitle}`
      : productTitle || variantTitle;

  if (!normalizeText(variant?.id) || !normalizeText(product?.id) || !title || !Number.isFinite(price) || price <= 0) {
    return null;
  }

  return {
    id: normalizeText(variant.id),
    name: title,
    category: null,
    price,
    calculatedPrice: price,
    shopifyProductId: normalizeText(product.id),
    shopifyVariantId: normalizeText(variant.id),
    salesCreditEligible: false,
    // Shopify-only fallback defaults to shipping-required when inventoryItem is missing.
    requiresShipping: variant.inventoryItem?.requiresShipping !== false,
    quantity,
  };
}

async function fetchShopifyCheckoutProduct({
  item,
  shopDomain,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
}) {
  const variantGid = getRequestedShopifyVariantGid(item);
  const productGid = getRequestedShopifyProductGid(item);

  if (variantGid) {
    const { data } = await shopifyGraphQLWithOfflineSessionImpl({
      shopDomain,
      apiVersion: DEFAULT_ADMIN_API_VERSION,
      query: VARIANT_FOR_CHECKOUT_QUERY,
      variables: {
        id: variantGid,
      },
    });
    const variant = data?.productVariant;
    const product = variant?.product;

    return buildShopifyOnlyProductFromVariant({
      variant,
      product,
      quantity: item.quantity,
    });
  }

  if (!productGid) {
    return null;
  }

  const { data } = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion: DEFAULT_ADMIN_API_VERSION,
    query: PRODUCT_FOR_CHECKOUT_QUERY,
    variables: {
      id: productGid,
    },
  });
  const product = data?.product;
  const variants = Array.isArray(product?.variants?.nodes) ? product.variants.nodes : [];

  if (variants.length !== 1) {
    return {
      error: VARIANT_REQUIRED_ERROR,
    };
  }

  return buildShopifyOnlyProductFromVariant({
    variant: variants[0],
    product,
    quantity: item.quantity,
  });
}

async function buildShopifyFallbackCheckoutPayload({
  request = null,
  resolvedVendorContext,
  submission,
  prismaClient = prisma,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
  checkoutSource = PUBLIC_CHECKOUT_SOURCE,
  env = process.env,
}) {
  if (!submission.items.every(hasRequestedShopifyReference)) {
    return {
      ok: false,
      error: INVALID_SELECTION_MESSAGE,
    };
  }

  const shopDomain = await resolveVendorStoreShopDomain({
    vendorStoreId: resolvedVendorContext.store.id,
    prismaClient,
  });

  if (!shopDomain) {
    return {
      ok: false,
      error: CHECKOUT_UNAVAILABLE_MESSAGE,
    };
  }

  const selectedProducts = [];

  for (const item of submission.items) {
    const resolvedProduct = await fetchShopifyCheckoutProduct({
      item,
      shopDomain,
      shopifyGraphQLWithOfflineSessionImpl,
    });

    if (resolvedProduct?.error) {
      return {
        ok: false,
        error: resolvedProduct.error,
      };
    }

    if (!resolvedProduct) {
      return {
        ok: false,
        error: INVALID_SELECTION_MESSAGE,
      };
    }

    selectedProducts.push({
      product: {
        ...resolvedProduct,
        shopDomain,
      },
      quantity: resolvedProduct.quantity,
    });
  }

  const countryPolicy = evaluateCheckoutCountryPolicy({
    vendorContext: resolvedVendorContext,
    products: selectedProducts.map(({ product }) => product),
    shippingCountry: submission.shippingAddress.countryCode,
    importResponsibilityAccepted: submission.importResponsibilityAccepted,
  });

  if (!countryPolicy.ok) {
    return {
      ok: false,
      error: countryPolicy.error,
    };
  }

  const salesCredit = await prepareCheckoutSalesCredit({
    request,
    submission,
    vendorContext: resolvedVendorContext,
    selectedProducts,
    prismaClient,
  });

  if (!salesCredit.ok) {
    return {
      ok: false,
      error: salesCredit.error,
    };
  }

  const metadata = buildCheckoutMetadata(resolvedVendorContext, checkoutSource);
  const customAttributes = [
    ...buildCheckoutCustomAttributes(resolvedVendorContext, countryPolicy, {
      env,
    }),
    ...salesCredit.customAttributes,
  ];

  return {
    ok: true,
    salesCreditOffset: salesCredit.offset,
    payload: {
      orderLike: {
        lines: selectedProducts.map(({ product, quantity }) =>
          buildServerTrustedCheckoutLine(product, quantity),
        ),
      },
      shippingAddress: submission.shippingAddress,
      customer: submission.customer,
      email: submission.customer.email,
      customerEmail: submission.customer.email,
      ...(submission.note ? { note: submission.note } : {}),
      shopDomain,
      tags: metadata.tags,
      customAttributes,
      ...(salesCredit.appliedDiscount
        ? { appliedDiscount: salesCredit.appliedDiscount }
        : {}),
      ...(countryPolicy.acceptance
        ? { buyerWarningAcceptance: countryPolicy.acceptance }
        : {}),
    },
  };
}

function normalizeStorefrontCheckoutSubmission(formData) {
  const fieldErrors = buildDefaultFieldErrors();
  const items = [];
  let hasInvalidQuantity = false;

  for (const [key, value] of formData.entries()) {
    if (!key.startsWith('quantity:')) {
      continue;
    }

    const productId = normalizeText(key.slice('quantity:'.length));
    const quantity = parseQuantityInput(value);

    if (!productId) {
      continue;
    }

    if (!quantity.isValid) {
      hasInvalidQuantity = true;
      continue;
    }

    if (quantity.isSelected) {
      items.push({
        productId,
        quantity: quantity.value,
      });
    }
  }

  const firstName = normalizeText(formData.get('firstName'));
  const lastName = normalizeText(formData.get('lastName'));
  const email = normalizeEmail(formData.get('email'));
  const phone = normalizeText(formData.get('phone'));
  const address1 = normalizeText(formData.get('address1'));
  const address2 = normalizeText(formData.get('address2'));
  const city = normalizeText(formData.get('city'));
  const province = normalizeText(formData.get('province'));
  const postalCode = normalizeText(formData.get('postalCode'));
  const country = normalizeText(formData.get('country'));
  const note = normalizeText(formData.get('note'));
  const importResponsibilityAccepted = normalizeBooleanInput(
    formData.get('importResponsibilityAccepted'),
  );
  const salesCreditRequest = normalizeSalesCreditRequest({
    enabled: formData.get('useSalesCredit'),
    amount: formData.get('salesCreditAmount'),
    idempotencyKey: formData.get('salesCreditIdempotencyKey'),
  });

  if (hasInvalidQuantity) {
    fieldErrors.cart = INVALID_QUANTITY_MESSAGE;
  } else if (items.length === 0) {
    fieldErrors.cart = INVALID_CART_MESSAGE;
  }

  if (!salesCreditRequest.ok) {
    fieldErrors.salesCredit = salesCreditRequest.error;
  }

  if (!firstName) {
    fieldErrors.firstName = '名を入力してください。';
  }

  if (!lastName) {
    fieldErrors.lastName = '姓を入力してください。';
  }

  if (!email) {
    fieldErrors.email = 'メールアドレスを入力してください。';
  } else if (!isValidEmail(email)) {
    fieldErrors.email = INVALID_EMAIL_MESSAGE;
  }

  if (!phone) {
    fieldErrors.phone = '電話番号を入力してください。';
  }

  if (!address1) {
    fieldErrors.address1 = '住所を入力してください。';
  }

  if (!city) {
    fieldErrors.city = '市区町村を入力してください。';
  }

  if (!province) {
    fieldErrors.province = '都道府県を入力してください。';
  }

  if (!postalCode) {
    fieldErrors.postalCode = '郵便番号を入力してください。';
  }

  if (!country) {
    fieldErrors.country = '国コードを入力してください。';
  }

  if (Object.values(fieldErrors).some(Boolean)) {
    return {
      ok: false,
      fieldErrors,
    };
  }

  return {
    ok: true,
    submission: {
      items,
      note,
      customer: {
        firstName,
        lastName,
        email,
        phone,
      },
      shippingAddress: {
        firstName,
        lastName,
        address1,
        ...(address2 ? { address2 } : {}),
        city,
        prefecture: province,
        province,
        postalCode,
        zip: postalCode,
        country: country.toUpperCase(),
        countryCode: country.toUpperCase(),
        phone,
      },
      importResponsibilityAccepted,
      salesCredit: salesCreditRequest.salesCredit,
    },
  };
}

function getPublicCheckoutItems(body) {
  if (Array.isArray(body?.items)) {
    return body.items;
  }

  if (Array.isArray(body?.orderLike?.lines)) {
    return body.orderLike.lines;
  }

  if (Array.isArray(body?.lines)) {
    return body.lines;
  }

  return [];
}

function normalizePublicCheckoutSubmission(body) {
  if (!isPlainObject(body)) {
    return {
      ok: false,
      errors: ['リクエスト形式を確認してください。'],
    };
  }

  const errors = [];
  const items = [];
  let hasInvalidItem = false;
  const vendorHandle = normalizeText(body.vendorHandle || body.handle);
  const requestedItems = getPublicCheckoutItems(body);
  const customer = isPlainObject(body.customer) ? body.customer : {};
  const shippingAddress = isPlainObject(body.shippingAddress)
    ? body.shippingAddress
    : isPlainObject(body.address)
      ? body.address
      : {};
  const firstName = normalizeText(customer.firstName || body.firstName);
  const lastName = normalizeText(customer.lastName || body.lastName);
  const email = normalizeEmail(customer.email || body.email || body.customerEmail);
  const phone = normalizeText(customer.phone || body.phone);
  const address1 = normalizeText(shippingAddress.address1);
  const address2 = normalizeText(shippingAddress.address2);
  const city = normalizeText(shippingAddress.city);
  const province = normalizeText(shippingAddress.province || shippingAddress.prefecture);
  const postalCode = normalizeText(shippingAddress.postalCode || shippingAddress.zip);
  const country = normalizeText(shippingAddress.country || shippingAddress.countryCode);
  const note = normalizeText(body.note);
  const importResponsibilityAccepted = normalizeBooleanInput(
    body.importResponsibilityAccepted ||
      body.import_responsibility_accepted ||
      body.buyerWarningAccepted,
  );
  const requestedSalesCredit = isPlainObject(body.salesCredit)
    ? body.salesCredit
    : {};
  const salesCreditRequest = normalizeSalesCreditRequest({
    enabled:
      body.useSalesCredit ??
      body.use_sales_credit ??
      requestedSalesCredit.enabled,
    amount:
      body.salesCreditAmount ??
      body.sales_credit_amount ??
      requestedSalesCredit.amount,
    idempotencyKey:
      body.salesCreditIdempotencyKey ??
      body.sales_credit_idempotency_key ??
      requestedSalesCredit.idempotencyKey,
  });

  for (const item of requestedItems) {
    const productId = normalizeText(
      item?.localProductId || item?.lineId || item?.productId || item?.id,
    );
    const shopifyProductId =
      normalizeText(item?.shopifyProductGid) || normalizeText(item?.shopifyProductId);
    const shopifyVariantId =
      normalizeText(item?.shopifyVariantGid) || normalizeText(item?.shopifyVariantId);
    const quantity = parseQuantityInput(item?.quantity ?? item?.qty);

    if ((!productId && !shopifyProductId && !shopifyVariantId) || !quantity.isValid) {
      hasInvalidItem = true;
      continue;
    }

    if (quantity.isSelected) {
      items.push({
        productId,
        shopifyProductId,
        shopifyVariantId,
        quantity: quantity.value,
      });
    }
  }

  if (!vendorHandle) {
    errors.push('店舗情報を確認できませんでした。');
  }

  if (hasInvalidItem) {
    errors.push('商品と数量を確認してください。');
  } else if (items.length === 0) {
    errors.push(INVALID_CART_MESSAGE);
  }

  if (!salesCreditRequest.ok) {
    errors.push(salesCreditRequest.error);
  }

  if (!firstName) {
    errors.push('名を入力してください。');
  }

  if (!lastName) {
    errors.push('姓を入力してください。');
  }

  if (!email) {
    errors.push('メールアドレスを入力してください。');
  } else if (!isValidEmail(email)) {
    errors.push(INVALID_EMAIL_MESSAGE);
  }

  if (!phone) {
    errors.push('電話番号を入力してください。');
  }

  if (!address1) {
    errors.push('住所を入力してください。');
  }

  if (!city) {
    errors.push('市区町村を入力してください。');
  }

  if (!province) {
    errors.push('都道府県を入力してください。');
  }

  if (!postalCode) {
    errors.push('郵便番号を入力してください。');
  }

  if (!country) {
    errors.push('国コードを入力してください。');
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
    };
  }

  return {
    ok: true,
    submission: {
      vendorHandle,
      items,
      note,
      customer: {
        firstName,
        lastName,
        email,
        phone,
      },
      shippingAddress: {
        firstName,
        lastName,
        address1,
        ...(address2 ? { address2 } : {}),
        city,
        prefecture: province,
        province,
        postalCode,
        zip: postalCode,
        country: country.toUpperCase(),
        countryCode: country.toUpperCase(),
        phone,
      },
      importResponsibilityAccepted,
      salesCredit: salesCreditRequest.salesCredit,
    },
  };
}

async function buildServerTrustedCheckoutPayload({
  request = null,
  vendorContext,
  vendorHandle,
  submission,
  prismaClient = prisma,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
  checkoutSource = PUBLIC_CHECKOUT_SOURCE,
  env = process.env,
}) {
  const resolvedVendorContext =
    vendorContext || (await getActiveVendorContextByHandle(vendorHandle, prismaClient));

  if (!resolvedVendorContext) {
    return {
      ok: false,
      error: CHECKOUT_UNAVAILABLE_MESSAGE,
    };
  }

  const uniqueProductIds = Array.from(
    new Set(submission.items.map((item) => item.productId).filter(Boolean)),
  );
  const multiSellerStorefrontEnabled =
    isMultiSellerStorefrontCheckoutEnabled(env);
  const products = await prismaClient.product.findMany({
    where: {
      id: { in: uniqueProductIds },
      ...(multiSellerStorefrontEnabled
        ? {}
        : { vendorStoreId: resolvedVendorContext.store.id }),
      approvalStatus: 'approved',
    },
    select: {
      id: true,
      name: true,
      price: true,
      category: true,
      calculatedPrice: true,
      inventoryQuantity: true,
      url: true,
      vendorStoreId: true,
      shopifyProductId: true,
      shopifyVariantId: true,
      shopDomain: true,
      shippingWeightGrams: true,
      shippingLengthMm: true,
      shippingWidthMm: true,
      shippingHeightMm: true,
      internationalShippingMethod: true,
      shippingWeightConfirmedAt: true,
      shippingWeightSource: true,
      shopifyVariantCount: true,
      shopifyWeightSyncStatus: true,
      productEuStatus: true,
      countryPolicy: true,
      complianceProfile: true,
      vendorStore: {
        select: {
          id: true,
          storeName: true,
          ownerName: true,
          country: true,
          category: true,
          note: true,
          isTestStore: true,
          returnAddresses: true,
          vendorAuth: {
            select: {
              id: true,
              handle: true,
              storeName: true,
              managementEmail: true,
              status: true,
              seller: {
                select: {
                  id: true,
                   status: true,
                   euSellerStatus: true,
                   complianceProfile: true,
                   agreementAcceptances: true,
                   settlementControl: true,
                 },
              },
            },
          },
          seller: {
            select: {
              id: true,
               status: true,
               euSellerStatus: true,
               complianceProfile: true,
               agreementAcceptances: true,
               settlementControl: true,
             },
          },
        },
      },
    },
  });

  const governanceGateEnabled = isMarketplaceGovernanceGateEnabled(env);
  const shopifyPaymentsApproval = governanceGateEnabled
    ? getShopifyMarketplacePaymentsApproval(env)
    : null;

  if (governanceGateEnabled && !shopifyPaymentsApproval?.ready) {
    return {
      ok: false,
      error: CHECKOUT_UNAVAILABLE_MESSAGE,
    };
  }

  if (products.length !== uniqueProductIds.length) {
    if (governanceGateEnabled) {
      return {
        ok: false,
        error: UNAVAILABLE_PRODUCT_MESSAGE,
      };
    }
    return buildShopifyFallbackCheckoutPayload({
      request,
      resolvedVendorContext,
      submission,
      prismaClient,
      shopifyGraphQLWithOfflineSessionImpl,
      checkoutSource,
      env,
    });
  }

  const productsById = new Map(products.map((product) => [product.id, product]));
  const selectedProducts = [];

  for (const item of submission.items) {
    const product = productsById.get(item.productId);

    if (!product) {
      if (governanceGateEnabled) {
        return {
          ok: false,
          error: UNAVAILABLE_PRODUCT_MESSAGE,
        };
      }
      return buildShopifyFallbackCheckoutPayload({
        request,
        resolvedVendorContext,
        submission,
        prismaClient,
        shopifyGraphQLWithOfflineSessionImpl,
        checkoutSource,
        env,
      });
    }

    const shopDomain = normalizeShopDomain(product.shopDomain);
    const price = toDisplayPrice(product);

    if (!shopDomain || price <= 0) {
      return {
        ok: false,
        error: UNAVAILABLE_PRODUCT_MESSAGE,
      };
    }

    const inventoryQuantity = normalizeInventoryQuantity(product.inventoryQuantity);

    if (inventoryQuantity === null || inventoryQuantity < item.quantity) {
      return {
        ok: false,
        error: OUT_OF_STOCK_MESSAGE,
      };
    }

    const productVendorContext = buildVendorContextForCheckoutProduct(
      product,
      resolvedVendorContext,
    );

    if (!productVendorContext) {
      return {
        ok: false,
        error: UNAVAILABLE_PRODUCT_MESSAGE,
      };
    }

    if (governanceGateEnabled) {
      const seller =
        product.vendorStore?.seller ||
        product.vendorStore?.vendorAuth?.seller ||
        null;
      const sellerReadiness = evaluateSellerGovernanceReadiness(
        seller
          ? {
              ...seller,
              vendorStore: product.vendorStore,
            }
          : null,
        getSellerAgreementReadinessOptions(env),
      );
      const productReadiness = evaluateProductGovernanceReadiness(product);

      if (!sellerReadiness.ready || !productReadiness.ready) {
        return {
          ok: false,
          error: UNAVAILABLE_PRODUCT_MESSAGE,
        };
      }
    }

    selectedProducts.push({
      product: {
        ...product,
        inventoryQuantity,
        shopDomain,
        vendorStoreId: productVendorContext.store.id,
        vendorStoreName: productVendorContext.store.storeName,
        vendorHandle: productVendorContext.vendor.handle,
        sellerId: productVendorContext.vendor.sellerId || null,
        salesCreditEligible: true,
      },
      vendorContext: productVendorContext,
      quantity: item.quantity,
    });
  }

  const selectedVendorStoreIds = Array.from(
    new Set(
      selectedProducts
        .map(({ vendorContext: itemVendorContext }) =>
          normalizeText(itemVendorContext?.store?.id),
        )
        .filter(Boolean),
    ),
  );
  const isMultiSellerCheckout = selectedVendorStoreIds.length > 1;

  if (!selectedVendorStoreIds.includes(resolvedVendorContext.store.id)) {
    return {
      ok: false,
      error: INVALID_SELECTION_MESSAGE,
    };
  }

  if (isMultiSellerCheckout && !multiSellerStorefrontEnabled) {
    return {
      ok: false,
      error: CHECKOUT_UNAVAILABLE_MESSAGE,
    };
  }

  const shopDomains = Array.from(
    new Set(selectedProducts.map(({ product }) => normalizeShopDomain(product.shopDomain)).filter(Boolean)),
  );

  if (shopDomains.length !== 1) {
    return {
      ok: false,
      error: CHECKOUT_UNAVAILABLE_MESSAGE,
    };
  }

  const countryPolicy = isMultiSellerCheckout
    ? evaluateMultiSellerCheckoutCountryPolicy({
        selectedProducts,
        shippingCountry: submission.shippingAddress.countryCode,
        importResponsibilityAccepted: submission.importResponsibilityAccepted,
      })
    : evaluateCheckoutCountryPolicy({
        vendorContext: resolvedVendorContext,
        products: selectedProducts.map(({ product }) => product),
        shippingCountry: submission.shippingAddress.countryCode,
        importResponsibilityAccepted: submission.importResponsibilityAccepted,
      });

  if (!countryPolicy.ok) {
    return {
      ok: false,
      error: countryPolicy.error,
    };
  }

  const salesCredit = isMultiSellerCheckout && submission.salesCredit
    ? {
        ok: false,
        error: MULTI_SELLER_SALES_CREDIT_UNAVAILABLE_MESSAGE,
      }
    : await prepareCheckoutSalesCredit({
        request,
        submission,
        vendorContext: resolvedVendorContext,
        selectedProducts,
        prismaClient,
      });

  if (!salesCredit.ok) {
    return {
      ok: false,
      error: salesCredit.error,
    };
  }

  const checkoutReference = `checkout:${randomUUID()}`;
  const termsPresentedAt = new Date();

  if (governanceGateEnabled) {
    try {
      await recordMarketplaceCheckoutEvidence(
        {
          checkoutReference,
          shopDomain: shopDomains[0],
          presentedAt: termsPresentedAt,
          selectedProducts,
          env,
        },
        { prismaClient },
      );
    } catch (error) {
      console.error('marketplace checkout evidence write failed:', error);
      return {
        ok: false,
        error: CHECKOUT_UNAVAILABLE_MESSAGE,
      };
    }
  }

  const metadata = buildCheckoutMetadata(resolvedVendorContext, checkoutSource, {
    isMultiSeller: isMultiSellerCheckout,
  });
  const customAttributes = [
    ...buildCheckoutCustomAttributes(resolvedVendorContext, countryPolicy, {
      isMultiSeller: isMultiSellerCheckout,
      selectedProducts,
      checkoutReference,
      presentedAt: termsPresentedAt,
      env,
    }),
    ...salesCredit.customAttributes,
  ];

  return {
    ok: true,
    salesCreditOffset: salesCredit.offset,
    payload: {
      orderLike: {
        lines: selectedProducts.map(({ product, quantity }) =>
          buildServerTrustedCheckoutLine(product, quantity),
        ),
      },
      shippingAddress: submission.shippingAddress,
      customer: submission.customer,
      email: submission.customer.email,
      customerEmail: submission.customer.email,
      ...(submission.note ? { note: submission.note } : {}),
      shopDomain: shopDomains[0],
      tags: metadata.tags,
      customAttributes,
      ...(salesCredit.appliedDiscount
        ? { appliedDiscount: salesCredit.appliedDiscount }
        : {}),
      ...(countryPolicy.acceptance
        ? { buyerWarningAcceptance: countryPolicy.acceptance }
        : {}),
    },
  };
}

export async function buildDraftOrderCheckoutInputFromStorefrontForm({
  request = null,
  formData,
  vendorContext,
  prismaClient = prisma,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
  env = process.env,
}) {
  const submission = normalizeStorefrontCheckoutSubmission(formData);

  if (!submission.ok) {
    return submission;
  }

  const trustedPayload = await buildServerTrustedCheckoutPayload({
    request,
    vendorContext,
    submission: submission.submission,
    prismaClient,
    shopifyGraphQLWithOfflineSessionImpl,
    env,
  });

  if (!trustedPayload.ok) {
    return {
      ok: false,
      fieldErrors: {
        ...buildDefaultFieldErrors(),
        cart: trustedPayload.error,
      },
    };
  }

  return {
    ok: true,
    payload: trustedPayload.payload,
    salesCreditOffset: trustedPayload.salesCreditOffset || null,
  };
}

export async function buildDraftOrderCheckoutInputFromPublicRequest({
  request = null,
  body,
  prismaClient = prisma,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
  env = process.env,
}) {
  const submission = normalizePublicCheckoutSubmission(body);

  if (!submission.ok) {
    return submission;
  }

  const vendorContext = await getActiveVendorContextByHandle(
    submission.submission.vendorHandle,
    prismaClient,
  );

  if (!vendorContext) {
    return {
      ok: false,
      errors: [CHECKOUT_UNAVAILABLE_MESSAGE],
    };
  }

  const trustedPayload = await buildServerTrustedCheckoutPayload({
    request,
    vendorContext,
    submission: submission.submission,
    prismaClient,
    shopifyGraphQLWithOfflineSessionImpl,
    env,
  });

  if (!trustedPayload.ok) {
    return {
      ok: false,
      errors: [trustedPayload.error],
    };
  }

  return {
    ok: true,
    payload: trustedPayload.payload,
    salesCreditOffset: trustedPayload.salesCreditOffset || null,
  };
}

export function createVendorStorefrontLoader({
  prismaClient = prisma,
} = {}) {
  return async function loader({ params }) {
    const storefront = await getVendorStorefrontByHandle(params.handle, prismaClient);

    if (!storefront) {
      throw buildNotFoundResponse();
    }

    return json(storefront);
  };
}

export function createVendorStorefrontAction({
  prismaClient = prisma,
  draftOrderCheckoutImpl = draftOrderCheckout,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
  env = process.env,
} = {}) {
  return async function action({ request, params }) {
    const vendorContext = await getActiveVendorContextByHandle(params.handle, prismaClient);

    if (!vendorContext) {
      throw buildNotFoundResponse();
    }

    const formData = await request.formData();
    const checkoutInput = await buildDraftOrderCheckoutInputFromStorefrontForm({
      request,
      formData,
      vendorContext,
      prismaClient,
      shopifyGraphQLWithOfflineSessionImpl,
      env,
    });

    if (!checkoutInput.ok) {
      return buildInvalidPayloadResponse(checkoutInput.fieldErrors);
    }

    try {
      const result = await draftOrderCheckoutImpl(checkoutInput.payload);
      const invoiceUrl = normalizeText(result?.invoiceUrl || result?.draftOrder?.invoiceUrl);

      if (!invoiceUrl) {
        throw new Error('draftOrderCheckout did not return invoiceUrl');
      }

      await markCheckoutSalesCreditOffsetCreated({
        salesCreditOffset: checkoutInput.salesCreditOffset,
        checkoutResult: result,
        prismaClient,
      });

      await recordBuyerWarningAcceptance({
        prismaClient,
        acceptance: checkoutInput.payload.buyerWarningAcceptance,
        orderId: result?.draftOrder?.id,
        request,
      });

      return redirect(invoiceUrl);
    } catch (error) {
      await releaseCheckoutSalesCreditOffset({
        salesCreditOffset: checkoutInput.salesCreditOffset,
        prismaClient,
      });
      console.error('vendor storefront checkout error:', error);
      return buildPublicCheckoutErrorResponse(error);
    }
  };
}

export function createPublicVendorDraftOrderCheckoutAction({
  prismaClient = prisma,
  draftOrderCheckoutImpl = draftOrderCheckout,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
  env = process.env,
} = {}) {
  return async function action({ request }) {
    if (request.method !== 'POST') {
      return buildMethodNotAllowedResponse();
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return buildJsonInvalidPayloadResponse(['リクエスト形式を確認してください。']);
    }

    const checkoutInput = await buildDraftOrderCheckoutInputFromPublicRequest({
      request,
      body,
      prismaClient,
      shopifyGraphQLWithOfflineSessionImpl,
      env,
    });

    if (!checkoutInput.ok) {
      return buildJsonInvalidPayloadResponse(checkoutInput.errors);
    }

    try {
      const result = await draftOrderCheckoutImpl(checkoutInput.payload);

      await markCheckoutSalesCreditOffsetCreated({
        salesCreditOffset: checkoutInput.salesCreditOffset,
        checkoutResult: result,
        prismaClient,
      });

      await recordBuyerWarningAcceptance({
        prismaClient,
        acceptance: checkoutInput.payload.buyerWarningAcceptance,
        orderId: result?.draftOrder?.id,
        request,
      });

      const responsePayload = { ...result };

      if (checkoutInput.salesCreditOffset) {
        responsePayload.salesCredit = {
          offsetId: checkoutInput.salesCreditOffset.id,
          amount: checkoutInput.salesCreditOffset.amount,
        };
      }

      return json(responsePayload);
    } catch (error) {
      await releaseCheckoutSalesCreditOffset({
        salesCreditOffset: checkoutInput.salesCreditOffset,
        prismaClient,
      });
      console.error('public vendor checkout api error:', error);
      return buildPublicApiCheckoutErrorResponse(error);
    }
  };
}

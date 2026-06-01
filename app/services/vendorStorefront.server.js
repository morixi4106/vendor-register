import { json, redirect } from '@remix-run/node';

import prisma from '../db.server.js';
import { draftOrderCheckout } from './draftOrderCheckout.server.js';
import { shopifyGraphQLWithOfflineSession } from '../utils/shopifyAdmin.server.js';
import {
  BUYER_IMPORT_WARNING_VERSION,
  evaluateCartDeliveryEligibility,
} from '../utils/deliveryEligibility.js';

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
const INVALID_EMAIL_MESSAGE = 'メールアドレスの形式を確認してください。';
const VARIANT_REQUIRED_ERROR = 'variant_required';
const PUBLIC_CHECKOUT_SOURCE = 'vendor_storefront';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_ADMIN_API_VERSION = '2025-01';

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

function normalizeCountryCode(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toUpperCase() : null;
}

function normalizeShopDomain(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toLowerCase() : null;
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

function buildCheckoutMetadata(vendorContext, checkoutSource = PUBLIC_CHECKOUT_SOURCE) {
  return {
    tags: [
      checkoutSource.replaceAll('_', '-'),
      `vendor:${vendorContext.vendor.handle}`,
    ],
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

function buildCheckoutCustomAttributes(vendorContext, countryPolicy) {
  const attributes = [
    { key: 'seller_name', value: vendorContext.vendor.storeName },
    { key: 'seller_country', value: vendorContext.store.country || '' },
    { key: 'seller_of_record', value: 'marketplace_seller' },
  ];

  if (countryPolicy?.requiresWarning) {
    attributes.push(
      { key: 'buyer_import_warning_version', value: countryPolicy.acceptance.warningVersion },
      { key: 'buyer_import_responsibility_accepted', value: 'true' },
    );
  }

  return attributes;
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
        ipAddress:
          normalizeText(request?.headers?.get?.('x-forwarded-for')) ||
          normalizeText(request?.headers?.get?.('cf-connecting-ip')),
        userAgent: normalizeText(request?.headers?.get?.('user-agent')),
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
    price,
    calculatedPrice: price,
    shopifyProductId: normalizeText(product.id),
    shopifyVariantId: normalizeText(variant.id),
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
  resolvedVendorContext,
  submission,
  prismaClient = prisma,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
  checkoutSource = PUBLIC_CHECKOUT_SOURCE,
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

  const metadata = buildCheckoutMetadata(resolvedVendorContext, checkoutSource);

  return {
    ok: true,
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
      customAttributes: buildCheckoutCustomAttributes(
        resolvedVendorContext,
        countryPolicy,
      ),
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

  if (hasInvalidQuantity) {
    fieldErrors.cart = INVALID_QUANTITY_MESSAGE;
  } else if (items.length === 0) {
    fieldErrors.cart = INVALID_CART_MESSAGE;
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
    },
  };
}

async function buildServerTrustedCheckoutPayload({
  vendorContext,
  vendorHandle,
  submission,
  prismaClient = prisma,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
  checkoutSource = PUBLIC_CHECKOUT_SOURCE,
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
  const products = await prismaClient.product.findMany({
    where: {
      id: { in: uniqueProductIds },
      vendorStoreId: resolvedVendorContext.store.id,
      approvalStatus: 'approved',
    },
    select: {
      id: true,
      name: true,
      price: true,
      calculatedPrice: true,
      url: true,
      shopifyProductId: true,
      shopDomain: true,
      productEuStatus: true,
      countryPolicy: true,
    },
  });

  if (products.length !== uniqueProductIds.length) {
    return buildShopifyFallbackCheckoutPayload({
      resolvedVendorContext,
      submission,
      prismaClient,
      shopifyGraphQLWithOfflineSessionImpl,
      checkoutSource,
    });
  }

  const productsById = new Map(products.map((product) => [product.id, product]));
  const selectedProducts = [];

  for (const item of submission.items) {
    const product = productsById.get(item.productId);

    if (!product) {
      return buildShopifyFallbackCheckoutPayload({
        resolvedVendorContext,
        submission,
        prismaClient,
        shopifyGraphQLWithOfflineSessionImpl,
        checkoutSource,
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

    selectedProducts.push({
      product: {
        ...product,
        shopDomain,
      },
      quantity: item.quantity,
    });
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

  const metadata = buildCheckoutMetadata(resolvedVendorContext, checkoutSource);

  return {
    ok: true,
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
      customAttributes: buildCheckoutCustomAttributes(
        resolvedVendorContext,
        countryPolicy,
      ),
      ...(countryPolicy.acceptance
        ? { buyerWarningAcceptance: countryPolicy.acceptance }
        : {}),
    },
  };
}

export async function buildDraftOrderCheckoutInputFromStorefrontForm({
  formData,
  vendorContext,
  prismaClient = prisma,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
}) {
  const submission = normalizeStorefrontCheckoutSubmission(formData);

  if (!submission.ok) {
    return submission;
  }

  const trustedPayload = await buildServerTrustedCheckoutPayload({
    vendorContext,
    submission: submission.submission,
    prismaClient,
    shopifyGraphQLWithOfflineSessionImpl,
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
  };
}

export async function buildDraftOrderCheckoutInputFromPublicRequest({
  body,
  prismaClient = prisma,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
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
    vendorContext,
    submission: submission.submission,
    prismaClient,
    shopifyGraphQLWithOfflineSessionImpl,
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
} = {}) {
  return async function action({ request, params }) {
    const vendorContext = await getActiveVendorContextByHandle(params.handle, prismaClient);

    if (!vendorContext) {
      throw buildNotFoundResponse();
    }

    const formData = await request.formData();
    const checkoutInput = await buildDraftOrderCheckoutInputFromStorefrontForm({
      formData,
      vendorContext,
      prismaClient,
      shopifyGraphQLWithOfflineSessionImpl,
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

      await recordBuyerWarningAcceptance({
        prismaClient,
        acceptance: checkoutInput.payload.buyerWarningAcceptance,
        orderId: result?.draftOrder?.id,
        request,
      });

      return redirect(invoiceUrl);
    } catch (error) {
      console.error('vendor storefront checkout error:', error);
      return buildPublicCheckoutErrorResponse(error);
    }
  };
}

export function createPublicVendorDraftOrderCheckoutAction({
  prismaClient = prisma,
  draftOrderCheckoutImpl = draftOrderCheckout,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
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
      body,
      prismaClient,
      shopifyGraphQLWithOfflineSessionImpl,
    });

    if (!checkoutInput.ok) {
      return buildJsonInvalidPayloadResponse(checkoutInput.errors);
    }

    try {
      const result = await draftOrderCheckoutImpl(checkoutInput.payload);

      await recordBuyerWarningAcceptance({
        prismaClient,
        acceptance: checkoutInput.payload.buyerWarningAcceptance,
        orderId: result?.draftOrder?.id,
        request,
      });

      return json(result);
    } catch (error) {
      console.error('public vendor checkout api error:', error);
      return buildPublicApiCheckoutErrorResponse(error);
    }
  };
}

import { json } from '@remix-run/node';

import {
  buildShippingV2QuoteRequest,
  fetchShippingV2Quote,
} from './shippingV2Writer.server.js';
import {
  createShippingDiagnosticId,
  recordShippingDiagnosticEvent,
} from './shippingDiagnostics.server.js';
import { normalizeShopDomain, shopifyGraphQLWithOfflineSession } from '../utils/shopifyAdmin.server.js';
import prisma from '../db.server.js';
import {
  EU_COUNTRY_CODES,
  evaluateCartDeliveryEligibility,
} from '../utils/deliveryEligibility.js';
import { SHOPIFY_API_VERSION } from '../utils/shopifyApiVersion.js';

const CARRIER_SERVICE_NAME = 'Shipping V2';
// Keep carrier labels ASCII-encoded in source to avoid mojibake in deploy/log pipelines.
const CARRIER_SERVICE_DISPLAY_NAME = '\u5730\u57df\u5225\u914d\u9001';
const CARRIER_SERVICE_CODE = 'shipping_v2';
const CARRIER_SERVICE_DESCRIPTION =
  '\u914d\u9001\u5148\u306b\u57fa\u3065\u304f\u9001\u6599';
const DEFAULT_ADMIN_API_VERSION = SHOPIFY_API_VERSION;

const CARRIER_SERVICES_QUERY = `#graphql
  query ShippingV2CarrierServices {
    carrierServices(first: 20) {
      nodes {
        id
        name
        callbackUrl
        active
        supportsServiceDiscovery
      }
    }
  }
`;

const CARRIER_SERVICE_CREATE_MUTATION = `#graphql
  mutation ShippingV2CarrierServiceCreate($input: DeliveryCarrierServiceCreateInput!) {
    carrierServiceCreate(input: $input) {
      carrierService {
        id
        name
        callbackUrl
        active
        supportsServiceDiscovery
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CARRIER_SERVICE_UPDATE_MUTATION = `#graphql
  mutation ShippingV2CarrierServiceUpdate($input: DeliveryCarrierServiceUpdateInput!) {
    carrierServiceUpdate(input: $input) {
      carrierService {
        id
        name
        callbackUrl
        active
        supportsServiceDiscovery
      }
      userErrors {
        field
        message
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

function normalizeCountryCode(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toUpperCase() : null;
}

function toFiniteNumber(value) {
  if (value == null || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toPositiveInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function normalizeCarrierDestination(destination) {
  const normalized = isPlainObject(destination) ? destination : {};
  const postalCode = normalizeText(
    normalized.zip || normalized.postal_code || normalized.postalCode,
  );
  const country = normalizeCountryCode(
    normalized.country || normalized.country_code || normalized.countryCode,
  );

  return {
    postalCode,
    zip: postalCode,
    prefecture: normalizeText(normalized.province || normalized.prefecture),
    province: normalizeText(normalized.province || normalized.prefecture),
    city: normalizeText(normalized.city),
    country,
    countryCode: country,
  };
}

function normalizeShopifyProductGid(value) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('gid://shopify/Product/')) {
    return normalized;
  }

  if (/^\d+$/.test(normalized)) {
    return `gid://shopify/Product/${normalized}`;
  }

  return normalized;
}

function normalizeShopifyVariantGid(value) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('gid://shopify/ProductVariant/')) {
    return normalized;
  }

  if (/^\d+$/.test(normalized)) {
    return `gid://shopify/ProductVariant/${normalized}`;
  }

  return normalized;
}

function getCarrierProductIdCandidates(lines) {
  const candidates = new Set();

  for (const line of Array.isArray(lines) ? lines : []) {
    const productId = normalizeText(line?.productId);
    const productGid = normalizeShopifyProductGid(productId);

    if (productId) {
      candidates.add(productId);
    }

    if (productGid) {
      candidates.add(productGid);
    }
  }

  return Array.from(candidates);
}

function getCarrierVariantIdCandidates(lines) {
  const candidates = new Set();

  for (const line of Array.isArray(lines) ? lines : []) {
    const variantId = normalizeText(line?.variantId || line?.variant_id);
    const variantGid = normalizeShopifyVariantGid(variantId);

    if (variantId) {
      candidates.add(variantId);
    }

    if (variantGid) {
      candidates.add(variantGid);
    }
  }

  return Array.from(candidates);
}

function getCarrierProductReferences(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((line) => {
      const productId = normalizeText(line?.productId);
      const productGid = normalizeShopifyProductGid(productId);
      const variantId = normalizeText(line?.variantId || line?.variant_id);
      const variantGid = normalizeShopifyVariantGid(variantId);

      if (!productId && !productGid && !variantId && !variantGid) {
        return null;
      }

      return {
        productId,
        productGid,
        variantId,
        variantGid,
      };
    })
    .filter(Boolean);
}

function productMatchesCarrierReference(product, reference) {
  const shopifyProductId = normalizeText(product?.shopifyProductId);
  const shopifyVariantId = normalizeText(product?.shopifyVariantId);

  return Boolean(
    (shopifyProductId &&
      (shopifyProductId === reference.productId ||
        shopifyProductId === reference.productGid)) ||
      (shopifyVariantId &&
        (shopifyVariantId === reference.variantId ||
          shopifyVariantId === reference.variantGid)),
  );
}

function getProductVendorStoreId(product) {
  return normalizeText(product?.vendorStoreId || product?.vendorStore?.id);
}

function findCarrierLineProducts(products, line) {
  const reference = {
    productId: normalizeText(line?.productId),
    productGid: normalizeShopifyProductGid(line?.productId),
    variantId: normalizeText(line?.variantId),
    variantGid: normalizeShopifyVariantGid(line?.variantId),
  };
  const variantMatches = products.filter((product) => {
    const shopifyVariantId = normalizeText(product?.shopifyVariantId);
    return Boolean(
      shopifyVariantId &&
        (shopifyVariantId === reference.variantId ||
          shopifyVariantId === reference.variantGid),
    );
  });

  if (variantMatches.length > 0) {
    return variantMatches;
  }

  return products.filter((product) =>
    productMatchesCarrierReference(product, reference),
  );
}

export async function resolveCarrierFulfillmentOwnership({
  quoteRequest,
  prismaClient = prisma,
} = {}) {
  const lines = Array.isArray(quoteRequest?.orderLike?.lines)
    ? quoteRequest.orderLike.lines
    : [];
  const shippableLines = lines.filter(
    (line) => line?.requiresShipping !== false && Number(line?.quantity || 0) > 0,
  );

  if (shippableLines.length === 0) {
    return { ok: true, quoteRequest, matchedProductCount: 0 };
  }

  const productIdCandidates = getCarrierProductIdCandidates(shippableLines);
  const variantIdCandidates = getCarrierVariantIdCandidates(shippableLines);
  const productWhereClauses = [];

  if (productIdCandidates.length > 0) {
    productWhereClauses.push({ shopifyProductId: { in: productIdCandidates } });
  }
  if (variantIdCandidates.length > 0) {
    productWhereClauses.push({ shopifyVariantId: { in: variantIdCandidates } });
  }
  if (productWhereClauses.length === 0) {
    return {
      ok: false,
      reason: 'missing_product_reference',
      quoteRequest,
    };
  }

  const shopDomain = normalizeShopDomain(quoteRequest?.shopDomain);
  const products = await prismaClient.product.findMany({
    where: {
      OR: productWhereClauses,
      ...(shopDomain
        ? { shopDomain: { in: [shopDomain, null] } }
        : {}),
    },
    select: {
      id: true,
      shopifyProductId: true,
      shopifyVariantId: true,
      vendorStoreId: true,
      vendorStore: {
        select: {
          id: true,
          isPlatformStore: true,
        },
      },
    },
  });
  const resolvedLines = [];

  for (const line of lines) {
    if (line?.requiresShipping === false || Number(line?.quantity || 0) <= 0) {
      resolvedLines.push(line);
      continue;
    }

    const matches = findCarrierLineProducts(products, line);
    const vendorStoreIds = Array.from(
      new Set(matches.map(getProductVendorStoreId).filter(Boolean)),
    );

    if (vendorStoreIds.length === 0) {
      return {
        ok: false,
        reason: 'unmanaged_product',
        productId: normalizeText(line?.productId),
        variantId: normalizeText(line?.variantId),
        quoteRequest,
      };
    }
    if (vendorStoreIds.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous_product_owner',
        productId: normalizeText(line?.productId),
        variantId: normalizeText(line?.variantId),
        vendorStoreIds,
        quoteRequest,
      };
    }

    const vendorStoreId = vendorStoreIds[0];
    resolvedLines.push({
      ...line,
      shipFromId: vendorStoreId,
      directShipGroup: vendorStoreId,
      shippingClass: line.shippingClass || 'direct',
    });
  }

  return {
    ok: true,
    quoteRequest: {
      ...quoteRequest,
      orderLike: {
        ...quoteRequest.orderLike,
        lines: resolvedLines,
      },
    },
    matchedProductCount: products.length,
  };
}

export async function validateCarrierEuDeliveryPolicy({
  quoteRequest,
  prismaClient = prisma,
} = {}) {
  const countryCode = normalizeCountryCode(
    quoteRequest?.shippingAddress?.countryCode ||
      quoteRequest?.shippingAddress?.country,
  );

  if (!countryCode || !EU_COUNTRY_CODES.has(countryCode)) {
    return {
      ok: true,
      reason: null,
      checked: false,
    };
  }

  const lines = Array.isArray(quoteRequest?.orderLike?.lines)
    ? quoteRequest.orderLike.lines
    : [];
  const productIdCandidates = getCarrierProductIdCandidates(lines);
  const variantIdCandidates = getCarrierVariantIdCandidates(lines);
  const productReferences = getCarrierProductReferences(lines);

  if (productReferences.length === 0) {
    return {
      ok: false,
      reason: 'missing_product_reference',
      checked: true,
      countryCode,
      productCount: 0,
    };
  }

  const productWhereClauses = [];

  if (productIdCandidates.length > 0) {
    productWhereClauses.push({
      shopifyProductId: {
        in: productIdCandidates,
      },
    });
  }

  if (variantIdCandidates.length > 0) {
    productWhereClauses.push({
      shopifyVariantId: {
        in: variantIdCandidates,
      },
    });
  }

  const products = await prismaClient.product.findMany({
    where: {
      OR: productWhereClauses,
    },
    select: {
      id: true,
      shopifyProductId: true,
      shopifyVariantId: true,
      productEuStatus: true,
      approvalStatus: true,
      countryPolicy: true,
      vendorStore: {
        select: {
          vendorAuth: {
            select: {
              id: true,
              handle: true,
              seller: {
                select: {
                  id: true,
                  euSellerStatus: true,
                },
              },
            },
          },
        },
      },
    },
  });

  const missingReference = productReferences.find(
    (reference) =>
      !products.some((product) => productMatchesCarrierReference(product, reference)),
  );

  if (missingReference) {
    return {
      ok: false,
      reason: 'unmanaged_product',
      countryCode,
      checked: true,
      productId: missingReference.productId,
      shopifyProductId: missingReference.productGid,
      shopifyVariantId: missingReference.variantGid,
      productCount: products.length,
    };
  }

  const cartPolicy = evaluateCartDeliveryEligibility({
    products,
    deliveryCountry: countryCode,
    importResponsibilityAccepted: true,
  });

  if (!cartPolicy.ok) {
    const blocker = cartPolicy.blocker;

    if (blocker) {
      return {
        ok: false,
        reason: blocker.reason,
        countryCode,
        productId: blocker.productId,
        shopifyProductId: blocker.shopifyProductId,
        shopifyVariantId: blocker.shopifyVariantId || null,
        sellerEuStatus: blocker.sellerEuStatus || null,
        productEuStatus: blocker.productEuStatus || null,
        productCount: products.length,
      };
    }

    return {
      ok: false,
      reason: cartPolicy.reason,
      countryCode,
      checked: true,
      productCount: products.length,
    };
  }

  return {
    ok: true,
    reason: null,
    checked: true,
    countryCode,
    productCount: products.length,
  };
}

function toMajorCurrencyAmountFromCarrierPrice(price) {
  const numeric = toFiniteNumber(price);

  if (numeric == null) {
    return null;
  }

  return numeric / 100;
}

function normalizeCarrierItem(item, index) {
  const quantity = toPositiveInteger(item?.quantity) || 1;
  const price = toMajorCurrencyAmountFromCarrierPrice(item?.price);
  const grams = toFiniteNumber(item?.grams);
  const lineAmount = price == null ? null : price * quantity;

  return {
    lineId: normalizeText(item?.id || item?.line_item_id || item?.variant_id || `carrier-line-${index}`),
    productId: normalizeText(item?.product_id),
    variantId: normalizeText(item?.variant_id),
    skuId: normalizeText(item?.sku),
    vendor: normalizeText(item?.vendor),
    title: normalizeText(item?.name || item?.title),
    quantity,
    requiresShipping: item?.requires_shipping !== false,
    ...(grams == null ? {} : { grams }),
    ...(lineAmount == null
      ? {}
      : { amountAfterItemDiscountBeforeOrderCoupon: lineAmount }),
  };
}

export function buildCarrierShippingV2QuoteRequest(carrierRequest) {
  const rate = isPlainObject(carrierRequest?.rate) ? carrierRequest.rate : {};
  const destination = normalizeCarrierDestination(rate.destination);
  const items = Array.isArray(rate.items) ? rate.items : [];

  return buildShippingV2QuoteRequest({
    lines: items.map(normalizeCarrierItem),
    shippingAddress: destination,
    shopDomain: normalizeShopDomain(rate.shop_domain || carrierRequest?.shop_domain),
  });
}

function getQuoteShippingAmount(quoteResponse) {
  const amount = toFiniteNumber(quoteResponse?.result?.totalShippingFee);
  return amount == null ? null : amount;
}

function summarizeCarrierDestination(destination) {
  const normalized = isPlainObject(destination) ? destination : {};

  return {
    country: normalizeText(normalized.country || normalized.country_code || normalized.countryCode),
    postalCode: normalizeText(normalized.zip || normalized.postal_code || normalized.postalCode),
    province: normalizeText(normalized.province || normalized.prefecture),
    city: normalizeText(normalized.city),
  };
}

function summarizeCarrierItems(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    productId: normalizeText(item?.product_id),
    variantId: normalizeText(item?.variant_id),
    skuId: normalizeText(item?.sku),
    vendor: normalizeText(item?.vendor),
    title: normalizeText(item?.name || item?.title),
    quantity: toPositiveInteger(item?.quantity) || 1,
    price: toMajorCurrencyAmountFromCarrierPrice(item?.price),
    grams: toFiniteNumber(item?.grams),
    requiresShipping: item?.requires_shipping !== false,
  }));
}

function summarizeQuoteRequest(quoteRequest) {
  const lines = Array.isArray(quoteRequest?.orderLike?.lines)
    ? quoteRequest.orderLike.lines
    : [];

  return {
    shippingAddress: quoteRequest?.shippingAddress || null,
    shopDomain: quoteRequest?.shopDomain || null,
    lineCount: lines.length,
    lines: lines.map((line) => ({
      productId: line.productId || null,
      variantId: line.variantId || null,
      skuId: line.skuId || null,
      vendor: line.vendor || null,
      quantity: line.quantity || null,
      requiresShipping: line.requiresShipping !== false,
      amountAfterItemDiscountBeforeOrderCoupon:
        line.amountAfterItemDiscountBeforeOrderCoupon ?? null,
      grams: line.grams ?? null,
    })),
  };
}

function summarizeQuoteLine(line) {
  return {
    productId: line?.productId || null,
    variantId: line?.variantId || null,
    skuId: line?.skuId || null,
    quantity: line?.quantity || null,
    shippingClass: line?.shippingClass || null,
    temperatureZone: line?.temperatureZone || null,
    leadTimeBucket: line?.leadTimeBucket || null,
    shipFromId: line?.shipFromId || null,
    forceSeparateShipment: line?.forceSeparateShipment ?? null,
    freeShippingEligible: line?.freeShippingEligible ?? null,
    shippingPoint: line?.shippingPoint ?? null,
    totalShippingPoint: line?.totalShippingPoint ?? null,
    amountAfterItemDiscountBeforeOrderCoupon:
      line?.amountAfterItemDiscountBeforeOrderCoupon ?? null,
    appliedLineRuleId: line?.appliedLineRuleId || null,
  };
}

function summarizeQuoteGroups(groups) {
  return (Array.isArray(groups) ? groups : []).map((group) => ({
    groupId: group?.groupId || null,
    mode: group?.mode || null,
    regionTier: group?.regionTier || null,
    packageCount: group?.packageCount ?? null,
    fee: group?.fee ?? null,
    originalFee: group?.originalFee ?? null,
    isDeliverable: group?.isDeliverable ?? null,
    isFreeShippingApplied: group?.isFreeShippingApplied ?? null,
    totalShippingPoint: group?.totalShippingPoint ?? null,
    totalWeightGrams: group?.totalWeightGrams ?? null,
    shipFromId: group?.shipFromId || null,
    temperatureZone: group?.temperatureZone || null,
    leadTimeBucket: group?.leadTimeBucket || null,
    messages: Array.isArray(group?.messages) ? group.messages : [],
    lineCount: Array.isArray(group?.lines) ? group.lines.length : 0,
    lines: (Array.isArray(group?.lines) ? group.lines : []).map(summarizeQuoteLine),
  }));
}

function summarizeQuoteResponse(quoteResponse) {
  return {
    ok: quoteResponse?.ok ?? null,
    enabled: quoteResponse?.enabled ?? null,
    reason: quoteResponse?.reason ?? null,
    isPendingAddress: quoteResponse?.result?.isPendingAddress ?? null,
    isDeliverable: quoteResponse?.result?.isDeliverable ?? null,
    totalShippingFee: quoteResponse?.result?.totalShippingFee ?? null,
    currencyCode: quoteResponse?.result?.currencyCode ?? null,
    shippingGroups: summarizeQuoteGroups(quoteResponse?.debug?.groups),
    debug: quoteResponse?.debug ?? null,
  };
}

export function getCarrierRatesEmptyReason(quoteResponse) {
  if (!isPlainObject(quoteResponse) || quoteResponse.ok !== true) {
    return 'invalid_quote_response';
  }

  if (quoteResponse.enabled === false || quoteResponse.reason === 'shipping_v2_disabled') {
    return 'shipping_v2_disabled';
  }

  if (quoteResponse.result?.isPendingAddress === true) {
    return 'pending_address';
  }

  if (quoteResponse.result?.isDeliverable === false) {
    return 'undeliverable';
  }

  if (!toShopifyCarrierSubunits(getQuoteShippingAmount(quoteResponse))) {
    return 'missing_total_shipping_fee';
  }

  return null;
}

export function toShopifyCarrierSubunits(amount) {
  const numeric = toFiniteNumber(amount);

  if (numeric == null || numeric < 0) {
    return null;
  }

  return String(Math.round(numeric * 100));
}

export function buildCarrierRatesResponse({ quoteResponse, currency }) {
  const emptyReason = getCarrierRatesEmptyReason(quoteResponse);

  if (emptyReason) {
    return { rates: [] };
  }

  const totalPrice = toShopifyCarrierSubunits(getQuoteShippingAmount(quoteResponse));

  return {
    rates: [
      {
        service_name: CARRIER_SERVICE_DISPLAY_NAME,
        service_code: CARRIER_SERVICE_CODE,
        total_price: totalPrice,
        currency: normalizeText(currency)?.toUpperCase() || 'JPY',
        description: CARRIER_SERVICE_DESCRIPTION,
      },
    ],
  };
}

function buildRequestDebugInfo({ request, rawBody }) {
  return {
    method: request.method,
    url: request.url,
    contentType: request.headers.get('content-type') || '',
    rawBodyLength: rawBody.length,
    rawBodyPreview: rawBody.slice(0, 200),
  };
}

function recordCarrierDiagnostic({ requestId, level = 'info', message, details }) {
  recordShippingDiagnosticEvent({
    requestId,
    source: 'carrier',
    level,
    message,
    details,
  });
}

function logCarrierRequest({ logInfo, message, request, rawBody = '' }) {
  logInfo?.(message, buildRequestDebugInfo({ request, rawBody }));
}

export function createCarrierShippingRatesLoader({ logInfo = console.log } = {}) {
  return async function loader({ request }) {
    logCarrierRequest({
      logInfo,
      message: 'carrier shipping rates health check:',
      request,
    });

    return json({
      ok: true,
      rates: [],
      service: CARRIER_SERVICE_NAME,
    });
  };
}

export function createCarrierShippingRatesAction({
  fetchShippingV2QuoteImpl = fetchShippingV2Quote,
  resolveCarrierFulfillmentOwnershipImpl = resolveCarrierFulfillmentOwnership,
  prismaClient = prisma,
  logInfo = console.log,
  logError = console.error,
} = {}) {
  return async function action({ request }) {
    const requestId = createShippingDiagnosticId('carrier');
    const rawBody = await request.text();
    const debugInfo = buildRequestDebugInfo({ request, rawBody });

    logInfo?.('carrier shipping rates request:', { requestId, ...debugInfo });
    recordCarrierDiagnostic({
      requestId,
      message: 'request_received',
      details: debugInfo,
    });

    if (!rawBody) {
      logError?.('carrier shipping rates empty body:', { requestId, ...debugInfo });
      recordCarrierDiagnostic({
        requestId,
        level: 'warn',
        message: 'empty_body',
        details: debugInfo,
      });
      return json({ rates: [] });
    }

    let body;

    try {
      body = JSON.parse(rawBody);
    } catch (error) {
      logError?.('carrier shipping rates invalid json:', {
        requestId,
        ...debugInfo,
        error: error instanceof Error ? error.message : String(error),
      });
      recordCarrierDiagnostic({
        requestId,
        level: 'warn',
        message: 'invalid_json',
        details: {
          ...debugInfo,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return json({ rates: [] });
    }

    const rate = isPlainObject(body?.rate) ? body.rate : {};
    let quoteRequest = buildCarrierShippingV2QuoteRequest(body);
    const parsedSummary = {
      destination: summarizeCarrierDestination(rate.destination),
      items: summarizeCarrierItems(rate.items),
    };
    let ownershipResolution;

    try {
      ownershipResolution = await resolveCarrierFulfillmentOwnershipImpl({
        quoteRequest,
        prismaClient,
      });
    } catch (error) {
      logError?.('carrier shipping rates ownership lookup failed:', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      recordCarrierDiagnostic({
        requestId,
        level: 'error',
        message: 'ownership_lookup_failed',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return json({ rates: [] });
    }

    if (!ownershipResolution.ok) {
      logInfo?.('carrier shipping rates blocked by product ownership:', {
        requestId,
        ...ownershipResolution,
        quoteRequest: undefined,
      });
      recordCarrierDiagnostic({
        requestId,
        level: 'warn',
        message: 'product_ownership_unresolved',
        details: {
          reason: ownershipResolution.reason,
          productId: ownershipResolution.productId || null,
          variantId: ownershipResolution.variantId || null,
          vendorStoreIds: ownershipResolution.vendorStoreIds || [],
        },
      });
      return json({ rates: [] });
    }

    quoteRequest = ownershipResolution.quoteRequest;
    const quoteRequestSummary = summarizeQuoteRequest(quoteRequest);

    logInfo?.('carrier shipping rates parsed payload:', {
      requestId,
      ...parsedSummary,
    });
    logInfo?.('carrier shipping rates quote request:', {
      requestId,
      ...quoteRequestSummary,
    });
    recordCarrierDiagnostic({
      requestId,
      message: 'payload_normalized',
      details: {
        parsed: parsedSummary,
        quoteRequest: quoteRequestSummary,
      },
    });

    try {
      const euDeliveryPolicy = await validateCarrierEuDeliveryPolicy({
        quoteRequest,
        prismaClient,
      });

      if (!euDeliveryPolicy.ok) {
        logInfo?.('carrier shipping rates blocked by eu delivery policy:', {
          requestId,
          ...euDeliveryPolicy,
        });
        recordCarrierDiagnostic({
          requestId,
          level: 'warn',
          message: 'eu_delivery_blocked',
          details: {
            policy: euDeliveryPolicy,
            quoteRequest: quoteRequestSummary,
          },
        });
        return json({ rates: [] });
      }

      const quoteResponse = await fetchShippingV2QuoteImpl({
        quoteRequest,
        diagnosticRequestId: requestId,
      });
      const ratesResponse = buildCarrierRatesResponse({
        quoteResponse,
        currency: rate.currency,
      });
      const emptyRatesReason = ratesResponse.rates.length === 0
        ? getCarrierRatesEmptyReason(quoteResponse) || 'empty_rates'
        : null;
      const quoteResponseSummary = summarizeQuoteResponse(quoteResponse);

      logInfo?.('carrier shipping rates quote response:', {
        requestId,
        emptyRatesReason,
        ...quoteResponseSummary,
      });
      logInfo?.('carrier shipping rates response:', { requestId, ...ratesResponse });
      recordCarrierDiagnostic({
        requestId,
        level: emptyRatesReason ? 'warn' : 'info',
        message: emptyRatesReason ? 'empty_rates' : 'rates_returned',
        details: {
          emptyRatesReason,
          quoteResponse: quoteResponseSummary,
          ratesResponse,
        },
      });
      return json(ratesResponse);
    } catch (error) {
      logError?.('carrier shipping rates quote_error:', {
        requestId,
        ...debugInfo,
        quoteRequest: quoteRequestSummary,
        error: error instanceof Error ? error.message : String(error),
      });
      recordCarrierDiagnostic({
        requestId,
        level: 'error',
        message: 'quote_error',
        details: {
          quoteRequest: quoteRequestSummary,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return json({ rates: [] });
    }
  };
}

export function getCarrierCallbackUrl(appUrl) {
  const normalizedAppUrl = normalizeText(appUrl || process.env.APP_URL);

  if (!normalizedAppUrl) {
    throw new Error('APP_URL is required to register the CarrierService');
  }

  return `${normalizedAppUrl.replace(/\/+$/, '')}/carrier/shipping-rates`;
}

function getCarrierUserErrors(payload, key) {
  const errors = payload?.[key]?.userErrors;
  return Array.isArray(errors) ? errors : [];
}

function assertNoCarrierUserErrors(payload, key) {
  const errors = getCarrierUserErrors(payload, key);

  if (errors.length > 0) {
    throw new Error(`CarrierService registration failed: ${JSON.stringify(errors)}`);
  }
}

export async function upsertShippingV2CarrierService({
  shopDomain,
  appUrl = process.env.APP_URL,
  apiVersion = DEFAULT_ADMIN_API_VERSION,
  shopifyGraphQLWithOfflineSessionImpl = shopifyGraphQLWithOfflineSession,
} = {}) {
  const callbackUrl = getCarrierCallbackUrl(appUrl);
  const listResult = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion,
    query: CARRIER_SERVICES_QUERY,
  });
  const services = Array.isArray(listResult.data?.carrierServices?.nodes)
    ? listResult.data.carrierServices.nodes
    : [];
  const existing = services.find((service) => service?.name === CARRIER_SERVICE_NAME);

  if (existing) {
    const updateResult = await shopifyGraphQLWithOfflineSessionImpl({
      shopDomain,
      apiVersion,
      query: CARRIER_SERVICE_UPDATE_MUTATION,
      variables: {
        input: {
          id: existing.id,
          name: CARRIER_SERVICE_NAME,
          callbackUrl,
          active: true,
          supportsServiceDiscovery: true,
        },
      },
    });

    assertNoCarrierUserErrors(updateResult.data, 'carrierServiceUpdate');

    return {
      ok: true,
      operation: 'updated',
      carrierService: updateResult.data?.carrierServiceUpdate?.carrierService,
      callbackUrl,
    };
  }

  const createResult = await shopifyGraphQLWithOfflineSessionImpl({
    shopDomain,
    apiVersion,
    query: CARRIER_SERVICE_CREATE_MUTATION,
    variables: {
      input: {
        name: CARRIER_SERVICE_NAME,
        callbackUrl,
        active: true,
        supportsServiceDiscovery: true,
      },
    },
  });

  assertNoCarrierUserErrors(createResult.data, 'carrierServiceCreate');

  return {
    ok: true,
    operation: 'created',
    carrierService: createResult.data?.carrierServiceCreate?.carrierService,
    callbackUrl,
  };
}

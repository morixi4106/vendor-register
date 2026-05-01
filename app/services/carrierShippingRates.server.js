import { json } from '@remix-run/node';

import {
  buildShippingV2QuoteRequest,
  fetchShippingV2Quote,
} from './shippingV2Writer.server.js';
import { normalizeShopDomain, shopifyGraphQLWithOfflineSession } from '../utils/shopifyAdmin.server.js';

const CARRIER_SERVICE_NAME = 'Shipping V2';
const CARRIER_SERVICE_CODE = 'shipping_v2';
const CARRIER_SERVICE_DESCRIPTION = 'Calculated shipping';
const DEFAULT_ADMIN_API_VERSION = '2025-01';

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

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toPositiveInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function normalizeCarrierDestination(destination) {
  const normalized = isPlainObject(destination) ? destination : {};

  return {
    postalCode: normalizeText(normalized.zip || normalized.postalCode),
    zip: normalizeText(normalized.zip || normalized.postalCode),
    prefecture: normalizeText(normalized.province || normalized.prefecture),
    province: normalizeText(normalized.province || normalized.prefecture),
    city: normalizeText(normalized.city),
    country: normalizeText(normalized.country || normalized.countryCode),
    countryCode: normalizeText(normalized.country || normalized.countryCode),
  };
}

function normalizeCarrierItem(item, index) {
  const quantity = toPositiveInteger(item?.quantity) || 1;
  const price = toFiniteNumber(item?.price);
  const lineAmount = price == null ? null : price * quantity;

  return {
    lineId: normalizeText(item?.id || item?.line_item_id || item?.variant_id || `carrier-line-${index}`),
    productId: normalizeText(item?.product_id),
    variantId: normalizeText(item?.variant_id),
    quantity,
    requiresShipping: item?.requires_shipping !== false,
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

export function toShopifyCarrierSubunits(amount) {
  const numeric = toFiniteNumber(amount);

  if (numeric == null || numeric < 0) {
    return null;
  }

  return String(Math.round(numeric * 100));
}

export function buildCarrierRatesResponse({ quoteResponse, currency }) {
  if (!isPlainObject(quoteResponse) || quoteResponse.ok !== true) {
    return { rates: [] };
  }

  if (quoteResponse.enabled === false || quoteResponse.reason === 'shipping_v2_disabled') {
    return { rates: [] };
  }

  if (quoteResponse.result?.isPendingAddress === true) {
    return { rates: [] };
  }

  if (quoteResponse.result?.isDeliverable === false) {
    return { rates: [] };
  }

  const totalPrice = toShopifyCarrierSubunits(getQuoteShippingAmount(quoteResponse));

  if (!totalPrice) {
    return { rates: [] };
  }

  return {
    rates: [
      {
        service_name: CARRIER_SERVICE_NAME,
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
  logInfo = console.log,
  logError = console.error,
} = {}) {
  return async function action({ request }) {
    const rawBody = await request.text();
    const debugInfo = buildRequestDebugInfo({ request, rawBody });

    logInfo?.('carrier shipping rates request:', debugInfo);

    if (!rawBody) {
      logError?.('carrier shipping rates empty body:', debugInfo);
      return json({ rates: [] });
    }

    let body;

    try {
      body = JSON.parse(rawBody);
    } catch (error) {
      logError?.('carrier shipping rates invalid json:', {
        ...debugInfo,
        error: error instanceof Error ? error.message : String(error),
      });
      return json({ rates: [] });
    }

    const rate = isPlainObject(body?.rate) ? body.rate : {};
    const quoteRequest = buildCarrierShippingV2QuoteRequest(body);

    logInfo?.('carrier shipping rates parsed payload:', {
      destination: rate.destination || null,
      items: Array.isArray(rate.items) ? rate.items : [],
    });
    logInfo?.('carrier shipping rates quote request:', quoteRequest);

    try {
      const quoteResponse = await fetchShippingV2QuoteImpl({ quoteRequest });
      const ratesResponse = buildCarrierRatesResponse({
        quoteResponse,
        currency: rate.currency,
      });

      logInfo?.('carrier shipping rates response:', ratesResponse);
      return json(ratesResponse);
    } catch (error) {
      logError?.('carrier shipping rates quote_error:', {
        ...debugInfo,
        quoteRequest,
        error: error instanceof Error ? error.message : String(error),
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

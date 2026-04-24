import { normalizeShopDomain } from '../utils/shopifyAdmin.server.js';

const DEFAULT_SHIPPING_V2_QUOTE_TIMEOUT_MS = 5000;

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

function clonePayload(payload) {
  return isPlainObject(payload) ? { ...payload } : {};
}

function normalizeShippingAddress(shippingAddress) {
  if (!isPlainObject(shippingAddress)) {
    return {};
  }

  const normalized = { ...shippingAddress };

  if (normalized.postalCode == null && normalized.zip != null) {
    normalized.postalCode = normalized.zip;
  }

  if (normalized.prefecture == null && normalized.province != null) {
    normalized.prefecture = normalized.province;
  }

  return normalized;
}

function buildShippingV2QuoteLine(line) {
  if (!isPlainObject(line)) {
    return {};
  }

  const normalized = {};

  if (normalizeText(line.lineId) || normalizeText(line.id) || normalizeText(line.cartLineId)) {
    normalized.lineId =
      normalizeText(line.lineId) ||
      normalizeText(line.id) ||
      normalizeText(line.cartLineId);
  }

  if (normalizeText(line.variantId) || normalizeText(line.merchandiseId)) {
    normalized.variantId =
      normalizeText(line.variantId) ||
      normalizeText(line.merchandiseId);
  }

  if (normalizeText(line.productId)) {
    normalized.productId = normalizeText(line.productId);
  }

  if (normalizeText(line.skuId) || normalizeText(line.sku)) {
    normalized.skuId = normalizeText(line.skuId) || normalizeText(line.sku);
  }

  if (toFiniteNumber(line.quantity ?? line.qty) != null) {
    normalized.quantity = toFiniteNumber(line.quantity ?? line.qty);
  }

  if (
    toFiniteNumber(
      line.amountAfterItemDiscountBeforeOrderCoupon ??
        line.discountedAmount ??
        line.lineAmount,
    ) != null
  ) {
    normalized.amountAfterItemDiscountBeforeOrderCoupon = toFiniteNumber(
      line.amountAfterItemDiscountBeforeOrderCoupon ??
        line.discountedAmount ??
        line.lineAmount,
    );
  }

  if (line.requiresShipping != null) {
    normalized.requiresShipping = Boolean(line.requiresShipping);
  }

  return normalized;
}

function buildFallbackResult({
  payload,
  legacyShippingAmount,
  reason,
  quoteRequest,
  quoteResponse = null,
  error = null,
}) {
  return {
    applied: false,
    reason,
    payload: clonePayload(payload),
    shippingAmount: legacyShippingAmount,
    quoteRequest,
    quoteResponse,
    ...(error ? { error } : {}),
  };
}

export function buildShippingV2QuoteRequest({
  lines,
  shippingAddress,
  shopDomain,
}) {
  return {
    orderLike: {
      lines: Array.isArray(lines) ? lines.map(buildShippingV2QuoteLine) : [],
    },
    shippingAddress: normalizeShippingAddress(shippingAddress),
    shopDomain: normalizeShopDomain(shopDomain),
  };
}

export async function fetchShippingV2Quote({
  quoteRequest,
  quoteUrl = process.env.SHIPPING_V2_QUOTE_URL,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_SHIPPING_V2_QUOTE_TIMEOUT_MS,
}) {
  const normalizedQuoteUrl = normalizeText(quoteUrl);

  if (!normalizedQuoteUrl) {
    throw new Error('SHIPPING_V2_QUOTE_URL is not configured');
  }

  const response = await fetchImpl(normalizedQuoteUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(quoteRequest),
    ...(timeoutMs > 0 && typeof AbortSignal?.timeout === 'function'
      ? { signal: AbortSignal.timeout(timeoutMs) }
      : {}),
  });

  let payload;

  try {
    payload = await response.json();
  } catch {
    throw new Error(`Shipping V2 quote response must be valid JSON (${response.status})`);
  }

  if (!response.ok) {
    throw new Error(`Shipping V2 quote request failed with status ${response.status}`);
  }

  return payload;
}

export function applyShippingV2QuoteToPayload({
  payload,
  legacyShippingAmount,
  quoteRequest,
  quoteResponse,
  shippingAmountField = 'shippingAmount',
}) {
  if (!isPlainObject(quoteResponse) || quoteResponse.ok !== true) {
    return buildFallbackResult({
      payload,
      legacyShippingAmount,
      reason: 'invalid_quote_response',
      quoteRequest,
      quoteResponse,
    });
  }

  if (quoteResponse.enabled === false || quoteResponse.reason === 'shipping_v2_disabled') {
    return buildFallbackResult({
      payload,
      legacyShippingAmount,
      reason: 'shipping_v2_disabled',
      quoteRequest,
      quoteResponse,
    });
  }

  if (quoteResponse.result?.isPendingAddress === true) {
    return buildFallbackResult({
      payload,
      legacyShippingAmount,
      reason: 'pending_address',
      quoteRequest,
      quoteResponse,
    });
  }

  if (quoteResponse.result?.isDeliverable === false) {
    return buildFallbackResult({
      payload,
      legacyShippingAmount,
      reason: 'undeliverable',
      quoteRequest,
      quoteResponse,
    });
  }

  const shippingAmount = toFiniteNumber(quoteResponse?.result?.totalShippingFee);

  if (shippingAmount == null) {
    return buildFallbackResult({
      payload,
      legacyShippingAmount,
      reason: 'invalid_quote_response',
      quoteRequest,
      quoteResponse,
    });
  }

  const nextPayload = clonePayload(payload);

  nextPayload[shippingAmountField] = shippingAmount;

  return {
    applied: true,
    reason: null,
    payload: nextPayload,
    shippingAmount,
    quoteRequest,
    quoteResponse,
  };
}

export async function prepareShippingV2WriterPayload({
  payload,
  lines,
  shippingAddress,
  shopDomain,
  legacyShippingAmount,
  shippingAmountField = 'shippingAmount',
  quoteUrl = process.env.SHIPPING_V2_QUOTE_URL,
  timeoutMs = DEFAULT_SHIPPING_V2_QUOTE_TIMEOUT_MS,
  fetchImpl = fetch,
  logError = console.error,
}) {
  const quoteRequest = buildShippingV2QuoteRequest({
    lines,
    shippingAddress,
    shopDomain,
  });

  try {
    const quoteResponse = await fetchShippingV2Quote({
      quoteRequest,
      quoteUrl,
      fetchImpl,
      timeoutMs,
    });

    return applyShippingV2QuoteToPayload({
      payload,
      legacyShippingAmount,
      quoteRequest,
      quoteResponse,
      shippingAmountField,
    });
  } catch (error) {
    if (typeof logError === 'function') {
      logError('shipping v2 writer integration error:', error);
    }

    return buildFallbackResult({
      payload,
      legacyShippingAmount,
      reason: 'quote_error',
      quoteRequest,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

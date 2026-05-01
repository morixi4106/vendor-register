import { json } from '@remix-run/node';

import {
  createShippingDiagnosticId,
  recordShippingDiagnosticEvent,
} from './shippingDiagnostics.server.js';

const SMOKE_SHIPPING_RATES_JPY = {
  JP: 870,
  US: 2500,
};
const DEFAULT_INTERNATIONAL_SHIPPING_RATE_JPY = 3500;
const SMOKE_QUOTE_SOURCE = 'vendor-register-smoke-quote';
const SMOKE_CALCULATION_VERSION = 'smoke_v1';
const JAPAN_PROVINCE_CODE_NAMES = {
  'JP-01': 'Hokkaido',
  'JP-02': 'Aomori',
  'JP-03': 'Iwate',
  'JP-04': 'Miyagi',
  'JP-05': 'Akita',
  'JP-06': 'Yamagata',
  'JP-07': 'Fukushima',
  'JP-08': 'Ibaraki',
  'JP-09': 'Tochigi',
  'JP-10': 'Gunma',
  'JP-11': 'Saitama',
  'JP-12': 'Chiba',
  'JP-13': 'Tokyo',
  'JP-14': 'Kanagawa',
  'JP-15': 'Niigata',
  'JP-16': 'Toyama',
  'JP-17': 'Ishikawa',
  'JP-18': 'Fukui',
  'JP-19': 'Yamanashi',
  'JP-20': 'Nagano',
  'JP-21': 'Gifu',
  'JP-22': 'Shizuoka',
  'JP-23': 'Aichi',
  'JP-24': 'Mie',
  'JP-25': 'Shiga',
  'JP-26': 'Kyoto',
  'JP-27': 'Osaka',
  'JP-28': 'Hyogo',
  'JP-29': 'Nara',
  'JP-30': 'Wakayama',
  'JP-31': 'Tottori',
  'JP-32': 'Shimane',
  'JP-33': 'Okayama',
  'JP-34': 'Hiroshima',
  'JP-35': 'Yamaguchi',
  'JP-36': 'Tokushima',
  'JP-37': 'Kagawa',
  'JP-38': 'Ehime',
  'JP-39': 'Kochi',
  'JP-40': 'Fukuoka',
  'JP-41': 'Saga',
  'JP-42': 'Nagasaki',
  'JP-43': 'Kumamoto',
  'JP-44': 'Oita',
  'JP-45': 'Miyazaki',
  'JP-46': 'Kagoshima',
  'JP-47': 'Okinawa',
};

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

function toPositiveNumber(value) {
  const numeric = Number(value);

  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function getShippingAddress(body) {
  return isPlainObject(body?.shippingAddress) ? body.shippingAddress : {};
}

function getOrderLines(body) {
  return Array.isArray(body?.orderLike?.lines) ? body.orderLike.lines : [];
}

function getSmokeRateForCountry(countryCode) {
  return SMOKE_SHIPPING_RATES_JPY[countryCode] ?? DEFAULT_INTERNATIONAL_SHIPPING_RATE_JPY;
}

function normalizeProvince({ countryCode, province }) {
  const normalized = normalizeText(province);

  if (!normalized) {
    return {
      province: null,
      provinceCode: null,
      provinceName: null,
    };
  }

  const provinceCode = normalized.toUpperCase();

  if (countryCode === 'JP' && /^JP-\d{2}$/.test(provinceCode)) {
    return {
      province: provinceCode,
      provinceCode,
      provinceName: JAPAN_PROVINCE_CODE_NAMES[provinceCode] || null,
    };
  }

  return {
    province: normalized,
    provinceCode: null,
    provinceName: normalized,
  };
}

function normalizeQuoteLine(line, index) {
  const normalized = isPlainObject(line) ? line : {};
  const quantity = toPositiveNumber(normalized.quantity) || 1;
  const amountAfterItemDiscountBeforeOrderCoupon =
    toPositiveNumber(normalized.amountAfterItemDiscountBeforeOrderCoupon) ??
    toPositiveNumber(normalized.amount) ??
    toPositiveNumber(normalized.price);

  return {
    lineId: normalizeText(normalized.lineId || normalized.id || `quote-line-${index}`),
    productId: normalizeText(normalized.productId || normalized.product_id),
    variantId: normalizeText(normalized.variantId || normalized.variant_id),
    quantity,
    requiresShipping: normalized.requiresShipping !== false,
    amountAfterItemDiscountBeforeOrderCoupon,
  };
}

function lineRequiresShipping(line) {
  return Boolean(line?.requiresShipping && line.quantity > 0);
}

export function normalizeShippingQuoteInput(body) {
  const shippingAddress = getShippingAddress(body);
  const countryCode = normalizeCountryCode(
    shippingAddress.countryCode || shippingAddress.country || shippingAddress.country_code,
  );
  const postalCode = normalizeText(
    shippingAddress.postalCode || shippingAddress.zip || shippingAddress.postal_code,
  );
  const province = normalizeProvince({
    countryCode,
    province: shippingAddress.province || shippingAddress.prefecture || shippingAddress.province_code,
  });
  const lines = getOrderLines(body).map(normalizeQuoteLine);

  return {
    source: 'smoke_quote',
    calculationVersion: SMOKE_CALCULATION_VERSION,
    shopDomain: normalizeText(body?.shopDomain),
    shippingAddress: {
      countryCode,
      country: countryCode,
      postalCode,
      zip: postalCode,
      province: province.province,
      prefecture: province.province,
      provinceCode: province.provinceCode,
      provinceName: province.provinceName,
      city: normalizeText(shippingAddress.city),
    },
    lines,
    lineCount: lines.length,
    shippableLineCount: lines.filter(lineRequiresShipping).length,
  };
}

function summarizeQuoteRequest(body) {
  const input = normalizeShippingQuoteInput(body);

  return {
    source: input.source,
    calculationVersion: input.calculationVersion,
    shopDomain: input.shopDomain,
    shippingAddress: {
      countryCode: input.shippingAddress.countryCode,
      postalCode: input.shippingAddress.postalCode,
      province: input.shippingAddress.province,
      provinceCode: input.shippingAddress.provinceCode,
      provinceName: input.shippingAddress.provinceName,
      city: input.shippingAddress.city,
    },
    lineCount: input.lineCount,
    shippableLineCount: input.shippableLineCount,
    lines: input.lines.map((line) => ({
      productId: line.productId,
      variantId: line.variantId,
      quantity: line.quantity,
      requiresShipping: line.requiresShipping,
      amountAfterItemDiscountBeforeOrderCoupon:
        line.amountAfterItemDiscountBeforeOrderCoupon,
    })),
  };
}

function summarizeQuoteResponse(payload) {
  return {
    ok: payload?.ok ?? null,
    enabled: payload?.enabled ?? null,
    reason: payload?.reason ?? null,
    isPendingAddress: payload?.result?.isPendingAddress ?? null,
    isDeliverable: payload?.result?.isDeliverable ?? null,
    totalShippingFee: payload?.result?.totalShippingFee ?? null,
    currencyCode: payload?.result?.currencyCode ?? null,
    debug: payload?.debug ?? null,
  };
}

function recordQuoteDiagnostic({ requestId, level = 'info', message, details }) {
  recordShippingDiagnosticEvent({
    requestId,
    source: 'quote',
    level,
    message,
    details,
  });
}

export function buildShippingQuoteResponse(body) {
  const input = normalizeShippingQuoteInput(body);
  const {
    countryCode,
    postalCode,
    province,
    provinceCode,
    provinceName,
  } = input.shippingAddress;
  const debug = {
    source: SMOKE_QUOTE_SOURCE,
    calculationVersion: SMOKE_CALCULATION_VERSION,
    countryCode,
    postalCode,
    province,
    provinceCode,
    provinceName,
    shippableLineCount: input.shippableLineCount,
  };

  if (!countryCode || !postalCode) {
    return {
      ok: true,
      enabled: true,
      reason: 'pending_address',
      result: {
        isPendingAddress: true,
        isDeliverable: false,
        totalShippingFee: null,
      },
      debug,
    };
  }

  return {
    ok: true,
    enabled: true,
    reason: null,
    result: {
      isPendingAddress: false,
      isDeliverable: true,
      totalShippingFee:
        input.shippableLineCount > 0 ? getSmokeRateForCountry(countryCode) : 0,
      currencyCode: 'JPY',
    },
    debug,
  };
}

export function createShippingQuoteLoader() {
  return async function loader() {
    return json(
      {
        ok: false,
        reason: 'method_not_allowed',
        message: 'Use POST with a Shipping V2 quote request JSON body.',
      },
      {
        status: 405,
        headers: {
          Allow: 'POST',
        },
      },
    );
  };
}

export function createShippingQuoteAction() {
  return async function action({ request }) {
    const requestId =
      request.headers.get('x-shipping-diagnostic-request-id') ||
      createShippingDiagnosticId('quote');
    let body;

    try {
      body = await request.json();
    } catch {
      recordQuoteDiagnostic({
        requestId,
        level: 'warn',
        message: 'invalid_json',
        details: {
          method: request.method,
          url: request.url,
          contentType: request.headers.get('content-type') || '',
        },
      });
      return json(
        {
          ok: false,
          reason: 'invalid_json',
        },
        { status: 400 },
      );
    }

    const payload = buildShippingQuoteResponse(body);
    const responseSummary = summarizeQuoteResponse(payload);

    recordQuoteDiagnostic({
      requestId,
      level: responseSummary.reason ? 'warn' : 'info',
      message: responseSummary.reason ? 'quote_not_applied' : 'quote_returned',
      details: {
        request: summarizeQuoteRequest(body),
        response: responseSummary,
      },
    });

    return json(payload);
  };
}

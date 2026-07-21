import { json } from '@remix-run/node';
import {
  getInternationalShippingCountryAvailability,
  INTERNATIONAL_SERVICE_STATUS,
} from './internationalShippingAvailability.server.js';

import {
  createShippingDiagnosticId,
  recordShippingDiagnosticEvent,
} from './shippingDiagnostics.server.js';
import {
  normalizeShippingRateRuleConfig,
  readShippingRateRuleConfig,
  resolveShippingRate,
  SHIPPING_RATE_RULES_SOURCE,
  SHIPPING_RATE_RULES_VERSION,
} from './shippingRateRules.server.js';

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

function toNonNegativeNumber(value) {
  const numeric = Number(value);

  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function getShippingAddress(body) {
  return isPlainObject(body?.shippingAddress) ? body.shippingAddress : {};
}

function getOrderLines(body) {
  return Array.isArray(body?.orderLike?.lines) ? body.orderLike.lines : [];
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
  const grams = toNonNegativeNumber(normalized.grams ?? normalized.weightGrams);

  return {
    lineId: normalizeText(normalized.lineId || normalized.id || `quote-line-${index}`),
    productId: normalizeText(normalized.productId || normalized.product_id),
    variantId: normalizeText(normalized.variantId || normalized.variant_id),
    skuId: normalizeText(normalized.skuId || normalized.sku),
    vendor: normalizeText(normalized.vendor),
    title: normalizeText(normalized.title || normalized.name),
    quantity,
    requiresShipping: (normalized.requiresShipping ?? normalized.requires_shipping) !== false,
    amountAfterItemDiscountBeforeOrderCoupon,
    grams,
    shippingLengthMm: toNonNegativeNumber(
      normalized.shippingLengthMm ?? normalized.shipping_length_mm,
    ),
    shippingWidthMm: toNonNegativeNumber(
      normalized.shippingWidthMm ?? normalized.shipping_width_mm,
    ),
    shippingHeightMm: toNonNegativeNumber(
      normalized.shippingHeightMm ?? normalized.shipping_height_mm,
    ),
    internationalShippingMethod: normalizeText(
      normalized.internationalShippingMethod ||
        normalized.international_shipping_method,
    ),
    shippingWeightConfirmed: normalized.shippingWeightConfirmed === true,
    shippingWeightSource: normalizeText(normalized.shippingWeightSource),
    shopifyVariantCount: toNonNegativeNumber(normalized.shopifyVariantCount),
    shopifyWeightSyncStatus: normalizeText(normalized.shopifyWeightSyncStatus),
    shipFromId: normalizeText(normalized.shipFromId || normalized.ship_from_id),
    leadTimeBucket: normalizeText(normalized.leadTimeBucket || normalized.lead_time_bucket),
    shippingClass: normalizeText(normalized.shippingClass || normalized.shipping_class),
    temperatureZone: normalizeText(normalized.temperatureZone || normalized.temperature_zone),
    directShipGroup: normalizeText(normalized.directShipGroup || normalized.direct_ship_group),
    forceSeparateShipment:
      normalized.forceSeparateShipment ?? normalized.force_separate_shipment ?? null,
    freeShippingEligible:
      normalized.freeShippingEligible ?? normalized.free_shipping_eligible ?? null,
    shippingPoint: toNonNegativeNumber(normalized.shippingPoint ?? normalized.shipping_point),
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
    source: 'shipping_rules_quote',
    calculationVersion: SHIPPING_RATE_RULES_VERSION,
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
      grams: line.grams,
      shippingLengthMm: line.shippingLengthMm,
      shippingWidthMm: line.shippingWidthMm,
      shippingHeightMm: line.shippingHeightMm,
      internationalShippingMethod: line.internationalShippingMethod,
      shippingWeightConfirmed: line.shippingWeightConfirmed,
      shippingWeightSource: line.shippingWeightSource,
      shopifyVariantCount: line.shopifyVariantCount,
      shopifyWeightSyncStatus: line.shopifyWeightSyncStatus,
      shippingClass: line.shippingClass,
      temperatureZone: line.temperatureZone,
      shippingPoint: line.shippingPoint,
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

export function buildShippingQuoteResponse(body, options = {}) {
  const input = {
    ...normalizeShippingQuoteInput(body),
    internationalServiceAvailabilityStatus:
      options.internationalServiceAvailabilityStatus ||
      body?.internationalServiceAvailabilityStatus ||
      INTERNATIONAL_SERVICE_STATUS.UNKNOWN,
  };
  const {
    countryCode,
    postalCode,
  } = input.shippingAddress;
  const debug = {
    source: SHIPPING_RATE_RULES_SOURCE,
    calculationVersion: SHIPPING_RATE_RULES_VERSION,
    countryCode,
    shippableLineCount: input.shippableLineCount,
  };
  const rawRuleConfig = Object.hasOwn(options, 'rawRuleConfig')
    ? options.rawRuleConfig
    : process.env.SHIPPING_V2_RATE_RULES_JSON;
  const configResult = options.ruleConfig
    ? { ok: true, config: normalizeShippingRateRuleConfig(options.ruleConfig) }
    : readShippingRateRuleConfig(rawRuleConfig);

  if (!configResult.ok) {
    return {
      ok: false,
      enabled: true,
      reason: configResult.reason,
      result: {
        isPendingAddress: false,
        isDeliverable: false,
        totalShippingFee: null,
      },
      debug: {
        ...debug,
        error: configResult.error,
      },
    };
  }

  if (configResult.config.enabled === false) {
    return {
      ok: true,
      enabled: false,
      reason: 'shipping_v2_disabled',
      result: {
        isPendingAddress: false,
        isDeliverable: false,
        totalShippingFee: null,
        currencyCode: configResult.config.currencyCode,
      },
      debug,
    };
  }

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

  const resolvedRate = resolveShippingRate(input, configResult.config);

  if (!resolvedRate.isDeliverable) {
    return {
      ok: true,
      enabled: true,
      reason: 'undeliverable',
      result: {
        isPendingAddress: false,
        isDeliverable: false,
        totalShippingFee: null,
        currencyCode: resolvedRate.currencyCode,
        rateSource: resolvedRate.rateSource,
      },
      debug: {
        ...debug,
        rateSource: resolvedRate.rateSource,
        matchedRuleId: resolvedRate.matchedRuleId,
        regionTier: resolvedRate.regionTier,
        totalWeightGrams: resolvedRate.totalWeightGrams,
        totalShippingPoint: resolvedRate.totalShippingPoint,
        freeShippingEligibleSubtotal: resolvedRate.freeShippingEligibleSubtotal,
        isFreeShippingThresholdMet: resolvedRate.isFreeShippingThresholdMet,
        groups: resolvedRate.groups,
      },
    };
  }

  return {
    ok: true,
    enabled: true,
    reason: null,
    result: {
      isPendingAddress: false,
      isDeliverable: true,
      totalShippingFee: resolvedRate.totalShippingFee,
      currencyCode: resolvedRate.currencyCode,
      rateSource: resolvedRate.rateSource,
    },
    debug: {
      ...debug,
      rateSource: resolvedRate.rateSource,
      matchedRuleId: resolvedRate.matchedRuleId,
      regionTier: resolvedRate.regionTier,
      totalWeightGrams: resolvedRate.totalWeightGrams,
      totalShippingPoint: resolvedRate.totalShippingPoint,
      freeShippingEligibleSubtotal: resolvedRate.freeShippingEligibleSubtotal,
      isFreeShippingThresholdMet: resolvedRate.isFreeShippingThresholdMet,
      groups: resolvedRate.groups,
    },
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

export function createShippingQuoteAction({
  getInternationalShippingCountryAvailabilityImpl =
    getInternationalShippingCountryAvailability,
} = {}) {
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

    const normalizedInput = normalizeShippingQuoteInput(body);
    let internationalServiceAvailabilityStatus = INTERNATIONAL_SERVICE_STATUS.UNKNOWN;

    if (
      normalizedInput.shippingAddress.countryCode &&
      normalizedInput.shippingAddress.countryCode !== 'JP'
    ) {
      try {
        const availability =
          await getInternationalShippingCountryAvailabilityImpl({
            countryCode: normalizedInput.shippingAddress.countryCode,
          });
        internationalServiceAvailabilityStatus = availability.status;
      } catch (error) {
        recordQuoteDiagnostic({
          requestId,
          level: 'error',
          message: 'international_service_availability_lookup_failed',
          details: {
            countryCode: normalizedInput.shippingAddress.countryCode,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    const payload = buildShippingQuoteResponse(body, {
      internationalServiceAvailabilityStatus,
    });
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

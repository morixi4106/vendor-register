export const BUYER_IMPORT_WARNING_VERSION = 'import-responsibility-v1';

export const DELIVERY_ELIGIBILITY_STATUS = {
  AVAILABLE: 'AVAILABLE',
  UNKNOWN_COUNTRY: 'UNKNOWN_COUNTRY',
  REQUIRES_IMPORT_WARNING: 'REQUIRES_IMPORT_WARNING',
  UNAVAILABLE_PRODUCT_EU_REVIEW: 'UNAVAILABLE_PRODUCT_EU_REVIEW',
  UNAVAILABLE_SELLER_EU_REVIEW: 'UNAVAILABLE_SELLER_EU_REVIEW',
  UNAVAILABLE_COUNTRY_BLOCKED: 'UNAVAILABLE_COUNTRY_BLOCKED',
  UNAVAILABLE_COUNTRY_NOT_ALLOWED: 'UNAVAILABLE_COUNTRY_NOT_ALLOWED',
  UNAVAILABLE_PRODUCT_UNAPPROVED: 'UNAVAILABLE_PRODUCT_UNAPPROVED',
};

export const EU_COUNTRY_CODES = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
]);

export const EU_SELLER_ALLOWED_STATUSES = new Set([
  'ALLOWED_UNDER_SMALL_PLATFORM_POLICY',
  'FULL_KYBC_APPROVED',
]);

export const EU_PRODUCT_ALLOWED_STATUSES = new Set(['APPROVED_LOW_RISK']);

export function normalizeText(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

export function normalizeCountryCode(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toUpperCase() : null;
}

export function normalizeCountryList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(normalizeCountryCode).filter(Boolean);
}

export function isEuCountry(value) {
  const countryCode = normalizeCountryCode(value);
  return Boolean(countryCode && EU_COUNTRY_CODES.has(countryCode));
}

function getSellerEuStatus(sellerOrVendorContext) {
  return (
    normalizeText(sellerOrVendorContext?.euSellerStatus)?.toUpperCase() ||
    normalizeText(sellerOrVendorContext?.seller?.euSellerStatus)?.toUpperCase() ||
    normalizeText(sellerOrVendorContext?.vendor?.euSellerStatus)?.toUpperCase() ||
    'DISABLED'
  );
}

function buildEligibilityResult({
  status,
  countryCode = null,
  product = null,
  sellerEuStatus = null,
  isAvailable = false,
  requiresImportWarning = false,
  severity = 'block',
  message,
  reason,
}) {
  return {
    status,
    reason: reason || status.toLowerCase(),
    countryCode,
    productId: product?.id || null,
    shopifyProductId: product?.shopifyProductId || null,
    sellerEuStatus,
    productEuStatus: product?.productEuStatus || null,
    isAvailable,
    requiresImportWarning,
    severity,
    warningVersion: requiresImportWarning ? BUYER_IMPORT_WARNING_VERSION : null,
    message,
  };
}

export function evaluateProductDeliveryEligibility({
  product,
  seller,
  vendorContext,
  deliveryCountry,
} = {}) {
  const countryCode = normalizeCountryCode(deliveryCountry);
  const sellerEuStatus = getSellerEuStatus(
    seller ||
      product?.seller ||
      product?.vendorStore?.seller ||
      product?.vendorStore?.vendorAuth?.seller ||
      vendorContext,
  );

  if (!countryCode) {
    return buildEligibilityResult({
      status: DELIVERY_ELIGIBILITY_STATUS.UNKNOWN_COUNTRY,
      product,
      sellerEuStatus,
      isAvailable: true,
      severity: 'info',
      message: '配送先国を選択すると、この商品を購入できるか確認できます。',
    });
  }

  if (product?.approvalStatus && product.approvalStatus !== 'approved') {
    return buildEligibilityResult({
      status: DELIVERY_ELIGIBILITY_STATUS.UNAVAILABLE_PRODUCT_UNAPPROVED,
      countryCode,
      product,
      sellerEuStatus,
      message: 'この商品は現在購入できません。',
    });
  }

  const blockedCountries = normalizeCountryList(
    product?.countryPolicy?.blockedCountries,
  );
  const allowedCountries = normalizeCountryList(
    product?.countryPolicy?.allowedCountries,
  );
  const requiresWarningCountries = normalizeCountryList(
    product?.countryPolicy?.requiresWarningCountries,
  );

  if (blockedCountries.includes(countryCode)) {
    return buildEligibilityResult({
      status: DELIVERY_ELIGIBILITY_STATUS.UNAVAILABLE_COUNTRY_BLOCKED,
      countryCode,
      product,
      sellerEuStatus,
      reason: 'country_blocked',
      message: 'この商品は選択した配送先国には販売できません。',
    });
  }

  if (allowedCountries.length > 0 && !allowedCountries.includes(countryCode)) {
    return buildEligibilityResult({
      status: DELIVERY_ELIGIBILITY_STATUS.UNAVAILABLE_COUNTRY_NOT_ALLOWED,
      countryCode,
      product,
      sellerEuStatus,
      reason: 'country_not_allowed',
      message: 'この商品は選択した配送先国には販売できません。',
    });
  }

  if (EU_COUNTRY_CODES.has(countryCode)) {
    if (!EU_SELLER_ALLOWED_STATUSES.has(sellerEuStatus)) {
      return buildEligibilityResult({
        status: DELIVERY_ELIGIBILITY_STATUS.UNAVAILABLE_SELLER_EU_REVIEW,
        countryCode,
        product,
        sellerEuStatus,
        reason: 'eu_seller_not_allowed',
        message:
          'この出店者はEU向け販売の確認が完了していないため、この配送先国には販売できません。',
      });
    }

    if (!EU_PRODUCT_ALLOWED_STATUSES.has(product?.productEuStatus || 'DISABLED')) {
      return buildEligibilityResult({
        status: DELIVERY_ELIGIBILITY_STATUS.UNAVAILABLE_PRODUCT_EU_REVIEW,
        countryCode,
        product,
        sellerEuStatus,
        reason: 'eu_product_not_allowed',
        message:
          'この商品はEU向け販売の確認が完了していないため、この配送先国には販売できません。',
      });
    }
  }

  const requiresImportWarning =
    EU_COUNTRY_CODES.has(countryCode) || requiresWarningCountries.includes(countryCode);

  if (requiresImportWarning) {
    return buildEligibilityResult({
      status: DELIVERY_ELIGIBILITY_STATUS.REQUIRES_IMPORT_WARNING,
      countryCode,
      product,
      sellerEuStatus,
      isAvailable: true,
      requiresImportWarning: true,
      severity: 'warning',
      reason: 'import_warning_required',
      message:
        '関税、輸入VAT、通関手数料が配達時に発生する場合があります。',
    });
  }

  return buildEligibilityResult({
    status: DELIVERY_ELIGIBILITY_STATUS.AVAILABLE,
    countryCode,
    product,
    sellerEuStatus,
    isAvailable: true,
    severity: 'ok',
    message: 'この配送先国へ販売できます。',
  });
}

export function evaluateCartDeliveryEligibility({
  products = [],
  seller,
  vendorContext,
  deliveryCountry,
  importResponsibilityAccepted = false,
} = {}) {
  const countryCode = normalizeCountryCode(deliveryCountry);
  const productResults = products.map((product) =>
    evaluateProductDeliveryEligibility({
      product,
      seller,
      vendorContext,
      deliveryCountry: countryCode,
    }),
  );
  const blocker = productResults.find((result) => !result.isAvailable);

  if (blocker) {
    return {
      ok: false,
      reason: blocker.reason,
      error: blocker.message,
      countryCode,
      requiresWarning: false,
      productResults,
      blocker,
    };
  }

  const requiresWarning = productResults.some(
    (result) => result.requiresImportWarning,
  );

  if (requiresWarning && !importResponsibilityAccepted) {
    return {
      ok: false,
      reason: 'buyer_warning_required',
      error: '配送先国と輸入条件の確認に同意してください。',
      countryCode,
      requiresWarning: true,
      productResults,
      blocker: null,
    };
  }

  return {
    ok: true,
    reason: null,
    error: null,
    countryCode,
    requiresWarning,
    productResults,
    blocker: null,
    acceptance: requiresWarning
      ? {
          selectedCountry: countryCode,
          shippingCountry: countryCode,
          productIds: products.map((product) => product.id).filter(Boolean),
          warningVersion: BUYER_IMPORT_WARNING_VERSION,
          importResponsibilityAccepted: true,
        }
      : null,
  };
}

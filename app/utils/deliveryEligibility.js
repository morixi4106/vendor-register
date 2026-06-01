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

export const PUBLIC_DELIVERY_ELIGIBILITY_STATUS = {
  AVAILABLE: 'AVAILABLE',
  UNKNOWN_COUNTRY: 'UNKNOWN_COUNTRY',
  REQUIRES_IMPORT_WARNING: 'REQUIRES_IMPORT_WARNING',
  UNAVAILABLE: 'UNAVAILABLE',
  UNPURCHASABLE: 'UNPURCHASABLE',
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

export const PUBLIC_DELIVERY_ELIGIBILITY_LABELS = {
  [PUBLIC_DELIVERY_ELIGIBILITY_STATUS.AVAILABLE]: '販売可能',
  [PUBLIC_DELIVERY_ELIGIBILITY_STATUS.UNKNOWN_COUNTRY]: '配送先未選択',
  [PUBLIC_DELIVERY_ELIGIBILITY_STATUS.REQUIRES_IMPORT_WARNING]: '注意確認が必要',
  [PUBLIC_DELIVERY_ELIGIBILITY_STATUS.UNAVAILABLE]: '販売できません',
  [PUBLIC_DELIVERY_ELIGIBILITY_STATUS.UNPURCHASABLE]: '購入できません',
};

export const PUBLIC_COUNTRY_LABELS_JA = {
  AT: 'オーストリア',
  AU: 'オーストラリア',
  BE: 'ベルギー',
  BG: 'ブルガリア',
  CY: 'キプロス',
  CZ: 'チェコ',
  DE: 'ドイツ',
  DK: 'デンマーク',
  EE: 'エストニア',
  ES: 'スペイン',
  FI: 'フィンランド',
  FR: 'フランス',
  GB: 'イギリス',
  GR: 'ギリシャ',
  HR: 'クロアチア',
  HU: 'ハンガリー',
  IE: 'アイルランド',
  IT: 'イタリア',
  JP: '日本',
  KR: '韓国',
  LT: 'リトアニア',
  LU: 'ルクセンブルク',
  LV: 'ラトビア',
  MT: 'マルタ',
  NL: 'オランダ',
  PL: 'ポーランド',
  PT: 'ポルトガル',
  RO: 'ルーマニア',
  SE: 'スウェーデン',
  SG: 'シンガポール',
  SI: 'スロベニア',
  SK: 'スロバキア',
  US: 'アメリカ',
};

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

export function formatPublicCountryLabel(countryCode) {
  const code = normalizeCountryCode(countryCode);
  return code ? PUBLIC_COUNTRY_LABELS_JA[code] || code : null;
}

function serializeCountryCodes(countryCodes) {
  return Array.from(new Set(countryCodes.map(normalizeCountryCode).filter(Boolean)))
    .sort((left, right) => {
      const leftLabel = formatPublicCountryLabel(left) || left;
      const rightLabel = formatPublicCountryLabel(right) || right;
      return leftLabel.localeCompare(rightLabel, 'ja-JP');
    })
    .map((code) => ({
      code,
      label: formatPublicCountryLabel(code) || code,
    }));
}

function getSellerEuStatus(sellerOrVendorContext) {
  return (
    normalizeText(sellerOrVendorContext?.euSellerStatus)?.toUpperCase() ||
    normalizeText(sellerOrVendorContext?.seller?.euSellerStatus)?.toUpperCase() ||
    normalizeText(sellerOrVendorContext?.vendor?.euSellerStatus)?.toUpperCase() ||
    'DISABLED'
  );
}

export function getPublicDeliveryEligibilityMessage({
  status,
  isAvailable = false,
  requiresImportWarning = false,
} = {}) {
  if (status === DELIVERY_ELIGIBILITY_STATUS.UNKNOWN_COUNTRY) {
    return '配送先を選択すると、この商品を購入できるか確認できます。';
  }

  if (requiresImportWarning) {
    return '配送先国によって、関税・税金・通関手数料が発生する場合があります。';
  }

  if (status === DELIVERY_ELIGIBILITY_STATUS.UNAVAILABLE_PRODUCT_UNAPPROVED) {
    return 'この商品は現在購入できません。';
  }

  if (!isAvailable || String(status || '').startsWith('UNAVAILABLE')) {
    return 'この配送先には販売できません。';
  }

  return 'この配送先に購入できます。';
}

export function getPublicDeliveryEligibilityStatus(eligibility = {}) {
  if (eligibility.status === DELIVERY_ELIGIBILITY_STATUS.UNKNOWN_COUNTRY) {
    return PUBLIC_DELIVERY_ELIGIBILITY_STATUS.UNKNOWN_COUNTRY;
  }

  if (
    eligibility.status === DELIVERY_ELIGIBILITY_STATUS.UNAVAILABLE_PRODUCT_UNAPPROVED
  ) {
    return PUBLIC_DELIVERY_ELIGIBILITY_STATUS.UNPURCHASABLE;
  }

  if (!eligibility.isAvailable || String(eligibility.status || '').startsWith('UNAVAILABLE')) {
    return PUBLIC_DELIVERY_ELIGIBILITY_STATUS.UNAVAILABLE;
  }

  if (eligibility.requiresImportWarning) {
    return PUBLIC_DELIVERY_ELIGIBILITY_STATUS.REQUIRES_IMPORT_WARNING;
  }

  return PUBLIC_DELIVERY_ELIGIBILITY_STATUS.AVAILABLE;
}

export function buildDeliveryRestrictionSummary({
  product,
  seller,
  vendorContext,
} = {}) {
  const sellerEuStatus = getSellerEuStatus(
    seller ||
      product?.seller ||
      product?.vendorStore?.seller ||
      product?.vendorStore?.vendorAuth?.seller ||
      vendorContext,
  );
  const blockedCountries = normalizeCountryList(
    product?.countryPolicy?.blockedCountries,
  );
  const allowedCountries = normalizeCountryList(
    product?.countryPolicy?.allowedCountries,
  );
  const requiresWarningCountries = normalizeCountryList(
    product?.countryPolicy?.requiresWarningCountries,
  );
  const unavailableCountryCodes = new Set(blockedCountries);

  if (
    !EU_SELLER_ALLOWED_STATUSES.has(sellerEuStatus) ||
    !EU_PRODUCT_ALLOWED_STATUSES.has(product?.productEuStatus || 'DISABLED')
  ) {
    for (const code of EU_COUNTRY_CODES) {
      unavailableCountryCodes.add(code);
    }
  }

  const unavailableCountries = serializeCountryCodes(
    Array.from(unavailableCountryCodes),
  );
  const allowedCountryList = serializeCountryCodes(
    allowedCountries.filter((code) => !unavailableCountryCodes.has(code)),
  );
  const warningCountryList = serializeCountryCodes(
    requiresWarningCountries.filter(
      (code) => !unavailableCountryCodes.has(code),
    ),
  );
  const isAllowedCountryLimited = allowedCountryList.length > 0;
  const hasUnavailableCountries = unavailableCountries.length > 0;
  const hasRestrictions = hasUnavailableCountries || isAllowedCountryLimited;
  const label = hasRestrictions
    ? '一部の配送先では購入できません'
    : '主な販売制限なし';
  const message = hasRestrictions
    ? isAllowedCountryLimited
      ? 'この商品は販売対象国が限定されています。配送先を選択すると購入可否を確認できます。'
      : 'この商品は一部の配送先では購入できません。配送先を選択すると購入可否を確認できます。'
    : '配送先を選択すると購入可否を確認できます。';

  return {
    hasRestrictions,
    label,
    message,
    unavailableCountries,
    allowedCountries: allowedCountryList,
    warningCountries: warningCountryList,
    hasAllowedCountryLimit: isAllowedCountryLimited,
  };
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
  publicMessage,
  reason,
}) {
  const publicStatus = getPublicDeliveryEligibilityStatus({
    status,
    isAvailable,
    requiresImportWarning,
  });
  const buyerMessage =
    publicMessage ||
    getPublicDeliveryEligibilityMessage({
      status,
      isAvailable,
      requiresImportWarning,
    });

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
    label: PUBLIC_DELIVERY_ELIGIBILITY_LABELS[publicStatus] || publicStatus,
    publicStatus,
    message: buyerMessage,
    publicMessage: buyerMessage,
    internalMessage: message || buyerMessage,
  };
}

export function serializePublicDeliveryEligibility(eligibility) {
  if (!eligibility || typeof eligibility !== 'object') {
    return eligibility;
  }

  const publicStatus = getPublicDeliveryEligibilityStatus(eligibility);
  const publicMessage =
    eligibility.publicMessage ||
    getPublicDeliveryEligibilityMessage({
      status: eligibility.status,
      isAvailable: eligibility.isAvailable,
      requiresImportWarning: eligibility.requiresImportWarning,
    });

  return {
    status: publicStatus,
    reason: publicStatus.toLowerCase(),
    countryCode: eligibility.countryCode,
    productId: eligibility.productId,
    shopifyProductId: eligibility.shopifyProductId,
    isAvailable: eligibility.isAvailable,
    requiresImportWarning: eligibility.requiresImportWarning,
    severity: eligibility.severity,
    warningVersion: eligibility.warningVersion,
    label: PUBLIC_DELIVERY_ELIGIBILITY_LABELS[publicStatus] || publicStatus,
    message: publicMessage,
    publicMessage,
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

export const SHIPPING_RATE_RULES_SOURCE = 'vendor-register-shipping-rules';
export const SHIPPING_RATE_RULES_VERSION = 'rules_v1';

const DEFAULT_SHIPPING_RATE_RULES = [
  {
    id: 'jp-default',
    countryCodes: ['JP'],
    amount: 870,
  },
  {
    id: 'us-default',
    countryCodes: ['US'],
    amount: 2500,
  },
];

export const DEFAULT_SHIPPING_RATE_RULE_CONFIG = {
  enabled: true,
  currencyCode: 'JPY',
  defaultAmount: 3500,
  undeliverableWhenNoRule: false,
  rules: DEFAULT_SHIPPING_RATE_RULES,
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeCode(value) {
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

function toNonNegativeNumber(value) {
  const numeric = toFiniteNumber(value);

  return numeric != null && numeric >= 0 ? numeric : null;
}

function normalizeCodeList(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];

  return values.map(normalizeCode).filter(Boolean);
}

function normalizeTextList(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];

  return values.map(normalizeText).filter(Boolean);
}

function normalizeRateRule(rule, index) {
  if (!isPlainObject(rule)) {
    return null;
  }

  const amount = toNonNegativeNumber(rule.amount ?? rule.totalShippingFee);

  if (amount == null) {
    return null;
  }

  return {
    id: normalizeText(rule.id || rule.name || `shipping-rule-${index}`),
    amount,
    countryCodes: normalizeCodeList(rule.countryCodes || rule.countries || rule.countryCode),
    provinceCodes: normalizeCodeList(
      rule.provinceCodes || rule.prefectureCodes || rule.provinceCode,
    ),
    provinceNames: normalizeCodeList(
      rule.provinceNames || rule.prefectureNames || rule.provinceName,
    ),
    postalCodePrefixes: normalizeTextList(
      rule.postalCodePrefixes || rule.zipPrefixes || rule.postalCodePrefix,
    ),
    productIds: normalizeTextList(rule.productIds || rule.productId),
    variantIds: normalizeTextList(rule.variantIds || rule.variantId),
    minTotalWeightGrams: toNonNegativeNumber(rule.minTotalWeightGrams),
    maxTotalWeightGrams: toNonNegativeNumber(rule.maxTotalWeightGrams),
  };
}

export function normalizeShippingRateRuleConfig(config) {
  const normalized = isPlainObject(config) ? config : {};
  const defaultConfig = DEFAULT_SHIPPING_RATE_RULE_CONFIG;
  const rules = (Array.isArray(normalized.rules) ? normalized.rules : defaultConfig.rules)
    .map(normalizeRateRule)
    .filter(Boolean);

  return {
    enabled: normalized.enabled !== false,
    currencyCode: normalizeCode(normalized.currencyCode) || defaultConfig.currencyCode,
    defaultAmount:
      toNonNegativeNumber(
        normalized.defaultAmount ??
          normalized.defaultRate ??
          normalized.noRuleAmount ??
          normalized.internationalAmount,
      ) ?? defaultConfig.defaultAmount,
    undeliverableWhenNoRule: normalized.undeliverableWhenNoRule === true,
    rules,
  };
}

export function readShippingRateRuleConfig(rawConfig) {
  const normalizedRawConfig = normalizeText(rawConfig);

  if (!normalizedRawConfig) {
    return {
      ok: true,
      config: normalizeShippingRateRuleConfig(DEFAULT_SHIPPING_RATE_RULE_CONFIG),
    };
  }

  try {
    return {
      ok: true,
      config: normalizeShippingRateRuleConfig(JSON.parse(normalizedRawConfig)),
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'shipping_rule_config_error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getShippableLines(input) {
  return Array.isArray(input?.lines)
    ? input.lines.filter((line) => line?.requiresShipping && Number(line.quantity) > 0)
    : [];
}

function getTotalWeightGrams(lines) {
  return lines.reduce((total, line) => {
    const lineWeight = toNonNegativeNumber(line.grams) || 0;
    const quantity = toNonNegativeNumber(line.quantity) || 1;

    return total + lineWeight * quantity;
  }, 0);
}

function matchesAny(value, expectedValues) {
  if (expectedValues.length === 0) {
    return true;
  }

  const normalized = normalizeCode(value);

  return Boolean(normalized && expectedValues.includes(normalized));
}

function matchesAnyText(value, expectedValues) {
  if (expectedValues.length === 0) {
    return true;
  }

  const normalized = normalizeText(value);

  return Boolean(normalized && expectedValues.includes(normalized));
}

function matchesAnyLineText(lines, field, expectedValues) {
  if (expectedValues.length === 0) {
    return true;
  }

  return lines.some((line) => matchesAnyText(line?.[field], expectedValues));
}

function matchesPostalCodePrefix(postalCode, prefixes) {
  if (prefixes.length === 0) {
    return true;
  }

  const normalizedPostalCode = normalizeText(postalCode);

  return Boolean(
    normalizedPostalCode &&
      prefixes.some((prefix) => normalizedPostalCode.startsWith(prefix)),
  );
}

function ruleMatchesInput(rule, input, shippableLines) {
  const shippingAddress = input?.shippingAddress || {};
  const totalWeightGrams = getTotalWeightGrams(shippableLines);

  if (!matchesAny(shippingAddress.countryCode, rule.countryCodes)) {
    return false;
  }

  if (
    rule.provinceCodes.length > 0 &&
    !matchesAny(shippingAddress.provinceCode || shippingAddress.province, rule.provinceCodes)
  ) {
    return false;
  }

  if (
    rule.provinceNames.length > 0 &&
    !matchesAny(shippingAddress.provinceName || shippingAddress.province, rule.provinceNames)
  ) {
    return false;
  }

  if (!matchesPostalCodePrefix(shippingAddress.postalCode, rule.postalCodePrefixes)) {
    return false;
  }

  if (!matchesAnyLineText(shippableLines, 'productId', rule.productIds)) {
    return false;
  }

  if (!matchesAnyLineText(shippableLines, 'variantId', rule.variantIds)) {
    return false;
  }

  if (
    rule.minTotalWeightGrams != null &&
    totalWeightGrams < rule.minTotalWeightGrams
  ) {
    return false;
  }

  if (
    rule.maxTotalWeightGrams != null &&
    totalWeightGrams > rule.maxTotalWeightGrams
  ) {
    return false;
  }

  return true;
}

export function resolveShippingRate(input, config) {
  const normalizedConfig = normalizeShippingRateRuleConfig(config);
  const shippableLines = getShippableLines(input);

  if (shippableLines.length === 0) {
    return {
      isDeliverable: true,
      totalShippingFee: 0,
      currencyCode: normalizedConfig.currencyCode,
      rateSource: 'no_shipping_required',
      matchedRuleId: 'no_shipping_required',
      shippableLineCount: 0,
      totalWeightGrams: 0,
    };
  }

  const matchedRule = normalizedConfig.rules.find((rule) =>
    ruleMatchesInput(rule, input, shippableLines),
  );

  if (matchedRule) {
    return {
      isDeliverable: true,
      totalShippingFee: matchedRule.amount,
      currencyCode: normalizedConfig.currencyCode,
      rateSource: 'rule',
      matchedRuleId: matchedRule.id,
      shippableLineCount: shippableLines.length,
      totalWeightGrams: getTotalWeightGrams(shippableLines),
    };
  }

  if (normalizedConfig.undeliverableWhenNoRule) {
    return {
      isDeliverable: false,
      totalShippingFee: null,
      currencyCode: normalizedConfig.currencyCode,
      rateSource: 'no_matching_rule',
      matchedRuleId: null,
      shippableLineCount: shippableLines.length,
      totalWeightGrams: getTotalWeightGrams(shippableLines),
    };
  }

  return {
    isDeliverable: true,
    totalShippingFee: normalizedConfig.defaultAmount,
    currencyCode: normalizedConfig.currencyCode,
    rateSource: 'default',
    matchedRuleId: 'default',
    shippableLineCount: shippableLines.length,
    totalWeightGrams: getTotalWeightGrams(shippableLines),
  };
}

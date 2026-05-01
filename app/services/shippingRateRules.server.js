export const SHIPPING_RATE_RULES_SOURCE = 'vendor-register-shipping-rules';
export const SHIPPING_RATE_RULES_VERSION = 'mvp_v2';

export const SHIPPING_MODES = ['mail', 'compact', 'parcel', 'cool', 'bulky', 'direct'];
export const REGION_TIERS = [
  'honshu',
  'hokkaido_kyushu',
  'okinawa',
  'remote_island',
  'us',
  'international',
];

const HOKKAIDO_KYUSHU_PROVINCE_CODES = new Set([
  'JP-01',
  'JP-40',
  'JP-41',
  'JP-42',
  'JP-43',
  'JP-44',
  'JP-45',
  'JP-46',
]);

const DEFAULT_LINE_VALUES = {
  shipFromId: 'default',
  leadTimeBucket: 'normal',
  shippingClass: 'parcel',
  temperatureZone: 'ambient',
  forceSeparateShipment: false,
  freeShippingEligible: true,
  shippingPoint: 1,
};

const DEFAULT_FEE_MATRIX = {
  mail: {
    honshu: 370,
    hokkaido_kyushu: 370,
    okinawa: 370,
    remote_island: 370,
    us: null,
    international: null,
  },
  compact: {
    honshu: 660,
    hokkaido_kyushu: 880,
    okinawa: 1200,
    remote_island: 1500,
    us: null,
    international: null,
  },
  parcel: {
    honshu: 870,
    hokkaido_kyushu: 1200,
    okinawa: 1800,
    remote_island: 2500,
    us: 2500,
    international: 3500,
  },
  cool: {
    honshu: 1200,
    hokkaido_kyushu: 1600,
    okinawa: 2500,
    remote_island: null,
    us: null,
    international: null,
  },
  bulky: {
    honshu: 3500,
    hokkaido_kyushu: 5000,
    okinawa: 8000,
    remote_island: 10000,
    us: null,
    international: null,
  },
  direct: {
    honshu: 1500,
    hokkaido_kyushu: 2200,
    okinawa: 3500,
    remote_island: 5000,
    us: 15000,
    international: 15000,
  },
};

const DEFAULT_EXTRA_PACKAGE_FEE = {
  mail: {
    honshu: 0,
    hokkaido_kyushu: 0,
    okinawa: 0,
    remote_island: 0,
    us: null,
    international: null,
  },
  compact: {
    honshu: 400,
    hokkaido_kyushu: 500,
    okinawa: 700,
    remote_island: 800,
    us: null,
    international: null,
  },
  parcel: {
    honshu: 700,
    hokkaido_kyushu: 900,
    okinawa: 1200,
    remote_island: 1500,
    us: 2000,
    international: 2500,
  },
  cool: {
    honshu: 900,
    hokkaido_kyushu: 1200,
    okinawa: 1500,
    remote_island: null,
    us: null,
    international: null,
  },
  bulky: {
    honshu: 3000,
    hokkaido_kyushu: 4500,
    okinawa: 7000,
    remote_island: 9000,
    us: null,
    international: null,
  },
  direct: {
    honshu: 1500,
    hokkaido_kyushu: 2200,
    okinawa: 3500,
    remote_island: 5000,
    us: 15000,
    international: 15000,
  },
};

const DEFAULT_POINT_THRESHOLD_BY_MODE = {
  mail: 1,
  compact: 2,
  parcel: 5,
  cool: 4,
  bulky: 1,
  direct: 1,
};

export const DEFAULT_SHIPPING_RATE_RULE_CONFIG = {
  enabled: true,
  currencyCode: 'JPY',
  defaultAmount: 3500,
  undeliverableWhenNoRule: false,
  lineDefaults: DEFAULT_LINE_VALUES,
  feeMatrix: DEFAULT_FEE_MATRIX,
  extraPackageFee: DEFAULT_EXTRA_PACKAGE_FEE,
  pointThresholdByMode: DEFAULT_POINT_THRESHOLD_BY_MODE,
  freeShippingRule: {
    enabled: true,
    threshold: 10000,
    eligibleModes: ['mail', 'compact', 'parcel'],
  },
  lineRules: [],
  rateOverrides: [],
  remoteIslandOverrides: [],
  disallowedCoolRegions: {
    regionTiers: ['remote_island', 'us', 'international'],
    provinceCodes: [],
    postalCodePrefixes: [],
  },
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

function normalizeLowerCode(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toLowerCase() : null;
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

function toPositiveInteger(value, fallback = null) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeBoolean(value, fallback = false) {
  if (value == null) {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (['true', '1', 'yes', 'y'].includes(normalized)) {
      return true;
    }

    if (['false', '0', 'no', 'n'].includes(normalized)) {
      return false;
    }
  }

  return Boolean(value);
}

function normalizeCodeList(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values.map(normalizeCode).filter(Boolean);
}

function normalizeLowerCodeList(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values.map(normalizeLowerCode).filter(Boolean);
}

function normalizeTextList(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values.map(normalizeText).filter(Boolean);
}

function normalizeShippingMode(value, fallback = DEFAULT_LINE_VALUES.shippingClass) {
  const normalized = normalizeLowerCode(value);
  return SHIPPING_MODES.includes(normalized) ? normalized : fallback;
}

function normalizeTemperatureZone(value) {
  const normalized = normalizeLowerCode(value);
  return ['ambient', 'chilled', 'frozen'].includes(normalized) ? normalized : 'ambient';
}

function normalizeLeadTimeBucket(value) {
  const normalized = normalizeLowerCode(value);
  return ['normal', 'reservation', 'preorder', 'backorder'].includes(normalized)
    ? normalized
    : 'normal';
}

function normalizeRegionTier(value) {
  const normalized = normalizeLowerCode(value);
  return REGION_TIERS.includes(normalized) ? normalized : null;
}

function mergeModeTierMap(defaultValue, overrideValue) {
  const result = {};
  const overrides = isPlainObject(overrideValue) ? overrideValue : {};

  for (const mode of SHIPPING_MODES) {
    result[mode] = {
      ...(defaultValue[mode] || {}),
      ...(isPlainObject(overrides[mode]) ? overrides[mode] : {}),
    };
  }

  return result;
}

function mergePointThresholds(overrideValue) {
  const overrides = isPlainObject(overrideValue) ? overrideValue : {};
  const result = { ...DEFAULT_POINT_THRESHOLD_BY_MODE };

  for (const mode of SHIPPING_MODES) {
    result[mode] = toPositiveInteger(overrides[mode], result[mode]) || result[mode];
  }

  return result;
}

function normalizeMatchRule(rule, index) {
  if (!isPlainObject(rule)) {
    return null;
  }

  return {
    id: normalizeText(rule.id || rule.name || `match-rule-${index}`),
    productIds: normalizeTextList(rule.productIds || rule.productId),
    variantIds: normalizeTextList(rule.variantIds || rule.variantId),
    skuIds: normalizeTextList(rule.skuIds || rule.skus || rule.skuId || rule.sku),
    vendors: normalizeTextList(rule.vendors || rule.vendor),
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
  };
}

function normalizeLineRule(rule, index) {
  const matcher = normalizeMatchRule(rule, index);

  if (!matcher) {
    return null;
  }

  const normalized = {
    ...matcher,
    shipFromId: normalizeText(rule.shipFromId || rule.ship_from_id),
    leadTimeBucket: rule.leadTimeBucket || rule.lead_time_bucket,
    shippingClass: rule.shippingClass || rule.shipping_class,
    temperatureZone: rule.temperatureZone || rule.temperature_zone,
    directShipGroup: normalizeText(rule.directShipGroup || rule.direct_ship_group),
    forceSeparateShipment:
      rule.forceSeparateShipment ?? rule.force_separate_shipment,
    freeShippingEligible:
      rule.freeShippingEligible ?? rule.free_shipping_eligible,
    shippingPoint: rule.shippingPoint ?? rule.shipping_point,
  };

  return normalized;
}

function normalizeRateOverride(rule, index) {
  const matcher = normalizeMatchRule(rule, index);
  const amount = toNonNegativeNumber(rule?.amount ?? rule?.totalShippingFee);

  if (!matcher || amount == null) {
    return null;
  }

  return {
    ...matcher,
    amount,
  };
}

function normalizeRemoteIslandOverride(rule, index) {
  const matcher = normalizeMatchRule(rule, index);

  if (!matcher) {
    return null;
  }

  return {
    ...matcher,
    regionTier: normalizeRegionTier(rule.regionTier || rule.region_tier) || 'remote_island',
  };
}

function normalizeFreeShippingRule(value) {
  const normalized = isPlainObject(value) ? value : {};
  const defaultRule = DEFAULT_SHIPPING_RATE_RULE_CONFIG.freeShippingRule;

  return {
    enabled: normalized.enabled !== false,
    threshold:
      toNonNegativeNumber(normalized.threshold ?? normalized.minimumSubtotal) ??
      defaultRule.threshold,
    eligibleModes:
      normalizeLowerCodeList(normalized.eligibleModes || normalized.modes).filter((mode) =>
        SHIPPING_MODES.includes(mode),
      ).length > 0
        ? normalizeLowerCodeList(normalized.eligibleModes || normalized.modes).filter((mode) =>
            SHIPPING_MODES.includes(mode),
          )
        : defaultRule.eligibleModes,
  };
}

function normalizeDisallowedCoolRegions(value) {
  const normalized = isPlainObject(value) ? value : {};
  const defaults = DEFAULT_SHIPPING_RATE_RULE_CONFIG.disallowedCoolRegions;

  return {
    regionTiers:
      normalizeLowerCodeList(normalized.regionTiers || normalized.region_tiers)
        .map(normalizeRegionTier)
        .filter(Boolean).length > 0
        ? normalizeLowerCodeList(normalized.regionTiers || normalized.region_tiers)
            .map(normalizeRegionTier)
            .filter(Boolean)
        : defaults.regionTiers,
    provinceCodes: normalizeCodeList(normalized.provinceCodes || normalized.provinceCode),
    postalCodePrefixes: normalizeTextList(
      normalized.postalCodePrefixes || normalized.postalCodePrefix,
    ),
  };
}

export function normalizeShippingRateRuleConfig(config) {
  const normalized = isPlainObject(config) ? config : {};
  const defaults = DEFAULT_SHIPPING_RATE_RULE_CONFIG;

  return {
    enabled: normalized.enabled !== false,
    currencyCode: normalizeCode(normalized.currencyCode) || defaults.currencyCode,
    defaultAmount:
      toNonNegativeNumber(
        normalized.defaultAmount ??
          normalized.defaultRate ??
          normalized.noRuleAmount ??
          normalized.internationalAmount,
      ) ?? defaults.defaultAmount,
    undeliverableWhenNoRule: normalized.undeliverableWhenNoRule === true,
    lineDefaults: {
      ...defaults.lineDefaults,
      ...(isPlainObject(normalized.lineDefaults) ? normalized.lineDefaults : {}),
    },
    feeMatrix: mergeModeTierMap(defaults.feeMatrix, normalized.feeMatrix),
    extraPackageFee: mergeModeTierMap(defaults.extraPackageFee, normalized.extraPackageFee),
    pointThresholdByMode: mergePointThresholds(normalized.pointThresholdByMode),
    freeShippingRule: normalizeFreeShippingRule(normalized.freeShippingRule),
    lineRules: (
      normalized.lineRules ||
      normalized.productRules ||
      normalized.skuRules ||
      normalized.productOverrides ||
      []
    )
      .map(normalizeLineRule)
      .filter(Boolean),
    rateOverrides: (normalized.rateOverrides || normalized.rules || [])
      .map(normalizeRateOverride)
      .filter(Boolean),
    remoteIslandOverrides: (normalized.remoteIslandOverrides || [])
      .map(normalizeRemoteIslandOverride)
      .filter(Boolean),
    disallowedCoolRegions: normalizeDisallowedCoolRegions(normalized.disallowedCoolRegions),
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

function matchesAnyCode(value, expectedValues) {
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

function ruleMatchesAddress(rule, shippingAddress) {
  return (
    matchesAnyCode(shippingAddress.countryCode, rule.countryCodes) &&
    matchesAnyCode(shippingAddress.provinceCode || shippingAddress.province, rule.provinceCodes) &&
    matchesAnyCode(shippingAddress.provinceName || shippingAddress.province, rule.provinceNames) &&
    matchesPostalCodePrefix(shippingAddress.postalCode, rule.postalCodePrefixes)
  );
}

function ruleMatchesLine(rule, line) {
  return (
    matchesAnyText(line.productId, rule.productIds) &&
    matchesAnyText(line.variantId, rule.variantIds) &&
    matchesAnyText(line.skuId || line.sku, rule.skuIds) &&
    matchesAnyText(line.vendor, rule.vendors)
  );
}

function rateOverrideMatches(rule, input, shippableLines) {
  const shippingAddress = input?.shippingAddress || {};

  return (
    ruleMatchesAddress(rule, shippingAddress) &&
    matchesAnyLineText(shippableLines, 'productId', rule.productIds) &&
    matchesAnyLineText(shippableLines, 'variantId', rule.variantIds) &&
    matchesAnyLineText(shippableLines, 'skuId', rule.skuIds) &&
    matchesAnyLineText(shippableLines, 'vendor', rule.vendors)
  );
}

function findLineRule(line, shippingAddress, config) {
  return config.lineRules.find(
    (rule) => ruleMatchesAddress(rule, shippingAddress) && ruleMatchesLine(rule, line),
  );
}

function normalizeLineWithRule(line, index, shippingAddress, config) {
  const raw = isPlainObject(line) ? line : {};
  const rule = findLineRule(raw, shippingAddress, config) || {};
  const defaults = config.lineDefaults;
  const quantity = toPositiveInteger(raw.quantity ?? raw.qty, 1);
  const shippingPoint =
    toNonNegativeNumber(rule.shippingPoint ?? raw.shippingPoint ?? raw.shipping_point) ??
    defaults.shippingPoint;
  const amountAfterItemDiscountBeforeOrderCoupon = toNonNegativeNumber(
    raw.amountAfterItemDiscountBeforeOrderCoupon ??
      raw.discountedAmount ??
      raw.lineAmount ??
      raw.amount ??
      raw.price,
  );

  return {
    lineId: normalizeText(raw.lineId || raw.id || raw.cartLineId || `shipping-line-${index}`),
    productId: normalizeText(raw.productId || raw.product_id),
    variantId: normalizeText(raw.variantId || raw.variant_id || raw.merchandiseId),
    skuId: normalizeText(raw.skuId || raw.sku),
    vendor: normalizeText(raw.vendor),
    title: normalizeText(raw.title || raw.name),
    quantity,
    requiresShipping: normalizeBoolean(raw.requiresShipping ?? raw.requires_shipping, true),
    amountAfterItemDiscountBeforeOrderCoupon,
    grams: toNonNegativeNumber(raw.grams ?? raw.weightGrams),
    shipFromId:
      normalizeText(rule.shipFromId || raw.shipFromId || raw.ship_from_id) ||
      defaults.shipFromId,
    leadTimeBucket: normalizeLeadTimeBucket(
      rule.leadTimeBucket || raw.leadTimeBucket || raw.lead_time_bucket || defaults.leadTimeBucket,
    ),
    shippingClass: normalizeShippingMode(
      rule.shippingClass || raw.shippingClass || raw.shipping_class || defaults.shippingClass,
    ),
    temperatureZone: normalizeTemperatureZone(
      rule.temperatureZone ||
        raw.temperatureZone ||
        raw.temperature_zone ||
        defaults.temperatureZone,
    ),
    directShipGroup:
      normalizeText(rule.directShipGroup || raw.directShipGroup || raw.direct_ship_group) ||
      null,
    forceSeparateShipment: normalizeBoolean(
      rule.forceSeparateShipment ??
        raw.forceSeparateShipment ??
        raw.force_separate_shipment,
      defaults.forceSeparateShipment,
    ),
    freeShippingEligible: normalizeBoolean(
      rule.freeShippingEligible ??
        raw.freeShippingEligible ??
        raw.free_shipping_eligible,
      defaults.freeShippingEligible,
    ),
    appliedLineRuleId: rule.id || null,
    shippingPoint,
    totalShippingPoint: shippingPoint * quantity,
  };
}

function getShippableLines(lines) {
  return Array.isArray(lines)
    ? lines.filter((line) => line?.requiresShipping && Number(line.quantity) > 0)
    : [];
}

function getTotalShippingPoint(lines) {
  return lines.reduce((total, line) => total + (toNonNegativeNumber(line.totalShippingPoint) || 0), 0);
}

function getTotalWeightGrams(lines) {
  return lines.reduce((total, line) => {
    const lineWeight = toNonNegativeNumber(line.grams) || 0;
    const quantity = toPositiveInteger(line.quantity, 1);
    return total + lineWeight * quantity;
  }, 0);
}

function getLineSubtotal(lines, { eligibleOnly = false } = {}) {
  return lines.reduce((total, line) => {
    if (eligibleOnly && line.freeShippingEligible !== true) {
      return total;
    }

    return total + (toNonNegativeNumber(line.amountAfterItemDiscountBeforeOrderCoupon) || 0);
  }, 0);
}

export function resolveRegionTier(shippingAddress = {}, config = DEFAULT_SHIPPING_RATE_RULE_CONFIG) {
  const countryCode = normalizeCode(
    shippingAddress.countryCode || shippingAddress.country || shippingAddress.country_code,
  );
  const provinceCode = normalizeCode(
    shippingAddress.provinceCode || shippingAddress.prefectureCode || shippingAddress.province,
  );
  const postalCode = normalizeText(
    shippingAddress.postalCode || shippingAddress.zip || shippingAddress.postal_code,
  );

  const remoteOverride = config.remoteIslandOverrides.find((override) =>
    ruleMatchesAddress(override, {
      countryCode,
      provinceCode,
      province: provinceCode,
      provinceName: shippingAddress.provinceName,
      postalCode,
    }),
  );

  if (remoteOverride) {
    return remoteOverride.regionTier;
  }

  if (countryCode === 'US') {
    return 'us';
  }

  if (countryCode && countryCode !== 'JP') {
    return 'international';
  }

  if (provinceCode === 'JP-47') {
    return 'okinawa';
  }

  if (HOKKAIDO_KYUSHU_PROVINCE_CODES.has(provinceCode)) {
    return 'hokkaido_kyushu';
  }

  return 'honshu';
}

function normalizeGroupTemperature(line) {
  if (line.temperatureZone === 'frozen') {
    return 'frozen';
  }

  if (line.temperatureZone === 'chilled' || line.shippingClass === 'cool') {
    return 'chilled';
  }

  return 'ambient';
}

function getGroupKey(line) {
  const directPart =
    line.shippingClass === 'direct' || line.directShipGroup
      ? `direct:${line.directShipGroup || line.lineId}`
      : 'stock';
  const separatePart = line.forceSeparateShipment ? `separate:${line.lineId}` : 'together';

  return [
    line.shipFromId,
    normalizeGroupTemperature(line),
    line.leadTimeBucket,
    directPart,
    separatePart,
  ].join('|');
}

export function groupShipmentLines(lines) {
  const groupsByKey = new Map();

  for (const line of lines) {
    const key = getGroupKey(line);

    if (!groupsByKey.has(key)) {
      groupsByKey.set(key, {
        groupId: `ship_group_${groupsByKey.size + 1}`,
        key,
        shipFromId: line.shipFromId,
        temperatureZone: normalizeGroupTemperature(line),
        leadTimeBucket: line.leadTimeBucket,
        isDirect: line.shippingClass === 'direct' || Boolean(line.directShipGroup),
        isForceSeparate: Boolean(line.forceSeparateShipment),
        lines: [],
        messages: [],
      });
    }

    groupsByKey.get(key).lines.push(line);
  }

  return Array.from(groupsByKey.values());
}

export function determineShipmentMode(group, config = DEFAULT_SHIPPING_RATE_RULE_CONFIG) {
  const lines = group.lines || [];
  const totalPoint = getTotalShippingPoint(lines);

  if (group.isDirect || lines.some((line) => line.shippingClass === 'direct')) {
    return 'direct';
  }

  if (lines.some((line) => line.shippingClass === 'bulky')) {
    return 'bulky';
  }

  if (
    group.temperatureZone === 'frozen' ||
    group.temperatureZone === 'chilled' ||
    lines.some((line) => line.shippingClass === 'cool')
  ) {
    return 'cool';
  }

  if (
    lines.every((line) => line.shippingClass === 'mail') &&
    totalPoint <= (config.pointThresholdByMode?.mail || DEFAULT_POINT_THRESHOLD_BY_MODE.mail)
  ) {
    return 'mail';
  }

  if (
    lines.every((line) => ['mail', 'compact'].includes(line.shippingClass)) &&
    totalPoint <= (config.pointThresholdByMode?.compact || DEFAULT_POINT_THRESHOLD_BY_MODE.compact)
  ) {
    return 'compact';
  }

  return 'parcel';
}

function estimatePackageCount(totalPoint, mode, config) {
  const threshold = toPositiveInteger(config.pointThresholdByMode[mode], 1) || 1;
  return Math.max(1, Math.ceil(totalPoint / threshold));
}

function lookupFee(map, mode, regionTier) {
  const amount = toNonNegativeNumber(map?.[mode]?.[regionTier]);
  return amount == null ? null : amount;
}

function isCoolDisallowed(regionTier, shippingAddress, config) {
  const disallowed = config.disallowedCoolRegions;

  if (disallowed.regionTiers.includes(regionTier)) {
    return true;
  }

  if (!matchesAnyCode(shippingAddress.provinceCode || shippingAddress.province, disallowed.provinceCodes)) {
    return true;
  }

  if (!matchesPostalCodePrefix(shippingAddress.postalCode, disallowed.postalCodePrefixes)) {
    return true;
  }

  return false;
}

function calculateGroupBaseFee({ group, regionTier, shippingAddress, config }) {
  const totalShippingPoint = getTotalShippingPoint(group.lines);
  const mode = determineShipmentMode(group, config);
  const packageCount = estimatePackageCount(totalShippingPoint, mode, config);

  if (mode === 'cool' && isCoolDisallowed(regionTier, shippingAddress, config)) {
    return {
      ...group,
      mode,
      regionTier,
      packageCount,
      totalShippingPoint,
      totalWeightGrams: getTotalWeightGrams(group.lines),
      fee: null,
      originalFee: null,
      isDeliverable: false,
      isFreeShippingApplied: false,
      messages: [...group.messages, 'cool_unavailable_region'],
    };
  }

  const baseFee = lookupFee(config.feeMatrix, mode, regionTier);
  const extraPackageFee = lookupFee(config.extraPackageFee, mode, regionTier);

  if (baseFee == null || (packageCount > 1 && extraPackageFee == null)) {
    return {
      ...group,
      mode,
      regionTier,
      packageCount,
      totalShippingPoint,
      totalWeightGrams: getTotalWeightGrams(group.lines),
      fee: null,
      originalFee: null,
      isDeliverable: false,
      isFreeShippingApplied: false,
      messages: [...group.messages, 'shipping_unavailable'],
    };
  }

  const fee = baseFee + Math.max(0, packageCount - 1) * extraPackageFee;

  return {
    ...group,
    mode,
    regionTier,
    packageCount,
    totalShippingPoint,
    totalWeightGrams: getTotalWeightGrams(group.lines),
    baseFee,
    extraPackageFee,
    fee,
    originalFee: fee,
    isDeliverable: true,
    isFreeShippingApplied: false,
    messages: group.messages,
  };
}

function applyFreeShipping(groups, lines, config) {
  const rule = config.freeShippingRule;

  if (!rule.enabled) {
    return {
      groups,
      freeShippingEligibleSubtotal: getLineSubtotal(lines, { eligibleOnly: true }),
      isFreeShippingThresholdMet: false,
    };
  }

  const freeShippingEligibleSubtotal = getLineSubtotal(lines, { eligibleOnly: true });
  const isFreeShippingThresholdMet = freeShippingEligibleSubtotal >= rule.threshold;
  const eligibleModes = new Set(rule.eligibleModes);

  if (!isFreeShippingThresholdMet) {
    return {
      groups,
      freeShippingEligibleSubtotal,
      isFreeShippingThresholdMet,
    };
  }

  return {
    groups: groups.map((group) => {
      const groupIsEligible =
        group.isDeliverable &&
        eligibleModes.has(group.mode) &&
        group.lines.every((line) => line.freeShippingEligible === true);

      if (!groupIsEligible) {
        return group;
      }

      return {
        ...group,
        fee: 0,
        isFreeShippingApplied: true,
        messages: [...group.messages, 'free_shipping_applied'],
      };
    }),
    freeShippingEligibleSubtotal,
    isFreeShippingThresholdMet,
  };
}

function summarizeLine(line) {
  return {
    lineId: line.lineId,
    productId: line.productId,
    variantId: line.variantId,
    skuId: line.skuId,
    quantity: line.quantity,
    shippingClass: line.shippingClass,
    temperatureZone: line.temperatureZone,
    leadTimeBucket: line.leadTimeBucket,
    shipFromId: line.shipFromId,
    forceSeparateShipment: line.forceSeparateShipment,
    freeShippingEligible: line.freeShippingEligible,
    shippingPoint: line.shippingPoint,
    totalShippingPoint: line.totalShippingPoint,
    amountAfterItemDiscountBeforeOrderCoupon:
      line.amountAfterItemDiscountBeforeOrderCoupon,
    appliedLineRuleId: line.appliedLineRuleId,
  };
}

function summarizeGroup(group) {
  return {
    groupId: group.groupId,
    mode: group.mode,
    regionTier: group.regionTier,
    packageCount: group.packageCount,
    fee: group.fee,
    originalFee: group.originalFee,
    isDeliverable: group.isDeliverable,
    isFreeShippingApplied: group.isFreeShippingApplied,
    totalShippingPoint: group.totalShippingPoint,
    totalWeightGrams: group.totalWeightGrams,
    shipFromId: group.shipFromId,
    temperatureZone: group.temperatureZone,
    leadTimeBucket: group.leadTimeBucket,
    messages: group.messages,
    lines: group.lines.map(summarizeLine),
  };
}

export function resolveShippingRate(input, config) {
  const normalizedConfig = normalizeShippingRateRuleConfig(config);
  const shippingAddress = input?.shippingAddress || {};
  const normalizedLines = (Array.isArray(input?.lines) ? input.lines : []).map((line, index) =>
    normalizeLineWithRule(line, index, shippingAddress, normalizedConfig),
  );
  const shippableLines = getShippableLines(normalizedLines);

  if (shippableLines.length === 0) {
    return {
      isDeliverable: true,
      totalShippingFee: 0,
      currencyCode: normalizedConfig.currencyCode,
      rateSource: 'no_shipping_required',
      matchedRuleId: 'no_shipping_required',
      regionTier: null,
      shippableLineCount: 0,
      totalWeightGrams: 0,
      totalShippingPoint: 0,
      freeShippingEligibleSubtotal: 0,
      isFreeShippingThresholdMet: false,
      groups: [],
      adminBreakdown: {
        normalizedLines: normalizedLines.map(summarizeLine),
      },
    };
  }

  const matchedOverride = normalizedConfig.rateOverrides.find((rule) =>
    rateOverrideMatches(rule, { ...input, shippingAddress }, shippableLines),
  );

  if (matchedOverride) {
    return {
      isDeliverable: true,
      totalShippingFee: matchedOverride.amount,
      currencyCode: normalizedConfig.currencyCode,
      rateSource: 'rate_override',
      matchedRuleId: matchedOverride.id,
      regionTier: resolveRegionTier(shippingAddress, normalizedConfig),
      shippableLineCount: shippableLines.length,
      totalWeightGrams: getTotalWeightGrams(shippableLines),
      totalShippingPoint: getTotalShippingPoint(shippableLines),
      freeShippingEligibleSubtotal: getLineSubtotal(shippableLines, { eligibleOnly: true }),
      isFreeShippingThresholdMet: false,
      groups: [
        {
          groupId: 'rate_override',
          mode: 'parcel',
          regionTier: resolveRegionTier(shippingAddress, normalizedConfig),
          packageCount: 1,
          fee: matchedOverride.amount,
          originalFee: matchedOverride.amount,
          isDeliverable: true,
          isFreeShippingApplied: false,
          messages: ['rate_override_applied'],
          lines: shippableLines.map(summarizeLine),
        },
      ],
      adminBreakdown: {
        normalizedLines: normalizedLines.map(summarizeLine),
        matchedOverride,
      },
    };
  }

  const regionTier = resolveRegionTier(shippingAddress, normalizedConfig);
  const baseGroups = groupShipmentLines(shippableLines).map((group) =>
    calculateGroupBaseFee({
      group,
      regionTier,
      shippingAddress,
      config: normalizedConfig,
    }),
  );
  const undeliverableGroup = baseGroups.find((group) => !group.isDeliverable);

  if (undeliverableGroup) {
    return {
      isDeliverable: false,
      totalShippingFee: null,
      currencyCode: normalizedConfig.currencyCode,
      rateSource: 'group_unavailable',
      matchedRuleId: undeliverableGroup.messages[0] || 'shipping_unavailable',
      regionTier,
      shippableLineCount: shippableLines.length,
      totalWeightGrams: getTotalWeightGrams(shippableLines),
      totalShippingPoint: getTotalShippingPoint(shippableLines),
      freeShippingEligibleSubtotal: getLineSubtotal(shippableLines, { eligibleOnly: true }),
      isFreeShippingThresholdMet: false,
      groups: baseGroups.map(summarizeGroup),
      adminBreakdown: {
        normalizedLines: normalizedLines.map(summarizeLine),
        unavailableGroup: summarizeGroup(undeliverableGroup),
      },
    };
  }

  const freeShippingResult = applyFreeShipping(baseGroups, shippableLines, normalizedConfig);
  const groups = freeShippingResult.groups.map(summarizeGroup);
  const totalShippingFee = groups.reduce((total, group) => total + group.fee, 0);

  return {
    isDeliverable: true,
    totalShippingFee,
    currencyCode: normalizedConfig.currencyCode,
    rateSource: 'shipment_groups',
    matchedRuleId: groups.map((group) => group.mode).join('+'),
    regionTier,
    shippableLineCount: shippableLines.length,
    totalWeightGrams: getTotalWeightGrams(shippableLines),
    totalShippingPoint: getTotalShippingPoint(shippableLines),
    freeShippingEligibleSubtotal: freeShippingResult.freeShippingEligibleSubtotal,
    isFreeShippingThresholdMet: freeShippingResult.isFreeShippingThresholdMet,
    groups,
    adminBreakdown: {
      normalizedLines: normalizedLines.map(summarizeLine),
      groups,
      companySplitPolicy: 'Do not add fees for splits outside configured shipment groups.',
    },
  };
}

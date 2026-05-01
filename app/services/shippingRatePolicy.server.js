import {
  normalizeShippingRateRuleConfig,
  readShippingRateRuleConfig,
  resolveShippingRate,
  REGION_TIERS,
  SHIPPING_MODES,
} from './shippingRateRules.server.js';

const SAMPLE_VARIANT_ID = '47424753369251';
const SAMPLE_PRODUCT_ID = '9044842447011';

const MODE_LABELS = {
  mail: 'Mail',
  compact: 'Compact parcel',
  parcel: 'Standard parcel',
  cool: 'Cool delivery',
  bulky: 'Bulky delivery',
  direct: 'Direct shipment',
};

const REGION_LABELS = {
  honshu: 'Honshu and standard JP regions',
  hokkaido_kyushu: 'Hokkaido and Kyushu',
  okinawa: 'Okinawa',
  remote_island: 'Remote islands',
  us: 'United States',
  asia: 'Asia',
  north_america: 'North America except United States',
  europe: 'Europe',
  oceania: 'Oceania',
  international: 'Other international regions',
};

function normalizeText(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function createQuoteInput({
  countryCode,
  postalCode,
  province,
  provinceCode = null,
  provinceName = null,
  city,
  shippingClass = 'parcel',
}) {
  return {
    shippingAddress: {
      countryCode,
      country: countryCode,
      postalCode,
      zip: postalCode,
      province,
      prefecture: province,
      provinceCode,
      provinceName,
      city,
    },
    lines: [
      {
        productId: SAMPLE_PRODUCT_ID,
        variantId: SAMPLE_VARIANT_ID,
        quantity: 1,
        requiresShipping: true,
        shippingClass,
        grams: 0,
      },
    ],
  };
}

function buildExamples(config) {
  const examples = [
    {
      label: 'Japan standard delivery example',
      destination: 'Tokyo Chiyoda / postal code 100-0001',
      input: createQuoteInput({
        countryCode: 'JP',
        postalCode: '100-0001',
        province: 'JP-13',
        provinceCode: 'JP-13',
        provinceName: 'Tokyo',
        city: 'Chiyoda',
      }),
    },
    {
      label: 'Japan standard delivery example',
      destination: 'Ibaraki Toride / postal code 300-1532',
      input: createQuoteInput({
        countryCode: 'JP',
        postalCode: '300-1532',
        province: 'JP-08',
        provinceCode: 'JP-08',
        provinceName: 'Ibaraki',
        city: 'Toride',
      }),
    },
    {
      label: 'International delivery example',
      destination: 'United States New York / ZIP 10118',
      input: createQuoteInput({
        countryCode: 'US',
        postalCode: '10118',
        province: 'NY',
        provinceName: 'NY',
        city: 'New York',
      }),
    },
    {
      label: 'Asia delivery example',
      destination: 'Singapore / postal code 018956',
      input: createQuoteInput({
        countryCode: 'SG',
        postalCode: '018956',
        province: null,
        city: 'Singapore',
      }),
    },
    {
      label: 'Europe delivery example',
      destination: 'France Paris / postal code 75001',
      input: createQuoteInput({
        countryCode: 'FR',
        postalCode: '75001',
        province: null,
        city: 'Paris',
      }),
    },
    {
      label: 'Oceania delivery example',
      destination: 'Australia Sydney / postal code 2000',
      input: createQuoteInput({
        countryCode: 'AU',
        postalCode: '2000',
        province: 'NSW',
        provinceName: 'NSW',
        city: 'Sydney',
      }),
    },
    {
      label: 'Other international delivery example',
      destination: 'South Africa Cape Town / postal code 8001',
      input: createQuoteInput({
        countryCode: 'ZA',
        postalCode: '8001',
        province: null,
        city: 'Cape Town',
      }),
    },
  ];

  return examples.map((example) => {
    const result = resolveShippingRate(example.input, config);

    return {
      label: example.label,
      destination: example.destination,
      amount: result.totalShippingFee,
      isDeliverable: result.isDeliverable,
      matchedRuleId: result.matchedRuleId,
    };
  });
}

function calculateAverageAmount(amounts) {
  if (amounts.length === 0) {
    return null;
  }

  return Math.round(
    amounts.reduce((total, amount) => total + amount, 0) / amounts.length,
  );
}

function buildFeeMatrixRows(config) {
  const rows = [];

  for (const mode of SHIPPING_MODES) {
    for (const regionTier of REGION_TIERS) {
      const amount = config.feeMatrix?.[mode]?.[regionTier];

      if (!Number.isFinite(amount)) {
        continue;
      }

      rows.push({
        id: `${mode}-${regionTier}`,
        condition: `${MODE_LABELS[mode] || mode} / ${REGION_LABELS[regionTier] || regionTier}`,
        amount,
      });
    }
  }

  return rows;
}

export function buildShippingRatePolicyData({
  rawRuleConfig,
  ruleConfig,
  generatedAt = new Date(),
} = {}) {
  const configResult = ruleConfig
    ? { ok: true, config: normalizeShippingRateRuleConfig(ruleConfig) }
    : readShippingRateRuleConfig(rawRuleConfig ?? process.env.SHIPPING_V2_RATE_RULES_JSON);

  if (!configResult.ok) {
    return {
      ok: false,
      reason: configResult.reason,
      error: configResult.error,
    };
  }

  const config = configResult.config;
  const rows = buildFeeMatrixRows(config);
  const shippableAmounts = rows.map((row) => row.amount).filter((amount) => Number.isFinite(amount));
  const minimumAmount = shippableAmounts.length > 0 ? Math.min(...shippableAmounts) : null;
  const maximumAmount = shippableAmounts.length > 0 ? Math.max(...shippableAmounts) : null;

  return {
    ok: true,
    generatedAt: generatedAt.toISOString(),
    currencyCode: config.currencyCode,
    enabled: config.enabled,
    minimumAmount,
    maximumAmount,
    averageAmount: calculateAverageAmount(shippableAmounts),
    defaultAmount: config.defaultAmount,
    undeliverableWhenNoRule: config.undeliverableWhenNoRule,
    rows,
    examples: buildExamples(config),
    note: normalizeText(process.env.SHIPPING_POLICY_NOTE),
  };
}

import {
  normalizeShippingRateRuleConfig,
  readShippingRateRuleConfig,
  resolveShippingRate,
} from './shippingRateRules.server.js';

const COUNTRY_LABELS_JA = {
  JP: '日本',
  US: '米国',
};

const SAMPLE_VARIANT_ID = '47424753369251';
const SAMPLE_PRODUCT_ID = '9044842447011';

function normalizeText(value) {
  const normalized = String(value || '').trim();

  return normalized || null;
}

function formatConditionList(values) {
  return values.length > 0 ? values.join(', ') : null;
}

function getCountryLabel(countryCode) {
  return COUNTRY_LABELS_JA[countryCode] || countryCode;
}

function describeRule(rule) {
  const parts = [];

  if (rule.countryCodes.length > 0) {
    parts.push(`配送先: ${rule.countryCodes.map(getCountryLabel).join(', ')}`);
  }

  if (rule.provinceCodes.length > 0) {
    parts.push(`都道府県コード: ${formatConditionList(rule.provinceCodes)}`);
  }

  if (rule.provinceNames.length > 0) {
    parts.push(`都道府県: ${formatConditionList(rule.provinceNames)}`);
  }

  if (rule.postalCodePrefixes.length > 0) {
    parts.push(`郵便番号の先頭: ${formatConditionList(rule.postalCodePrefixes)}`);
  }

  if (rule.productIds.length > 0) {
    parts.push(`対象商品ID: ${formatConditionList(rule.productIds)}`);
  }

  if (rule.variantIds.length > 0) {
    parts.push(`対象バリアントID: ${formatConditionList(rule.variantIds)}`);
  }

  if (rule.minTotalWeightGrams != null || rule.maxTotalWeightGrams != null) {
    const min = rule.minTotalWeightGrams ?? 0;
    const max = rule.maxTotalWeightGrams ?? '上限なし';
    parts.push(`重量: ${min}g - ${max}g`);
  }

  return parts.length > 0 ? parts.join(' / ') : '全配送先';
}

function createQuoteInput({
  countryCode,
  postalCode,
  province,
  provinceCode = null,
  provinceName = null,
  city,
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
        grams: 0,
      },
    ],
  };
}

function buildExamples(config) {
  const examples = [
    {
      label: '日本国内配送の例',
      destination: '東京都千代田区 / 郵便番号 100-0001',
      input: createQuoteInput({
        countryCode: 'JP',
        postalCode: '100-0001',
        province: 'JP-13',
        provinceCode: 'JP-13',
        provinceName: 'Tokyo',
        city: '千代田区',
      }),
    },
    {
      label: '日本国内配送の例',
      destination: '茨城県取手市 / 郵便番号 300-1532',
      input: createQuoteInput({
        countryCode: 'JP',
        postalCode: '300-1532',
        province: 'JP-08',
        provinceCode: 'JP-08',
        provinceName: 'Ibaraki',
        city: '取手市',
      }),
    },
    {
      label: '海外配送の例',
      destination: '米国 New York / ZIP 10118',
      input: createQuoteInput({
        countryCode: 'US',
        postalCode: '10118',
        province: 'NY',
        provinceName: 'NY',
        city: 'New York',
      }),
    },
    {
      label: 'その他海外配送の例',
      destination: 'フランス Paris / 郵便番号 75001',
      input: createQuoteInput({
        countryCode: 'FR',
        postalCode: '75001',
        province: null,
        city: 'Paris',
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
  const ruleRows = config.rules.map((rule) => ({
    id: rule.id,
    condition: describeRule(rule),
    amount: rule.amount,
  }));
  const shippableAmounts = [
    ...ruleRows.map((rule) => rule.amount),
    ...(config.undeliverableWhenNoRule ? [] : [config.defaultAmount]),
  ].filter((amount) => Number.isFinite(amount));
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
    rows: ruleRows,
    examples: buildExamples(config),
    note: normalizeText(process.env.SHIPPING_POLICY_NOTE),
  };
}

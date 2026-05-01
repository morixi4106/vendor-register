import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readShippingRateRuleConfig,
  resolveShippingRate,
} from '../../app/services/shippingRateRules.server.js';

function createInput(overrides = {}) {
  return {
    shippingAddress: {
      countryCode: 'JP',
      postalCode: '150-0001',
      province: 'JP-13',
      provinceCode: 'JP-13',
      provinceName: 'Tokyo',
      ...overrides.shippingAddress,
    },
    lines: [
      {
        productId: 'product-1',
        variantId: 'variant-1',
        quantity: 2,
        requiresShipping: true,
        grams: 500,
      },
      ...(overrides.lines || []),
    ],
    shippableLineCount: 1 + (overrides.lines || []).length,
  };
}

test('shipping rate rules preserve default JP and US rates', () => {
  const config = readShippingRateRuleConfig(null).config;

  assert.equal(resolveShippingRate(createInput(), config).totalShippingFee, 870);
  assert.equal(
    resolveShippingRate(
      createInput({
        shippingAddress: {
          countryCode: 'US',
          province: 'NY',
          provinceCode: null,
          provinceName: 'NY',
        },
      }),
      config,
    ).totalShippingFee,
    2500,
  );
});

test('shipping rate rules match province, variant, and weight constraints', () => {
  const resolution = resolveShippingRate(createInput(), {
    currencyCode: 'JPY',
    defaultAmount: 3500,
    rules: [
      {
        id: 'tokyo-light-variant',
        countryCodes: ['JP'],
        provinceCodes: ['JP-13'],
        variantIds: ['variant-1'],
        maxTotalWeightGrams: 1200,
        amount: 990,
      },
    ],
  });

  assert.equal(resolution.totalShippingFee, 990);
  assert.equal(resolution.matchedRuleId, 'tokyo-light-variant');
  assert.equal(resolution.totalWeightGrams, 1000);
});

test('shipping rate rules can mark unmatched destinations undeliverable', () => {
  const resolution = resolveShippingRate(
    createInput({
      shippingAddress: {
        countryCode: 'FR',
        province: null,
        provinceCode: null,
        provinceName: null,
      },
    }),
    {
      undeliverableWhenNoRule: true,
      rules: [
        {
          id: 'jp-only',
          countryCodes: ['JP'],
          amount: 870,
        },
      ],
    },
  );

  assert.equal(resolution.isDeliverable, false);
  assert.equal(resolution.totalShippingFee, null);
  assert.equal(resolution.rateSource, 'no_matching_rule');
});

test('shipping rate rule config reports invalid JSON without throwing', () => {
  const result = readShippingRateRuleConfig('{nope');

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'shipping_rule_config_error');
  assert.match(result.error, /JSON/);
});

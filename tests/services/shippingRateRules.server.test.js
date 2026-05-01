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
    rateOverrides: [
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
      feeMatrix: {
        parcel: {
          international: null,
        },
      },
    },
  );

  assert.equal(resolution.isDeliverable, false);
  assert.equal(resolution.totalShippingFee, null);
  assert.equal(resolution.rateSource, 'group_unavailable');
});

test('shipping rate rules split direct, cool, and normal shipment groups', () => {
  const resolution = resolveShippingRate(
    createInput({
      lines: [
        {
          productId: 'product-cool',
          variantId: 'variant-cool',
          quantity: 1,
          requiresShipping: true,
          temperatureZone: 'chilled',
          shippingPoint: 1,
        },
        {
          productId: 'product-direct',
          variantId: 'variant-direct',
          quantity: 1,
          requiresShipping: true,
          shippingClass: 'direct',
          directShipGroup: 'maker-a',
          shippingPoint: 1,
        },
      ],
    }),
  );

  assert.equal(resolution.isDeliverable, true);
  assert.deepEqual(
    resolution.groups.map((group) => group.mode).sort(),
    ['cool', 'direct', 'parcel'],
  );
  assert.equal(resolution.groups.length, 3);
});

test('shipping rate rules apply free shipping only to eligible normal groups', () => {
  const resolution = resolveShippingRate(
    createInput({
      lines: [
        {
          productId: 'product-cool',
          variantId: 'variant-cool',
          quantity: 1,
          requiresShipping: true,
          temperatureZone: 'chilled',
          amountAfterItemDiscountBeforeOrderCoupon: 1000,
        },
      ],
    }),
    {
      freeShippingRule: {
        threshold: 1000,
        eligibleModes: ['parcel'],
      },
    },
  );

  const parcelGroup = resolution.groups.find((group) => group.mode === 'parcel');
  const coolGroup = resolution.groups.find((group) => group.mode === 'cool');

  assert.equal(resolution.isFreeShippingThresholdMet, true);
  assert.equal(parcelGroup.fee, 0);
  assert.equal(parcelGroup.isFreeShippingApplied, true);
  assert.equal(coolGroup.isFreeShippingApplied, false);
});

test('shipping rate rules estimate package count by shipping points', () => {
  const resolution = resolveShippingRate(
    createInput({
      lines: [],
    }),
    {
      pointThresholdByMode: {
        parcel: 3,
      },
    },
  );

  assert.equal(resolution.groups[0].mode, 'parcel');
  assert.equal(resolution.groups[0].packageCount, 1);

  const oversized = resolveShippingRate(
    createInput({
      lines: [
        {
          productId: 'product-2',
          variantId: 'variant-2',
          quantity: 2,
          requiresShipping: true,
          shippingPoint: 2,
        },
      ],
    }),
    {
      pointThresholdByMode: {
        parcel: 3,
      },
    },
  );

  assert.equal(oversized.groups[0].packageCount, 2);
  assert.equal(oversized.groups[0].fee, 1570);
});

test('shipping rate rule config reports invalid JSON without throwing', () => {
  const result = readShippingRateRuleConfig('{nope');

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'shipping_rule_config_error');
  assert.match(result.error, /JSON/);
});

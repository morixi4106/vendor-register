import assert from 'node:assert/strict';
import test from 'node:test';

import { buildShippingRatePolicyData } from '../../app/services/shippingRatePolicy.server.js';

const FIXED_DATE = new Date('2026-05-02T00:00:00.000Z');

test('shipping rate policy exposes minimum, maximum, average, and examples', () => {
  const policy = buildShippingRatePolicyData({
    rawRuleConfig: '',
    generatedAt: FIXED_DATE,
  });

  assert.equal(policy.ok, true);
  assert.equal(policy.generatedAt, FIXED_DATE.toISOString());
  assert.equal(policy.minimumAmount, 870);
  assert.equal(policy.maximumAmount, 3500);
  assert.equal(policy.averageAmount, 2290);
  assert.equal(policy.rows.some((row) => row.id === 'jp-default'), true);
  assert.equal(policy.rows.some((row) => row.id === 'us-default'), true);
  assert.equal(policy.examples.length >= 4, true);
  assert.equal(
    policy.examples.some(
      (example) => example.destination.includes('100-0001') && example.amount === 870,
    ),
    true,
  );
});

test('shipping rate policy reflects configured public rules', () => {
  const policy = buildShippingRatePolicyData({
    generatedAt: FIXED_DATE,
    ruleConfig: {
      currencyCode: 'JPY',
      defaultAmount: 4200,
      rules: [
        {
          id: 'tokyo-policy-test',
          countryCodes: ['JP'],
          provinceCodes: ['JP-13'],
          variantIds: ['47424753369251'],
          amount: 990,
        },
      ],
    },
  });

  assert.equal(policy.minimumAmount, 990);
  assert.equal(policy.maximumAmount, 4200);
  assert.deepEqual(policy.rows, [
    {
      id: 'tokyo-policy-test',
      condition:
        '配送先: 日本 / 都道府県コード: JP-13 / 対象バリアントID: 47424753369251',
      amount: 990,
    },
  ]);
  assert.equal(
    policy.examples.find((example) => example.destination.includes('100-0001'))
      .matchedRuleId,
    'tokyo-policy-test',
  );
});

test('shipping rate policy reports invalid config without throwing', () => {
  const policy = buildShippingRatePolicyData({
    rawRuleConfig: '{nope',
    generatedAt: FIXED_DATE,
  });

  assert.equal(policy.ok, false);
  assert.equal(policy.reason, 'shipping_rule_config_error');
});

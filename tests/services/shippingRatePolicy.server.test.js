import assert from 'node:assert/strict';
import test from 'node:test';

import { buildShippingRatePolicyData } from '../../app/services/shippingRatePolicy.server.js';

const FIXED_DATE = new Date('2026-05-02T00:00:00.000Z');

test('shipping rate policy exposes minimum, maximum, and examples', () => {
  const policy = buildShippingRatePolicyData({
    rawRuleConfig: '',
    generatedAt: FIXED_DATE,
  });

  assert.equal(policy.ok, true);
  assert.equal(policy.generatedAt, FIXED_DATE.toISOString());
  assert.equal(policy.minimumAmount, 370);
  assert.equal(policy.maximumAmount, 15000);
  assert.equal(policy.rows.some((row) => row.id === 'parcel-honshu'), true);
  assert.equal(policy.rows.some((row) => row.id === 'direct-international'), true);
  assert.equal(policy.examples.length >= 4, true);
  assert.equal(
    policy.examples.some(
      (example) => example.destination.includes('100-0001') && example.amount === 870,
    ),
    true,
  );
});

test('shipping rate policy reflects configured fee matrix values', () => {
  const policy = buildShippingRatePolicyData({
    generatedAt: FIXED_DATE,
    ruleConfig: {
      currencyCode: 'JPY',
      defaultAmount: 4200,
      feeMatrix: {
        parcel: {
          honshu: 990,
        },
      },
    },
  });

  assert.equal(policy.rows.find((row) => row.id === 'parcel-honshu').amount, 990);
  assert.equal(
    policy.examples.find((example) => example.destination.includes('100-0001')).amount,
    990,
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

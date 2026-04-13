import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculatePrice,
  calculatePriceBreakdown,
} from '../../app/utils/priceCalculator.js';

function assertAlmostEqual(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
}

test('calculatePrice applies duty, margin, fees, and rounds up', () => {
  const input = {
    costAmount: 100,
    fxRate: 1,
    dutyRate: 0.1,
    marginRate: 0.2,
    paymentFeeRate: 0.05,
    paymentFeeFixed: 10,
    bufferRate: 0.1,
  };

  const breakdown = calculatePriceBreakdown(input);

  assert.equal(breakdown.costFx, 100);
  assert.equal(breakdown.duty, 10);
  assert.equal(breakdown.landed, 110);
  assertAlmostEqual(breakdown.safeCost, 121);
  assertAlmostEqual(breakdown.target, 145.2);
  assertAlmostEqual(breakdown.rawPrice, 163.36842105263156);
  assert.equal(breakdown.finalPrice, 164);
  assert.equal(calculatePrice(input), 164);
});

test('calculatePrice handles decimal inputs and always rounds upward', () => {
  const finalPrice = calculatePrice({
    costAmount: 10.5,
    fxRate: 150,
    dutyRate: 0.2,
    marginRate: 0.1,
    paymentFeeRate: 0.04,
    paymentFeeFixed: 50,
    bufferRate: 0.1,
  });

  assert.equal(finalPrice, 2435);
});

test('calculatePrice rejects invalid payment fee rate', () => {
  assert.throws(
    () =>
      calculatePrice({
        costAmount: 100,
        fxRate: 1,
        dutyRate: 0,
        marginRate: 0.1,
        paymentFeeRate: 1,
        paymentFeeFixed: 0,
        bufferRate: 0,
      }),
    /paymentFeeRate must be between 0 and 1/,
  );
});

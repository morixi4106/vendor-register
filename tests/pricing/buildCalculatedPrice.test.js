import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCalculatedPrice,
  calculateProductPrice,
  calculateProductPriceResult,
  validatePriceInputs,
} from '../../app/utils/buildCalculatedPrice.js';

test('calculateProductPrice uses provided settings, fx, and duty values', async () => {
  const result = await calculateProductPrice(
    {
      costAmount: '10.5',
      costCurrency: 'usd',
      dutyCategory: 'cosmetics',
      shopDomain: 'shop-a.myshopify.com',
    },
    {
      shopDomain: 'shop-a.myshopify.com',
      settings: {
        shopDomain: 'shop-a.myshopify.com',
        defaultMarginRate: 0.1,
        paymentFeeRate: 0.04,
        paymentFeeFixed: 50,
        bufferRate: 0.1,
      },
      fxRate: 150,
    },
  );

  assert.equal(result.shopDomain, 'shop-a.myshopify.com');
  assert.equal(result.input.costAmount, 10.5);
  assert.equal(result.input.costCurrency, 'USD');
  assert.equal(result.input.dutyCategory, 'cosmetics');
  assert.equal(result.input.fxRate, 150);
  assert.equal(result.input.dutyRate, 0.2);
  assert.equal(result.finalPrice, 2435);
  assert.equal(result.breakdown.finalPrice, 2435);
});

test('buildCalculatedPrice reads pricing metafields as the linked product input source', async () => {
  const result = await buildCalculatedPrice(
    {
      shopDomain: 'shop-a.myshopify.com',
      costAmount: 9999,
      metafields: [
        { namespace: 'pricing', key: 'cost_amount', value: '25' },
        { namespace: 'pricing', key: 'cost_currency', value: 'EUR' },
        { namespace: 'pricing', key: 'duty_category', value: 'cosmetics' },
      ],
    },
    {
      settings: {
        shopDomain: 'shop-a.myshopify.com',
        defaultMarginRate: 0.1,
        paymentFeeRate: 0.04,
        paymentFeeFixed: 50,
        bufferRate: 0.1,
      },
      fxRate: 2,
    },
  );

  assert.equal(result.input.costAmount, 25);
  assert.equal(result.input.costCurrency, 'EUR');
  assert.equal(result.input.dutyCategory, 'cosmetics');
  assert.equal(result.finalPrice, 128);
});

test('costAmount zero is allowed for preview-style validation but rejected for apply-style validation', async () => {
  const previewInput = validatePriceInputs(
    {
      costAmount: 0,
      costCurrency: 'jpy',
    },
    {
      requirePositiveCostAmount: false,
    },
  );

  assert.equal(previewInput.costAmount, 0);
  assert.equal(previewInput.costCurrency, 'JPY');

  const applyResult = await calculateProductPriceResult(
    {
      costAmount: 0,
      costCurrency: 'JPY',
      shopDomain: 'shop-a.myshopify.com',
    },
    {
      requirePositiveCostAmount: true,
      shopDomain: 'shop-a.myshopify.com',
      settings: {
        shopDomain: 'shop-a.myshopify.com',
        defaultMarginRate: 0.1,
        paymentFeeRate: 0.04,
        paymentFeeFixed: 50,
        bufferRate: 0.1,
      },
      fxRate: 1,
    },
  );

  assert.equal(applyResult.ok, false);
  assert.equal(applyResult.error.status, 'invalid');
  assert.equal(applyResult.error.message, 'pricing.cost_amount is empty');
});

test('calculateProductPriceResult normalizes invalid calculation failures', async () => {
  const result = await calculateProductPriceResult(
    {
      costAmount: 'not-a-number',
      costCurrency: 'JPY',
    },
    {
      settings: {
        shopDomain: 'shop-a.myshopify.com',
        defaultMarginRate: 0.1,
        paymentFeeRate: 0.04,
        paymentFeeFixed: 50,
        bufferRate: 0.1,
      },
      fxRate: 1,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.status, 'invalid');
  assert.equal(result.error.code, 'invalid_cost_amount');
  assert.equal(result.error.needsReconnect, false);
});

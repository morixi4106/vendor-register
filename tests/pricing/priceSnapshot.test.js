import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRICE_FORMULA_VERSION,
  buildPriceSnapshot,
  buildPriceSnapshotUpdate,
} from '../../app/utils/priceSnapshot.js';

function createPriceResult() {
  return {
    shopDomain: 'shop-a.myshopify.com',
    finalPrice: 2435,
    input: {
      costAmount: 10.5,
      costCurrency: 'USD',
      dutyCategory: 'cosmetics',
      fxRate: 150,
      dutyRate: 0.2,
      marginRate: 0.1,
      paymentFeeRate: 0.04,
      paymentFeeFixed: 50,
    },
    settings: {
      defaultMarginRate: 0.1,
      paymentFeeRate: 0.04,
      paymentFeeFixed: 50,
      bufferRate: 0.1,
    },
    breakdown: {
      rawPrice: 2434.2708333333335,
      finalPrice: 2435,
    },
  };
}

test('buildPriceSnapshot preserves explanation inputs, source, and formula version', () => {
  const snapshot = buildPriceSnapshot(createPriceResult(), {
    calculatedAt: new Date('2026-04-09T10:00:00.000Z'),
    localProductId: 'prod_local_1',
    shopifyProductId: 'gid://shopify/Product/1',
    shopDomain: 'shop-a.myshopify.com',
    snapshotType: 'preview',
    source: {
      pricingInput: 'shopify_product_metafields',
      shopSettings: 'shopify_shop_metafields',
      fxRate: 'fx_rate_table',
    },
  });

  assert.equal(snapshot.snapshotType, 'preview');
  assert.equal(snapshot.priceFormulaVersion, PRICE_FORMULA_VERSION);
  assert.equal(snapshot.calculatedAt, '2026-04-09T10:00:00.000Z');
  assert.equal(snapshot.shopDomain, 'shop-a.myshopify.com');
  assert.equal(snapshot.input.shopDomain, 'shop-a.myshopify.com');
  assert.equal(snapshot.input.costAmount, 10.5);
  assert.equal(snapshot.input.costCurrency, 'USD');
  assert.equal(snapshot.input.dutyCategory, 'cosmetics');
  assert.deepEqual(snapshot.source, {
    pricingInput: 'shopify_product_metafields',
    shopSettings: 'shopify_shop_metafields',
    fxRate: 'fx_rate_table',
  });
  assert.deepEqual(snapshot.roundingResult, {
    method: 'Math.ceil',
    rawPrice: 2434.2708333333335,
    finalPrice: 2435,
  });
});

test('buildPriceSnapshotUpdate maps the latest successful snapshot back to Product fields', () => {
  const snapshot = buildPriceSnapshot(createPriceResult(), {
    calculatedAt: new Date('2026-04-09T10:00:00.000Z'),
    localProductId: 'prod_local_1',
    shopifyProductId: 'gid://shopify/Product/1',
    shopDomain: 'shop-a.myshopify.com',
  });

  const update = buildPriceSnapshotUpdate(snapshot);

  assert.equal(update.calculatedPrice, 2435);
  assert.equal(update.usedFxRate, 150);
  assert.equal(update.usedMargin, 0.1);
  assert.equal(update.usedDutyRate, 0.2);
  assert.ok(update.calculatedAt instanceof Date);
  assert.equal(update.calculatedAt.toISOString(), '2026-04-09T10:00:00.000Z');
  assert.equal(update.priceFormulaVersion, PRICE_FORMULA_VERSION);
  assert.deepEqual(update.priceSnapshotJson, snapshot);
});

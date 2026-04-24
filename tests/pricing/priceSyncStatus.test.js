import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRICE_SYNC_STATUS,
  createPriceCalculationError,
  getEffectivePriceSyncStatus,
  normalizePriceSyncFailure,
} from '../../app/utils/priceSyncStatus.js';

test('getEffectivePriceSyncStatus prefers explicit status and falls back to latest snapshot presence', () => {
  assert.equal(
    getEffectivePriceSyncStatus({ priceSyncStatus: PRICE_SYNC_STATUS.INVALID }),
    PRICE_SYNC_STATUS.INVALID,
  );

  assert.equal(
    getEffectivePriceSyncStatus({ priceSnapshotJson: { calculatedPrice: 1000 } }),
    PRICE_SYNC_STATUS.APPLIED,
  );

  assert.equal(getEffectivePriceSyncStatus({}), PRICE_SYNC_STATUS.CALCULATED_NOT_APPLIED);
});

test('normalizePriceSyncFailure keeps structured calculation failures as invalid', () => {
  const failure = normalizePriceSyncFailure(
    createPriceCalculationError('invalid_cost_amount', 'costAmount must be a valid number'),
  );

  assert.equal(failure.code, 'invalid_cost_amount');
  assert.equal(failure.status, PRICE_SYNC_STATUS.INVALID);
  assert.equal(failure.needsReconnect, false);
});

test('normalizePriceSyncFailure maps auth failures to reconnectable apply failures', () => {
  const failure = normalizePriceSyncFailure(
    new Error('Shopify GraphQL request failed: 401 {"errors":"Unauthorized"}'),
  );

  assert.equal(failure.code, 'shopify_auth_error');
  assert.equal(failure.status, PRICE_SYNC_STATUS.APPLY_FAILED);
  assert.equal(failure.message, 'Shopify authentication is required');
  assert.equal(failure.needsReconnect, true);
});

test('normalizePriceSyncFailure preserves shop-specific offline-session failures', () => {
  const failure = normalizePriceSyncFailure(
    new Error('Offline session not found for shop: b301ze-1a.myshopify.com'),
  );

  assert.equal(failure.code, 'shopify_auth_error');
  assert.equal(failure.status, PRICE_SYNC_STATUS.APPLY_FAILED);
  assert.equal(
    failure.message,
    'Offline session not found for shop: b301ze-1a.myshopify.com',
  );
  assert.equal(failure.needsReconnect, true);
});

test('normalizePriceSyncFailure maps Shopify mutation failures to apply_failed without reconnect', () => {
  const failure = normalizePriceSyncFailure(
    new Error('productVariantsBulkUpdate failed: [{"message":"invalid"}]'),
  );

  assert.equal(failure.code, 'shopify_apply_error');
  assert.equal(failure.status, PRICE_SYNC_STATUS.APPLY_FAILED);
  assert.equal(failure.needsReconnect, false);
});

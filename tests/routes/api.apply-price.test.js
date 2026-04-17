import assert from 'node:assert/strict';
import test from 'node:test';

import { createApplyPriceAction } from '../../app/services/api.apply-price.server.js';
import { PRICE_SYNC_STATUS } from '../../app/utils/priceSyncStatus.js';

test('api.apply-price returns 400 when productId is missing', async () => {
  const action = createApplyPriceAction();
  const request = new Request('http://localhost/api/apply-price', {
    method: 'POST',
    body: JSON.stringify({}),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'productId is required',
  });
});

test('api.apply-price returns the apply result on success', async () => {
  const action = createApplyPriceAction({
    applyProductPriceImpl: async (productId, options) => ({
      ok: true,
      productId,
      shopDomain: options.shopDomain,
      newPrice: '2435',
    }),
  });

  const request = new Request('http://localhost/api/apply-price', {
    method: 'POST',
    body: JSON.stringify({
      productId: 'gid://shopify/Product/1',
      shopDomain: 'shop-a.myshopify.com',
    }),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    productId: 'gid://shopify/Product/1',
    shopDomain: 'shop-a.myshopify.com',
    newPrice: '2435',
  });
});

test('api.apply-price maps apply failures to response JSON', async () => {
  const action = createApplyPriceAction({
    applyProductPriceImpl: async () => {
      const error = new Error('Shopify authentication is required');
      error.priceSyncFailure = {
        status: PRICE_SYNC_STATUS.APPLY_FAILED,
        message: 'Shopify authentication is required',
        needsReconnect: true,
      };
      throw error;
    },
  });

  const request = new Request('http://localhost/api/apply-price', {
    method: 'POST',
    body: JSON.stringify({
      productId: 'gid://shopify/Product/1',
    }),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'Shopify authentication is required',
    priceSyncStatus: PRICE_SYNC_STATUS.APPLY_FAILED,
    needsReconnect: true,
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRefreshFxCronHandler,
  createRefreshFxAction,
  createRunRefreshFx,
  createRunAutoPriceRefresh,
} from '../../app/services/api.refresh-fx.server.js';

function createFakePrismaForAutoRefresh(products = []) {
  return {
    product: {
      async findMany() {
        return products.map((product) => ({ ...product }));
      },
    },
  };
}

test('api.refresh-fx refreshes rates without auto applying prices by default', async () => {
  let applyCalled = false;
  const action = createRefreshFxAction({
    apiKey: 'test-key',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          conversion_rates: {
            JPY: 150,
            USD: 1,
            EUR: 0.9,
            GBP: 0.8,
            CNY: 7.2,
            KRW: 1300,
          },
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      ),
    upsertFxRateImpl: async ({ base, quote, rate }) => ({ base, quote, rate }),
    runAutoPriceRefreshImpl: async () => {
      applyCalled = true;
      return {};
    },
  });
  const request = new Request('http://localhost/api/refresh-fx', {
    method: 'POST',
  });

  const response = await action({ request });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    message: 'Updated 5 FX rates',
    fxRates: [
      { base: 'USD', quote: 'JPY', rate: 150 },
      { base: 'EUR', quote: 'JPY', rate: 166.66666666666666 },
      { base: 'GBP', quote: 'JPY', rate: 187.5 },
      { base: 'CNY', quote: 'JPY', rate: 20.833333333333332 },
      { base: 'KRW', quote: 'JPY', rate: 0.11538461538461539 },
    ],
    priceRefresh: null,
  });
  assert.equal(applyCalled, false);
});

test('api.refresh-fx auto applies prices sequentially and reports updated/skipped/failed counts', async () => {
  const action = createRefreshFxAction({
    apiKey: 'test-key',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          conversion_rates: {
            JPY: 150,
            USD: 1,
            EUR: 0.9,
            GBP: 0.8,
            CNY: 7.2,
            KRW: 1300,
          },
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      ),
    upsertFxRateImpl: async ({ base, quote, rate }) => ({ base, quote, rate }),
    runAutoPriceRefreshImpl: async () => ({
      targeted: 3,
      processed: 3,
      updated: 1,
      skipped: 1,
      failed: 1,
      failedProducts: ['prod_local_3'],
      skippedMissingShopDomainProducts: [],
    }),
  });
  const request = new Request('http://localhost/api/refresh-fx?autoApplyPrices=1', {
    method: 'POST',
  });

  const response = await action({ request });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    message: 'Updated 5 FX rates',
    fxRates: [
      { base: 'USD', quote: 'JPY', rate: 150 },
      { base: 'EUR', quote: 'JPY', rate: 166.66666666666666 },
      { base: 'GBP', quote: 'JPY', rate: 187.5 },
      { base: 'CNY', quote: 'JPY', rate: 20.833333333333332 },
      { base: 'KRW', quote: 'JPY', rate: 0.11538461538461539 },
    ],
    priceRefresh: {
      targeted: 3,
      processed: 3,
      updated: 1,
      skipped: 1,
      failed: 1,
      failedProducts: ['prod_local_3'],
      skippedMissingShopDomainProducts: [],
    },
  });
});

test('createRunRefreshFx returns the same payload shape used by api.refresh-fx with auto apply enabled', async () => {
  const runRefreshFx = createRunRefreshFx({
    apiKey: 'test-key',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          conversion_rates: {
            JPY: 150,
            USD: 1,
            EUR: 0.9,
            GBP: 0.8,
            CNY: 7.2,
            KRW: 1300,
          },
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      ),
    upsertFxRateImpl: async ({ base, quote, rate }) => ({ base, quote, rate }),
    runAutoPriceRefreshImpl: async () => ({
      targeted: 1,
      processed: 1,
      updated: 1,
      skipped: 0,
      failed: 0,
      failedProducts: [],
      skippedMissingShopDomainProducts: [],
    }),
  });

  assert.deepEqual(await runRefreshFx({ autoApplyPrices: true }), {
    ok: true,
    message: 'Updated 5 FX rates',
    fxRates: [
      { base: 'USD', quote: 'JPY', rate: 150 },
      { base: 'EUR', quote: 'JPY', rate: 166.66666666666666 },
      { base: 'GBP', quote: 'JPY', rate: 187.5 },
      { base: 'CNY', quote: 'JPY', rate: 20.833333333333332 },
      { base: 'KRW', quote: 'JPY', rate: 0.11538461538461539 },
    ],
    priceRefresh: {
      targeted: 1,
      processed: 1,
      updated: 1,
      skipped: 0,
      failed: 0,
      failedProducts: [],
      skippedMissingShopDomainProducts: [],
    },
  });
});

test('api.refresh-fx cron directly reuses the shared refresh runner and returns the same body shape', async () => {
  let receivedOptions = null;
  const handler = createRefreshFxCronHandler({
    runRefreshFxImpl: async (options) => {
      receivedOptions = options;

      return {
        ok: true,
        message: 'Updated 5 FX rates',
        fxRates: [{ base: 'USD', quote: 'JPY', rate: 150 }],
        priceRefresh: {
          targeted: 2,
          processed: 2,
          updated: 1,
          skipped: 1,
          failed: 0,
          failedProducts: [],
          skippedMissingShopDomainProducts: ['prod_local_3'],
        },
      };
    },
  });

  const response = await handler({
    request: new Request('http://localhost/api/refresh-fx/cron', {
      method: 'POST',
    }),
  });

  assert.deepEqual(receivedOptions, { autoApplyPrices: true });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    message: 'Updated 5 FX rates',
    fxRates: [{ base: 'USD', quote: 'JPY', rate: 150 }],
    priceRefresh: {
      targeted: 2,
      processed: 2,
      updated: 1,
      skipped: 1,
      failed: 0,
      failedProducts: [],
      skippedMissingShopDomainProducts: ['prod_local_3'],
    },
  });
});

test('createRunAutoPriceRefresh continues after one product failure and counts duplicates or missing shop context as skipped', async () => {
  const appliedProducts = [];
  const runner = createRunAutoPriceRefresh({
    prismaClient: createFakePrismaForAutoRefresh([
      {
        id: 'prod_local_1',
        shopifyProductId: 'gid://shopify/Product/1',
        shopDomain: 'shop-a.myshopify.com',
      },
      {
        id: 'prod_local_2',
        shopifyProductId: 'gid://shopify/Product/2',
        shopDomain: 'shop-a.myshopify.com',
      },
      {
        id: 'prod_local_3',
        shopifyProductId: 'gid://shopify/Product/3',
        shopDomain: null,
      },
      {
        id: 'prod_local_4',
        shopifyProductId: 'gid://shopify/Product/1',
        shopDomain: 'shop-a.myshopify.com',
      },
    ]),
    applyProductPriceImpl: async (productId, options) => {
      appliedProducts.push({ productId, options });

      if (productId === 'gid://shopify/Product/2') {
        throw new Error('boom');
      }

      if (productId === 'gid://shopify/Product/1') {
        return {
          ok: true,
          skipped: false,
        };
      }

      return {
        ok: true,
        skipped: true,
      };
    },
    logInfo: () => {},
    logError: () => {},
  });

  const result = await runner();

  assert.deepEqual(appliedProducts, [
    {
      productId: 'gid://shopify/Product/1',
      options: {
        shopDomain: 'shop-a.myshopify.com',
        localProductId: 'prod_local_1',
      },
    },
    {
      productId: 'gid://shopify/Product/2',
      options: {
        shopDomain: 'shop-a.myshopify.com',
        localProductId: 'prod_local_2',
      },
    },
  ]);
  assert.deepEqual(result, {
    targeted: 4,
    processed: 2,
    updated: 1,
    skipped: 2,
    failed: 1,
    failedProducts: ['prod_local_2'],
    skippedMissingShopDomainProducts: ['prod_local_3'],
  });
});

test('api.refresh-fx reuses the in-flight auto price refresh run instead of starting a second one', async () => {
  let resolveRefresh = null;
  let runCount = 0;
  const action = createRefreshFxAction({
    apiKey: 'test-key',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          conversion_rates: {
            JPY: 150,
            USD: 1,
            EUR: 0.9,
            GBP: 0.8,
            CNY: 7.2,
            KRW: 1300,
          },
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      ),
    upsertFxRateImpl: async ({ base, quote, rate }) => ({ base, quote, rate }),
    runAutoPriceRefreshImpl: () => {
      runCount += 1;

      return new Promise((resolve) => {
        resolveRefresh = resolve;
      });
    },
  });

  const requestA = new Request('http://localhost/api/refresh-fx?autoApplyPrices=1', {
    method: 'POST',
  });
  const requestB = new Request('http://localhost/api/refresh-fx?autoApplyPrices=1', {
    method: 'POST',
  });

  const responsePromiseA = action({ request: requestA });
  const responsePromiseB = action({ request: requestB });

  for (let attempt = 0; attempt < 5 && runCount === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(runCount, 1);

  resolveRefresh({
    targeted: 1,
    processed: 1,
    updated: 1,
    skipped: 0,
    failed: 0,
    failedProducts: [],
    skippedMissingShopDomainProducts: [],
  });

  const [responseA, responseB] = await Promise.all([responsePromiseA, responsePromiseB]);

  assert.equal(responseA.status, 200);
  assert.equal(responseB.status, 200);
  assert.equal(runCount, 1);
  assert.deepEqual(await responseA.json(), await responseB.json());
});

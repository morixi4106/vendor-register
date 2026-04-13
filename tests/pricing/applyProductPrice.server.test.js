import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createApplyCalculatedPriceToShopify,
  createApplyProductPrice,
} from '../../app/utils/applyProductPrice.server.js';
import { PRICE_SYNC_STATUS, createPriceCalculationError } from '../../app/utils/priceSyncStatus.js';

function pickSelectedFields(record, select) {
  if (!record) {
    return null;
  }

  if (!select) {
    return { ...record };
  }

  return Object.fromEntries(
    Object.entries(select)
      .filter(([, enabled]) => enabled)
      .map(([key]) => [key, record[key] ?? null]),
  );
}

function createFakePrisma({ linkedProducts = [], productsById = {} } = {}) {
  const state = {
    linkedProducts: linkedProducts.map((product) => ({ ...product })),
    productsById: new Map(
      Object.entries(productsById).map(([id, product]) => [id, { id, ...product }]),
    ),
    updates: [],
    logs: [],
  };

  return {
    state,
    product: {
      async findMany() {
        return state.linkedProducts.map((product) => ({ ...product }));
      },
      async findUnique({ where, select }) {
        const record =
          state.productsById.get(where.id) ||
          state.linkedProducts.find((product) => product.id === where.id) ||
          null;

        return pickSelectedFields(record, select);
      },
      async update({ where, data }) {
        const previous = state.productsById.get(where.id) || { id: where.id };
        const next = { ...previous, ...data };
        state.productsById.set(where.id, next);
        state.updates.push({ where, data, next });
        return next;
      },
    },
    productPriceApplyLog: {
      async create({ data }) {
        const log = {
          id: `log_${state.logs.length + 1}`,
          ...data,
        };
        state.logs.push(log);
        return log;
      },
    },
  };
}

function createReadProductResponse() {
  return {
    shopDomain: 'shop-a.myshopify.com',
    data: {
      product: {
        id: 'gid://shopify/Product/1',
        title: 'Face Cream',
        costAmountMetafield: { value: '10.5' },
        costCurrencyMetafield: { value: 'USD' },
        dutyCategoryMetafield: { value: 'cosmetics' },
        variants: {
          nodes: [{ id: 'gid://shopify/ProductVariant/1', title: 'Default', price: '1999' }],
        },
      },
      shop: {
        marginRate: { value: '0.1' },
        paymentFeeRate: { value: '0.04' },
        paymentFeeFixed: { value: '50' },
        bufferRate: { value: '0.1' },
      },
    },
  };
}

test('applyProductPrice success saves snapshot, clears priceSyncError, and appends a success log', async () => {
  const prismaClient = createFakePrisma({
    linkedProducts: [
      {
        id: 'prod_local_1',
        shopDomain: 'shop-a.myshopify.com',
        shopifyProductId: 'gid://shopify/Product/1',
      },
    ],
    productsById: {
      prod_local_1: {
        shopDomain: 'shop-a.myshopify.com',
        shopifyProductId: 'gid://shopify/Product/1',
        priceSyncError: 'old failure',
      },
    },
  });

  const applyProductPrice = createApplyProductPrice({
    prismaClient,
    shopifyGraphQLWithOfflineSessionImpl: async () => createReadProductResponse(),
    applyCalculatedPriceToShopifyImpl: async () => ({ userErrors: [] }),
  });

  const result = await applyProductPrice('gid://shopify/Product/1', {
    shopDomain: 'shop-a.myshopify.com',
    localProductId: 'prod_local_1',
    fxRate: 150,
  });

  assert.equal(result.ok, true);
  assert.equal(result.newPrice, '2435');
  assert.equal(result.priceSyncStatus, PRICE_SYNC_STATUS.APPLIED);
  assert.equal(prismaClient.state.updates.length, 1);
  assert.equal(prismaClient.state.logs.length, 1);

  const successUpdate = prismaClient.state.updates[0].data;
  assert.equal(successUpdate.priceSyncStatus, PRICE_SYNC_STATUS.APPLIED);
  assert.equal(successUpdate.priceSyncError, null);
  assert.ok(successUpdate.priceAppliedAt instanceof Date);
  assert.ok(successUpdate.lastPriceApplyAttemptAt instanceof Date);
  assert.equal(successUpdate.calculatedPrice, 2435);
  assert.equal(successUpdate.priceSnapshotJson.calculatedPrice, 2435);

  const successLog = prismaClient.state.logs[0];
  assert.equal(successLog.status, 'success');
  assert.equal(successLog.productId, 'prod_local_1');
  assert.equal(successLog.shopDomain, 'shop-a.myshopify.com');
  assert.equal(successLog.attemptedPrice, 2435);
  assert.equal(successLog.priceSnapshotJson.calculatedPrice, 2435);
});

test('applyProductPrice invalid failure updates sync state, preserves latest successful snapshot, and logs invalid', async () => {
  const prismaClient = createFakePrisma({
    linkedProducts: [
      {
        id: 'prod_local_1',
        shopDomain: 'shop-a.myshopify.com',
        shopifyProductId: 'gid://shopify/Product/1',
      },
    ],
    productsById: {
      prod_local_1: {
        shopDomain: 'shop-a.myshopify.com',
        shopifyProductId: 'gid://shopify/Product/1',
        priceSnapshotJson: { calculatedPrice: 9999, preserved: true },
        priceAppliedAt: new Date('2026-04-09T00:00:00.000Z'),
      },
    },
  });

  let applyCalled = false;
  const applyProductPrice = createApplyProductPrice({
    prismaClient,
    calculateProductPriceImpl: async () => {
      throw createPriceCalculationError('missing_cost_amount', 'pricing.cost_amount is empty');
    },
    shopifyGraphQLWithOfflineSessionImpl: async () => createReadProductResponse(),
    applyCalculatedPriceToShopifyImpl: async () => {
      applyCalled = true;
      return { userErrors: [] };
    },
  });

  await assert.rejects(
    () =>
      applyProductPrice('gid://shopify/Product/1', {
        shopDomain: 'shop-a.myshopify.com',
        localProductId: 'prod_local_1',
        fxRate: 150,
      }),
    /pricing\.cost_amount is empty/,
  );

  assert.equal(applyCalled, false);
  assert.equal(prismaClient.state.updates.length, 1);
  assert.equal(prismaClient.state.logs.length, 1);

  const invalidUpdate = prismaClient.state.updates[0].data;
  assert.equal(invalidUpdate.priceSyncStatus, PRICE_SYNC_STATUS.INVALID);
  assert.equal(invalidUpdate.priceSyncError, 'pricing.cost_amount is empty');
  assert.ok(invalidUpdate.lastPriceApplyAttemptAt instanceof Date);
  assert.equal(Object.hasOwn(invalidUpdate, 'priceSnapshotJson'), false);
  assert.equal(
    prismaClient.state.productsById.get('prod_local_1').priceSnapshotJson.preserved,
    true,
  );

  const invalidLog = prismaClient.state.logs[0];
  assert.equal(invalidLog.status, 'invalid');
  assert.equal(invalidLog.productId, 'prod_local_1');
  assert.equal(invalidLog.errorSummary, 'pricing.cost_amount is empty');
});

test('applyProductPrice apply_failed keeps the previous successful snapshot and appends logs', async () => {
  const prismaClient = createFakePrisma({
    linkedProducts: [
      {
        id: 'prod_local_1',
        shopDomain: 'shop-a.myshopify.com',
        shopifyProductId: 'gid://shopify/Product/1',
      },
    ],
    productsById: {
      prod_local_1: {
        shopDomain: 'shop-a.myshopify.com',
        shopifyProductId: 'gid://shopify/Product/1',
      },
    },
  });

  const successApplyProductPrice = createApplyProductPrice({
    prismaClient,
    shopifyGraphQLWithOfflineSessionImpl: async () => createReadProductResponse(),
    applyCalculatedPriceToShopifyImpl: async () => ({ userErrors: [] }),
  });

  await successApplyProductPrice('gid://shopify/Product/1', {
    shopDomain: 'shop-a.myshopify.com',
    localProductId: 'prod_local_1',
    fxRate: 150,
  });

  const previousSnapshot = prismaClient.state.productsById.get('prod_local_1').priceSnapshotJson;
  const previousAppliedAt = prismaClient.state.productsById.get('prod_local_1').priceAppliedAt;

  const failedApplyProductPrice = createApplyProductPrice({
    prismaClient,
    shopifyGraphQLWithOfflineSessionImpl: async () => createReadProductResponse(),
    applyCalculatedPriceToShopifyImpl: async () => {
      throw new Error('Shopify GraphQL request failed: 500 {"errors":"boom"}');
    },
  });

  await assert.rejects(
    () =>
      failedApplyProductPrice('gid://shopify/Product/1', {
        shopDomain: 'shop-a.myshopify.com',
        localProductId: 'prod_local_1',
        fxRate: 150,
      }),
    /Shopify GraphQL request failed: 500/,
  );

  assert.equal(prismaClient.state.logs.length, 2);
  assert.equal(prismaClient.state.logs[0].status, 'success');
  assert.equal(prismaClient.state.logs[1].status, 'apply_failed');

  const failedUpdate = prismaClient.state.updates[1].data;
  assert.equal(failedUpdate.priceSyncStatus, PRICE_SYNC_STATUS.APPLY_FAILED);
  assert.equal(failedUpdate.priceSyncError, 'Shopify GraphQL request failed: 500 {"errors":"boom"}');
  assert.equal(Object.hasOwn(failedUpdate, 'priceSnapshotJson'), false);
  assert.deepEqual(prismaClient.state.productsById.get('prod_local_1').priceSnapshotJson, previousSnapshot);
  assert.equal(prismaClient.state.productsById.get('prod_local_1').priceAppliedAt, previousAppliedAt);
});

test('applyProductPrice logs unresolved local-product failures with productId null', async () => {
  const prismaClient = createFakePrisma();

  const applyProductPrice = createApplyProductPrice({
    prismaClient,
    shopifyGraphQLWithOfflineSessionImpl: async () => createReadProductResponse(),
    applyCalculatedPriceToShopifyImpl: createApplyCalculatedPriceToShopify({
      shopifyGraphQLWithOfflineSessionImpl: async () => {
        throw new Error('apply should not be called');
      },
    }),
  });

  await assert.rejects(
    () =>
      applyProductPrice('gid://shopify/Product/1', {
        shopDomain: 'shop-a.myshopify.com',
        fxRate: 150,
      }),
    /Local product not found for snapshot persistence/,
  );

  assert.equal(prismaClient.state.logs.length, 1);
  assert.equal(prismaClient.state.logs[0].productId, null);
  assert.equal(prismaClient.state.logs[0].shopifyProductId, 'gid://shopify/Product/1');
  assert.equal(prismaClient.state.logs[0].shopDomain, 'shop-a.myshopify.com');
});

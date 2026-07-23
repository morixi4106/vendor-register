import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGetOfflineAdminContextForShopDomain,
  createShopifyGraphQLWithOfflineSession,
  resolveShopDomain,
} from '../../app/utils/shopifyAdmin.server.js';

test('shopifyGraphQLWithOfflineSession gets a background admin client from the requested shopDomain', async () => {
  const calls = [];
  const shopifyGraphQLWithOfflineSession = createShopifyGraphQLWithOfflineSession({
    getOfflineAdminContextForShopDomainImpl: async (shopDomain) => ({
      shopDomain,
      session: {
        accessToken: 'offline-token',
      },
      admin: {
        graphql: async (query, options) => {
          calls.push({ shopDomain, query, options });

          return new Response(
            JSON.stringify({
              data: {
                shop: {
                  name: 'B301ZE',
                },
              },
            }),
            {
              status: 200,
              headers: {
                'Content-Type': 'application/json',
              },
            },
          );
        },
      },
    }),
  });

  const result = await shopifyGraphQLWithOfflineSession({
    shopDomain: 'b301ze-1a.myshopify.com',
    apiVersion: '2026-04',
    query: 'query ReadShop { shop { name } }',
    variables: { test: true },
  });

  assert.deepEqual(calls, [
    {
      shopDomain: 'b301ze-1a.myshopify.com',
      query: 'query ReadShop { shop { name } }',
      options: {
        apiVersion: '2026-04',
        variables: { test: true },
      },
    },
  ]);
  assert.deepEqual(result, {
    data: {
      shop: {
        name: 'B301ZE',
      },
    },
    shopDomain: 'b301ze-1a.myshopify.com',
  });
});

test('shopifyGraphQLWithOfflineSession briefly retries Shopify throttling', async () => {
  let attempts = 0;
  const delays = [];
  const shopifyGraphQLWithOfflineSession = createShopifyGraphQLWithOfflineSession({
    getOfflineAdminContextForShopDomainImpl: async (shopDomain) => ({
      shopDomain,
      session: { accessToken: 'offline-token' },
      admin: {
        graphql: async () => {
          attempts += 1;
          if (attempts < 3) {
            throw new Error('GraphqlQueryError: Throttled');
          }
          return new Response(JSON.stringify({ data: { shop: { id: 'shop-1' } } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      },
    }),
    sleepImpl: async (milliseconds) => {
      delays.push(milliseconds);
    },
    randomImpl: () => 0.5,
    maxThrottleRetries: 2,
  });

  const result = await shopifyGraphQLWithOfflineSession({
    shopDomain: 'b301ze-1a.myshopify.com',
    apiVersion: '2026-04',
    query: 'query ReadShop { shop { id } }',
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [300, 600]);
  assert.equal(result.data.shop.id, 'shop-1');
});

test('shopifyGraphQLWithOfflineSession does not retry non-throttle failures', async () => {
  let attempts = 0;
  const shopifyGraphQLWithOfflineSession = createShopifyGraphQLWithOfflineSession({
    getOfflineAdminContextForShopDomainImpl: async (shopDomain) => ({
      shopDomain,
      session: { accessToken: 'offline-token' },
      admin: {
        graphql: async () => {
          attempts += 1;
          throw new Error('Shopify GraphQL errors: invalid query');
        },
      },
    }),
    sleepImpl: async () => {
      throw new Error('non-throttle failures must not sleep');
    },
  });

  await assert.rejects(
    () =>
      shopifyGraphQLWithOfflineSession({
        shopDomain: 'b301ze-1a.myshopify.com',
        apiVersion: '2026-04',
        query: 'query Broken { broken }',
      }),
    /invalid query/,
  );
  assert.equal(attempts, 1);
});

test('getOfflineAdminContextForShopDomain reports the missing offline session for the requested shop', async () => {
  const getOfflineAdminContextForShopDomain = createGetOfflineAdminContextForShopDomain({
    resolveShopDomainImpl: async () => 'b301ze-1a.myshopify.com',
    loadOfflineAdminContextImpl: async () => {
      throw new Error(
        'Could not find a session for shop b301ze-1a.myshopify.com when creating unauthenticated admin context',
      );
    },
  });

  await assert.rejects(
    () => getOfflineAdminContextForShopDomain('b301ze-1a.myshopify.com'),
    /Offline session not found for shop: b301ze-1a\.myshopify\.com/,
  );
});

test('resolveShopDomain uses a configured primary shop before ambiguous offline sessions', async () => {
  const shopDomain = await resolveShopDomain(null, {
    configuredPrimaryShopDomain: 'primary-shop.myshopify.com',
    listOfflineShopDomainsImpl: async () => [
      'shop-a.myshopify.com',
      'shop-b.myshopify.com',
    ],
  });

  assert.equal(shopDomain, 'primary-shop.myshopify.com');
});

test('resolveShopDomain still rejects ambiguous offline sessions without a configured shop', async () => {
  await assert.rejects(
    () =>
      resolveShopDomain(null, {
        configuredPrimaryShopDomain: null,
        listOfflineShopDomainsImpl: async () => [
          'shop-a.myshopify.com',
          'shop-b.myshopify.com',
        ],
      }),
    /Shop context is ambiguous for this product/,
  );
});

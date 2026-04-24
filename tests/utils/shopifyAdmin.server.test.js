import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGetOfflineAdminContextForShopDomain,
  createShopifyGraphQLWithOfflineSession,
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

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildShippingQuoteResponse,
  createShippingQuoteAction,
  createShippingQuoteLoader,
} from '../../app/services/shippingQuote.server.js';
import {
  clearShippingDiagnosticEvents,
  listShippingDiagnosticEvents,
} from '../../app/services/shippingDiagnostics.server.js';

function createQuoteRequest(overrides = {}) {
  return {
    orderLike: {
      lines: [
        {
          productId: 'gid://shopify/Product/1',
          variantId: 'gid://shopify/ProductVariant/1',
          quantity: 1,
          requiresShipping: true,
          amountAfterItemDiscountBeforeOrderCoupon: 4200,
        },
      ],
    },
    shippingAddress: {
      country: 'JP',
      countryCode: 'JP',
      prefecture: 'Tokyo',
      province: 'Tokyo',
      postalCode: '150-0001',
      zip: '150-0001',
      city: 'Shibuya',
    },
    shopDomain: 'b30ize-1a.myshopify.com',
    ...overrides,
  };
}

test('api.shipping-quote returns a JP smoke quote in the Shipping V2 response shape', () => {
  assert.deepEqual(buildShippingQuoteResponse(createQuoteRequest()).result, {
    isPendingAddress: false,
    isDeliverable: true,
    totalShippingFee: 870,
    currencyCode: 'JPY',
  });
});

test('api.shipping-quote returns a different smoke quote for US addresses', async () => {
  clearShippingDiagnosticEvents();
  const action = createShippingQuoteAction();
  const response = await action({
    request: new Request('http://localhost/api/shipping-quote', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shipping-Diagnostic-Request-Id': 'carrier_test_1',
      },
      body: JSON.stringify(
        createQuoteRequest({
          shippingAddress: {
            country: 'US',
            countryCode: 'US',
            province: 'CA',
            postalCode: '90210',
          },
        }),
      ),
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.result.totalShippingFee, 2500);
  assert.deepEqual(listShippingDiagnosticEvents({ limit: 1 })[0], {
    sequence: 1,
    timestamp: listShippingDiagnosticEvents({ limit: 1 })[0].timestamp,
    requestId: 'carrier_test_1',
    source: 'quote',
    level: 'info',
    message: 'quote_returned',
    details: {
      request: {
        source: 'smoke_quote',
        shopDomain: 'b30ize-1a.myshopify.com',
        shippingAddress: {
          countryCode: 'US',
          postalCode: '90210',
          province: 'CA',
          city: null,
        },
        lineCount: 1,
        shippableLineCount: 1,
      },
      response: {
        ok: true,
        enabled: true,
        reason: null,
        isPendingAddress: false,
        isDeliverable: true,
        totalShippingFee: 2500,
        currencyCode: 'JPY',
        debug: {
          source: 'vendor-register-smoke-quote',
          countryCode: 'US',
          postalCode: '90210',
          shippableLineCount: 1,
        },
      },
    },
  });
});

test('api.shipping-quote returns pending_address when address is incomplete', () => {
  const payload = buildShippingQuoteResponse(
    createQuoteRequest({
      shippingAddress: {
        country: 'JP',
      },
    }),
  );

  assert.equal(payload.reason, 'pending_address');
  assert.equal(payload.result.isPendingAddress, true);
  assert.equal(payload.result.totalShippingFee, null);
});

test('api.shipping-quote returns JSON errors for invalid JSON and GET requests', async () => {
  const action = createShippingQuoteAction();
  const loader = createShippingQuoteLoader();
  const invalidJsonResponse = await action({
    request: new Request('http://localhost/api/shipping-quote', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: '{nope',
    }),
  });
  const loaderResponse = await loader();

  assert.equal(invalidJsonResponse.status, 400);
  assert.deepEqual(await invalidJsonResponse.json(), {
    ok: false,
    reason: 'invalid_json',
  });
  assert.equal(loaderResponse.status, 405);
  assert.equal(loaderResponse.headers.get('Allow'), 'POST');
});

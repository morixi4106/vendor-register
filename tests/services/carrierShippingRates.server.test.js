import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCarrierRatesResponse,
  buildCarrierShippingV2QuoteRequest,
  createCarrierShippingRatesAction,
  createCarrierShippingRatesLoader,
  getCarrierRatesEmptyReason,
  getCarrierCallbackUrl,
  toShopifyCarrierSubunits,
  upsertShippingV2CarrierService,
} from '../../app/services/carrierShippingRates.server.js';
import {
  clearShippingDiagnosticEvents,
  listShippingDiagnosticEvents,
} from '../../app/services/shippingDiagnostics.server.js';

function createCarrierRequest(overrides = {}) {
  return {
    rate: {
      currency: 'JPY',
      destination: {
        country: 'JP',
        province: 'Tokyo',
        city: 'Shibuya',
        zip: '150-0001',
      },
      items: [
        {
          product_id: 9044842447011,
          variant_id: 111222333,
          quantity: 2,
          price: 2100,
          requires_shipping: true,
        },
      ],
      ...overrides.rate,
    },
    ...overrides,
  };
}

test('carrier shipping rates converts Shopify destination and items to Shipping V2 quote input', () => {
  const quoteRequest = buildCarrierShippingV2QuoteRequest(createCarrierRequest());

  assert.deepEqual(quoteRequest.shippingAddress, {
    postalCode: '150-0001',
    zip: '150-0001',
    prefecture: 'Tokyo',
    province: 'Tokyo',
    city: 'Shibuya',
    country: 'JP',
    countryCode: 'JP',
  });
  assert.deepEqual(quoteRequest.orderLike.lines, [
    {
      lineId: '111222333',
      productId: '9044842447011',
      variantId: '111222333',
      quantity: 2,
      amountAfterItemDiscountBeforeOrderCoupon: 42,
      requiresShipping: true,
    },
  ]);
});

test('carrier shipping rates accepts Shopify carrier postal_code payloads', () => {
  const quoteRequest = buildCarrierShippingV2QuoteRequest(
    createCarrierRequest({
      rate: {
        destination: {
          country: 'JP',
          postal_code: '300-1532',
          province: 'JP-08',
          city: '取手市',
        },
        items: [
          {
            product_id: 9044842447011,
            variant_id: 47424753369251,
            quantity: 1,
            grams: 120,
            price: 165000,
            requires_shipping: true,
          },
        ],
      },
    }),
  );

  assert.deepEqual(quoteRequest.shippingAddress, {
    postalCode: '300-1532',
    zip: '300-1532',
    prefecture: 'JP-08',
    province: 'JP-08',
    city: '取手市',
    country: 'JP',
    countryCode: 'JP',
  });
  assert.deepEqual(quoteRequest.orderLike.lines, [
    {
      lineId: '47424753369251',
      productId: '9044842447011',
      variantId: '47424753369251',
      quantity: 1,
      grams: 120,
      amountAfterItemDiscountBeforeOrderCoupon: 1650,
      requiresShipping: true,
    },
  ]);
});

test('carrier shipping rates returns rates from Shipping V2 quote response', async () => {
  let receivedQuoteRequest = null;
  const infoLogs = [];
  const action = createCarrierShippingRatesAction({
    fetchShippingV2QuoteImpl: async ({ quoteRequest }) => {
      receivedQuoteRequest = quoteRequest;

      return {
        ok: true,
        enabled: true,
        result: {
          isPendingAddress: false,
          isDeliverable: true,
          totalShippingFee: 420,
        },
      };
    },
    logInfo: (...args) => infoLogs.push(args),
  });
  const response = await action({
    request: new Request('http://localhost/carrier/shipping-rates', {
      method: 'POST',
      body: JSON.stringify(createCarrierRequest()),
      headers: {
        'Content-Type': 'application/json',
      },
    }),
  });
  const payload = await response.json();

  assert.equal(receivedQuoteRequest.shippingAddress.postalCode, '150-0001');
  assert.equal(infoLogs.some(([message]) => message === 'carrier shipping rates request:'), true);
  assert.equal(infoLogs.some(([message]) => message === 'carrier shipping rates response:'), true);
  assert.deepEqual(payload, {
    rates: [
      {
        service_name: 'Shipping V2',
        service_code: 'shipping_v2',
        total_price: '42000',
        currency: 'JPY',
        description: 'Calculated shipping',
      },
    ],
  });
});

test('carrier shipping rates GET loader does not parse a body', async () => {
  const logs = [];
  const loader = createCarrierShippingRatesLoader({
    logInfo: (...args) => logs.push(args),
  });
  const response = await loader({
    request: new Request('http://localhost/carrier/shipping-rates', {
      method: 'GET',
    }),
  });

  assert.deepEqual(await response.json(), {
    ok: true,
    rates: [],
    service: 'Shipping V2',
  });
  assert.equal(logs[0][0], 'carrier shipping rates health check:');
});

test('carrier shipping rates returns empty rates for empty body without throwing', async () => {
  const errors = [];
  let callCount = 0;
  const action = createCarrierShippingRatesAction({
    fetchShippingV2QuoteImpl: async () => {
      callCount += 1;
      return {};
    },
    logInfo: () => {},
    logError: (...args) => errors.push(args),
  });
  const response = await action({
    request: new Request('http://localhost/carrier/shipping-rates', {
      method: 'POST',
      body: '',
      headers: {
        'Content-Type': 'application/json',
      },
    }),
  });

  assert.deepEqual(await response.json(), { rates: [] });
  assert.equal(callCount, 0);
  assert.equal(errors[0][0], 'carrier shipping rates empty body:');
  assert.equal(errors[0][1].rawBodyLength, 0);
});

test('carrier shipping rates returns empty rates for invalid JSON without throwing', async () => {
  const errors = [];
  let callCount = 0;
  const action = createCarrierShippingRatesAction({
    fetchShippingV2QuoteImpl: async () => {
      callCount += 1;
      return {};
    },
    logInfo: () => {},
    logError: (...args) => errors.push(args),
  });
  const response = await action({
    request: new Request('http://localhost/carrier/shipping-rates', {
      method: 'POST',
      body: '{nope',
      headers: {
        'Content-Type': 'application/json',
      },
    }),
  });

  assert.deepEqual(await response.json(), { rates: [] });
  assert.equal(callCount, 0);
  assert.equal(errors[0][0], 'carrier shipping rates invalid json:');
  assert.equal(errors[0][1].rawBodyPreview, '{nope');
});

test('carrier shipping rates converts Shipping V2 amount to Shopify carrier subunits', () => {
  assert.equal(toShopifyCarrierSubunits(420), '42000');
  assert.equal(toShopifyCarrierSubunits('1000'), '100000');
});

test('carrier shipping rates returns empty rates for quote errors and undeliverable quotes', async () => {
  clearShippingDiagnosticEvents();

  assert.deepEqual(
    buildCarrierRatesResponse({
      quoteResponse: {
        ok: true,
        enabled: true,
        result: {
          isDeliverable: false,
          totalShippingFee: 420,
        },
      },
      currency: 'JPY',
    }),
    { rates: [] },
  );

  const action = createCarrierShippingRatesAction({
    fetchShippingV2QuoteImpl: async () => {
      throw new Error('quote_error');
    },
    logError: () => {},
  });
  const response = await action({
    request: new Request('http://localhost/carrier/shipping-rates', {
      method: 'POST',
      body: JSON.stringify(createCarrierRequest()),
      headers: {
        'Content-Type': 'application/json',
      },
    }),
  });

  assert.deepEqual(await response.json(), { rates: [] });
  assert.equal(
    listShippingDiagnosticEvents({ limit: 10 }).some(
      (event) => event.source === 'carrier' && event.message === 'quote_error',
    ),
    true,
  );
});

test('carrier shipping rates records empty rate reasons for diagnostics', async () => {
  clearShippingDiagnosticEvents();
  const action = createCarrierShippingRatesAction({
    fetchShippingV2QuoteImpl: async () => ({
      ok: true,
      enabled: true,
      reason: 'pending_address',
      result: {
        isPendingAddress: true,
        isDeliverable: false,
        totalShippingFee: null,
      },
    }),
    logInfo: () => {},
    logError: () => {},
  });
  const response = await action({
    request: new Request('http://localhost/carrier/shipping-rates', {
      method: 'POST',
      body: JSON.stringify(createCarrierRequest()),
      headers: {
        'Content-Type': 'application/json',
      },
    }),
  });
  const events = listShippingDiagnosticEvents({ limit: 10 });

  assert.deepEqual(await response.json(), { rates: [] });
  assert.equal(
    getCarrierRatesEmptyReason({
      ok: true,
      enabled: true,
      reason: 'pending_address',
      result: {
        isPendingAddress: true,
      },
    }),
    'pending_address',
  );
  assert.equal(
    events.some(
      (event) =>
        event.source === 'carrier' &&
        event.message === 'empty_rates' &&
        event.details.emptyRatesReason === 'pending_address',
    ),
    true,
  );
});

test('upsertShippingV2CarrierService updates an existing Shipping V2 carrier service', async () => {
  const calls = [];
  const result = await upsertShippingV2CarrierService({
    shopDomain: 'shop-a.myshopify.com',
    appUrl: 'https://example.trycloudflare.com',
    shopifyGraphQLWithOfflineSessionImpl: async (call) => {
      calls.push(call);

      if (call.query.includes('carrierServices')) {
        return {
          data: {
            carrierServices: {
              nodes: [
                {
                  id: 'gid://shopify/DeliveryCarrierService/1',
                  name: 'Shipping V2',
                  callbackUrl: 'https://old.example.com/carrier/shipping-rates',
                  active: true,
                  supportsServiceDiscovery: true,
                },
              ],
            },
          },
        };
      }

      return {
        data: {
          carrierServiceUpdate: {
            carrierService: {
              id: 'gid://shopify/DeliveryCarrierService/1',
              name: 'Shipping V2',
              callbackUrl: call.variables.input.callbackUrl,
              active: true,
              supportsServiceDiscovery: true,
            },
            userErrors: [],
          },
        },
      };
    },
  });

  assert.equal(result.operation, 'updated');
  assert.equal(result.callbackUrl, 'https://example.trycloudflare.com/carrier/shipping-rates');
  assert.equal(calls[1].variables.input.id, 'gid://shopify/DeliveryCarrierService/1');
});

test('getCarrierCallbackUrl uses the current dev tunnel URL exactly', () => {
  assert.equal(
    getCarrierCallbackUrl('https://low-alpine-hosts-contributed.trycloudflare.com'),
    'https://low-alpine-hosts-contributed.trycloudflare.com/carrier/shipping-rates',
  );
});

test('upsertShippingV2CarrierService creates when no existing service is found', async () => {
  const calls = [];
  const result = await upsertShippingV2CarrierService({
    shopDomain: 'shop-a.myshopify.com',
    appUrl: 'https://example.trycloudflare.com/',
    shopifyGraphQLWithOfflineSessionImpl: async (call) => {
      calls.push(call);

      if (call.query.includes('carrierServices')) {
        return {
          data: {
            carrierServices: {
              nodes: [],
            },
          },
        };
      }

      return {
        data: {
          carrierServiceCreate: {
            carrierService: {
              id: 'gid://shopify/DeliveryCarrierService/2',
              name: 'Shipping V2',
              callbackUrl: call.variables.input.callbackUrl,
              active: true,
              supportsServiceDiscovery: true,
            },
            userErrors: [],
          },
        },
      };
    },
  });

  assert.equal(result.operation, 'created');
  assert.equal(calls[1].variables.input.name, 'Shipping V2');
  assert.equal(calls[1].variables.input.callbackUrl, 'https://example.trycloudflare.com/carrier/shipping-rates');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCarrierRatesResponse,
  buildCarrierShippingV2QuoteRequest,
  createCarrierShippingRatesAction,
  createCarrierShippingRatesLoader,
  getCarrierRatesEmptyReason,
  getCarrierCallbackUrl,
  resolveCarrierFulfillmentOwnership,
  toShopifyCarrierSubunits,
  upsertShippingV2CarrierService,
  validateCarrierEuDeliveryPolicy,
} from '../../app/services/carrierShippingRates.server.js';
import {
  clearShippingDiagnosticEvents,
  listShippingDiagnosticEvents,
} from '../../app/services/shippingDiagnostics.server.js';

const passThroughOwnershipResolution = async ({ quoteRequest }) => ({
  ok: true,
  quoteRequest,
});

function createCarrierRequest(overrides = {}) {
  const { rate: rateOverrides = {}, ...rest } = overrides;

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
      ...rateOverrides,
    },
    ...rest,
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

test('carrier shipping rates split physical items by their owning vendor store', async () => {
  const quoteRequest = buildCarrierShippingV2QuoteRequest(
    createCarrierRequest({
      rate: {
        items: [
          {
            product_id: 9044842447011,
            variant_id: 111222333,
            quantity: 1,
            price: 2100,
            requires_shipping: true,
          },
          {
            product_id: 9159637270691,
            variant_id: 444555666,
            quantity: 1,
            price: 6500,
            requires_shipping: true,
          },
        ],
      },
    }),
  );
  const result = await resolveCarrierFulfillmentOwnership({
    quoteRequest,
    prismaClient: {
      product: {
        async findMany() {
          return [
            {
              id: 'marketplace_product',
              shopifyProductId: 'gid://shopify/Product/9044842447011',
              shopifyVariantId: 'gid://shopify/ProductVariant/111222333',
              vendorStoreId: 'marketplace_store',
              vendorStore: {
                id: 'marketplace_store',
                isPlatformStore: false,
              },
            },
            {
              id: 'platform_product',
              shopifyProductId: 'gid://shopify/Product/9159637270691',
              shopifyVariantId: 'gid://shopify/ProductVariant/444555666',
              vendorStoreId: 'platform_store',
              vendorStore: {
                id: 'platform_store',
                isPlatformStore: true,
              },
            },
          ];
        },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.quoteRequest.orderLike.lines.map((line) => ({
      productId: line.productId,
      shipFromId: line.shipFromId,
      directShipGroup: line.directShipGroup,
      shippingClass: line.shippingClass,
    })),
    [
      {
        productId: '9044842447011',
        shipFromId: 'marketplace_store',
        directShipGroup: 'marketplace_store',
        shippingClass: 'direct',
      },
      {
        productId: '9159637270691',
        shipFromId: 'platform_store',
        directShipGroup: 'platform_store',
        shippingClass: 'direct',
      },
    ],
  );
});

test('carrier shipping rates reject a physical item without an app product owner', async () => {
  const quoteRequest = buildCarrierShippingV2QuoteRequest(createCarrierRequest());
  const result = await resolveCarrierFulfillmentOwnership({
    quoteRequest,
    prismaClient: {
      product: {
        async findMany() {
          return [];
        },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unmanaged_product');
  assert.equal(result.productId, '9044842447011');
});

test('carrier shipping rates returns rates from Shipping V2 quote response', async () => {
  let receivedQuoteRequest = null;
  const infoLogs = [];
  const action = createCarrierShippingRatesAction({
    resolveCarrierFulfillmentOwnershipImpl: passThroughOwnershipResolution,
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
        debug: {
          groups: [
            {
              groupId: 'ship_group_1',
              mode: 'parcel',
              regionTier: 'honshu',
              packageCount: 1,
              fee: 420,
              originalFee: 420,
              isDeliverable: true,
              isFreeShippingApplied: false,
              totalShippingPoint: 1,
              totalWeightGrams: 0,
              shipFromId: 'default',
              temperatureZone: 'ambient',
              leadTimeBucket: 'normal',
              messages: [],
              lines: [
                {
                  productId: '9044842447011',
                  variantId: '111222333',
                  quantity: 2,
                  shippingClass: 'parcel',
                  temperatureZone: 'ambient',
                  shippingPoint: 1,
                  totalShippingPoint: 2,
                  appliedLineRuleId: null,
                },
              ],
            },
          ],
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
  const serializedLogs = JSON.stringify(infoLogs);
  assert.equal(serializedLogs.includes('150-0001'), false);
  assert.equal(serializedLogs.includes('Shibuya'), false);
  const quoteResponseLog = infoLogs.find(
    ([message]) => message === 'carrier shipping rates quote response:',
  );
  assert.equal(quoteResponseLog[1].shippingGroups[0].mode, 'parcel');
  assert.equal(quoteResponseLog[1].shippingGroups[0].fee, 420);
  assert.equal(quoteResponseLog[1].shippingGroups[0].lines[0].variantId, '111222333');
  assert.deepEqual(payload, {
    rates: [
      {
        service_name: '地域別配送',
        service_code: 'shipping_v2',
        total_price: '42000',
        currency: 'JPY',
        description: '配送先に基づく送料',
      },
    ],
  });
});

test('carrier shipping rates blocks EU checkout when the current product EU status is not approved', async () => {
  clearShippingDiagnosticEvents();
  let quoteCallCount = 0;
  let productQuery = null;
  const action = createCarrierShippingRatesAction({
    resolveCarrierFulfillmentOwnershipImpl: passThroughOwnershipResolution,
    prismaClient: {
      product: {
        async findMany(query) {
          productQuery = query;
          return [
            {
              id: 'prod_1',
              shopifyProductId: 'gid://shopify/Product/9044842447011',
              shopifyVariantId: 'gid://shopify/ProductVariant/111222333',
              approvalStatus: 'approved',
              productEuStatus: 'REJECTED_HIGH_RISK',
              countryPolicy: null,
              vendorStore: {
                vendorAuth: {
                  id: 'vendor_1',
                  handle: 'amber-cellar',
                  seller: {
                    id: 'seller_1',
                    euSellerStatus: 'FULL_KYBC_APPROVED',
                  },
                },
              },
            },
          ];
        },
      },
    },
    fetchShippingV2QuoteImpl: async () => {
      quoteCallCount += 1;
      return {};
    },
    logInfo: () => {},
    logError: () => {},
  });
  const response = await action({
    request: new Request('http://localhost/carrier/shipping-rates', {
      method: 'POST',
      body: JSON.stringify(
        createCarrierRequest({
          rate: {
            destination: {
              country: 'FR',
              zip: '75001',
              city: 'Paris',
            },
          },
        }),
      ),
      headers: {
        'Content-Type': 'application/json',
      },
    }),
  });

  assert.deepEqual(await response.json(), { rates: [] });
  assert.equal(quoteCallCount, 0);
  assert.deepEqual(productQuery.where.OR, [
    {
      shopifyProductId: {
        in: ['9044842447011', 'gid://shopify/Product/9044842447011'],
      },
    },
    {
      shopifyVariantId: {
        in: ['111222333', 'gid://shopify/ProductVariant/111222333'],
      },
    },
  ]);
  assert.equal(
    listShippingDiagnosticEvents({ limit: 10 }).some(
      (event) =>
        event.source === 'carrier' &&
        event.message === 'international_delivery_blocked' &&
        event.details.policy.reason === 'eu_product_not_allowed',
    ),
    true,
  );
});

test('validateCarrierEuDeliveryPolicy allows EU delivery only for approved seller and product', async () => {
  const quoteRequest = buildCarrierShippingV2QuoteRequest(
    createCarrierRequest({
      rate: {
        destination: {
          country: 'FR',
          zip: '75001',
          city: 'Paris',
        },
      },
    }),
  );
  const result = await validateCarrierEuDeliveryPolicy({
    quoteRequest,
    prismaClient: {
      product: {
        async findMany() {
          return [
            {
              id: 'prod_1',
              shopifyProductId: 'gid://shopify/Product/9044842447011',
              shopifyVariantId: 'gid://shopify/ProductVariant/111222333',
              approvalStatus: 'approved',
              productEuStatus: 'APPROVED_LOW_RISK',
              countryPolicy: {
                allowedCountries: ['FR'],
                blockedCountries: [],
              },
              vendorStore: {
                vendorAuth: {
                  seller: {
                    euSellerStatus: 'FULL_KYBC_APPROVED',
                  },
                },
              },
            },
          ];
        },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.countryCode, 'FR');
  assert.equal(result.productCount, 1);
});

test('carrier delivery policy enforces product country rules outside the EU', async () => {
  const quoteRequest = buildCarrierShippingV2QuoteRequest(
    createCarrierRequest({
      rate: {
        destination: {
          country: 'CA',
          zip: 'M5V 3L9',
          city: 'Toronto',
        },
      },
    }),
  );
  const result = await validateCarrierEuDeliveryPolicy({
    quoteRequest,
    prismaClient: {
      product: {
        async findMany() {
          return [
            {
              id: 'prod_1',
              shopifyProductId: 'gid://shopify/Product/9044842447011',
              shopifyVariantId: 'gid://shopify/ProductVariant/111222333',
              approvalStatus: 'approved',
              productEuStatus: 'DISABLED',
              countryPolicy: {
                allowedCountries: ['JP', 'FR'],
                blockedCountries: [],
              },
              vendorStore: { vendorAuth: { seller: null } },
            },
          ];
        },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.countryCode, 'CA');
  assert.equal(result.reason, 'country_not_allowed');
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

test('carrier shipping rates fails closed when the request body cannot be read', async () => {
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
    request: {
      method: 'POST',
      url: 'http://localhost/carrier/shipping-rates',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      text: async () => {
        throw new Error('stream interrupted');
      },
    },
  });

  assert.deepEqual(await response.json(), { rates: [] });
  assert.equal(callCount, 0);
  assert.equal(errors[0][0], 'carrier shipping rates body read failed:');
  assert.equal(errors[0][1].error, 'stream interrupted');
  assert.equal('url' in errors[0][1], false);
  assert.equal('rawBody' in errors[0][1], false);
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
  assert.equal(errors[0][1].rawBodyLength, 5);
  assert.equal('rawBodyPreview' in errors[0][1], false);
});

test('carrier shipping rates converts Shipping V2 amount to Shopify carrier subunits', () => {
  assert.equal(toShopifyCarrierSubunits(420), '42000');
  assert.equal(toShopifyCarrierSubunits('1000'), '100000');
});

test('carrier shipping rates labels international quotes as Air Packet', () => {
  const response = buildCarrierRatesResponse({
    quoteResponse: {
      ok: true,
      enabled: true,
      result: {
        isDeliverable: true,
        totalShippingFee: 2040,
        rateSource: 'japan_post_air_packet',
      },
    },
    currency: 'JPY',
  });

  assert.equal(response.rates[0].service_name, '国際エアパケット');
  assert.equal(
    response.rates[0].service_code,
    'shipping_v2_jp_air_packet_2026_06_01',
  );
  assert.equal(response.rates[0].description, '日本郵便の追跡付き国際配送');
  assert.equal(response.rates[0].total_price, '204000');
});

test('carrier shipping rates encodes the Air Packet zone and weight bands for order audit', () => {
  const response = buildCarrierRatesResponse({
    quoteResponse: {
      ok: true,
      enabled: true,
      result: {
        isDeliverable: true,
        totalShippingFee: 6040,
        rateSource: 'japan_post_air_packet',
      },
      debug: {
        groups: [
          {
            lineQuotes: [
              { zone: 3, weightBandGrams: 800, quantity: 2 },
              { zone: 3, weightBandGrams: 100, quantity: 1 },
            ],
          },
        ],
      },
    },
    currency: 'JPY',
  });

  assert.equal(
    response.rates[0].service_code,
    'shipping_v2_jp_air_packet_2026_06_01_z3_b1x1.8x2',
  );
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
    resolveCarrierFulfillmentOwnershipImpl: passThroughOwnershipResolution,
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
    resolveCarrierFulfillmentOwnershipImpl: passThroughOwnershipResolution,
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

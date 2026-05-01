import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildShippingQuoteResponse,
  createShippingQuoteAction,
  createShippingQuoteLoader,
  normalizeShippingQuoteInput,
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

test('api.shipping-quote returns a JP default quote in the Shipping V2 response shape', () => {
  assert.deepEqual(buildShippingQuoteResponse(createQuoteRequest()).result, {
    isPendingAddress: false,
    isDeliverable: true,
    totalShippingFee: 870,
    currencyCode: 'JPY',
  });
});

test('api.shipping-quote normalizes Shopify quote input for diagnostics', () => {
  assert.deepEqual(
    normalizeShippingQuoteInput(
      createQuoteRequest({
        orderLike: {
          lines: [
            {
              product_id: 9044842447011,
              variant_id: 47424753369251,
              quantity: 1,
              requiresShipping: true,
              price: 165000,
            },
          ],
        },
        shippingAddress: {
          country: 'JP',
          postal_code: '300-1532',
          province: 'JP-08',
          city: 'Toride',
        },
      }),
    ),
    {
      source: 'shipping_rules_quote',
      calculationVersion: 'rules_v1',
      shopDomain: 'b30ize-1a.myshopify.com',
      shippingAddress: {
        countryCode: 'JP',
        country: 'JP',
        postalCode: '300-1532',
        zip: '300-1532',
        province: 'JP-08',
        prefecture: 'JP-08',
        provinceCode: 'JP-08',
        provinceName: 'Ibaraki',
        city: 'Toride',
      },
      lines: [
        {
          lineId: 'quote-line-0',
          productId: '9044842447011',
          variantId: '47424753369251',
          quantity: 1,
          requiresShipping: true,
          amountAfterItemDiscountBeforeOrderCoupon: 165000,
          grams: null,
        },
      ],
      lineCount: 1,
      shippableLineCount: 1,
    },
  );
});

test('api.shipping-quote returns a different default quote for US addresses', async () => {
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
        source: 'shipping_rules_quote',
        calculationVersion: 'rules_v1',
        shopDomain: 'b30ize-1a.myshopify.com',
        shippingAddress: {
          countryCode: 'US',
          postalCode: '90210',
          province: 'CA',
          provinceCode: null,
          provinceName: 'CA',
          city: null,
        },
        lineCount: 1,
        shippableLineCount: 1,
        lines: [
          {
            productId: 'gid://shopify/Product/1',
            variantId: 'gid://shopify/ProductVariant/1',
            quantity: 1,
            requiresShipping: true,
            amountAfterItemDiscountBeforeOrderCoupon: 4200,
            grams: null,
          },
        ],
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
          source: 'vendor-register-shipping-rules',
          calculationVersion: 'rules_v1',
          countryCode: 'US',
          postalCode: '90210',
          province: 'CA',
          provinceCode: null,
          provinceName: 'CA',
          shippableLineCount: 1,
          rateSource: 'rule',
          matchedRuleId: 'us-default',
          totalWeightGrams: 0,
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

test('api.shipping-quote returns zero when every line is non-shipping', () => {
  const payload = buildShippingQuoteResponse(
    createQuoteRequest({
      orderLike: {
        lines: [
          {
            productId: 'gid://shopify/Product/1',
            variantId: 'gid://shopify/ProductVariant/1',
            quantity: 1,
            requiresShipping: false,
            amountAfterItemDiscountBeforeOrderCoupon: 4200,
          },
        ],
      },
    }),
  );

  assert.equal(payload.result.totalShippingFee, 0);
  assert.equal(payload.debug.shippableLineCount, 0);
});

test('api.shipping-quote can use configured province and variant rules', () => {
  const payload = buildShippingQuoteResponse(
    createQuoteRequest({
      orderLike: {
        lines: [
          {
            productId: '9044842447011',
            variantId: '47424753369251',
            quantity: 1,
            requiresShipping: true,
            grams: 300,
          },
        ],
      },
      shippingAddress: {
        country: 'JP',
        postal_code: '300-1532',
        province: 'JP-08',
      },
    }),
    {
      ruleConfig: {
        currencyCode: 'JPY',
        defaultAmount: 3500,
        rules: [
          {
            id: 'ibaraki-target-variant',
            countryCodes: ['JP'],
            provinceCodes: ['JP-08'],
            variantIds: ['47424753369251'],
            maxTotalWeightGrams: 1000,
            amount: 990,
          },
        ],
      },
    },
  );

  assert.equal(payload.result.totalShippingFee, 990);
  assert.equal(payload.debug.matchedRuleId, 'ibaraki-target-variant');
  assert.equal(payload.debug.totalWeightGrams, 300);
});

test('api.shipping-quote returns undeliverable when configured with no matching rule', () => {
  const payload = buildShippingQuoteResponse(
    createQuoteRequest({
      shippingAddress: {
        country: 'FR',
        postalCode: '75001',
      },
    }),
    {
      ruleConfig: {
        undeliverableWhenNoRule: true,
        rules: [
          {
            id: 'jp-only',
            countryCodes: ['JP'],
            amount: 870,
          },
        ],
      },
    },
  );

  assert.equal(payload.reason, 'undeliverable');
  assert.equal(payload.result.isDeliverable, false);
  assert.equal(payload.debug.rateSource, 'no_matching_rule');
});

test('api.shipping-quote fails closed for invalid JSON rule config', () => {
  const payload = buildShippingQuoteResponse(createQuoteRequest(), {
    rawRuleConfig: '{nope',
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.reason, 'shipping_rule_config_error');
  assert.equal(payload.result.isDeliverable, false);
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

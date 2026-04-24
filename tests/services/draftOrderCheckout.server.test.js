import assert from 'node:assert/strict';
import test from 'node:test';

import { createDraftOrderCheckout } from '../../app/services/draftOrderCheckout.server.js';

const GENERIC_CHECKOUT_ERROR_MESSAGE =
  '注文の作成に失敗しました。入力内容を確認して、もう一度お試しください。';
const GENERIC_SHIPPING_ERROR_MESSAGE =
  '送料の計算に失敗しました。配送先を確認して、もう一度お試しください。';

function buildValidCheckoutRequest(overrides = {}) {
  return {
    orderLike: {
      lines: [
        {
          lineId: 'prod_1',
          title: 'Amber Wine',
          quantity: 2,
          originalUnitPrice: 2400,
          amountAfterItemDiscountBeforeOrderCoupon: 4800,
        },
      ],
      ...overrides.orderLike,
    },
    shippingAddress: {
      firstName: 'Taro',
      lastName: 'Yamada',
      address1: '1-2-3 Jingumae',
      city: 'Shibuya',
      prefecture: 'Tokyo',
      postalCode: '150-0001',
      country: 'JP',
      phone: '+819012345678',
      ...overrides.shippingAddress,
    },
    shopDomain: 'shop-a.myshopify.com',
    email: 'taro@example.com',
    note: 'Leave at front desk',
    tags: [
      'vendor-storefront',
      'vendor:amber-cellar',
    ],
    shippingLine: {
      title: 'Legacy shipping',
      ...overrides.shippingLine,
    },
    ...overrides,
  };
}

function createDraftOrderCreateResponse(overrides = {}) {
  return {
    data: {
      draftOrderCreate: {
        draftOrder: {
          id: 'gid://shopify/DraftOrder/1',
          invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
          customAttributes: [],
          shippingLine: {
            title: 'Prepared shipping',
          },
          ...overrides.draftOrder,
        },
        userErrors: [],
        ...overrides.payload,
      },
    },
    shopDomain: 'shop-a.myshopify.com',
  };
}

test('draftOrderCheckout uses prepared shippingAmount and preserves vendor metadata', async () => {
  let prepareCallCount = 0;
  let receivedGraphQLInput = null;
  const checkout = createDraftOrderCheckout({
    prepareShippingV2WriterPayloadImpl: async (input) => {
      prepareCallCount += 1;

      return {
        applied: true,
        reason: null,
        payload: {
          ...input.payload,
          shippingAmount: 420,
          shippingLine: {
            title: 'Prepared shipping',
          },
        },
      };
    },
    shopifyGraphQLWithOfflineSessionImpl: async ({ variables }) => {
      receivedGraphQLInput = variables.input;
      return createDraftOrderCreateResponse();
    },
  });

  const result = await checkout(buildValidCheckoutRequest());

  assert.equal(prepareCallCount, 1);
  assert.equal(receivedGraphQLInput.shippingLine.price, 420);
  assert.deepEqual(receivedGraphQLInput.tags, [
    'vendor-storefront',
    'vendor:amber-cellar',
  ]);
  assert.equal('customAttributes' in receivedGraphQLInput, false);
  assert.equal(JSON.stringify(receivedGraphQLInput).includes('vendorId'), false);
  assert.equal(JSON.stringify(receivedGraphQLInput).includes('vendorStoreId'), false);
  assert.equal(JSON.stringify(receivedGraphQLInput).includes('localProductId'), false);
  assert.equal(JSON.stringify(receivedGraphQLInput).includes('productUrl'), false);
  assert.equal(JSON.stringify(receivedGraphQLInput).includes('shopifyProductId'), false);
  assert.deepEqual(result, {
    ok: true,
    draftOrder: {
      id: 'gid://shopify/DraftOrder/1',
      invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
    },
    invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
    applied: true,
    reason: null,
    shippingAmount: 420,
  });
});

test('draftOrderCheckout fails closed when Shipping V2 cannot produce a quote', async () => {
  let graphQLCallCount = 0;
  const checkout = createDraftOrderCheckout({
    prepareShippingV2WriterPayloadImpl: async () => ({
      applied: false,
      reason: 'quote_error',
      payload: {
        shippingAmount: 550,
        shippingLine: {
          title: 'Fallback shipping',
        },
      },
    }),
    shopifyGraphQLWithOfflineSessionImpl: async () => {
      graphQLCallCount += 1;
      return createDraftOrderCreateResponse();
    },
  });

  await assert.rejects(
    () => checkout(buildValidCheckoutRequest()),
    (error) =>
      error?.reason === 'shipping_quote_failed' &&
      error?.publicMessage === GENERIC_SHIPPING_ERROR_MESSAGE,
  );

  assert.equal(graphQLCallCount, 0);
});

test('draftOrderCheckout does not generate shipping_v2_snapshot locally after prepare', async () => {
  let receivedGraphQLInput = null;
  const checkout = createDraftOrderCheckout({
    prepareShippingV2WriterPayloadImpl: async (input) => ({
      applied: true,
      reason: null,
      payload: {
        ...input.payload,
        shippingAmount: 460,
      },
    }),
    shopifyGraphQLWithOfflineSessionImpl: async ({ variables }) => {
      receivedGraphQLInput = variables.input;
      return createDraftOrderCreateResponse();
    },
  });

  await checkout(buildValidCheckoutRequest());

  assert.equal('customAttributes' in receivedGraphQLInput, false);
  assert.equal(JSON.stringify(receivedGraphQLInput).includes('shipping_v2_snapshot'), false);
});

test('draftOrderCheckout treats Shopify GraphQL userErrors as sanitized failures', async () => {
  const checkout = createDraftOrderCheckout({
    prepareShippingV2WriterPayloadImpl: async (input) => ({
      applied: true,
      reason: null,
      payload: {
        ...input.payload,
        shippingAmount: 420,
      },
    }),
    shopifyGraphQLWithOfflineSessionImpl: async () =>
      createDraftOrderCreateResponse({
        draftOrder: null,
        payload: {
          userErrors: [{ field: ['input', 'lineItems'], message: 'Variant is invalid' }],
        },
      }),
  });

  await assert.rejects(
    () => checkout(buildValidCheckoutRequest()),
    (error) =>
      error?.reason === 'checkout_failed' &&
      error?.publicMessage === GENERIC_CHECKOUT_ERROR_MESSAGE &&
      Array.isArray(error?.userErrors),
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDraftOrderCheckout } from '../../app/services/draftOrderCheckout.server.js';

const GENERIC_CHECKOUT_ERROR_MESSAGE =
  '注文の作成に失敗しました。入力内容を確認して、もう一度お試しください。';
const GENERIC_SHIPPING_ERROR_MESSAGE =
  '送料の計算に失敗しました。配送先を確認して、もう一度お試しください。';

function createTestDraftOrderCheckout(options = {}) {
  return createDraftOrderCheckout({
    inspectDraftOrderSaleEligibilityImpl: async () => ({ ok: true }),
    ...options,
  });
}

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

function createDraftOrderPrepareResponse(overrides = {}) {
  return {
    data: {
      draftOrderPrepareForBuyerCheckout: {
        draftOrder: {
          id: 'gid://shopify/DraftOrder/1',
          invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
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
  let graphQLCallCount = 0;
  let receivedGraphQLInput = null;
  let prepareMutation = null;
  const checkout = createTestDraftOrderCheckout({
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
    shopifyGraphQLWithOfflineSessionImpl: async ({ query, variables }) => {
      graphQLCallCount += 1;
      if (query.includes('draftOrderPrepareForBuyerCheckout')) {
        prepareMutation = query;
        return createDraftOrderPrepareResponse();
      }
      receivedGraphQLInput = variables.input;
      return createDraftOrderCreateResponse();
    },
  });

  const result = await checkout(buildValidCheckoutRequest());

  assert.equal(prepareCallCount, 1);
  assert.equal(graphQLCallCount, 2);
  assert.match(prepareMutation, /bypassCartValidations:\s*true/);
  assert.match(prepareMutation, /allowDiscountCodesInCheckout:\s*false/);
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
  const checkout = createTestDraftOrderCheckout({
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
  const checkout = createTestDraftOrderCheckout({
    prepareShippingV2WriterPayloadImpl: async (input) => ({
      applied: true,
      reason: null,
      payload: {
        ...input.payload,
        shippingAmount: 460,
      },
    }),
    shopifyGraphQLWithOfflineSessionImpl: async ({ query, variables }) => {
      if (query.includes('draftOrderPrepareForBuyerCheckout')) {
        return createDraftOrderPrepareResponse();
      }
      receivedGraphQLInput = variables.input;
      return createDraftOrderCreateResponse();
    },
  });

  await checkout(buildValidCheckoutRequest());

  assert.equal('customAttributes' in receivedGraphQLInput, false);
  assert.equal(JSON.stringify(receivedGraphQLInput).includes('shipping_v2_snapshot'), false);
});

test('draftOrderCheckout treats Shopify GraphQL userErrors as sanitized failures', async () => {
  const checkout = createTestDraftOrderCheckout({
    prepareShippingV2WriterPayloadImpl: async (input) => ({
      applied: true,
      reason: null,
      payload: {
        ...input.payload,
        shippingAmount: 420,
      },
    }),
    shopifyGraphQLWithOfflineSessionImpl: async ({ query }) => {
      if (query.includes('draftOrderPrepareForBuyerCheckout')) {
        return createDraftOrderPrepareResponse();
      }
      return createDraftOrderCreateResponse({
        draftOrder: null,
        payload: {
          userErrors: [{ field: ['input', 'lineItems'], message: 'Variant is invalid' }],
        },
      });
    },
  });

  await assert.rejects(
    () => checkout(buildValidCheckoutRequest()),
    (error) =>
      error?.reason === 'checkout_failed' &&
      error?.publicMessage === GENERIC_CHECKOUT_ERROR_MESSAGE &&
      Array.isArray(error?.userErrors),
  );
});

test('draftOrderCheckout treats prepare userErrors as sanitized failures', async () => {
  const checkout = createTestDraftOrderCheckout({
    prepareShippingV2WriterPayloadImpl: async (input) => ({
      applied: true,
      reason: null,
      payload: {
        ...input.payload,
        shippingAmount: 420,
      },
    }),
    shopifyGraphQLWithOfflineSessionImpl: async ({ query }) => {
      if (!query.includes('draftOrderPrepareForBuyerCheckout')) {
        return createDraftOrderCreateResponse();
      }
      return createDraftOrderPrepareResponse({
        draftOrder: null,
        payload: {
          userErrors: [{ field: ['id'], message: 'Draft order is invalid' }],
        },
      });
    },
  });

  await assert.rejects(
    () => checkout(buildValidCheckoutRequest()),
    (error) =>
      error?.reason === 'checkout_failed' &&
      error?.publicMessage === GENERIC_CHECKOUT_ERROR_MESSAGE &&
      Array.isArray(error?.userErrors),
  );
});

test('draftOrderCheckout blocks ineligible products before shipping or Shopify mutations', async () => {
  let shippingCalls = 0;
  let graphQLCalls = 0;
  const checkout = createDraftOrderCheckout({
    inspectDraftOrderSaleEligibilityImpl: async () => ({
      ok: false,
      reason: 'purchase_stop_active',
    }),
    prepareShippingV2WriterPayloadImpl: async () => {
      shippingCalls += 1;
      return { applied: true, payload: {} };
    },
    shopifyGraphQLWithOfflineSessionImpl: async () => {
      graphQLCalls += 1;
      return createDraftOrderCreateResponse();
    },
  });

  await assert.rejects(
    () => checkout(buildValidCheckoutRequest()),
    (error) => error?.reason === 'sale_eligibility_blocked',
  );
  assert.equal(shippingCalls, 0);
  assert.equal(graphQLCalls, 0);
});

test('draftOrderCheckout aggregates duplicate local product rows before inventory and mutation', async () => {
  let receivedLines = null;
  const checkout = createTestDraftOrderCheckout({
    prepareShippingV2WriterPayloadImpl: async (input) => ({
      applied: true,
      payload: {
        ...input.payload,
        shippingAmount: 420,
      },
    }),
    shopifyGraphQLWithOfflineSessionImpl: async ({ query, variables }) => {
      if (query.includes('draftOrderPrepareForBuyerCheckout')) {
        return createDraftOrderPrepareResponse();
      }
      receivedLines = variables.input.lineItems;
      return createDraftOrderCreateResponse();
    },
  });
  const request = buildValidCheckoutRequest({
    orderLike: {
      lines: [
        {
          lineId: 'prod_1',
          title: 'Amber Wine',
          quantity: 1,
          originalUnitPrice: 2400,
          amountAfterItemDiscountBeforeOrderCoupon: 2400,
        },
        {
          lineId: 'prod_1',
          title: 'Amber Wine',
          quantity: 2,
          originalUnitPrice: 2400,
          amountAfterItemDiscountBeforeOrderCoupon: 4800,
        },
      ],
    },
  });

  await checkout(request);

  assert.equal(receivedLines.length, 1);
  assert.equal(receivedLines[0].quantity, 3);
});

test('draftOrderCheckout rejects excessive line and quantity inputs before external work', async () => {
  let externalCalls = 0;
  const checkout = createTestDraftOrderCheckout({
    prepareShippingV2WriterPayloadImpl: async () => {
      externalCalls += 1;
      return { applied: true, payload: {} };
    },
  });
  const excessiveLines = Array.from({ length: 21 }, (_, index) => ({
    lineId: `prod_${index}`,
    title: `Product ${index}`,
    quantity: 1,
    originalUnitPrice: 100,
    amountAfterItemDiscountBeforeOrderCoupon: 100,
  }));

  await assert.rejects(
    () =>
      checkout(
        buildValidCheckoutRequest({
          orderLike: { lines: excessiveLines },
        }),
      ),
    (error) => error?.reason === 'invalid_payload',
  );
  assert.equal(externalCalls, 0);
});

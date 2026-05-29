import assert from 'node:assert/strict';
import test from 'node:test';

import { createDraftOrderCheckout } from '../../app/services/draftOrderCheckout.server.js';
import { createDraftOrderCheckoutLoader } from '../../app/services/draftOrderCheckout.server.js';
import { createPublicVendorDraftOrderCheckoutAction } from '../../app/services/vendorStorefront.server.js';

const GENERIC_CHECKOUT_ERROR_MESSAGE =
  '注文の作成に失敗しました。入力内容を確認して、もう一度お試しください。';
const INVALID_SELECTION_MESSAGE =
  '選択した商品を確認できませんでした。もう一度商品を選び直してください。';

function createProducts() {
  return [
    {
      id: 'prod_1',
      name: 'Amber Wine',
      description: 'Skin contact white',
      imageUrl: null,
      price: 4200,
      calculatedPrice: 4200,
      url: 'https://example.com/products/amber-wine',
      shopDomain: 'shop-a.myshopify.com',
      shopifyProductId: 'gid://shopify/Product/1',
      approvalStatus: 'approved',
      vendorStoreId: 'store_1',
      productEuStatus: 'DISABLED',
      countryPolicy: null,
    },
    {
      id: 'prod_pending',
      name: 'Pending Bottle',
      description: 'Pending review',
      imageUrl: null,
      price: 3800,
      calculatedPrice: 3800,
      url: 'https://example.com/products/pending-bottle',
      shopDomain: 'shop-a.myshopify.com',
      shopifyProductId: 'gid://shopify/Product/2',
      approvalStatus: 'pending',
      vendorStoreId: 'store_1',
      productEuStatus: 'DISABLED',
      countryPolicy: null,
    },
    {
      id: 'prod_other',
      name: 'Other Store Bottle',
      description: 'Other vendor item',
      imageUrl: null,
      price: 5000,
      calculatedPrice: 5000,
      url: 'https://example.com/products/other-store-bottle',
      shopDomain: 'shop-b.myshopify.com',
      shopifyProductId: 'gid://shopify/Product/3',
      approvalStatus: 'approved',
      vendorStoreId: 'store_2',
      productEuStatus: 'DISABLED',
      countryPolicy: null,
    },
  ];
}

function projectProduct(product, select) {
  if (!select) {
    return { ...product };
  }

  const projected = {};

  for (const [key, enabled] of Object.entries(select)) {
    if (enabled) {
      projected[key] = product[key];
    }
  }

  return projected;
}

function createFakePrisma({
  products = createProducts(),
  seller = null,
  buyerWarningRecords = [],
} = {}) {
  return {
    vendor: {
      async findUnique({ where }) {
        if (where.handle !== 'amber-cellar') {
          return null;
        }

        return {
          id: 'vendor_1',
          handle: 'amber-cellar',
          storeName: 'Amber Cellar',
          managementEmail: 'owner@example.com',
          status: 'active',
          seller,
          vendorStore: {
            id: 'store_1',
            storeName: 'Amber Cellar',
            ownerName: 'Owner',
            country: 'JP',
            category: 'Wine',
            note: 'Natural wine selection',
          },
        };
      },
    },
    product: {
      async findMany({ where, select }) {
        return products
          .filter((product) => {
            if (where?.vendorStoreId && product.vendorStoreId !== where.vendorStoreId) {
              return false;
            }

            if (where?.approvalStatus && product.approvalStatus !== where.approvalStatus) {
              return false;
            }

            if (where?.id?.in && !where.id.in.includes(product.id)) {
              return false;
            }

            return true;
          })
          .map((product) => projectProduct(product, select));
      },
    },
    buyerWarningAcceptance: {
      async create({ data }) {
        const record = {
          id: `bwa_${buyerWarningRecords.length + 1}`,
          ...data,
        };
        buyerWarningRecords.push(record);
        return record;
      },
    },
  };
}

function createValidBody(overrides = {}) {
  return {
    vendorHandle: 'amber-cellar',
    items: [
      {
        productId: 'prod_1',
        quantity: 2,
      },
    ],
    customer: {
      firstName: 'Taro',
      lastName: 'Yamada',
      email: 'taro@example.com',
      phone: '09012345678',
    },
    shippingAddress: {
      address1: '1-2-3 Jingumae',
      city: 'Shibuya',
      province: 'Tokyo',
      postalCode: '150-0001',
      country: 'JP',
    },
    ...overrides,
  };
}

function createShopifyFallbackBody(overrides = {}) {
  return createValidBody({
    items: [
      {
        shopifyProductId: 'gid://shopify/Product/999',
        quantity: 1,
        price: 1,
      },
    ],
    shopDomain: 'evil-shop.myshopify.com',
    ...overrides,
  });
}

function createShopifyGraphQLStub({ productVariants, variant } = {}) {
  return async ({ shopDomain, query, variables }) => {
    assert.equal(shopDomain, 'shop-a.myshopify.com');
    assert.equal(query.includes('requiresShipping'), true);
    assert.equal(query.includes('inventoryItem'), true);

    if (query.includes('productVariant')) {
      return {
        data: {
          productVariant:
            variant ?? {
              id: variables.id,
              title: 'Default Title',
              price: '1234',
              inventoryItem: {
                requiresShipping: true,
              },
              product: {
                id: 'gid://shopify/Product/999',
                title: 'Shopify Only Bottle',
              },
            },
        },
      };
    }

    return {
      data: {
        product: {
          id: variables.id,
          title: 'Shopify Only Bottle',
          variants: {
            nodes:
              productVariants ?? [
                {
                  id: 'gid://shopify/ProductVariant/9991',
                  title: 'Default Title',
                  price: '1234',
                  inventoryItem: {
                    requiresShipping: true,
                  },
                },
              ],
          },
        },
      },
    };
  };
}

test('api.draft-order.checkout returns 405 for non-POST loader requests', async () => {
  const loader = createDraftOrderCheckoutLoader();
  const request = new Request('http://localhost/api/draft-order/checkout');

  const response = await loader({ request });

  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'POST');
});

test('api.draft-order.checkout creates a server-trusted payload and ignores shopDomain tampering', async () => {
  let receivedPayload = null;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma(),
    draftOrderCheckoutImpl: async (payload) => {
      receivedPayload = payload;

      return {
        ok: true,
        draftOrder: {
          id: 'gid://shopify/DraftOrder/1',
          invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
        },
        invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
        applied: true,
        reason: null,
        shippingAmount: 420,
      };
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        shopDomain: 'evil-shop.myshopify.com',
        price: 1,
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });

  assert.equal(response.status, 200);
  assert.equal(receivedPayload.shopDomain, 'shop-a.myshopify.com');
  assert.deepEqual(receivedPayload.tags, [
    'vendor-storefront',
    'vendor:amber-cellar',
  ]);
  assert.deepEqual(receivedPayload.customAttributes, [
    { key: 'seller_name', value: 'Amber Cellar' },
    { key: 'seller_country', value: 'JP' },
    { key: 'seller_of_record', value: 'marketplace_seller' },
  ]);
  assert.equal(JSON.stringify(receivedPayload).includes('vendorId'), false);
  assert.equal(JSON.stringify(receivedPayload).includes('vendorStoreId'), false);
  assert.equal(JSON.stringify(receivedPayload).includes('localProductId'), false);
  assert.equal(JSON.stringify(receivedPayload).includes('productUrl'), false);
  assert.equal(JSON.stringify(receivedPayload).includes('shopifyProductId'), false);
  assert.deepEqual(await response.json(), {
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

test('api.draft-order.checkout rejects EU checkout before product EU approval', async () => {
  let callCount = 0;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma({
      seller: {
        id: 'seller_1',
        euSellerStatus: 'FULL_KYBC_APPROVED',
      },
    }),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return {};
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        shippingAddress: {
          ...createValidBody().shippingAddress,
          country: 'DE',
        },
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.equal(payload.reason, 'invalid_payload');
  assert.deepEqual(payload.errors, [
    '選択した商品はEU向け販売の審査が完了していないため、指定国には販売できません。',
  ]);
});

test('api.draft-order.checkout requires EU import warning acceptance', async () => {
  let callCount = 0;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma({
      seller: {
        id: 'seller_1',
        euSellerStatus: 'FULL_KYBC_APPROVED',
      },
      products: createProducts().map((product) =>
        product.id === 'prod_1'
          ? { ...product, productEuStatus: 'APPROVED_LOW_RISK' }
          : product,
      ),
    }),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return {};
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        shippingAddress: {
          ...createValidBody().shippingAddress,
          country: 'DE',
        },
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.deepEqual(payload.errors, ['配送先国と輸入条件の確認に同意してください。']);
});

test('api.draft-order.checkout records EU import warning acceptance after checkout', async () => {
  const buyerWarningRecords = [];
  let receivedPayload = null;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma({
      buyerWarningRecords,
      seller: {
        id: 'seller_1',
        euSellerStatus: 'FULL_KYBC_APPROVED',
      },
      products: createProducts().map((product) =>
        product.id === 'prod_1'
          ? { ...product, productEuStatus: 'APPROVED_LOW_RISK' }
          : product,
      ),
    }),
    draftOrderCheckoutImpl: async (payload) => {
      receivedPayload = payload;

      return {
        ok: true,
        draftOrder: {
          id: 'gid://shopify/DraftOrder/1',
          invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
        },
        invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
      };
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        importResponsibilityAccepted: true,
        shippingAddress: {
          ...createValidBody().shippingAddress,
          country: 'DE',
        },
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'node-test',
    },
  });

  const response = await action({ request });

  assert.equal(response.status, 200);
  assert.equal(receivedPayload.buyerWarningAcceptance.shippingCountry, 'DE');
  assert.deepEqual(receivedPayload.customAttributes, [
    { key: 'seller_name', value: 'Amber Cellar' },
    { key: 'seller_country', value: 'JP' },
    { key: 'seller_of_record', value: 'marketplace_seller' },
    { key: 'buyer_import_warning_version', value: 'import-responsibility-v1' },
    { key: 'buyer_import_responsibility_accepted', value: 'true' },
  ]);
  assert.equal(buyerWarningRecords.length, 1);
  assert.equal(buyerWarningRecords[0].orderId, 'gid://shopify/DraftOrder/1');
  assert.equal(buyerWarningRecords[0].shippingCountry, 'DE');
  assert.equal(buyerWarningRecords[0].importResponsibilityAccepted, true);
});

test('api.draft-order.checkout rejects items from another vendor store', async () => {
  let callCount = 0;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma(),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return {};
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        items: [
          { productId: 'prod_1', quantity: 1 },
          { productId: 'prod_other', quantity: 1 },
        ],
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.equal(payload.reason, 'invalid_payload');
  assert.deepEqual(payload.errors, [INVALID_SELECTION_MESSAGE]);
});

test('api.draft-order.checkout rejects unapproved products', async () => {
  let callCount = 0;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma(),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return {};
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createValidBody({
        items: [{ productId: 'prod_pending', quantity: 1 }],
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.deepEqual(payload.errors, [INVALID_SELECTION_MESSAGE]);
});

test('api.draft-order.checkout falls back to Shopify product when local product id is absent', async () => {
  let receivedPayload = null;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma(),
    shopifyGraphQLWithOfflineSessionImpl: createShopifyGraphQLStub(),
    draftOrderCheckoutImpl: async (payload) => {
      receivedPayload = payload;

      return {
        ok: true,
        draftOrder: {
          id: 'gid://shopify/DraftOrder/1',
          invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
        },
        invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
        applied: true,
        reason: null,
        shippingAmount: 420,
      };
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(createShopifyFallbackBody()),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });

  assert.equal(response.status, 200);
  assert.equal(receivedPayload.shopDomain, 'shop-a.myshopify.com');
  assert.equal(receivedPayload.orderLike.lines[0].variantId, 'gid://shopify/ProductVariant/9991');
  assert.equal(receivedPayload.orderLike.lines[0].productId, 'gid://shopify/Product/999');
  assert.equal(receivedPayload.orderLike.lines[0].originalUnitPrice, 1234);
  assert.equal(receivedPayload.orderLike.lines[0].amountAfterItemDiscountBeforeOrderCoupon, 1234);
  assert.equal(receivedPayload.orderLike.lines[0].requiresShipping, true);
  assert.equal(JSON.stringify(receivedPayload).includes('shipping_v2_snapshot'), false);
});

test('api.draft-order.checkout uses requested Shopify variant before product fallback', async () => {
  let receivedPayload = null;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma(),
    shopifyGraphQLWithOfflineSessionImpl: createShopifyGraphQLStub({
      variant: {
        id: 'gid://shopify/ProductVariant/selected',
        title: '750ml',
        price: '2345',
        inventoryItem: {
          requiresShipping: false,
        },
        product: {
          id: 'gid://shopify/Product/999',
          title: 'Shopify Only Bottle',
        },
      },
    }),
    draftOrderCheckoutImpl: async (payload) => {
      receivedPayload = payload;
      return {
        ok: true,
        invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
        draftOrder: {
          id: 'gid://shopify/DraftOrder/1',
          invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
        },
        applied: true,
        shippingAmount: 420,
      };
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createShopifyFallbackBody({
        items: [
          {
            shopifyProductId: 'gid://shopify/Product/999',
            shopifyVariantId: 'gid://shopify/ProductVariant/selected',
            quantity: 2,
            price: 1,
          },
        ],
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });

  assert.equal(response.status, 200);
  assert.equal(receivedPayload.orderLike.lines[0].variantId, 'gid://shopify/ProductVariant/selected');
  assert.equal(receivedPayload.orderLike.lines[0].originalUnitPrice, 2345);
  assert.equal(receivedPayload.orderLike.lines[0].amountAfterItemDiscountBeforeOrderCoupon, 4690);
  assert.equal(receivedPayload.orderLike.lines[0].requiresShipping, false);
});

test('api.draft-order.checkout does not require ProductVariant.requiresShipping in Shopify fallback result', async () => {
  let receivedPayload = null;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma(),
    shopifyGraphQLWithOfflineSessionImpl: createShopifyGraphQLStub({
      variant: {
        id: 'gid://shopify/ProductVariant/selected',
        title: '750ml',
        price: '2345',
        product: {
          id: 'gid://shopify/Product/999',
          title: 'Shopify Only Bottle',
        },
        inventoryItem: null,
      },
    }),
    draftOrderCheckoutImpl: async (payload) => {
      receivedPayload = payload;
      return {
        ok: true,
        invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
        draftOrder: {
          id: 'gid://shopify/DraftOrder/1',
          invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
        },
        applied: true,
        shippingAmount: 420,
      };
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(
      createShopifyFallbackBody({
        items: [
          {
            shopifyVariantId: 'gid://shopify/ProductVariant/selected',
            quantity: 1,
          },
        ],
      }),
    ),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });

  assert.equal(response.status, 200);
  assert.equal(receivedPayload.orderLike.lines[0].requiresShipping, true);
});

test('api.draft-order.checkout returns variant_required for multi-variant Shopify products', async () => {
  let callCount = 0;
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma(),
    shopifyGraphQLWithOfflineSessionImpl: createShopifyGraphQLStub({
      productVariants: [
        {
          id: 'gid://shopify/ProductVariant/1',
          title: 'Small',
          price: '1200',
          inventoryItem: {
            requiresShipping: true,
          },
        },
        {
          id: 'gid://shopify/ProductVariant/2',
          title: 'Large',
          price: '1400',
          inventoryItem: {
            requiresShipping: true,
          },
        },
      ],
    }),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return {};
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(createShopifyFallbackBody()),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.deepEqual(payload.errors, ['variant_required']);
});

test('api.draft-order.checkout prepares Shopify fallback shipping once without caller snapshots', async () => {
  let prepareCallCount = 0;
  let receivedPrepareInput = null;
  const checkout = createDraftOrderCheckout({
    prepareShippingV2WriterPayloadImpl: async (input) => {
      prepareCallCount += 1;
      receivedPrepareInput = input;

      return {
        applied: true,
        reason: null,
        payload: {
          ...input.payload,
          shippingAmount: 420,
        },
      };
    },
    shopifyGraphQLWithOfflineSessionImpl: async () => ({
      data: {
        draftOrderCreate: {
          draftOrder: {
            id: 'gid://shopify/DraftOrder/1',
            invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
          },
          userErrors: [],
        },
      },
    }),
  });
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma(),
    shopifyGraphQLWithOfflineSessionImpl: createShopifyGraphQLStub(),
    draftOrderCheckoutImpl: checkout,
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(createShopifyFallbackBody()),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(prepareCallCount, 1);
  assert.equal(JSON.stringify(receivedPrepareInput).includes('shipping_v2_snapshot'), false);
  assert.equal(payload.invoiceUrl, 'https://shop-a.myshopify.com/invoices/1');
  assert.equal(payload.applied, true);
  assert.equal(payload.shippingAmount, 420);
});

test('api.draft-order.checkout sanitizes service failures', async () => {
  const action = createPublicVendorDraftOrderCheckoutAction({
    prismaClient: createFakePrisma(),
    draftOrderCheckoutImpl: async () => {
      const error = new Error('draftOrderCreate failed');
      error.userErrors = [{ field: ['input', 'lineItems'], message: 'Variant is invalid' }];
      throw error;
    },
  });
  const request = new Request('http://localhost/api/draft-order/checkout', {
    method: 'POST',
    body: JSON.stringify(createValidBody()),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const response = await action({ request });
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.deepEqual(payload, {
    ok: false,
    reason: 'internal_error',
    error: GENERIC_CHECKOUT_ERROR_MESSAGE,
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';

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

function createFakePrisma({ products = createProducts() } = {}) {
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
  assert.equal('customAttributes' in receivedPayload, false);
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

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDraftOrderCheckoutInputFromStorefrontForm,
  createVendorStorefrontAction,
} from '../../app/services/vendorStorefront.server.js';

const GENERIC_CHECKOUT_ERROR_MESSAGE =
  '注文の作成に失敗しました。入力内容を確認して、もう一度お試しください。';
const INVALID_SELECTION_MESSAGE =
  '選択した商品を確認できませんでした。もう一度商品を選び直してください。';

function createVendorContext() {
  return {
    vendor: {
      id: 'vendor_1',
      handle: 'amber-cellar',
      storeName: 'Amber Cellar',
      managementEmail: 'owner@example.com',
    },
    store: {
      id: 'store_1',
      storeName: 'Amber Cellar',
      ownerName: 'Owner',
      country: 'JP',
      category: 'Wine',
      note: 'Natural wine selection',
    },
  };
}

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

function buildFormData(entries) {
  return new URLSearchParams(entries);
}

function buildValidEntries(overrides = []) {
  return [
    ['quantity:prod_1', '2'],
    ['firstName', 'Taro'],
    ['lastName', 'Yamada'],
    ['email', 'taro@example.com'],
    ['phone', '09012345678'],
    ['address1', '1-2-3 Jingumae'],
    ['city', 'Shibuya'],
    ['province', 'Tokyo'],
    ['postalCode', '150-0001'],
    ['country', 'JP'],
    ...overrides,
  ];
}

test('vendor.$handle buildDraftOrderCheckoutInputFromStorefrontForm creates a server-trusted payload', async () => {
  const result = await buildDraftOrderCheckoutInputFromStorefrontForm({
    formData: buildFormData([
      ...buildValidEntries(),
      ['address2', 'Room 101'],
      ['note', 'Handle with care'],
      ['shopDomain', 'evil-shop.myshopify.com'],
      ['originalUnitPrice', '1'],
      ['price', '1'],
    ]),
    vendorContext: createVendorContext(),
    prismaClient: createFakePrisma(),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, {
    orderLike: {
      lines: [
        {
          lineId: 'prod_1',
          productId: 'gid://shopify/Product/1',
          title: 'Amber Wine',
          originalUnitPrice: 4200,
          quantity: 2,
          amountAfterItemDiscountBeforeOrderCoupon: 8400,
          requiresShipping: true,
        },
      ],
    },
    shippingAddress: {
      firstName: 'Taro',
      lastName: 'Yamada',
      address1: '1-2-3 Jingumae',
      address2: 'Room 101',
      city: 'Shibuya',
      prefecture: 'Tokyo',
      province: 'Tokyo',
      postalCode: '150-0001',
      zip: '150-0001',
      country: 'JP',
      countryCode: 'JP',
      phone: '09012345678',
    },
    customer: {
      firstName: 'Taro',
      lastName: 'Yamada',
      email: 'taro@example.com',
      phone: '09012345678',
    },
    email: 'taro@example.com',
    customerEmail: 'taro@example.com',
    note: 'Handle with care',
    shopDomain: 'shop-a.myshopify.com',
    tags: [
      'vendor-storefront',
      'vendor:amber-cellar',
    ],
  });
  assert.equal(JSON.stringify(result.payload).includes('evil-shop.myshopify.com'), false);
  assert.equal('customAttributes' in result.payload, false);
  assert.equal(
    JSON.stringify(result.payload).includes('localProductId'),
    false,
  );
  assert.equal(JSON.stringify(result.payload).includes('productUrl'), false);
  assert.equal(JSON.stringify(result.payload).includes('shopifyProductId'), false);
});

test('vendor.$handle action redirects to invoiceUrl on success', async () => {
  let receivedPayload = null;
  const action = createVendorStorefrontAction({
    prismaClient: createFakePrisma(),
    draftOrderCheckoutImpl: async (payload) => {
      receivedPayload = payload;

      return {
        invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
      };
    },
  });
  const request = new Request('http://localhost/vendor/amber-cellar', {
    method: 'POST',
    body: buildFormData(buildValidEntries()),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
  });

  const response = await action({
    request,
    params: { handle: 'amber-cellar' },
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), 'https://shop-a.myshopify.com/invoices/1');
  assert.equal(receivedPayload.shopDomain, 'shop-a.myshopify.com');
});

test('vendor.$handle action rejects other-vendor product ids mixed into the form', async () => {
  let callCount = 0;
  const action = createVendorStorefrontAction({
    prismaClient: createFakePrisma(),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return { invoiceUrl: 'https://shop-a.myshopify.com/invoices/1' };
    },
  });
  const request = new Request('http://localhost/vendor/amber-cellar', {
    method: 'POST',
    body: buildFormData([
      ...buildValidEntries(),
      ['quantity:prod_other', '1'],
    ]),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
  });

  const response = await action({
    request,
    params: { handle: 'amber-cellar' },
  });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.equal(payload.reason, 'invalid_payload');
  assert.equal(payload.fieldErrors.cart, INVALID_SELECTION_MESSAGE);
});

test('vendor.$handle action rejects unapproved products', async () => {
  let callCount = 0;
  const action = createVendorStorefrontAction({
    prismaClient: createFakePrisma(),
    draftOrderCheckoutImpl: async () => {
      callCount += 1;
      return { invoiceUrl: 'https://shop-a.myshopify.com/invoices/1' };
    },
  });
  const request = new Request('http://localhost/vendor/amber-cellar', {
    method: 'POST',
    body: buildFormData([
      ...buildValidEntries([
        ['quantity:prod_1', '0'],
      ]),
      ['quantity:prod_pending', '1'],
    ]),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
  });

  const response = await action({
    request,
    params: { handle: 'amber-cellar' },
  });
  const payload = await response.json();

  assert.equal(callCount, 0);
  assert.equal(response.status, 400);
  assert.equal(payload.fieldErrors.cart, INVALID_SELECTION_MESSAGE);
});

test('vendor.$handle action returns validation errors for invalid input', async () => {
  const action = createVendorStorefrontAction({
    prismaClient: createFakePrisma(),
    draftOrderCheckoutImpl: async () => {
      throw new Error('should not be called');
    },
  });
  const request = new Request('http://localhost/vendor/amber-cellar', {
    method: 'POST',
    body: buildFormData([
      ['quantity:prod_1', '0'],
      ['firstName', ''],
      ['lastName', ''],
      ['email', ''],
      ['phone', ''],
      ['address1', ''],
      ['city', ''],
      ['province', ''],
      ['postalCode', ''],
      ['country', ''],
    ]),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
  });

  const response = await action({
    request,
    params: { handle: 'amber-cellar' },
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.reason, 'invalid_payload');
  assert.equal(payload.fieldErrors.cart, '商品を1点以上選択してください。');
  assert.equal(payload.fieldErrors.email, 'メールアドレスを入力してください。');
});

test('vendor.$handle action sanitizes raw Shopify errors for the client', async () => {
  const action = createVendorStorefrontAction({
    prismaClient: createFakePrisma(),
    draftOrderCheckoutImpl: async () => {
      const error = new Error('draftOrderCreate failed');
      error.userErrors = [{ field: ['input', 'lineItems'], message: 'Variant is invalid' }];
      throw error;
    },
  });
  const request = new Request('http://localhost/vendor/amber-cellar', {
    method: 'POST',
    body: buildFormData(buildValidEntries([
      ['quantity:prod_1', '1'],
    ])),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
  });

  const response = await action({
    request,
    params: { handle: 'amber-cellar' },
  });
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.equal(payload.reason, 'internal_error');
  assert.equal(payload.error, GENERIC_CHECKOUT_ERROR_MESSAGE);
  assert.equal('details' in payload, false);
});

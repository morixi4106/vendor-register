import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDraftOrderCheckoutInputFromStorefrontForm,
  createVendorStorefrontAction,
} from '../../app/services/vendorStorefront.server.js';

const GENERIC_CHECKOUT_ERROR_MESSAGE =
  '注文の作成に失敗しました。入力内容を確認して、もう一度お試しください。';

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
    ['quantity:prod_1', '1'],
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

test('vendors.$handle buildDraftOrderCheckoutInputFromStorefrontForm keeps vendor/store metadata', async () => {
  const result = await buildDraftOrderCheckoutInputFromStorefrontForm({
    formData: buildFormData(buildValidEntries()),
    vendorContext: createVendorContext(),
    prismaClient: createFakePrisma(),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.payload.tags, [
    'vendor-storefront',
    'vendor:amber-cellar',
  ]);
  assert.equal('customAttributes' in result.payload, false);
});

test('vendors.$handle action redirects to invoiceUrl on success', async () => {
  const action = createVendorStorefrontAction({
    prismaClient: createFakePrisma(),
    draftOrderCheckoutImpl: async () => ({
      invoiceUrl: 'https://shop-a.myshopify.com/invoices/1',
    }),
  });
  const request = new Request('http://localhost/vendors/amber-cellar', {
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
});

test('vendors.$handle action ignores a tampered shopDomain form value', async () => {
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
  const request = new Request('http://localhost/vendors/amber-cellar', {
    method: 'POST',
    body: buildFormData(buildValidEntries([['shopDomain', 'evil-shop.myshopify.com']])),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
  });

  const response = await action({
    request,
    params: { handle: 'amber-cellar' },
  });

  assert.equal(response.status, 302);
  assert.equal(receivedPayload.shopDomain, 'shop-a.myshopify.com');
});

test('vendors.$handle action sanitizes service failures for alias traffic too', async () => {
  const action = createVendorStorefrontAction({
    prismaClient: createFakePrisma(),
    draftOrderCheckoutImpl: async () => {
      const error = new Error('draftOrderCreate failed');
      error.userErrors = [{ field: ['input', 'lineItems'], message: 'Variant is invalid' }];
      throw error;
    },
  });
  const request = new Request('http://localhost/vendors/amber-cellar', {
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
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.equal(payload.error, GENERIC_CHECKOUT_ERROR_MESSAGE);
  assert.equal('details' in payload, false);
});

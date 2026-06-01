import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductDeliveryEligibilityLoader } from '../../app/services/productDeliveryEligibility.server.js';

function createProduct(overrides = {}) {
  return {
    id: 'prod_1',
    name: 'Amber Wine',
    shopifyProductId: 'gid://shopify/Product/1',
    approvalStatus: 'approved',
    productEuStatus: 'APPROVED_LOW_RISK',
    countryPolicy: null,
    vendorStore: {
      vendorAuth: {
        handle: 'amber-cellar',
        seller: {
          euSellerStatus: 'FULL_KYBC_APPROVED',
        },
      },
    },
    ...overrides,
  };
}

function createFakePrisma(product = createProduct()) {
  return {
    product: {
      async findFirst() {
        return product;
      },
    },
  };
}

test('product delivery eligibility returns EU warning status for approved products', async () => {
  const loader = createProductDeliveryEligibilityLoader({
    prismaClient: createFakePrisma(),
  });
  const response = await loader({
    request: new Request(
      'http://localhost/api/product-delivery-eligibility?shopifyProductId=1&deliveryCountry=FR',
    ),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.deliveryCountry, 'FR');
  assert.equal(body.deliveryEligibility.status, 'REQUIRES_IMPORT_WARNING');
  assert.equal(body.deliveryEligibility.isAvailable, true);
});

test('product delivery eligibility blocks rejected EU products', async () => {
  const loader = createProductDeliveryEligibilityLoader({
    prismaClient: createFakePrisma(
      createProduct({
        productEuStatus: 'REJECTED_HIGH_RISK',
      }),
    ),
  });
  const response = await loader({
    request: new Request(
      'http://localhost/api/product-delivery-eligibility?productId=prod_1&deliveryCountry=DE',
    ),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.deliveryEligibility.status, 'UNAVAILABLE_PRODUCT_EU_REVIEW');
  assert.equal(body.deliveryEligibility.reason, 'eu_product_not_allowed');
});

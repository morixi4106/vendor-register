import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDeliveryRestrictionSummary,
  DELIVERY_ELIGIBILITY_STATUS,
  evaluateCartDeliveryEligibility,
  evaluateProductDeliveryEligibility,
} from '../../app/utils/deliveryEligibility.js';

const approvedSeller = {
  euSellerStatus: 'FULL_KYBC_APPROVED',
};

function createProduct(overrides = {}) {
  return {
    id: 'prod_1',
    shopifyProductId: 'gid://shopify/Product/1',
    approvalStatus: 'approved',
    productEuStatus: 'APPROVED_LOW_RISK',
    countryPolicy: null,
    ...overrides,
  };
}

test('evaluateProductDeliveryEligibility returns warning-required for EU approved products', () => {
  const result = evaluateProductDeliveryEligibility({
    product: createProduct(),
    seller: approvedSeller,
    deliveryCountry: 'FR',
  });

  assert.equal(result.status, DELIVERY_ELIGIBILITY_STATUS.REQUIRES_IMPORT_WARNING);
  assert.equal(result.isAvailable, true);
  assert.equal(result.requiresImportWarning, true);
  assert.equal(result.warningVersion, 'import-responsibility-v1');
  assert.equal(result.label, '注意確認が必要');
  assert.equal(
    result.message,
    '配送先国によって、関税・税金・通関手数料が発生する場合があります。',
  );
});

test('evaluateProductDeliveryEligibility blocks EU products before product approval', () => {
  const result = evaluateProductDeliveryEligibility({
    product: createProduct({ productEuStatus: 'REJECTED_HIGH_RISK' }),
    seller: approvedSeller,
    deliveryCountry: 'DE',
  });

  assert.equal(result.status, DELIVERY_ELIGIBILITY_STATUS.UNAVAILABLE_PRODUCT_EU_REVIEW);
  assert.equal(result.reason, 'eu_product_not_allowed');
  assert.equal(result.isAvailable, false);
  assert.equal(result.label, '販売できません');
  assert.equal(result.message, 'この配送先には販売できません。');
  assert.equal(
    result.internalMessage,
    'この商品はEU向け販売の確認が完了していないため、この配送先国には販売できません。',
  );
});

test('evaluateProductDeliveryEligibility omits public copy for plainly available products', () => {
  const result = evaluateProductDeliveryEligibility({
    product: createProduct(),
    seller: approvedSeller,
    deliveryCountry: 'JP',
  });

  assert.equal(result.status, DELIVERY_ELIGIBILITY_STATUS.AVAILABLE);
  assert.equal(result.isAvailable, true);
  assert.equal(result.label, null);
  assert.equal(result.message, null);
});

test('evaluateCartDeliveryEligibility blocks mixed EU carts when any product is unavailable', () => {
  const result = evaluateCartDeliveryEligibility({
    products: [
      createProduct({ id: 'prod_ok' }),
      createProduct({
        id: 'prod_blocked',
        productEuStatus: 'DISABLED',
      }),
    ],
    seller: approvedSeller,
    deliveryCountry: 'FR',
    importResponsibilityAccepted: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'eu_product_not_allowed');
  assert.equal(result.blocker.productId, 'prod_blocked');
});

test('evaluateCartDeliveryEligibility requires warning acceptance for EU carts', () => {
  const result = evaluateCartDeliveryEligibility({
    products: [createProduct()],
    seller: approvedSeller,
    deliveryCountry: 'FR',
    importResponsibilityAccepted: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'buyer_warning_required');
  assert.equal(result.requiresWarning, true);
});

test('evaluateCartDeliveryEligibility returns acceptance metadata after EU warning acceptance', () => {
  const result = evaluateCartDeliveryEligibility({
    products: [createProduct()],
    seller: approvedSeller,
    deliveryCountry: 'fr',
    importResponsibilityAccepted: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.requiresWarning, true);
  assert.deepEqual(result.acceptance, {
    selectedCountry: 'FR',
    shippingCountry: 'FR',
    productIds: ['prod_1'],
    warningVersion: 'import-responsibility-v1',
    importResponsibilityAccepted: true,
  });
});

test('buildDeliveryRestrictionSummary lists unavailable countries before country selection', () => {
  const summary = buildDeliveryRestrictionSummary({
    product: createProduct({
      productEuStatus: 'REJECTED_HIGH_RISK',
      countryPolicy: {
        blockedCountries: ['US'],
        allowedCountries: [],
        requiresWarningCountries: [],
      },
    }),
    seller: approvedSeller,
  });

  assert.equal(summary.hasRestrictions, true);
  assert.equal(summary.label, '一部の配送先では購入できません');
  assert.equal(
    summary.unavailableCountries.some((country) => country.code === 'FR'),
    true,
  );
  assert.equal(
    summary.unavailableCountries.some((country) => country.code === 'US'),
    true,
  );
});

test('buildDeliveryRestrictionSummary reports allowed-country limits', () => {
  const summary = buildDeliveryRestrictionSummary({
    product: createProduct({
      countryPolicy: {
        blockedCountries: [],
        allowedCountries: ['JP', 'US'],
        requiresWarningCountries: [],
      },
    }),
    seller: approvedSeller,
  });

  assert.equal(summary.hasRestrictions, true);
  assert.equal(summary.hasAllowedCountryLimit, true);
  assert.deepEqual(
    summary.allowedCountries.map((country) => country.code).sort(),
    ['JP', 'US'],
  );
});

test('buildDeliveryRestrictionSummary does not list unavailable countries as allowed', () => {
  const summary = buildDeliveryRestrictionSummary({
    product: createProduct({
      productEuStatus: 'REJECTED_HIGH_RISK',
      countryPolicy: {
        blockedCountries: [],
        allowedCountries: ['FR', 'JP'],
        requiresWarningCountries: [],
      },
    }),
    seller: approvedSeller,
  });

  assert.equal(summary.hasAllowedCountryLimit, true);
  assert.equal(
    summary.allowedCountries.some((country) => country.code === 'FR'),
    false,
  );
  assert.equal(
    summary.allowedCountries.some((country) => country.code === 'JP'),
    true,
  );
});

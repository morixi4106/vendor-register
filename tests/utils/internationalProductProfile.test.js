import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeHsCode,
  validateInternationalCustomsProfile,
  validateInternationalProductProfile,
} from '../../app/utils/internationalProductProfile.js';

function validProfile(overrides = {}) {
  return {
    internationalShippingMethod: 'AIR_PACKET',
    shippingWeightGrams: 500,
    shippingLengthMm: 250,
    shippingWidthMm: 180,
    shippingHeightMm: 70,
    shippingWeightConfirmedAt: new Date('2026-09-01T00:00:00.000Z'),
    shippingWeightSource: 'MANUAL_CONFIRMED',
    shopifyVariantCount: 1,
    shopifyWeightSyncStatus: 'SYNCED',
    complianceProfile: {
      countryOfOriginCode: 'JP',
      hsCode: '4202.92',
      customsDescriptionEn: 'Cotton pouch',
      regulatoryCategory: 'GENERAL_GOODS',
    },
    ...overrides,
  };
}

test('normalizeHsCode keeps only tariff digits', () => {
  assert.equal(normalizeHsCode('4202.92-000'), '420292000');
});

test('validateInternationalCustomsProfile accepts a complete customs profile', () => {
  const result = validateInternationalCustomsProfile(validProfile());

  assert.equal(result.ok, true);
  assert.equal(result.normalized.hsCode, '420292');
});

test('validateInternationalCustomsProfile rejects incomplete customs data', () => {
  const result = validateInternationalCustomsProfile(
    validProfile({
      complianceProfile: {
        countryOfOriginCode: 'Japan',
        hsCode: '42',
        customsDescriptionEn: '化粧品',
        regulatoryCategory: null,
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons.sort(), [
    'country_of_origin_invalid',
    'customs_description_invalid',
    'hs_code_invalid',
    'regulatory_category_missing',
  ]);
});

test('validateInternationalProductProfile combines shipping and customs checks', () => {
  assert.equal(validateInternationalProductProfile(validProfile()).ok, true);

  const blocked = validateInternationalProductProfile(
    validProfile({ shippingWeightConfirmedAt: null }),
  );
  assert.equal(blocked.ok, false);
  assert.ok(blocked.reasons.includes('shipping_weight_unverified'));
});

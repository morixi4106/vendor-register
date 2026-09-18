import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductDeliveryEligibilityLoader } from '../../app/services/productDeliveryEligibility.server.js';
import {
  getInternationalMarketRequirements,
  INTERNATIONAL_MARKET_REQUIREMENT_VERSION,
} from '../../app/utils/internationalMarketReadiness.js';

function buildMarketEvidence(countryCode) {
  const confirmedAt = new Date('2026-09-01T00:00:00.000Z');
  return getInternationalMarketRequirements(countryCode).map((requirement) => ({
    checkKey: requirement.code,
    status: 'CONFIRMED',
    evidenceReference: `test:${requirement.code}`,
    evidenceHash: 'e'.repeat(64),
    confirmedBy: 'test_operator',
    confirmedAt,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    metadataJson: {
      countryCode,
      requirementVersion: INTERNATIONAL_MARKET_REQUIREMENT_VERSION,
      officialSourceUrl: requirement.sourceUrl,
      confirmations: Object.fromEntries(
        requirement.confirmations.map((key) => [key, true]),
      ),
    },
  }));
}

function createProduct(overrides = {}) {
  return {
    id: 'prod_1',
    name: 'Amber Wine',
    shopifyProductId: 'gid://shopify/Product/1',
    approvalStatus: 'approved',
    productEuStatus: 'APPROVED_LOW_RISK',
    category: 'GENERAL_GOODS',
    countryPolicy: {
      blockedCountries: [],
      allowedCountries: ['DE', 'FR'],
      requiresWarningCountries: [],
    },
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
      approvalStatus: 'APPROVED',
      countryOfOriginCode: 'JP',
      hsCode: '420292',
      customsDescriptionEn: 'Cotton pouch',
      regulatoryCategory: 'GENERAL_GOODS',
    },
    complianceEvidence: [],
    complianceDecisions: [],
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
    internationalShippingCountryAvailability: {
      async findUnique() {
        return {
          countryCode: 'FR',
          service: 'JAPAN_POST_AIR_PACKET',
          status: 'ACTIVE',
          checkedAt: new Date(),
        };
      },
    },
    operationalReadinessAttestation: {
      async findMany() {
        return buildMarketEvidence('FR');
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
  assert.equal(body.deliveryEligibility.label, '注意確認が必要');
  assert.equal(
    body.deliveryEligibility.message,
    '配送先国によって、関税・税金・通関手数料が発生する場合があります。',
  );
  assert.equal('internalMessage' in body.deliveryEligibility, false);
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
  assert.equal(body.deliveryEligibility.status, 'UNAVAILABLE');
  assert.equal(body.deliveryEligibility.reason, 'unavailable');
  assert.equal(body.deliveryEligibility.label, '販売できません');
  assert.equal(body.deliveryEligibility.message, 'この配送先には販売できません。');
  assert.equal('sellerEuStatus' in body.deliveryEligibility, false);
  assert.equal('productEuStatus' in body.deliveryEligibility, false);
  assert.equal(body.deliveryRestrictionSummary.hasRestrictions, true);
  assert.equal(
    body.deliveryRestrictionSummary.unavailableCountries.some(
      (country) => country.code === 'DE',
    ),
    true,
  );
});

test('product delivery eligibility blocks stale international service data', async () => {
  const loader = createProductDeliveryEligibilityLoader({
    prismaClient: createFakePrisma(),
    getInternationalShippingCountryAvailabilityImpl: async () => ({
      countryCode: 'FR',
      service: 'JAPAN_POST_AIR_PACKET',
      status: 'ACTIVE',
      checkedAt: new Date('2000-01-01T00:00:00.000Z'),
    }),
  });
  const response = await loader({
    request: new Request(
      'http://localhost/api/product-delivery-eligibility?productId=prod_1&deliveryCountry=FR',
    ),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.deliveryEligibility.isAvailable, false);
  assert.equal(
    body.deliveryEligibility.reason,
    'unavailable',
  );
});

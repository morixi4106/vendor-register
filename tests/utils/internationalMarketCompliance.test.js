import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateInternationalMarketCompliance,
  getInternationalMarket,
  getRequiredInternationalRequirements,
} from '../../app/utils/internationalMarketCompliance.js';

const evaluatedAt = new Date('2026-09-18T00:00:00.000Z');

function generalGoods(overrides = {}) {
  return {
    id: 'product_1',
    category: 'GENERAL_GOODS',
    complianceProfile: {
      approvalStatus: 'APPROVED',
      regulatoryCategory: 'GENERAL_GOODS',
    },
    complianceEvidence: [],
    complianceDecisions: [],
    ...overrides,
  };
}

function cosmeticsWithRequirements(countryCode) {
  const product = generalGoods({
    category: 'COSMETICS',
    complianceProfile: {
      approvalStatus: 'APPROVED',
      regulatoryCategory: 'COSMETICS',
    },
  });
  const requirements = getRequiredInternationalRequirements(product, countryCode);
  product.complianceDecisions = requirements.map((requirement, index) => ({
    id: `decision_${index}`,
    decision: 'COMPLIANT',
    decidedAt: evaluatedAt,
    reviewDueAt: new Date('2099-01-01T00:00:00.000Z'),
    requirement: { ...requirement, isActive: true, status: 'ACTIVE' },
  }));
  product.complianceEvidence = requirements.map((requirement, index) => ({
    id: `evidence_${index}`,
    status: 'VERIFIED',
    verificationLevel: requirement.requiredVerificationLevel,
    reviewDueAt: new Date('2099-01-01T00:00:00.000Z'),
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    revokedAt: null,
    requirement: { ...requirement, isActive: true, status: 'ACTIVE' },
  }));
  return product;
}

test('getInternationalMarket separates domestic, EU, GB, US, and other markets', () => {
  assert.equal(getInternationalMarket('JP'), 'DOMESTIC');
  assert.equal(getInternationalMarket('FR'), 'EU');
  assert.equal(getInternationalMarket('GB'), 'GB');
  assert.equal(getInternationalMarket('US'), 'US');
  assert.equal(getInternationalMarket('SG'), 'OTHER');
});

test('general goods require an approved international profile but no cosmetics evidence', () => {
  const result = evaluateInternationalMarketCompliance({
    product: generalGoods(),
    destinationCountry: 'US',
    evaluatedAt,
  });

  assert.equal(result.ready, true);
  assert.deepEqual(result.requirements, []);
});

test('cosmetics fail closed until every market requirement has a decision and evidence', () => {
  const product = cosmeticsWithRequirements('FR');
  product.complianceEvidence.pop();
  const result = evaluateInternationalMarketCompliance({
    product,
    destinationCountry: 'FR',
    evaluatedAt,
  });

  assert.equal(result.ready, false);
  assert.ok(result.reasons.some((reason) => reason.startsWith('requirement_evidence_missing:')));
});

test('cosmetics pass when all current market requirements are evidenced', () => {
  const result = evaluateInternationalMarketCompliance({
    product: cosmeticsWithRequirements('US'),
    destinationCountry: 'US',
    evaluatedAt,
  });

  assert.equal(result.ready, true);
  assert.ok(result.requirements.length >= 3);
  assert.equal(result.requirements.every((entry) => entry.ready), true);
});

test('US MoCRA exemptions only satisfy explicitly exemptible requirements', () => {
  const product = cosmeticsWithRequirements('US');
  for (const decision of product.complianceDecisions) {
    decision.decision = 'NOT_APPLICABLE';
  }

  const result = evaluateInternationalMarketCompliance({
    product,
    destinationCountry: 'US',
    evaluatedAt,
  });

  assert.equal(result.ready, false);
  assert.ok(
    result.reasons.includes(
      'requirement_not_applicable_not_allowed:US_COSMETICS_SAFETY_SUBSTANTIATION',
    ),
  );
  for (const code of [
    'US_COSMETICS_FACILITY_REGISTRATION',
    'US_COSMETICS_PRODUCT_LISTING',
    'US_COSMETICS_GMP_APPLICABILITY',
  ]) {
    assert.equal(
      result.requirements.find((requirement) => requirement.code === code)?.ready,
      true,
    );
  }
});

test('cosmetics fail closed when the requirement catalog review has expired', () => {
  const product = cosmeticsWithRequirements('US');
  for (const entry of [
    ...product.complianceDecisions,
    ...product.complianceEvidence,
  ]) {
    entry.requirement.reviewDueAt = new Date('2026-09-17T00:00:00.000Z');
  }

  const result = evaluateInternationalMarketCompliance({
    product,
    destinationCountry: 'US',
    evaluatedAt,
  });

  assert.equal(result.ready, false);
  assert.ok(
    result.reasons.some((reason) =>
      reason.startsWith('requirement_catalog_review_overdue:'),
    ),
  );
});

test('cosmetics markets without a configured rule set fail closed', () => {
  const result = evaluateInternationalMarketCompliance({
    product: cosmeticsWithRequirements('SG'),
    destinationCountry: 'SG',
    evaluatedAt,
  });

  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes('international_cosmetics_market_not_configured'));
});

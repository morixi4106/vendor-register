import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWithdrawalIdempotencyKey,
  evaluateWithdrawalEligibility,
  normalizeWithdrawalFormData,
} from '../../app/services/withdrawals.server.js';
import { WITHDRAWAL_ELIGIBILITY_STATUSES } from '../../app/utils/withdrawalStatus.js';

function daysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function createFormData(entries) {
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, item);
      }
    } else {
      params.set(key, value);
    }
  }
  return params;
}

test('normalizeWithdrawalFormData keeps required buyer and order fields', () => {
  const normalized = normalizeWithdrawalFormData(
    createFormData([
      ['customerName', ' Test Taro '],
      ['customerEmail', ' TEST@example.COM '],
      ['orderNumber', ' #1010 '],
      ['countryCode', 'fr'],
      ['receivedDate', daysAgo(1)],
    ]),
  );

  assert.equal(normalized.ok, true);
  assert.equal(normalized.values.customerName, 'Test Taro');
  assert.equal(normalized.values.customerEmail, 'test@example.com');
  assert.equal(normalized.values.orderNumber, '#1010');
  assert.equal(normalized.values.countryCode, 'FR');
  assert.equal(normalized.values.withdrawalScope, 'FULL');
});

test('normalizeWithdrawalFormData requires selected items for partial withdrawals', () => {
  const normalized = normalizeWithdrawalFormData(
    createFormData([
      ['customerName', 'Test Taro'],
      ['customerEmail', 'test@example.com'],
      ['orderNumber', '#1010'],
      ['countryCode', 'DE'],
      ['withdrawalScope', 'PARTIAL'],
    ]),
  );

  assert.equal(normalized.ok, false);
  assert.equal(Boolean(normalized.errors.itemText), true);
});

test('evaluateWithdrawalEligibility accepts matching EU requests within fourteen days', () => {
  const result = evaluateWithdrawalEligibility({
    values: {
      customerEmail: 'test@example.com',
      countryCode: 'FR',
      receivedDate: new Date(daysAgo(2)),
      itemCondition: '',
    },
    orderSnapshot: {
      buyerEmail: 'TEST@example.com',
      createdAt: daysAgo(2),
    },
  });

  assert.equal(result.status, WITHDRAWAL_ELIGIBILITY_STATUSES.ELIGIBLE);
  assert.equal(result.isEuCountry, true);
  assert.equal(result.orderFound, true);
  assert.equal(result.orderEmailMatched, true);
});

test('evaluateWithdrawalEligibility flags non-EU, expired, and used-item review cases', () => {
  const nonEu = evaluateWithdrawalEligibility({
    values: {
      customerEmail: 'test@example.com',
      countryCode: 'JP',
      receivedDate: new Date(daysAgo(2)),
    },
    orderSnapshot: { buyerEmail: 'test@example.com' },
  });
  const expired = evaluateWithdrawalEligibility({
    values: {
      customerEmail: 'test@example.com',
      countryCode: 'DE',
      receivedDate: new Date(daysAgo(20)),
    },
    orderSnapshot: { buyerEmail: 'test@example.com' },
  });
  const valueReduction = evaluateWithdrawalEligibility({
    values: {
      customerEmail: 'test@example.com',
      countryCode: 'DE',
      receivedDate: new Date(daysAgo(2)),
      itemCondition: 'used and dirty',
    },
    orderSnapshot: { buyerEmail: 'test@example.com' },
  });

  assert.equal(nonEu.status, WITHDRAWAL_ELIGIBILITY_STATUSES.NON_EU_REVIEW);
  assert.equal(expired.status, WITHDRAWAL_ELIGIBILITY_STATUSES.DEADLINE_EXPIRED);
  assert.equal(
    valueReduction.status,
    WITHDRAWAL_ELIGIBILITY_STATUSES.VALUE_REDUCTION_REVIEW,
  );
});

test('buildWithdrawalIdempotencyKey normalizes repeated submissions', () => {
  const first = buildWithdrawalIdempotencyKey({
    shopDomain: 'B30IZE-1A.MyShopify.com',
    orderNumber: ' #1010 ',
    email: ' TEST@example.COM ',
    withdrawalScope: 'partial',
    itemText: '  coat ',
    selectedLineItems: ['line-b', 'line-a'],
  });
  const second = buildWithdrawalIdempotencyKey({
    shopDomain: 'b30ize-1a.myshopify.com',
    orderNumber: '#1010',
    email: 'test@example.com',
    withdrawalScope: 'PARTIAL',
    itemText: 'coat',
    selectedLineItems: ['line-a', 'line-b'],
  });

  assert.equal(first, second);
});

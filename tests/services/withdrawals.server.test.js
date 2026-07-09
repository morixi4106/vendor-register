import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWithdrawalIdempotencyKey,
  createWithdrawalRequestFromForm,
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

function createMarketplaceOrder(overrides = {}) {
  const createdAt = new Date(daysAgo(2));

  return {
    id: 'marketplace_order_1',
    shopDomain: 'b30ize-1a.myshopify.com',
    shopifyOrderId: 'gid://shopify/Order/1010',
    shopifyOrderName: '#1010',
    shopifyOrderNumber: '1010',
    buyerEmail: 'test@example.com',
    buyerName: 'Test Taro',
    totalAmount: 1049,
    subtotalAmount: 179,
    shippingAmount: 870,
    discountAmount: 0,
    taxAmount: 16,
    currencyCode: 'JPY',
    financialStatus: 'paid',
    fulfillmentStatus: 'fulfilled',
    metadataJson: {
      shippingAddress: {
        countryCodeV2: 'DE',
      },
    },
    createdAt,
    updatedAt: createdAt,
    processedAt: createdAt,
    cancelledAt: null,
    ...overrides,
  };
}

function createFakeWithdrawalPrisma({ marketplaceOrder = createMarketplaceOrder() } = {}) {
  const state = {
    marketplaceOrder,
    withdrawalRequests: [],
    statusHistory: [],
    emailLogs: [],
  };

  const buildRequestWithRelations = (request) =>
    request
      ? {
          ...request,
          emailLogs: state.emailLogs
            .filter((log) => log.withdrawalRequestId === request.id)
            .slice()
            .reverse(),
          statusHistory: state.statusHistory
            .filter((history) => history.withdrawalRequestId === request.id)
            .slice()
            .reverse(),
        }
      : null;

  const prismaClient = {
    _state: state,
    marketplaceOrder: {
      async findFirst() {
        return state.marketplaceOrder;
      },
    },
    withdrawalRequest: {
      async count() {
        return 0;
      },
      async findUnique({ where }) {
        const request = state.withdrawalRequests.find((item) =>
          where.id
            ? item.id === where.id
            : item.idempotencyKey === where.idempotencyKey,
        );

        return buildRequestWithRelations(request);
      },
      async create({ data }) {
        const request = {
          id: `withdrawal_${state.withdrawalRequests.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        state.withdrawalRequests.push(request);
        return request;
      },
    },
    withdrawalRequestStatusHistory: {
      async create({ data }) {
        const history = {
          id: `history_${state.statusHistory.length + 1}`,
          createdAt: new Date(),
          ...data,
        };
        state.statusHistory.push(history);
        return history;
      },
    },
    withdrawalEmailLog: {
      async create({ data }) {
        const log = {
          id: `email_log_${state.emailLogs.length + 1}`,
          createdAt: new Date(),
          ...data,
        };
        state.emailLogs.push(log);
        return log;
      },
    },
    async $transaction(callback) {
      return callback(this);
    },
  };

  return prismaClient;
}

function createValidWithdrawalForm() {
  return createFormData([
    ['customerName', 'Test Taro'],
    ['customerEmail', 'test@example.com'],
    ['orderNumber', '#1010'],
    ['countryCode', 'DE'],
    ['receivedDate', daysAgo(2)],
    ['withdrawalScope', 'FULL'],
  ]);
}

async function withWithdrawalEmailEnvDisabled(callback) {
  const previous = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    WITHDRAWAL_FROM_EMAIL: process.env.WITHDRAWAL_FROM_EMAIL,
    MAIL_FROM: process.env.MAIL_FROM,
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
  };

  process.env.RESEND_API_KEY = '';
  process.env.WITHDRAWAL_FROM_EMAIL = '';
  process.env.MAIL_FROM = '';
  process.env.ADMIN_EMAIL = '';

  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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

test('createWithdrawalRequestFromForm stores a request and logs skipped email delivery', async () => {
  await withWithdrawalEmailEnvDisabled(async () => {
    const prismaClient = createFakeWithdrawalPrisma();
    const result = await createWithdrawalRequestFromForm({
      request: new Request('https://example.com/apps/vendors/withdrawal'),
      formData: createValidWithdrawalForm(),
      shopDomain: 'b30ize-1a.myshopify.com',
      prismaClient,
    });

    assert.equal(result.ok, true);
    assert.equal(result.duplicate, false);
    assert.equal(result.withdrawalRequest.customerEmail, 'test@example.com');
    assert.equal(result.withdrawalRequest.status, 'REQUESTED');
    assert.equal(
      result.withdrawalRequest.eligibilityStatus,
      WITHDRAWAL_ELIGIBILITY_STATUSES.ELIGIBLE,
    );
    assert.equal(result.emailResult.ok, false);
    assert.equal(result.emailResult.error, 'email_not_configured');
    assert.equal(prismaClient._state.withdrawalRequests.length, 1);
    assert.equal(prismaClient._state.statusHistory.length, 1);
    assert.equal(prismaClient._state.emailLogs.length, 1);
    assert.equal(prismaClient._state.emailLogs[0].status, 'failed');
  });
});

test('createWithdrawalRequestFromForm returns duplicate without creating another request', async () => {
  await withWithdrawalEmailEnvDisabled(async () => {
    const prismaClient = createFakeWithdrawalPrisma();
    const first = await createWithdrawalRequestFromForm({
      request: new Request('https://example.com/apps/vendors/withdrawal'),
      formData: createValidWithdrawalForm(),
      shopDomain: 'b30ize-1a.myshopify.com',
      prismaClient,
    });
    const second = await createWithdrawalRequestFromForm({
      request: new Request('https://example.com/apps/vendors/withdrawal'),
      formData: createValidWithdrawalForm(),
      shopDomain: 'b30ize-1a.myshopify.com',
      prismaClient,
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.withdrawalRequest.id, first.withdrawalRequest.id);
    assert.equal(prismaClient._state.withdrawalRequests.length, 1);
    assert.equal(prismaClient._state.statusHistory.length, 1);
    assert.equal(prismaClient._state.emailLogs.length, 2);
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWithdrawalIdempotencyKey,
  createWithdrawalRequestFromForm,
  evaluateWithdrawalEligibility,
  ensureWithdrawalReturnProofToken,
  findOrderForWithdrawal,
  findWithdrawalReturnProofRequest,
  getWithdrawalShopifyLiveOrderStatus,
  normalizeWithdrawalCompletionFormData,
  normalizeWithdrawalRefundDecisionFormData,
  normalizeWithdrawalReturnInfoFormData,
  normalizeWithdrawalFormData,
  sendWithdrawalVendorNotificationEmails,
  submitWithdrawalReturnProof,
  updateWithdrawalCompletionRecord,
  updateWithdrawalRefundDecision,
  updateWithdrawalReturnInfo,
} from '../../app/services/withdrawals.server.js';
import { WITHDRAWAL_ELIGIBILITY_STATUSES } from '../../app/utils/withdrawalStatus.js';

process.env.PRIVACY_HASH_SECRET = 'test-privacy-hash-secret-with-at-least-32-chars';

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

function createFakeWithdrawalPrisma({
  marketplaceOrder = createMarketplaceOrder(),
  sellerOrders = [],
  sellers = [],
} = {}) {
  const state = {
    marketplaceOrder,
    sellerOrders,
    sellers,
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
      async findFirst({ where }) {
        const request = state.withdrawalRequests.find((item) =>
          Object.entries(where || {}).every(([key, value]) => item[key] === value),
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
      async update({ where, data }) {
        const index = state.withdrawalRequests.findIndex(
          (item) => item.id === where.id,
        );

        if (index === -1) {
          throw new Error('withdrawal_not_found');
        }

        state.withdrawalRequests[index] = {
          ...state.withdrawalRequests[index],
          ...data,
          updatedAt: new Date(),
        };

        return state.withdrawalRequests[index];
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
      async findFirst({ where }) {
        return (
          state.emailLogs.find((log) =>
            Object.entries(where || {}).every(([key, value]) => log[key] === value),
          ) || null
        );
      },
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
    sellerOrder: {
      async findMany({ where }) {
        const conditions = Array.isArray(where?.OR) ? where.OR : [];

        if (conditions.length === 0) {
          return [];
        }

        return state.sellerOrders.filter((sellerOrder) =>
          conditions.some((condition) =>
            Object.entries(condition).every(
              ([key, value]) => sellerOrder[key] === value,
            ),
          ),
        );
      },
    },
    seller: {
      async findMany({ where }) {
        const conditions = Array.isArray(where?.OR) ? where.OR : [];

        if (conditions.length === 0) {
          return [];
        }

        return state.sellers.filter((seller) =>
          conditions.some((condition) =>
            Object.entries(condition).every(([key, value]) => {
              if (value && typeof value === 'object' && Array.isArray(value.in)) {
                return value.in.includes(seller[key]);
              }

              return seller[key] === value;
            }),
          ),
        );
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

test('normalizeWithdrawalFormData localizes length validation without truncating the phone value', () => {
  const longOrderNumber = `#${'1'.repeat(80)}`;
  const longPhone = `+44${'1'.repeat(39)}`;
  const normalized = normalizeWithdrawalFormData(
    createFormData([
      ['customerName', 'Test User'],
      ['customerEmail', 'test@example.com'],
      ['orderNumber', longOrderNumber],
      ['customerPhone', longPhone],
    ]),
    { locale: 'en-GB' },
  );

  assert.equal(normalized.ok, false);
  assert.equal(normalized.errors.orderNumber, 'The order number is too long.');
  assert.equal(
    normalized.errors.customerPhone,
    'The telephone number is too long.',
  );
  assert.equal(normalized.values.customerPhone, longPhone);
});

test('normalizeWithdrawalRefundDecisionFormData computes the planned refund total', () => {
  const normalized = normalizeWithdrawalRefundDecisionFormData(
    createFormData([
      ['refundDecisionStatus', 'partial_refund'],
      ['refundItemAmount', '1,000'],
      ['refundInitialShippingAmount', '870'],
      ['refundDeductionAmount', '300'],
      ['refundCurrencyCode', 'jpy'],
      ['returnShippingPayer', 'customer'],
    ]),
  );

  assert.equal(normalized.ok, true);
  assert.equal(normalized.values.refundDecisionStatus, 'PARTIAL_REFUND');
  assert.equal(normalized.values.refundItemAmount, 1000);
  assert.equal(normalized.values.refundInitialShippingAmount, 870);
  assert.equal(normalized.values.refundDeductionAmount, 300);
  assert.equal(normalized.values.refundTotalAmount, 1570);
  assert.equal(normalized.values.refundCurrencyCode, 'JPY');
  assert.equal(normalized.values.returnShippingPayer, 'CUSTOMER');
});

test('normalizeWithdrawalRefundDecisionFormData rejects invalid amounts', () => {
  const normalized = normalizeWithdrawalRefundDecisionFormData(
    createFormData([
      ['refundDecisionStatus', 'FULL_REFUND'],
      ['refundItemAmount', '-1'],
    ]),
  );

  assert.equal(normalized.ok, false);
  assert.equal(normalized.errors.refundItemAmount, 'invalid_amount');
});

test('normalizeWithdrawalRefundDecisionFormData parses decimal currencies as minor units', () => {
  const normalized = normalizeWithdrawalRefundDecisionFormData(
    createFormData([
      ['refundDecisionStatus', 'PARTIAL_REFUND'],
      ['refundItemAmount', '10.99'],
      ['refundInitialShippingAmount', '2.50'],
      ['refundDeductionAmount', '1.25'],
      ['refundCurrencyCode', 'eur'],
    ]),
  );

  assert.equal(normalized.ok, true);
  assert.equal(normalized.values.refundItemAmount, 1099);
  assert.equal(normalized.values.refundInitialShippingAmount, 250);
  assert.equal(normalized.values.refundDeductionAmount, 125);
  assert.equal(normalized.values.refundTotalAmount, 1224);
  assert.equal(normalized.values.refundCurrencyCode, 'EUR');
});

test('normalizeWithdrawalCompletionFormData keeps completion result fields', () => {
  const normalized = normalizeWithdrawalCompletionFormData(
    createFormData([
      ['completionStatus', 'refunded'],
      ['completionAction', 'Refunded from Shopify admin'],
      ['completionRefundedAmount', '1,049'],
      ['completionRefundedShipping', '870'],
      ['completionCurrencyCode', 'jpy'],
      ['completionShopifyRefundId', 'gid://shopify/Refund/1'],
    ]),
  );

  assert.equal(normalized.ok, true);
  assert.equal(normalized.values.completionStatus, 'REFUNDED');
  assert.equal(normalized.values.completionRefundedAmount, 1049);
  assert.equal(normalized.values.completionRefundedShipping, 870);
  assert.equal(normalized.values.completionCurrencyCode, 'JPY');
  assert.equal(
    normalized.values.completionShopifyRefundId,
    'gid://shopify/Refund/1',
  );
});

test('normalizeWithdrawalCompletionFormData requires amount for refund completion', () => {
  const normalized = normalizeWithdrawalCompletionFormData(
    createFormData([['completionStatus', 'REFUNDED']]),
  );

  assert.equal(normalized.ok, false);
  assert.equal(
    normalized.errors.completionRefundedAmount,
    'required_for_refunded_completion',
  );
});

test('normalizeWithdrawalReturnInfoFormData keeps return tracking and condition fields', () => {
  const normalized = normalizeWithdrawalReturnInfoFormData(
    createFormData([
      ['returnRequirementStatus', 'received'],
      ['returnTrackingCompany', 'Japan Post'],
      ['returnTrackingNumber', ' TEST123456789JP '],
      ['returnTrackingUrl', ' https://track.example.com/TEST123456789JP '],
      ['returnReceivedAt', '2026-07-09'],
      ['returnConditionStatus', 'dirty_review'],
      ['returnConditionNotes', 'small stain near sleeve'],
    ]),
  );

  assert.equal(normalized.ok, true);
  assert.equal(normalized.values.returnRequirementStatus, 'RECEIVED');
  assert.equal(normalized.values.returnTrackingCompany, 'Japan Post');
  assert.equal(normalized.values.returnTrackingNumber, 'TEST123456789JP');
  assert.equal(normalized.values.returnConditionStatus, 'DIRTY_REVIEW');
  assert.equal(normalized.values.returnProofJson.trackingNumber, 'TEST123456789JP');
});

test('normalizeWithdrawalReturnInfoFormData rejects invalid return statuses', () => {
  const normalized = normalizeWithdrawalReturnInfoFormData(
    createFormData([
      ['returnRequirementStatus', 'lost'],
      ['returnConditionStatus', 'unknown'],
    ]),
  );

  assert.equal(normalized.ok, false);
  assert.equal(
    normalized.errors.returnRequirementStatus,
    'invalid_return_requirement_status',
  );
  assert.equal(
    normalized.errors.returnConditionStatus,
    'invalid_return_condition_status',
  );
});

test('normalizeWithdrawalReturnInfoFormData rejects invalid tracking URLs', () => {
  const normalized = normalizeWithdrawalReturnInfoFormData(
    createFormData([
      ['returnRequirementStatus', 'in_transit'],
      ['returnConditionStatus', 'unused_ok'],
      ['returnTrackingUrl', 'javascript:alert(1)'],
    ]),
  );

  assert.equal(normalized.ok, false);
  assert.equal(normalized.errors.returnTrackingUrl, 'invalid_return_tracking_url');
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

test('evaluateWithdrawalEligibility does not expire requests from order date alone', () => {
  const result = evaluateWithdrawalEligibility({
    values: {
      customerEmail: 'test@example.com',
      countryCode: 'DE',
      receivedDate: null,
    },
    orderSnapshot: {
      buyerEmail: 'test@example.com',
      createdAt: daysAgo(30),
      processedAt: daysAgo(30),
    },
  });

  assert.equal(result.status, WITHDRAWAL_ELIGIBILITY_STATUSES.DEADLINE_REVIEW);
  assert.equal(result.deadlineAt, null);
});

test('evaluateWithdrawalEligibility flags exempt item candidates and already refunded orders for review', () => {
  const exempt = evaluateWithdrawalEligibility({
    values: {
      customerEmail: 'test@example.com',
      countryCode: 'DE',
      receivedDate: new Date(daysAgo(2)),
      itemText: 'custom made hygiene item',
      itemCondition: '',
    },
    orderSnapshot: { buyerEmail: 'test@example.com', lineItems: [] },
  });
  const refunded = evaluateWithdrawalEligibility({
    values: {
      customerEmail: 'test@example.com',
      countryCode: 'DE',
      receivedDate: new Date(daysAgo(2)),
      itemCondition: '',
    },
    orderSnapshot: {
      buyerEmail: 'test@example.com',
      financialStatus: 'REFUNDED',
      totalRefundedAmount: 1000,
    },
  });

  assert.equal(exempt.status, WITHDRAWAL_ELIGIBILITY_STATUSES.EXEMPTION_REVIEW);
  assert.equal(refunded.status, WITHDRAWAL_ELIGIBILITY_STATUSES.PENDING_REVIEW);
  assert.match(refunded.warnings.join(' '), /返金済み/);
});

test('findOrderForWithdrawal falls back to Shopify Admin lookup when local snapshot is missing', async () => {
  const prismaClient = createFakeWithdrawalPrisma({ marketplaceOrder: null });
  const result = await findOrderForWithdrawal({
    prismaClient,
    shopDomain: 'b30ize-1a.myshopify.com',
    orderNumber: '#1010',
    customerEmail: 'test@example.com',
    shopifyGraphQLWithOfflineSessionImpl: async ({ variables }) => {
      assert.match(variables.query, /#1010/);
      return {
        data: {
          orders: {
            nodes: [
              {
                id: 'gid://shopify/Order/1010',
                name: '#1010',
                email: 'test@example.com',
                createdAt: new Date().toISOString(),
                processedAt: new Date().toISOString(),
                displayFinancialStatus: 'PAID',
                displayFulfillmentStatus: 'FULFILLED',
                currentTotalPriceSet: {
                  shopMoney: { amount: '10.99', currencyCode: 'EUR' },
                },
                lineItems: {
                  nodes: [
                    {
                      id: 'gid://shopify/LineItem/1',
                      title: 'Test item',
                      quantity: 2,
                      discountedTotalSet: {
                        shopMoney: { amount: '10.99', currencyCode: 'EUR' },
                      },
                    },
                  ],
                },
                shippingAddress: {
                  countryCodeV2: 'DE',
                },
              },
            ],
          },
        },
      };
    },
  });

  assert.equal(result.source, 'shopify_admin');
  assert.equal(result.orderSnapshot.totalAmount, 1099);
  assert.equal(result.orderSnapshot.lineItems[0].quantity, 2);
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

test('email mismatch is recorded but does not start seller return processing', async () => {
  await withWithdrawalEmailEnvDisabled(async () => {
    const prismaClient = createFakeWithdrawalPrisma({
      sellerOrders: [
        {
          id: 'seller_order_1',
          marketplaceOrderId: 'marketplace_order_1',
          shopifyOrderId: 'gid://shopify/Order/1010',
          sellerId: 'seller_1',
          vendorStoreId: 'store_1',
          lines: [{ id: 'line_1', title: 'Test Product' }],
        },
      ],
      sellers: [
        {
          id: 'seller_1',
          vendorId: 'vendor_1',
          vendorStoreId: 'store_1',
          vendor: { managementEmail: 'vendor@example.com' },
          vendorStore: { email: 'store@example.com' },
        },
      ],
    });
    const formData = createValidWithdrawalForm();
    formData.set('customerEmail', 'different@example.com');

    const result = await createWithdrawalRequestFromForm({
      request: new Request('https://example.com/apps/vendors/withdrawal'),
      formData,
      shopDomain: 'b30ize-1a.myshopify.com',
      prismaClient,
    });

    assert.equal(result.ok, true);
    assert.equal(result.identityReviewRequired, true);
    assert.equal(
      result.withdrawalRequest.eligibilityStatus,
      WITHDRAWAL_ELIGIBILITY_STATUSES.EMAIL_MISMATCH_REVIEW,
    );
    assert.equal(result.withdrawalRequest.progressStatus, 'REVIEW_REQUIRED');
    assert.equal(result.directReturnResult.reason, 'identity_review_required');
    assert.equal(result.vendorNotificationResult.reason, 'identity_review_required');
    assert.equal(
      prismaClient._state.emailLogs.some((log) => log.emailType === 'vendor_notification'),
      false,
    );
    assert.ok(result.receiptToken);
    assert.notEqual(result.withdrawalRequest.receiptTokenHash, result.receiptToken);
  });
});

test('createWithdrawalRequestFromForm records vendor notification attempts for affected sellers', async () => {
  await withWithdrawalEmailEnvDisabled(async () => {
    const prismaClient = createFakeWithdrawalPrisma({
      sellerOrders: [
        {
          id: 'seller_order_1',
          marketplaceOrderId: 'marketplace_order_1',
          shopifyOrderId: 'gid://shopify/Order/1010',
          sellerId: 'seller_1',
          vendorStoreId: 'store_1',
          lines: [
            {
              id: 'line_1',
              title: 'Test Product',
              shopifyLineItemId: 'gid://shopify/LineItem/1',
            },
          ],
        },
      ],
      sellers: [
        {
          id: 'seller_1',
          vendorId: 'vendor_1',
          vendorStoreId: 'store_1',
          vendor: {
            id: 'vendor_1',
            storeName: 'Vendor Store',
            managementEmail: 'vendor@example.com',
          },
          vendorStore: {
            id: 'store_1',
            storeName: 'Vendor Store',
            email: 'store@example.com',
          },
        },
      ],
    });
    const result = await createWithdrawalRequestFromForm({
      request: new Request('https://example.com/apps/vendors/withdrawal'),
      formData: createValidWithdrawalForm(),
      shopDomain: 'b30ize-1a.myshopify.com',
      prismaClient,
    });
    const vendorLog = prismaClient._state.emailLogs.find(
      (log) => log.emailType === 'vendor_notification',
    );

    assert.equal(result.ok, true);
    assert.equal(result.vendorNotificationResult.failedCount, 1);
    assert.equal(vendorLog.toEmail, 'vendor@example.com');
    assert.match(vendorLog.bodyText, /Test Product/);
  });
});

test('sendWithdrawalVendorNotificationEmails skips vendors already notified', async () => {
  await withWithdrawalEmailEnvDisabled(async () => {
    const prismaClient = createFakeWithdrawalPrisma({
      sellerOrders: [
        {
          id: 'seller_order_1',
          marketplaceOrderId: 'marketplace_order_1',
          shopifyOrderId: 'gid://shopify/Order/1010',
          sellerId: 'seller_1',
          vendorStoreId: 'store_1',
          lines: [],
        },
      ],
      sellers: [
        {
          id: 'seller_1',
          vendorId: 'vendor_1',
          vendorStoreId: 'store_1',
          vendor: {
            id: 'vendor_1',
            storeName: 'Vendor Store',
            managementEmail: 'vendor@example.com',
          },
          vendorStore: {
            id: 'store_1',
            storeName: 'Vendor Store',
            email: 'store@example.com',
          },
        },
      ],
    });
    const created = await createWithdrawalRequestFromForm({
      request: new Request('https://example.com/apps/vendors/withdrawal'),
      formData: createValidWithdrawalForm(),
      shopDomain: 'b30ize-1a.myshopify.com',
      prismaClient,
    });

    prismaClient._state.emailLogs = prismaClient._state.emailLogs.map((log) =>
      log.emailType === 'vendor_notification'
        ? { ...log, status: 'sent', sentAt: new Date() }
        : log,
    );

    const result = await sendWithdrawalVendorNotificationEmails({
      withdrawalRequestId: created.withdrawalRequest.id,
      prismaClient,
    });

    assert.equal(result.ok, true);
    assert.equal(result.skippedCount, 1);
    assert.equal(
      prismaClient._state.emailLogs.filter(
        (log) => log.emailType === 'vendor_notification',
      ).length,
      1,
    );
  });
});

test('updateWithdrawalRefundDecision stores admin refund judgement and history', async () => {
  await withWithdrawalEmailEnvDisabled(async () => {
    const prismaClient = createFakeWithdrawalPrisma();
    const created = await createWithdrawalRequestFromForm({
      request: new Request('https://example.com/apps/vendors/withdrawal'),
      formData: createValidWithdrawalForm(),
      shopDomain: 'b30ize-1a.myshopify.com',
      prismaClient,
    });

    const result = await updateWithdrawalRefundDecision({
      id: created.withdrawalRequest.id,
      formData: createFormData([
        ['refundDecisionStatus', 'PARTIAL_REFUND'],
        ['refundItemAmount', '179'],
        ['refundInitialShippingAmount', '870'],
        ['refundDeductionAmount', '100'],
        ['refundCurrencyCode', 'JPY'],
        ['returnShippingPayer', 'CUSTOMER'],
        ['refundDecisionReason', 'item condition checked'],
      ]),
      prismaClient,
    });

    assert.equal(result.ok, true);
    assert.equal(result.withdrawalRequest.refundDecisionStatus, 'PARTIAL_REFUND');
    assert.equal(result.withdrawalRequest.refundTotalAmount, 949);
    assert.equal(result.withdrawalRequest.returnShippingPayer, 'CUSTOMER');
    assert.equal(result.withdrawalRequest.refundDecisionReason, 'item condition checked');
    assert.equal(prismaClient._state.statusHistory.length, 2);
    assert.equal(
      prismaClient._state.statusHistory[1].reason,
      'refund_decision_updated',
    );
  });
});

test('updateWithdrawalCompletionRecord closes a refunded request and records history', async () => {
  await withWithdrawalEmailEnvDisabled(async () => {
    const prismaClient = createFakeWithdrawalPrisma();
    const created = await createWithdrawalRequestFromForm({
      request: new Request('https://example.com/apps/vendors/withdrawal'),
      formData: createValidWithdrawalForm(),
      shopDomain: 'b30ize-1a.myshopify.com',
      prismaClient,
    });

    const result = await updateWithdrawalCompletionRecord({
      id: created.withdrawalRequest.id,
      formData: createFormData([
        ['completionStatus', 'REFUNDED'],
        ['completionAction', 'Refunded manually'],
        ['completionRefundedAmount', '1049'],
        ['completionRefundedShipping', '870'],
        ['completionCurrencyCode', 'JPY'],
      ]),
      changedBy: 'admin@example.com',
      prismaClient,
    });

    assert.equal(result.ok, true);
    assert.equal(result.withdrawalRequest.status, 'REFUNDED');
    assert.equal(result.withdrawalRequest.completionStatus, 'REFUNDED');
    assert.equal(result.withdrawalRequest.completionRefundedAmount, 1049);
    assert.equal(result.withdrawalRequest.completionRecordedBy, 'admin@example.com');
    assert.ok(result.withdrawalRequest.completedAt instanceof Date);
    assert.equal(prismaClient._state.statusHistory.length, 2);
    assert.equal(
      prismaClient._state.statusHistory[1].reason,
      'completion_recorded',
    );
  });
});

test('updateWithdrawalCompletionRecord does not reset a completed request to undecided', async () => {
  await withWithdrawalEmailEnvDisabled(async () => {
    const prismaClient = createFakeWithdrawalPrisma();
    const created = await createWithdrawalRequestFromForm({
      request: new Request('https://example.com/apps/vendors/withdrawal'),
      formData: createValidWithdrawalForm(),
      shopDomain: 'b30ize-1a.myshopify.com',
      prismaClient,
    });

    await updateWithdrawalCompletionRecord({
      id: created.withdrawalRequest.id,
      formData: createFormData([
        ['completionStatus', 'REFUNDED'],
        ['completionRefundedAmount', '1049'],
        ['completionCurrencyCode', 'JPY'],
      ]),
      prismaClient,
    });

    const reset = await updateWithdrawalCompletionRecord({
      id: created.withdrawalRequest.id,
      formData: createFormData([['completionStatus', 'UNDECIDED']]),
      prismaClient,
    });

    assert.equal(reset.ok, false);
    assert.equal(reset.error, 'completion_reset_not_allowed');
  });
});

test('updateWithdrawalReturnInfo stores return proof and history', async () => {
  await withWithdrawalEmailEnvDisabled(async () => {
    const prismaClient = createFakeWithdrawalPrisma();
    const created = await createWithdrawalRequestFromForm({
      request: new Request('https://example.com/apps/vendors/withdrawal'),
      formData: createValidWithdrawalForm(),
      shopDomain: 'b30ize-1a.myshopify.com',
      prismaClient,
    });

    const result = await updateWithdrawalReturnInfo({
      id: created.withdrawalRequest.id,
      formData: createFormData([
        ['returnRequirementStatus', 'CONDITION_CHECKED'],
        ['returnTrackingCompany', 'Japan Post'],
        ['returnTrackingNumber', 'TEST123456789JP'],
        ['returnTrackingUrl', 'https://track.example.com/TEST123456789JP'],
        ['returnReceivedAt', '2026-07-09'],
        ['returnConditionStatus', 'DAMAGED_REVIEW'],
        ['returnConditionNotes', 'box damaged'],
      ]),
      prismaClient,
    });

    assert.equal(result.ok, true);
    assert.equal(result.withdrawalRequest.returnRequirementStatus, 'CONDITION_CHECKED');
    assert.equal(result.withdrawalRequest.returnConditionStatus, 'DAMAGED_REVIEW');
    assert.equal(result.withdrawalRequest.returnProofJson.trackingNumber, 'TEST123456789JP');
    assert.equal(prismaClient._state.statusHistory.length, 2);
    assert.equal(
      prismaClient._state.statusHistory[1].reason,
      'return_info_updated',
    );
  });
});

test('return proof token lookup accepts only the generated token', async () => {
  await withWithdrawalEmailEnvDisabled(async () => {
    const prismaClient = createFakeWithdrawalPrisma();
    const created = await createWithdrawalRequestFromForm({
      request: new Request('https://example.com/apps/vendors/withdrawal'),
      formData: createValidWithdrawalForm(),
      shopDomain: 'b30ize-1a.myshopify.com',
      prismaClient,
    });

    const tokenResult = await ensureWithdrawalReturnProofToken({
      withdrawalRequestId: created.withdrawalRequest.id,
      request: new Request('https://example.com/app/withdrawals/withdrawal_1'),
      prismaClient,
    });

    assert.equal(tokenResult.ok, true);
    assert.equal(tokenResult.url.includes('/apps/vendors/withdrawal/return-proof'), true);
    assert.equal(tokenResult.url.includes(tokenResult.token), true);
    assert.notEqual(
      prismaClient._state.withdrawalRequests[0].returnProofTokenHash,
      tokenResult.token,
    );

    const validLookup = await findWithdrawalReturnProofRequest({
      requestId: created.withdrawalRequest.id,
      token: tokenResult.token,
      prismaClient,
    });
    const invalidLookup = await findWithdrawalReturnProofRequest({
      requestId: created.withdrawalRequest.id,
      token: 'wrong-token',
      prismaClient,
    });

    assert.equal(validLookup.ok, true);
    assert.equal(validLookup.withdrawalRequest.id, created.withdrawalRequest.id);
    assert.equal(invalidLookup.ok, false);
    assert.equal(invalidLookup.error, 'invalid_return_proof_link');
  });
});

test('submitWithdrawalReturnProof stores customer tracking proof and history', async () => {
  await withWithdrawalEmailEnvDisabled(async () => {
    const prismaClient = createFakeWithdrawalPrisma();
    const created = await createWithdrawalRequestFromForm({
      request: new Request('https://example.com/apps/vendors/withdrawal'),
      formData: createValidWithdrawalForm(),
      shopDomain: 'b30ize-1a.myshopify.com',
      prismaClient,
    });
    const tokenResult = await ensureWithdrawalReturnProofToken({
      withdrawalRequestId: created.withdrawalRequest.id,
      request: new Request('https://example.com/app/withdrawals/withdrawal_1'),
      prismaClient,
    });

    const invalid = await submitWithdrawalReturnProof({
      requestId: created.withdrawalRequest.id,
      token: tokenResult.token,
      formData: createFormData([['returnTrackingCompany', 'Japan Post']]),
      request: new Request('https://example.com/apps/vendors/withdrawal/return-proof'),
      prismaClient,
    });

    assert.equal(invalid.ok, false);
    assert.equal(invalid.errors.returnTrackingNumber, 'tracking_required');

    const result = await submitWithdrawalReturnProof({
      requestId: created.withdrawalRequest.id,
      token: tokenResult.token,
      formData: createFormData([
        ['returnTrackingCompany', 'Japan Post'],
        ['returnTrackingNumber', 'TEST123456789JP'],
        ['returnTrackingUrl', 'https://track.example.com/TEST123456789JP'],
        ['customerMemo', 'Shipped today'],
      ]),
      request: new Request('https://example.com/apps/vendors/withdrawal/return-proof', {
        headers: {
          'user-agent': 'node-test',
        },
      }),
      prismaClient,
    });

    assert.equal(result.ok, true);
    assert.equal(result.withdrawalRequest.returnRequirementStatus, 'IN_TRANSIT');
    assert.equal(result.withdrawalRequest.returnTrackingCompany, 'Japan Post');
    assert.equal(result.withdrawalRequest.returnTrackingNumber, 'TEST123456789JP');
    assert.equal(result.withdrawalRequest.returnProofSubmittedAt instanceof Date, true);
    assert.equal(result.withdrawalRequest.returnProofJson.customerMemo, 'Shipped today');
    assert.equal(prismaClient._state.statusHistory.at(-1).reason, 'return_proof_submitted');
  });
});

test('getWithdrawalShopifyLiveOrderStatus returns normalized live Shopify order data', async () => {
  const calls = [];
  const result = await getWithdrawalShopifyLiveOrderStatus({
    withdrawalRequest: {
      shopDomain: 'b30ize-1a.myshopify.com',
      shopifyOrderId: '6923324588195',
    },
    shopifyGraphQLWithOfflineSessionImpl: async (input) => {
      calls.push(input);
      return {
        shopDomain: input.shopDomain,
        data: {
          node: {
            id: input.variables.id,
            name: '#1010',
            email: 'buyer@example.com',
            createdAt: '2026-06-20T00:00:00Z',
            processedAt: '2026-06-20T00:01:00Z',
            cancelledAt: null,
            cancelReason: null,
            displayFinancialStatus: 'PAID',
            displayFulfillmentStatus: 'UNFULFILLED',
            totalPriceSet: {
              shopMoney: { amount: '1114.00', currencyCode: 'JPY' },
            },
            currentTotalPriceSet: {
              shopMoney: { amount: '1114.00', currencyCode: 'JPY' },
            },
            totalRefundedSet: {
              shopMoney: { amount: '0.00', currencyCode: 'JPY' },
            },
          },
        },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].variables.id, 'gid://shopify/Order/6923324588195');
  assert.equal(result.order.name, '#1010');
  assert.equal(result.order.financialStatus, 'PAID');
  assert.equal(result.order.totalAmount, 1114);
  assert.equal(result.order.currencyCode, 'JPY');
});

test('getWithdrawalShopifyLiveOrderStatus safely reports missing order context', async () => {
  const result = await getWithdrawalShopifyLiveOrderStatus({
    withdrawalRequest: {
      shopDomain: 'b30ize-1a.myshopify.com',
    },
    shopifyGraphQLWithOfflineSessionImpl: async () => {
      throw new Error('should not call Shopify');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_shopify_order_id');
});

test('getWithdrawalShopifyLiveOrderStatus sanitizes Shopify read failures', async () => {
  const result = await getWithdrawalShopifyLiveOrderStatus({
    withdrawalRequest: {
      shopDomain: 'b30ize-1a.myshopify.com',
      shopifyOrderId: 'gid://shopify/Order/6923324588195',
    },
    shopifyGraphQLWithOfflineSessionImpl: async () => {
      throw new Error('Shopify GraphQL errors: [{"message":"Field does not exist"}]');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'shopify_graphql_error');
});

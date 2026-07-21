import assert from "node:assert/strict";
import test from "node:test";

import {
  approvePayoutRun,
  backfillSellerOrderShadowChecks,
  buildMarketplaceOrderSnapshot,
  calculateSellerPayoutableLedgerBalance,
  calculateSellerSalesCreditAvailability,
  authorizeSalesCreditOffset,
  captureSalesCreditOffset,
  createCheckoutOrder,
  createCheckoutOrderPaymentIntent,
  createConnectedAccountPayout,
  createOrderRefund,
  createPayoutRun,
  createSellerAccountSession,
  createSellerStripeAccount,
  executePayoutRun,
  executeWisePayoutRun,
  handleStripeWebhook,
  inferShopifyOrderSalesCreditPaymentRisk,
  listSellerLedgerRepairCandidates,
  markPayoutRunManuallyPaid,
  processShopifyDisputeSettlement,
  processShopifyOrderCancelledSettlement,
  processShopifyOrderPaidSettlement,
  processShopifyRefundSettlement,
  releaseSalesCreditOffset,
  repairSellerNegativeLedgerBalance,
  reverseSalesCreditOffsetForRefund,
  resetSellerStripeAccountForRecreate,
  SALES_CREDIT_PAYMENT_RISK_CLASSES,
  syncWisePayoutRunStatus,
} from "../../app/services/sellerPayments.server.js";

process.env.MARKETPLACE_SETTLEMENT_ACTIONS_ENABLED = "true";
process.env.DOMESTIC_SELLER_SETTLEMENT_ENABLED = "true";
process.env.CROSS_BORDER_SELLER_SETTLEMENT_ENABLED = "false";
process.env.SHOPIFY_MARKETPLACE_PAYMENTS_WRITTEN_APPROVAL_CONFIRMED = "true";
process.env.SHOPIFY_MARKETPLACE_PAYMENTS_WRITTEN_APPROVAL_REFERENCE =
  "unit-test-approval";

test("buildMarketplaceOrderSnapshot preserves Carrier Service Air Packet rate provenance", () => {
  const snapshot = buildMarketplaceOrderSnapshot({
    payload: {
      id: 1001,
      order_number: 1001,
      total_price: "2500",
      subtotal_price: "1620",
      total_discounts: "0",
      total_tax: "0",
      shipping_lines: [
        {
          code: "shipping_v2_jp_air_packet_2026_06_01",
          price: "880",
        },
      ],
      line_items: [],
    },
    shopDomain: "example.myshopify.com",
    shopifyOrderId: "gid://shopify/Order/1001",
    shopifyOrderName: "#1001",
    currencyCode: "jpy",
  });

  assert.deepEqual(snapshot.metadataJson.shippingRateSnapshot, {
    source: "japan_post_air_packet",
    rateVersion: "2026-06-01",
    currencyCode: "jpy",
    chargedAmount: 880,
    serviceCodes: ["shipping_v2_jp_air_packet_2026_06_01"],
    lineCount: 1,
    snapshotSource: "shopify_shipping_lines",
  });
});

test("buildMarketplaceOrderSnapshot restores encoded Carrier Service zone and bands", () => {
  const snapshot = buildMarketplaceOrderSnapshot({
    payload: {
      id: 1002,
      order_number: 1002,
      total_price: "6920",
      subtotal_price: "880",

      total_discounts: "0",
      total_tax: "0",
      shipping_lines: [
        {
          code: "shipping_v2_jp_air_packet_2026_06_01_z3_b1x1.8x2",
          price: "6040",
        },
      ],
      line_items: [],
    },
    shopDomain: "example.myshopify.com",
    shopifyOrderId: "gid://shopify/Order/1002",
    shopifyOrderName: "#1002",
    currencyCode: "jpy",
  });

  assert.equal(snapshot.metadataJson.shippingRateSnapshot.zone, 3);
  assert.deepEqual(snapshot.metadataJson.shippingRateSnapshot.weightBands, [
    { weightBandGrams: 100, quantity: 1 },
    { weightBandGrams: 800, quantity: 2 },
  ]);
  assert.equal(snapshot.metadataJson.shippingRateSnapshot.chargedAmount, 6040);
  assert.equal(
    snapshot.metadataJson.shippingRateSnapshot.rateVersion,
    "2026-06-01",
  );
});

const TRUSTED_SALES_CREDIT_METADATA = {
  salesCreditPaymentRiskClass:
    SALES_CREDIT_PAYMENT_RISK_CLASSES.CARD_3DS_AUTHENTICATED,
  salesCreditPaymentRiskRateBps: 10000,
};

function assertShopifyProductLookupWhere(
  where,
  { shopDomain, productIds = [], variantIds = [] },
) {
  const referenceClauses = where?.AND?.[0]?.OR || [];
  const productClause = referenceClauses.find(
    (clause) => clause.shopifyProductId,
  );
  const variantClause = referenceClauses.find(
    (clause) => clause.shopifyVariantId,
  );

  if (productIds.length > 0) {
    assert.deepEqual(productClause?.shopifyProductId?.in, productIds);
  } else {
    assert.equal(productClause, undefined);
  }

  if (variantIds.length > 0) {
    assert.deepEqual(variantClause?.shopifyVariantId?.in, variantIds);
  } else {
    assert.equal(variantClause, undefined);
  }

  assert.deepEqual(where?.AND?.[1]?.OR, [
    { shopDomain },
    { shopDomain: null },
  ]);
}

function createSellerOrderShadowFakeModels(state) {
  return {
    ...(state.checkoutEvidenceByReference
      ? {
          marketplaceCheckoutEvidence: {
            async findUnique({ where }) {
              return (
                state.checkoutEvidenceByReference.get(
                  where.checkoutReference,
                ) || null
              );
            },
            async update({ where, data }) {
              const current = Array.from(
                state.checkoutEvidenceByReference.values(),
              ).find((entry) => entry.id === where.id);
              const updated = { ...current, ...data };
              state.checkoutEvidenceByReference.set(
                updated.checkoutReference,
                updated,
              );
              return updated;
            },
          },
        }
      : {}),
    marketplaceOrder: {
      async upsert({ where, create, update }) {
        const key = `${where.shopDomain_shopifyOrderId.shopDomain}:${where.shopDomain_shopifyOrderId.shopifyOrderId}`;
        const existing = state.marketplaceOrders.get(key);
        const record = existing
          ? { ...existing, ...update }
          : { id: `mo_${state.marketplaceOrders.size + 1}`, ...create };

        state.marketplaceOrders.set(key, record);
        return record;
      },
    },
    sellerOrder: {
      async upsert({ where, create, update }) {
        const key = `${where.marketplaceOrderId_sellerId.marketplaceOrderId}:${where.marketplaceOrderId_sellerId.sellerId}`;
        const existing = state.sellerOrders.get(key);
        const record = existing
          ? { ...existing, ...update }
          : { id: `so_${state.sellerOrders.size + 1}`, ...create };

        state.sellerOrders.set(key, record);
        return record;
      },
    },
    sellerOrderLine: {
      async upsert({ where, create, update }) {
        const key = `${where.sellerOrderId_shopifyLineItemId.sellerOrderId}:${where.sellerOrderId_shopifyLineItemId.shopifyLineItemId}`;
        const existing = state.sellerOrderLines.get(key);
        const record = existing
          ? { ...existing, ...update }
          : { id: `sol_${state.sellerOrderLines.size + 1}`, ...create };

        state.sellerOrderLines.set(key, record);
        return record;
      },
    },
    sellerOrderShadowCheck: {
      async findFirst({ where }) {
        return (
          state.sellerOrderShadowChecks.find((check) => {
            if (where?.shopDomain && check.shopDomain !== where.shopDomain) {
              return false;
            }

            if (where?.shopifyOrderId && check.shopifyOrderId !== where.shopifyOrderId) {
              return false;
            }

            return true;
          }) || null
        );
      },
      async create({ data }) {
        const record = {
          id: `sosc_${state.sellerOrderShadowChecks.length + 1}`,
          ...data,
        };

        state.sellerOrderShadowChecks.push(record);
        return record;
      },
    },
  };
}

test("createSellerStripeAccount creates a connected account with manual payouts and no hosted dashboard", async () => {
  const stripeCalls = {
    accountsCreate: [],
    balanceSettingsUpdate: [],
  };

  const fakeStripe = {
    accounts: {
      async create(params) {
        stripeCalls.accountsCreate.push(params);
        return {
          id: "acct_123",
          country: "JP",
          default_currency: "jpy",
          details_submitted: false,
          charges_enabled: false,
          payouts_enabled: false,
          requirements: {
            currently_due: ["business_profile.url"],
          },
        };
      },
    },
    balanceSettings: {
      async update(params, options) {
        stripeCalls.balanceSettingsUpdate.push({ params, options });
      },
    },
  };

  let savedStripeAccountData = null;
  const fakePrisma = {
    seller: {
      async findUnique() {
        return {
          id: "seller_1",
          vendorId: "vendor_1",
          vendorStoreId: "store_1",
          vendor: {
            id: "vendor_1",
            handle: "amber-cellar",
            storeName: "Amber Cellar",
            managementEmail: "owner@example.com",
            vendorStore: {
              id: "store_1",
              country: "Japan",
            },
          },
          stripeAccount: null,
        };
      },
    },
    sellerStripeAccount: {
      async create({ data }) {
        savedStripeAccountData = data;
        return {
          id: "ssa_1",
          ...data,
          createdAt: new Date("2026-05-01T00:00:00Z"),
          updatedAt: new Date("2026-05-01T00:00:00Z"),
        };
      },
    },
  };

  const result = await createSellerStripeAccount(
    { sellerId: "seller_1" },
    {
      prismaClient: fakePrisma,
      stripeClient: fakeStripe,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.stripeAccount.stripeAccountId, "acct_123");
  assert.equal(savedStripeAccountData.dashboardType, "none");
  assert.equal(savedStripeAccountData.payoutSchedule, "manual");
  assert.deepEqual(stripeCalls.accountsCreate[0], {
    country: "JP",
    email: "owner@example.com",
    business_profile: {
      name: "Amber Cellar",
    },
    controller: {
      fees: {
        payer: "account",
      },
      losses: {
        payments: "stripe",
      },
      requirement_collection: "stripe",
      stripe_dashboard: {
        type: "none",
      },
    },
    capabilities: {
      card_payments: {
        requested: true,
      },
      transfers: {
        requested: true,
      },
    },
    metadata: {
      sellerId: "seller_1",
      vendorId: "vendor_1",
      vendorHandle: "amber-cellar",
      vendorStoreId: "store_1",
    },
  });
  assert.deepEqual(stripeCalls.balanceSettingsUpdate[0], {
    params: {
      payments: {
        payouts: {
          schedule: {
            interval: "manual",
          },
        },
      },
    },
    options: {
      stripeAccount: "acct_123",
    },
  });
});

test("createSellerStripeAccount falls back to account settings for manual payouts", async () => {
  const stripeCalls = {
    accountsUpdate: [],
  };

  const fakeStripe = {
    accounts: {
      async create() {
        return {
          id: "acct_fallback",
          country: "JP",
          default_currency: "jpy",
          details_submitted: false,
          charges_enabled: false,
          payouts_enabled: false,
          requirements: {},
        };
      },
      async update(accountId, params) {
        stripeCalls.accountsUpdate.push({ accountId, params });
      },
    },
    balanceSettings: {
      async update() {
        throw Object.assign(new Error("Balance Settings unavailable"), {
          raw: {
            message: "Balance Settings unavailable",
            type: "invalid_request_error",
          },
        });
      },
    },
  };
  const fakePrisma = {
    seller: {
      async findUnique() {
        return {
          id: "seller_1",
          vendor: {
            id: "vendor_1",
            handle: "amber-cellar",
            storeName: "Amber Cellar",
            managementEmail: "owner@example.com",
            vendorStore: {
              id: "store_1",
              country: "Japan",
            },
          },
          stripeAccount: null,
        };
      },
    },
    sellerStripeAccount: {
      async create({ data }) {
        return {
          id: "ssa_1",
          ...data,
        };
      },
    },
  };

  const result = await createSellerStripeAccount(
    { sellerId: "seller_1" },
    {
      prismaClient: fakePrisma,
      stripeClient: fakeStripe,
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(stripeCalls.accountsUpdate[0], {
    accountId: "acct_fallback",
    params: {
      settings: {
        payouts: {
          schedule: {
            interval: "manual",
          },
        },
      },
    },
  });
});

test("resetSellerStripeAccountForRecreate removes an unused Stripe account and marks stale orders failed", async () => {
  const state = {
    seller: {
      id: "seller_1",
      status: "active",
      statusReason: null,
      stripeAccount: {
        id: "seller_stripe_1",
        stripeAccountId: "acct_old",
      },
      orders: [
        {
          id: "order_1",
          status: "payment_intent_created",
          paidAt: null,
          stripeChargeId: null,
        },
      ],
      payoutRuns: [],
      ledgerEntries: [],
    },
    deletedStripeAccountId: null,
    updatedOrders: null,
    statusHistory: [],
  };
  const fakePrisma = {
    seller: {
      async findUnique({ where }) {
        assert.deepEqual(where, { id: "seller_1" });
        return state.seller;
      },
      async update({ where, data }) {
        assert.deepEqual(where, { id: "seller_1" });
        state.seller = {
          ...state.seller,
          ...data,
        };
        return state.seller;
      },
    },
    order: {
      async updateMany({ where, data }) {
        state.updatedOrders = { where, data };
        return { count: 1 };
      },
    },
    sellerStripeAccount: {
      async delete({ where }) {
        state.deletedStripeAccountId = where.id;
        state.seller = {
          ...state.seller,
          stripeAccount: null,
        };
        return { id: where.id };
      },
    },
    sellerStatusHistory: {
      async create({ data }) {
        state.statusHistory.push(data);
        return data;
      },
    },
    async $transaction(callback) {
      return callback(fakePrisma);
    },
  };

  const result = await resetSellerStripeAccountForRecreate(
    {
      sellerId: "seller_1",
      changedBy: "admin",
      reason: "platform_mismatch",
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, true);
  assert.equal(result.reset, true);
  assert.equal(result.removedStripeAccountId, "acct_old");
  assert.equal(result.staleOrdersUpdated, 1);
  assert.equal(state.deletedStripeAccountId, "seller_stripe_1");
  assert.equal(state.seller.status, "pending");
  assert.equal(state.seller.statusReason, "platform_mismatch");
  assert.deepEqual(state.updatedOrders.data, {
    status: "failed",
    sellerStripeAccountId: null,
    stripeAccountId: null,
  });
  assert.equal(state.statusHistory[0].fromStatus, "active");
  assert.equal(state.statusHistory[0].toStatus, "pending");
});

test("resetSellerStripeAccountForRecreate refuses to reset accounts with paid orders", async () => {
  const fakePrisma = {
    seller: {
      async findUnique() {
        return {
          id: "seller_1",
          status: "active",
          stripeAccount: {
            id: "seller_stripe_1",
            stripeAccountId: "acct_old",
          },
          orders: [
            {
              id: "order_paid",
              status: "paid",
              paidAt: new Date(),
              stripeChargeId: "ch_123",
            },
          ],
          payoutRuns: [],
          ledgerEntries: [],
        };
      },
    },
  };

  const result = await resetSellerStripeAccountForRecreate(
    { sellerId: "seller_1" },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "stripe_account_reset_blocked");
  assert.deepEqual(result.blockers.orders, [
    {
      id: "order_paid",
      status: "paid",
    },
  ]);
});

test("createSellerAccountSession returns an embedded account session secret", async () => {
  const fakePrisma = {
    vendor: {
      async findUnique() {
        return {
          id: "vendor_1",
          seller: {
            stripeAccount: {
              stripeAccountId: "acct_123",
            },
          },
        };
      },
    },
  };

  const fakeStripe = {
    accountSessions: {
      async create(params) {
        assert.equal(params.account, "acct_123");
        assert.equal(params.components.account_onboarding.enabled, true);
        assert.equal(params.components.account_management.enabled, true);
        assert.equal(params.components.notification_banner.enabled, true);

        return {
          client_secret: "cas_123_secret",
          expires_at: 1777777777,
        };
      },
    },
  };

  const result = await createSellerAccountSession(
    { vendorId: "vendor_1" },
    {
      prismaClient: fakePrisma,
      stripeClient: fakeStripe,
    },
  );

  assert.deepEqual(result, {
    ok: true,
    clientSecret: "cas_123_secret",
    expiresAt: 1777777777,
  });
});

test("createCheckoutOrder builds a server-calculated order for one seller only", async () => {
  let createdOrderData = null;
  const fakePrisma = {
    vendor: {
      async findUnique() {
        return {
          id: "vendor_1",
          handle: "amber-cellar",
          vendorStore: {
            id: "store_1",
          },
          seller: {
            id: "seller_1",
            status: "active",
            stripeAccount: {
              id: "ssa_1",
              stripeAccountId: "acct_123",
            },
          },
        };
      },
    },
    product: {
      async findMany() {
        return [
          {
            id: "prod_1",
            name: "Amber Wine",
            price: 4200,
            calculatedPrice: 4500,
          },
        ];
      },
    },
    order: {
      async create({ data }) {
        createdOrderData = data;
        return {
          id: "order_1",
          ...data,
        };
      },
    },
  };

  const result = await createCheckoutOrder(
    {
      vendorHandle: "amber-cellar",
      items: [{ productId: "prod_1", quantity: 2 }],
      customer: {
        firstName: "Taro",
        lastName: "Yamada",
        email: "Taro@example.com",
      },
      shippingAddress: {
        address1: "1-2-3",
        city: "Tokyo",
        postalCode: "1500001",
        country: "JP",
      },
      totalAmount: 1,
      applicationFeeAmount: 1,
    },
    {
      prismaClient: fakePrisma,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.order.subtotalAmount, 9000);
  assert.equal(result.order.totalAmount, 9000);
  assert.equal(result.order.applicationFeeAmount, 900);
  assert.equal(createdOrderData.sellerId, "seller_1");
  assert.equal(createdOrderData.sellerStripeAccountId, "ssa_1");
  assert.equal(createdOrderData.stripeAccountId, "acct_123");
  assert.deepEqual(createdOrderData.lineItemsJson, [
    {
      productId: "prod_1",
      name: "Amber Wine",
      quantity: 2,
      unitAmount: 4500,
      totalAmount: 9000,
    },
  ]);
});

test("createCheckoutOrderPaymentIntent creates a direct charge on the connected account", async () => {
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_vendor_register";

  const stripeCalls = {
    create: [],
  };
  let updatedOrderData = null;
  const fakePrisma = {
    order: {
      async findUnique() {
        return {
          id: "order_1",
          sellerId: "seller_1",
          stripeAccountId: "acct_123",
          sellerStripeAccountId: "ssa_1",
          totalAmount: 9000,
          applicationFeeAmount: 900,
          currencyCode: "jpy",
          customerEmail: "taro@example.com",
          stripePaymentIntentId: null,
          seller: {
            vendorId: "vendor_1",
            status: "active",
            stripeAccount: {
              stripeAccountId: "acct_123",
            },
            vendor: {
              id: "vendor_1",
              vendorStore: { isTestStore: false },
            },
            complianceProfile: { countryCode: "JP" },
            settlementControl: { payoutHold: false },
          },
          sellerStripeAccount: {
            stripeAccountId: "acct_123",
          },
        };
      },
      async update({ data }) {
        updatedOrderData = data;
      },
    },
  };
  const fakeStripe = {
    paymentIntents: {
      async create(params, options) {
        stripeCalls.create.push({ params, options });
        return {
          id: "pi_123",
          client_secret: "pi_123_secret",
          status: "requires_payment_method",
        };
      },
      async retrieve() {
        throw Object.assign(new Error("missing"), { code: "resource_missing" });
      },
    },
  };

  const result = await createCheckoutOrderPaymentIntent(
    { orderId: "order_1" },
    {
      prismaClient: fakePrisma,
      stripeClient: fakeStripe,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.paymentIntentId, "pi_123");
  assert.equal(result.clientSecret, "pi_123_secret");
  assert.equal(result.publishableKey, "pk_test_vendor_register");
  assert.deepEqual(stripeCalls.create[0], {
    params: {
      amount: 9000,
      currency: "jpy",
      application_fee_amount: 900,
      automatic_payment_methods: {
        enabled: true,
      },
      receipt_email: "taro@example.com",
      metadata: {
        orderId: "order_1",
        sellerId: "seller_1",
        vendorId: "vendor_1",
      },
    },
    options: {
      stripeAccount: "acct_123",
    },
  });
  assert.deepEqual(updatedOrderData, {
    status: "payment_intent_created",
    stripePaymentIntentId: "pi_123",
  });
});

test("handleStripeWebhook stores a minimized audit event idempotently and writes charge ledger entries", async () => {
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_vendor_register";

  const state = {
    savedEvent: null,
    order: {
      id: "order_1",
      sellerId: "seller_1",
      sellerStripeAccountId: "ssa_1",
      stripeAccountId: "acct_123",
      stripePaymentIntentId: null,
      stripeChargeId: null,
      paidAt: null,
      status: "payment_intent_created",
      currencyCode: "jpy",
    },
    ledgerEntries: [],
    processed: [],
  };

  const fakePrisma = {
    stripeEvent: {
      async findUnique() {
        return state.savedEvent;
      },
      async create({ data }) {
        state.savedEvent = {
          id: "sev_1",
          ...data,
        };
        return state.savedEvent;
      },
      async update({ where, data }) {
        state.processed.push({ where, data });
        state.savedEvent = {
          ...state.savedEvent,
          ...data,
        };
        return state.savedEvent;
      },
    },
    order: {
      async findUnique({ where }) {
        if (where.id === "order_1") {
          return state.order;
        }

        return null;
      },
      async findFirst({ where }) {
        if (where.stripePaymentIntentId === "pi_123") {
          return state.order;
        }

        return null;
      },
      async update({ data }) {
        state.order = {
          ...state.order,
          ...data,
        };
        return state.order;
      },
    },
    ledgerEntry: {
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `le_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
  };

  const fakeStripe = {
    webhooks: {
      constructEvent() {
        return {
          id: "evt_123",
          type: "payment_intent.succeeded",
          account: "acct_123",
          livemode: false,
          created: 1777777777,
          data: {
            object: {
              id: "pi_123",
              amount: 9000,
              amount_received: 9000,
              currency: "jpy",
              latest_charge: "ch_123",
              metadata: {
                orderId: "order_1",
              },
              created: 1777777777,
            },
          },
        };
      },
    },
  };

  const firstResult = await handleStripeWebhook(
    {
      rawBody: "{}",
      signature: "t=1,v1=test",
    },
    {
      prismaClient: fakePrisma,
      stripeClient: fakeStripe,
    },
  );

  const duplicateResult = await handleStripeWebhook(
    {
      rawBody: "{}",
      signature: "t=1,v1=test",
    },
    {
      prismaClient: fakePrisma,
      stripeClient: fakeStripe,
    },
  );

  assert.deepEqual(firstResult, {
    ok: true,
    duplicate: false,
    eventId: "evt_123",
    webhookSecretType: "platform",
  });
  assert.deepEqual(duplicateResult, {
    ok: true,
    duplicate: true,
    eventId: "evt_123",
    webhookSecretType: "platform",
  });
  assert.equal(state.order.status, "paid");
  assert.equal(state.order.stripeChargeId, "ch_123");
  assert.equal(state.ledgerEntries.length, 1);
  assert.equal(state.ledgerEntries[0].stripeEventId, "sev_1");
  assert.equal(state.ledgerEntries[0].entryType, "charge");
  assert.equal(state.ledgerEntries[0].stripeObjectId, "ch_123");
  assert.equal(state.savedEvent.payloadJson.eventId, "evt_123");
  assert.equal(state.savedEvent.payloadJson.object.id, "pi_123");
  assert.equal(state.savedEvent.payloadJson.object.metadata.orderId, "order_1");
  assert.equal(state.savedEvent.payloadJson.data, undefined);
});

test("handleStripeWebhook prefers the Connect webhook secret when present", async () => {
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_vendor_register";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_platform_vendor_register";

  const fakePrisma = {
    stripeEvent: {
      async findUnique() {
        return null;
      },
      async create({ data }) {
        return {
          id: "sev_connect",
          ...data,
        };
      },
      async update() {},
    },
    sellerStripeAccount: {
      async findUnique() {
        return null;
      },
    },
  };
  const fakeStripe = {
    webhooks: {
      constructEvent(_rawBody, _signature, secret) {
        assert.equal(secret, "whsec_connect_vendor_register");
        return {
          id: "evt_connect_1",
          type: "account.updated",
          account: "acct_123",
          livemode: false,
          created: 1777777777,
          data: {
            object: {
              id: "acct_123",
              payouts_enabled: false,
            },
          },
        };
      },
    },
  };

  const result = await handleStripeWebhook(
    {
      rawBody: "{}",
      signature: "t=1,v1=test",
    },
    {
      prismaClient: fakePrisma,
      stripeClient: fakeStripe,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.webhookSecretType, "connect");
});

test("payout.failed marks the payout run failed and moves the seller to review", async () => {
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_vendor_register";

  const state = {
    savedEvent: null,
    payoutRun: {
      id: "pr_failed",
      sellerId: "seller_1",
      sellerStripeAccountId: "ssa_1",
      stripeAccountId: "acct_123",
      amount: 5000,
      currencyCode: "jpy",
      status: "executed",
      stripePayoutId: "po_failed",
      failureCode: null,
      failureMessage: null,
    },
    seller: {
      id: "seller_1",
      status: "active",
      statusReason: null,
    },
    ledgerEntries: [],
    statusHistory: [],
  };
  const fakePrisma = {
    stripeEvent: {
      async findUnique() {
        return state.savedEvent;
      },
      async create({ data }) {
        state.savedEvent = {
          id: "sev_payout_failed",
          ...data,
        };
        return state.savedEvent;
      },
      async update({ data }) {
        state.savedEvent = {
          ...state.savedEvent,
          ...data,
        };
        return state.savedEvent;
      },
    },
    payoutRun: {
      async findFirst({ where }) {
        return where.stripePayoutId === "po_failed" ? state.payoutRun : null;
      },
      async update({ data }) {
        state.payoutRun = {
          ...state.payoutRun,
          ...data,
        };
        return state.payoutRun;
      },
    },
    seller: {
      async findUnique({ where }) {
        return where.id === state.seller.id ? state.seller : null;
      },
      async update({ data }) {
        state.seller = {
          ...state.seller,
          ...data,
        };
        return state.seller;
      },
    },
    sellerStatusHistory: {
      async create({ data }) {
        state.statusHistory.push(data);
        return data;
      },
    },
    ledgerEntry: {
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `le_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
  };
  const fakeStripe = {
    webhooks: {
      constructEvent() {
        return {
          id: "evt_payout_failed",
          type: "payout.failed",
          account: "acct_123",
          livemode: false,
          created: 1777777777,
          data: {
            object: {
              id: "po_failed",
              amount: 5000,
              currency: "jpy",
              failure_code: "account_closed",
              failure_message: "Bank account closed",
              created: 1777777777,
            },
          },
        };
      },
    },
  };

  const result = await handleStripeWebhook(
    {
      rawBody: "{}",
      signature: "t=1,v1=test",
    },
    {
      prismaClient: fakePrisma,
      stripeClient: fakeStripe,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(state.payoutRun.status, "failed");
  assert.equal(state.payoutRun.failureCode, "account_closed");
  assert.equal(state.seller.status, "review");
  assert.equal(
    state.seller.statusReason,
    "payout_external_account_update_required",
  );
  assert.equal(state.ledgerEntries.length, 0);
  assert.equal(state.statusHistory[0].changedBy, "stripe.payout.failed");
});

test("payout.created updates the run without ledger debit and payout.paid records the debit", async () => {
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_vendor_register";

  let currentEventType = "payout.created";
  const state = {
    savedEvents: new Map(),
    payoutRun: {
      id: "pr_paid",
      sellerId: "seller_1",
      sellerStripeAccountId: "ssa_1",
      stripeAccountId: "acct_123",
      amount: 5000,
      currencyCode: "jpy",
      status: "approved",
      stripePayoutId: null,
      failureCode: null,
      failureMessage: null,
    },
    ledgerEntries: [],
  };
  const fakePrisma = {
    stripeEvent: {
      async findUnique({ where }) {
        return state.savedEvents.get(where.stripeEventId) || null;
      },
      async create({ data }) {
        const savedEvent = {
          id: `sev_${data.stripeEventId}`,
          ...data,
        };
        state.savedEvents.set(data.stripeEventId, savedEvent);
        return savedEvent;
      },
      async update({ where, data }) {
        const savedEvent = {
          ...state.savedEvents.get(where.stripeEventId),
          ...data,
        };
        state.savedEvents.set(where.stripeEventId, savedEvent);
        return savedEvent;
      },
    },
    payoutRun: {
      async findFirst({ where }) {
        return where.stripePayoutId === state.payoutRun.stripePayoutId
          ? state.payoutRun
          : null;
      },
      async findUnique({ where }) {
        return where.id === state.payoutRun.id ? state.payoutRun : null;
      },
      async update({ data }) {
        state.payoutRun = {
          ...state.payoutRun,
          ...data,
        };
        return state.payoutRun;
      },
    },
    ledgerEntry: {
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `le_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
  };
  const fakeStripe = {
    webhooks: {
      constructEvent() {
        return {
          id: `evt_${currentEventType.replace(".", "_")}`,
          type: currentEventType,
          account: "acct_123",
          livemode: false,
          created: 1777777777,
          data: {
            object: {
              id: "po_paid",
              amount: 5000,
              currency: "jpy",
              destination: "ba_123",
              created: 1777777777,
              metadata: {
                payoutRunId: "pr_paid",
              },
            },
          },
        };
      },
    },
  };

  const createdResult = await handleStripeWebhook(
    {
      rawBody: "{}",
      signature: "t=1,v1=test",
    },
    {
      prismaClient: fakePrisma,
      stripeClient: fakeStripe,
    },
  );

  assert.equal(createdResult.ok, true);
  assert.equal(state.payoutRun.status, "executed");
  assert.equal(state.payoutRun.stripePayoutId, "po_paid");
  assert.equal(state.ledgerEntries.length, 0);

  currentEventType = "payout.paid";
  const paidResult = await handleStripeWebhook(
    {
      rawBody: "{}",
      signature: "t=1,v1=test",
    },
    {
      prismaClient: fakePrisma,
      stripeClient: fakeStripe,
    },
  );

  assert.equal(paidResult.ok, true);
  assert.equal(state.ledgerEntries.length, 1);
  assert.equal(state.ledgerEntries[0].entryType, "payout_paid");
  assert.equal(state.ledgerEntries[0].direction, "debit");
  assert.equal(state.ledgerEntries[0].amount, 5000);
});

test("processShopifyOrderPaidSettlement records a seller payable ledger entry", async () => {
  const state = {
    ledgerEntries: [],
  };
  const fakePrisma = {
    ledgerEntry: {
      async findFirst({ where }) {
        assert.deepEqual(where, {
          entryType: "shopify_order_paid",
          stripeObjectId: "gid://shopify/Order/1001",
        });
        return null;
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `le_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
    product: {
      async findMany({ where }) {
        assertShopifyProductLookupWhere(where, {
          shopDomain: "b30ize-1a.myshopify.com",
          productIds: ["gid://shopify/Product/911", "911"],
          variantIds: ["gid://shopify/ProductVariant/912", "912"],
        });
        return [
          {
            id: "product_1",
            name: "Test Product",
            approvalStatus: "approved",
            shopifyProductId: "gid://shopify/Product/911",
            shopifyVariantId: "gid://shopify/ProductVariant/912",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStoreId: "store_1",
            vendorStore: {
              id: "store_1",
              storeName: "Test Store",
              seller: null,
              vendorAuth: {
                id: "vendor_1",
                handle: "vendor",
                storeName: "Test Store",
                seller: {
                  id: "seller_1",
                  status: "active",
                  stripeAccount: {
                    id: "ssa_1",
                    stripeAccountId: "acct_123",
                  },
                },
              },
            },
          },
        ];
      },
    },
  };

  const result = await processShopifyOrderPaidSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 1001,
        admin_graphql_api_id: "gid://shopify/Order/1001",
        name: "#1001",
        currency: "JPY",
        processed_at: "2026-05-15T12:00:00Z",
        line_items: [
          {
            id: 501,
            product_id: 911,
            variant_id: 912,
            price: "26948.00",
            quantity: 1,
            discount_allocations: [
              {
                amount: "100.00",
              },
            ],
          },
        ],
      },
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.sellerId, "seller_1");
  assert.equal(result.amount, 26848);
  assert.equal(state.ledgerEntries.length, 1);
  assert.equal(state.ledgerEntries[0].entryType, "shopify_order_paid");
  assert.equal(state.ledgerEntries[0].direction, "credit");
  assert.equal(state.ledgerEntries[0].sellerId, "seller_1");
  assert.equal(state.ledgerEntries[0].sellerStripeAccountId, "ssa_1");
  assert.equal(state.ledgerEntries[0].stripeAccountId, "acct_123");
  assert.equal(
    state.ledgerEntries[0].stripeObjectId,
    "gid://shopify/Order/1001",
  );
  assert.equal(state.ledgerEntries[0].metadataJson.vendorHandle, "vendor");
  assert.equal(state.ledgerEntries[0].metadataJson.lineItems[0].amount, 26848);
});

test("processShopifyOrderPaidSettlement shadow-writes a matching seller order", async () => {
  const state = {
    ledgerEntries: [],
    marketplaceOrders: new Map(),
    sellerOrders: new Map(),
    sellerOrderLines: new Map(),
    sellerOrderShadowChecks: [],
    checkoutEvidenceByReference: new Map([
      [
        "checkout:evidence-1101",
        {
          id: "mce_1",
          checkoutReference: "checkout:evidence-1101",
          sellerAgreementVersion: "seller-2026-01",
          buyerTermsVersion: "buyer-2026-01",
          buyerTermsHash: "a".repeat(64),
          buyerTermsUrl: "https://example.com/buyer-terms",
          buyerTermsLocale: "ja-JP",
          presentedAt: new Date("2026-06-19T08:59:00Z"),
          sellerSnapshotsJson: [
            {
              sellerId: "seller_1",
              snapshot: {
                governanceSnapshotVersion: "marketplace-governance-v1",
                buyerTermsVersion: "buyer-2026-01",
                legalSellerSnapshotJson: {
                  sellerId: "seller_1",
                  legalName: "Checkout Legal Seller",
                },
                sellerAgreementSnapshotJson: {
                  version: "seller-2026-01",
                  documentHash: "b".repeat(64),
                },
              },
            },
          ],
          productSnapshotsJson: [
            {
              productId: "product_1",
              snapshot: {
                productId: "product_1",
                conditionStatus: "CHECKOUT_CAPTURED",
              },
            },
          ],
        },
      ],
    ]),
  };
  const fakePrisma = {
    ...createSellerOrderShadowFakeModels(state),
    ledgerEntry: {
      async findFirst({ where }) {
        assert.deepEqual(where, {
          entryType: "shopify_order_paid",
          stripeObjectId: "gid://shopify/Order/1101",
        });
        return null;
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `le_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
    product: {
      async findMany() {
        return [
          {
            id: "product_1",
            name: "Shadow Product",
            approvalStatus: "approved",
            shopifyProductId: "gid://shopify/Product/911",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStoreId: "store_1",
            vendorStore: {
              id: "store_1",
              storeName: "Shadow Store",
              seller: null,
              vendorAuth: {
                id: "vendor_1",
                handle: "shadow-store",
                storeName: "Shadow Store",
                seller: {
                  id: "seller_1",
                  status: "active",
                  stripeAccount: null,
                },
              },
            },
          },
        ];
      },
    },
  };

  const result = await processShopifyOrderPaidSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 1101,
        admin_graphql_api_id: "gid://shopify/Order/1101",
        name: "#1101",
        order_number: 1101,
        currency: "JPY",
        financial_status: "paid",
        processed_at: "2026-06-19T09:00:00Z",
        email: "buyer@example.com",
        total_price: "1900",
        subtotal_price: "2000",
        total_discounts: "100",
        total_tax: "0",
        note_attributes: [
          { name: "checkout_reference", value: "checkout:evidence-1101" },
        ],
        line_items: [
          {
            id: 501,
            product_id: 911,
            variant_id: 912,
            title: "Shadow Product",
            sku: "SHADOW-1",
            price: "1000",
            quantity: 2,
            discount_allocations: [{ amount: "100" }],
          },
        ],
      },
    },
    {
      prismaClient: fakePrisma,
      env: { SELLER_ORDER_SHADOW_WRITE_ENABLED: "true" },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.amount, 1900);
  assert.equal(result.sellerOrderShadow.ok, true);
  assert.equal(result.sellerOrderShadow.status, "matched");
  assert.equal(state.marketplaceOrders.size, 1);
  assert.equal(state.sellerOrders.size, 1);
  assert.equal(state.sellerOrderLines.size, 1);
  assert.equal(state.sellerOrderShadowChecks.length, 1);

  const sellerOrder = Array.from(state.sellerOrders.values())[0];
  assert.equal(sellerOrder.sellerId, "seller_1");
  assert.equal(sellerOrder.vendorStoreId, "store_1");
  assert.equal(sellerOrder.sellerSubtotalAmount, 2000);
  assert.equal(sellerOrder.sellerDiscountAmount, 100);
  assert.equal(sellerOrder.sellerPayableAmount, 1900);
  assert.equal(sellerOrder.buyerTermsVersion, "buyer-2026-01");
  assert.equal(sellerOrder.buyerTermsHash, "a".repeat(64));
  assert.equal(
    sellerOrder.legalSellerSnapshotJson.legalName,
    "Checkout Legal Seller",
  );
  assert.equal(
    sellerOrder.sellerAgreementSnapshotJson.documentHash,
    "b".repeat(64),
  );

  const line = Array.from(state.sellerOrderLines.values())[0];
  assert.equal(line.shopifyLineItemId, "gid://shopify/LineItem/501");
  assert.equal(line.shopifyProductId, "gid://shopify/Product/911");
  assert.equal(line.shopifyVariantId, "gid://shopify/ProductVariant/912");
  assert.equal(line.quantity, 2);
  assert.equal(line.netAmount, 1900);
  assert.equal(line.complianceSnapshotJson.conditionStatus, "CHECKOUT_CAPTURED");

  assert.equal(
    state.checkoutEvidenceByReference.get("checkout:evidence-1101").status,
    "ORDER_CAPTURED",
  );

  assert.equal(state.sellerOrderShadowChecks[0].status, "matched");
  assert.equal(state.sellerOrderShadowChecks[0].currencyCode, "jpy");
  assert.equal(state.sellerOrderShadowChecks[0].legacyLedgerAmount, 1900);
  assert.equal(
    state.sellerOrderShadowChecks[0].sellerOrderCalculatedAmount,
    1900,
  );
});

test("processShopifyOrderPaidSettlement prefers Shopify variant mapping over product mapping", async () => {
  const state = {
    ledgerEntries: [],
    marketplaceOrders: new Map(),
    sellerOrders: new Map(),
    sellerOrderLines: new Map(),
    sellerOrderShadowChecks: [],
  };
  const makeVendorStore = ({ storeId, sellerId, handle }) => ({
    id: storeId,
    storeName: handle,
    seller: null,
    vendorAuth: {
      id: `vendor_${sellerId}`,
      handle,
      storeName: handle,
      seller: {
        id: sellerId,
        status: "active",
        stripeAccount: null,
      },
    },
  });
  const fakePrisma = {
    ...createSellerOrderShadowFakeModels(state),
    ledgerEntry: {
      async findFirst() {
        return null;
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `le_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
    product: {
      async findMany({ where }) {
        assertShopifyProductLookupWhere(where, {
          shopDomain: "b30ize-1a.myshopify.com",
          productIds: ["gid://shopify/Product/911", "911"],
          variantIds: ["gid://shopify/ProductVariant/912", "912"],
        });

        return [
          {
            id: "product_from_product_id",
            name: "Product ID Store Product",
            approvalStatus: "approved",
            shopifyProductId: "gid://shopify/Product/911",
            shopifyVariantId: null,
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStoreId: "store_product",
            vendorStore: makeVendorStore({
              storeId: "store_product",
              sellerId: "seller_product",
              handle: "Product Store",
            }),
          },
          {
            id: "product_from_variant_id",
            name: "Variant Store Product",
            approvalStatus: "approved",
            shopifyProductId: "gid://shopify/Product/999",
            shopifyVariantId: "gid://shopify/ProductVariant/912",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStoreId: "store_variant",
            vendorStore: makeVendorStore({
              storeId: "store_variant",
              sellerId: "seller_variant",
              handle: "Variant Store",
            }),
          },
        ];
      },
    },
  };

  const result = await processShopifyOrderPaidSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 1102,
        admin_graphql_api_id: "gid://shopify/Order/1102",
        name: "#1102",
        order_number: 1102,
        currency: "JPY",
        financial_status: "paid",
        processed_at: "2026-06-19T09:30:00Z",
        total_price: "1000",
        subtotal_price: "1000",
        total_discounts: "0",
        total_tax: "0",
        line_items: [
          {
            id: 502,
            product_id: 911,
            variant_id: 912,
            title: "Variant Store Product",
            sku: "VARIANT-1",
            price: "1000",
            quantity: 1,
          },
        ],
      },
    },
    {
      prismaClient: fakePrisma,
      env: { SELLER_ORDER_SHADOW_WRITE_ENABLED: "true" },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.sellerId, "seller_variant");
  assert.equal(state.ledgerEntries[0].sellerId, "seller_variant");

  const sellerOrder = Array.from(state.sellerOrders.values())[0];
  assert.equal(sellerOrder.sellerId, "seller_variant");
  assert.equal(sellerOrder.vendorStoreId, "store_variant");

  const line = Array.from(state.sellerOrderLines.values())[0];
  assert.equal(line.productId, "product_from_variant_id");
  assert.equal(line.shopifyVariantId, "gid://shopify/ProductVariant/912");
});

test("backfillSellerOrderShadowChecks creates a shadow check from an existing ledger and skips the second run", async () => {
  const ledgerEntry = {
    id: "le_backfill_1",
    sellerId: "seller_1",
    entryType: "shopify_order_paid",
    stripeObjectId: "gid://shopify/Order/1301",
    amount: 1900,
    currencyCode: "jpy",
    direction: "credit",
    occurredAt: new Date("2026-06-20T09:00:00Z"),
    metadataJson: {
      shopDomain: "b30ize-1a.myshopify.com",
      shopifyOrderId: "gid://shopify/Order/1301",
      shopifyOrderName: "#1301",
      shopifyOrderNumericId: "1301",
      lineItems: [
        {
          shopifyLineItemId: "601",
          shopifyProductId: "gid://shopify/Product/911",
          localProductId: "product_1",
          localProductName: "Shadow Product",
          quantity: 2,
          amount: 1900,
        },
      ],
    },
  };
  const state = {
    marketplaceOrders: new Map(),
    sellerOrders: new Map(),
    sellerOrderLines: new Map(),
    sellerOrderShadowChecks: [
      {
        id: "sosc_other_shop",
        shopDomain: "other-shop.myshopify.com",
        shopifyOrderId: "gid://shopify/Order/1301",
        status: "matched",
        checkedAt: new Date("2026-06-20T08:00:00Z"),
      },
    ],
  };
  const fakePrisma = {
    ...createSellerOrderShadowFakeModels(state),
    ledgerEntry: {
      async findMany() {
        return [ledgerEntry];
      },
    },
    product: {
      async findMany() {
        return [
          {
            id: "product_1",
            name: "Shadow Product",
            approvalStatus: "approved",
            shopifyProductId: "gid://shopify/Product/911",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStoreId: "store_1",
            vendorStore: {
              id: "store_1",
              storeName: "Shadow Store",
              seller: null,
              vendorAuth: {
                id: "vendor_1",
                handle: "shadow-store",
                storeName: "Shadow Store",
                seller: {
                  id: "seller_1",
                  status: "active",
                  stripeAccount: null,
                },
              },
            },
          },
        ];
      },
    },
  };

  const firstResult = await backfillSellerOrderShadowChecks(
    {
      days: 30,
      limit: 10,
      now: new Date("2026-06-20T12:00:00Z"),
    },
    { prismaClient: fakePrisma },
  );
  const secondResult = await backfillSellerOrderShadowChecks(
    {
      days: 30,
      limit: 10,
      now: new Date("2026-06-20T12:00:00Z"),
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.scanned, 1);
  assert.equal(firstResult.created, 1);
  assert.equal(firstResult.failed, 0);
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.created, 0);
  assert.equal(secondResult.skippedExisting, 1);
  assert.equal(state.marketplaceOrders.size, 1);
  assert.equal(state.sellerOrders.size, 1);
  assert.equal(state.sellerOrderLines.size, 1);
  assert.equal(state.sellerOrderShadowChecks.length, 2);
  const line = Array.from(state.sellerOrderLines.values())[0];
  assert.equal(line.quantity, 2);
  assert.equal(line.netAmount, 1900);
  const createdCheck = state.sellerOrderShadowChecks[1];
  assert.equal(createdCheck.status, "matched");
  assert.equal(createdCheck.shopDomain, "b30ize-1a.myshopify.com");
  assert.equal(createdCheck.legacyLedgerAmount, 1900);
  assert.equal(
    createdCheck.sellerOrderCalculatedAmount,
    1900,
  );
});

test("backfillSellerOrderShadowChecks records a failed check when products cannot be matched", async () => {
  const ledgerEntry = {
    id: "le_backfill_missing_product",
    sellerId: "seller_1",
    entryType: "shopify_order_paid",
    stripeObjectId: "gid://shopify/Order/1302",
    amount: 1900,
    currencyCode: "jpy",
    direction: "credit",
    occurredAt: new Date("2026-06-20T09:00:00Z"),
    metadataJson: {
      shopDomain: "b30ize-1a.myshopify.com",
      shopifyOrderId: "gid://shopify/Order/1302",
      shopifyOrderName: "#1302",
      lineItems: [
        {
          shopifyLineItemId: "602",
          shopifyProductId: "gid://shopify/Product/999",
          localProductId: "missing_product",
          localProductName: "Missing Product",
          quantity: 1,
          amount: 1900,
        },
      ],
    },
  };
  const state = {
    marketplaceOrders: new Map(),
    sellerOrders: new Map(),
    sellerOrderLines: new Map(),
    sellerOrderShadowChecks: [],
  };
  let productsAvailable = false;
  const fakePrisma = {
    ...createSellerOrderShadowFakeModels(state),
    ledgerEntry: {
      async findMany() {
        return [ledgerEntry];
      },
    },
    product: {
      async findMany() {
        return productsAvailable
          ? [
              {
                id: "missing_product",
                name: "Missing Product",
                approvalStatus: "approved",
                shopifyProductId: "gid://shopify/Product/999",
                shopDomain: "b30ize-1a.myshopify.com",
                vendorStoreId: "store_1",
                vendorStore: {
                  id: "store_1",
                  storeName: "Recovered Store",
                  seller: {
                    id: "seller_1",
                    status: "active",
                    stripeAccount: null,
                  },
                  vendorAuth: null,
                },
              },
            ]
          : [];
      },
    },
  };

  const result = await backfillSellerOrderShadowChecks(
    {
      days: 30,
      limit: 10,
      now: new Date("2026-06-20T12:00:00Z"),
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, true);
  assert.equal(result.scanned, 1);
  assert.equal(result.created, 0);
  assert.equal(result.failed, 1);
  assert.equal(state.marketplaceOrders.size, 0);
  assert.equal(state.sellerOrders.size, 0);
  assert.equal(state.sellerOrderLines.size, 0);
  assert.equal(state.sellerOrderShadowChecks.length, 1);
  assert.equal(state.sellerOrderShadowChecks[0].status, "failed");
  assert.equal(
    state.sellerOrderShadowChecks[0].errorMessage,
    "backfill_no_matching_products",
  );
  assert.equal(state.sellerOrderShadowChecks[0].legacyLedgerAmount, 1900);

  productsAvailable = true;
  const retryResult = await backfillSellerOrderShadowChecks(
    {
      days: 30,
      limit: 10,
      retryFailed: true,
      now: new Date("2026-06-20T12:00:00Z"),
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(retryResult.ok, true);
  assert.equal(retryResult.created, 1);
  assert.equal(retryResult.skippedExisting, 0);
  assert.equal(state.sellerOrders.size, 1);
  assert.equal(state.sellerOrderLines.size, 1);
  assert.equal(state.sellerOrderShadowChecks.length, 2);
  assert.equal(state.sellerOrderShadowChecks[1].status, "matched");
});

test("processShopifyOrderPaidSettlement reads Shopify transaction risk when the webhook payload is incomplete", async () => {
  const state = {
    ledgerEntries: [],
    adminRiskLookups: [],
  };
  const fakePrisma = {
    ledgerEntry: {
      async findFirst({ where }) {
        assert.deepEqual(where, {
          entryType: "shopify_order_paid",
          stripeObjectId: "gid://shopify/Order/1002",
        });
        return null;
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `le_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
    product: {
      async findMany({ where }) {
        assertShopifyProductLookupWhere(where, {
          shopDomain: "b30ize-1a.myshopify.com",
          productIds: ["gid://shopify/Product/912", "912"],
        });
        return [
          {
            id: "product_1",
            name: "Test Product",
            approvalStatus: "approved",
            shopifyProductId: "gid://shopify/Product/912",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStoreId: "store_1",
            vendorStore: {
              id: "store_1",
              storeName: "Test Store",
              seller: {
                id: "seller_1",
                status: "active",
                stripeAccount: null,
              },
              vendorAuth: null,
            },
          },
        ];
      },
    },
  };
  const fakeShopifyGraphQL = async ({ shopDomain, query, variables }) => {
    state.adminRiskLookups.push({ shopDomain, query, variables });
    assert.equal(shopDomain, "b30ize-1a.myshopify.com");
    assert.equal(variables.id, "gid://shopify/Order/1002");

    return {
      data: {
        order: {
          paymentGatewayNames: ["Shopify Payments"],
          sourceName: "web",
          transactions: [
            {
              id: "gid://shopify/OrderTransaction/1",
              kind: "SALE",
              status: "SUCCESS",
              gateway: "shopify_payments",
              formattedGateway: "Shopify Payments",
              manualPaymentGateway: false,
              receiptJson: JSON.stringify({
                three_d_secure: {
                  authenticated: true,
                  liability_shifted: true,
                },
              }),
              paymentDetails: {
                __typename: "CardPaymentDetails",
                paymentMethodName: "Visa",
              },
            },
          ],
        },
      },
    };
  };

  const result = await processShopifyOrderPaidSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 1002,
        admin_graphql_api_id: "gid://shopify/Order/1002",
        name: "#1002",
        currency: "JPY",
        payment_gateway_names: ["Shopify Payments"],
        processed_at: "2026-05-15T12:00:00Z",
        line_items: [
          {
            id: 502,
            product_id: 912,
            price: "12000.00",
            quantity: 1,
          },
        ],
      },
    },
    {
      prismaClient: fakePrisma,
      shopifyGraphQLWithOfflineSessionImpl: fakeShopifyGraphQL,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.paymentRisk.adminLookupAttempted, true);
  assert.equal(result.paymentRisk.adminLookupSucceeded, true);
  assert.equal(
    result.paymentRisk.riskClass,
    SALES_CREDIT_PAYMENT_RISK_CLASSES.CARD_3DS_AUTHENTICATED,
  );
  assert.equal(result.paymentRisk.rateBps, 10000);
  assert.equal(state.adminRiskLookups.length, 1);
  assert.equal(state.ledgerEntries.length, 1);
  assert.equal(
    state.ledgerEntries[0].metadataJson.salesCreditPaymentRiskClass,
    SALES_CREDIT_PAYMENT_RISK_CLASSES.CARD_3DS_AUTHENTICATED,
  );
  assert.equal(
    state.ledgerEntries[0].metadataJson.salesCreditPaymentRiskRateBps,
    10000,
  );
  assert.equal(
    state.ledgerEntries[0].metadataJson
      .salesCreditPaymentRiskAdminLookupAttempted,
    true,
  );
  assert.equal(
    state.ledgerEntries[0].metadataJson
      .salesCreditPaymentRiskAdminLookupSucceeded,
    true,
  );
});

test("processShopifyOrderPaidSettlement captures sales credit and credits the target seller gross item amount", async () => {
  const state = {
    ledgerEntries: [],
    salesCreditOffset: {
      id: "sco_1",
      sellerId: "seller_buyer",
      amount: 1000,
      currencyCode: "jpy",
      status: "authorized",
      checkoutReference: "draft-order:test",
      idempotencyKey: "checkout_sales_credit_1",
      expiresAt: null,
      metadataJson: {
        targetSellerId: "seller_target",
      },
    },
  };
  const fakePrisma = {
    ledgerEntry: {
      async findFirst({ where }) {
        if (where.entryType === "shopify_order_paid") {
          return null;
        }

        if (where.entryType === "sales_credit_offset_captured") {
          return null;
        }

        return null;
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `le_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
    salesCreditOffset: {
      async findUnique({ where }) {
        return where.id === state.salesCreditOffset.id
          ? state.salesCreditOffset
          : null;
      },
      async update({ where, data }) {
        assert.equal(where.id, state.salesCreditOffset.id);
        state.salesCreditOffset = {
          ...state.salesCreditOffset,
          ...data,
        };
        return state.salesCreditOffset;
      },
    },
    product: {
      async findMany() {
        return [
          {
            id: "product_1",
            name: "Target Product",
            approvalStatus: "approved",
            shopifyProductId: "gid://shopify/Product/911",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStore: {
              vendorAuth: {
                id: "vendor_target",
                handle: "target",
                seller: {
                  id: "seller_target",
                  status: "active",
                  stripeAccount: null,
                },
              },
            },
          },
        ];
      },
    },
  };

  const result = await processShopifyOrderPaidSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 1002,
        admin_graphql_api_id: "gid://shopify/Order/1002",
        name: "#1002",
        currency: "JPY",
        processed_at: "2026-06-01T12:00:00Z",
        payment_gateway_names: ["Shopify Payments"],
        transactions: [
          {
            payment_details: {
              three_d_secure: {
                authenticated: true,
                liability_shifted: true,
              },
            },
          },
        ],
        note_attributes: [
          { name: "sales_credit_offset_id", value: "sco_1" },
          { name: "sales_credit_offset_amount", value: "1000" },
          { name: "sales_credit_buyer_seller_id", value: "seller_buyer" },
        ],
        line_items: [
          {
            id: 501,
            product_id: 911,
            price: "4000.00",
            quantity: 1,
            discount_allocations: [{ amount: "1000.00" }],
          },
        ],
      },
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, true);
  assert.equal(result.amount, 4000);
  assert.equal(result.salesCreditCapture.ok, true);
  assert.equal(state.salesCreditOffset.status, "captured");
  assert.equal(state.ledgerEntries.length, 2);
  assert.equal(state.ledgerEntries[0].entryType, "sales_credit_offset_captured");
  assert.equal(state.ledgerEntries[0].sellerId, "seller_buyer");
  assert.equal(state.ledgerEntries[0].direction, "debit");
  assert.equal(state.ledgerEntries[0].amount, 1000);
  assert.equal(state.ledgerEntries[1].entryType, "shopify_order_paid");
  assert.equal(state.ledgerEntries[1].sellerId, "seller_target");
  assert.equal(state.ledgerEntries[1].direction, "credit");
  assert.equal(state.ledgerEntries[1].amount, 4000);
  assert.equal(state.ledgerEntries[1].metadataJson.cashSettlementAmount, 3000);
  assert.equal(
    state.ledgerEntries[1].metadataJson.salesCreditPaymentRiskClass,
    SALES_CREDIT_PAYMENT_RISK_CLASSES.CARD_3DS_AUTHENTICATED,
  );
  assert.equal(
    state.ledgerEntries[1].metadataJson.salesCreditPaymentRiskRateBps,
    10000,
  );
  assert.equal(state.ledgerEntries[1].metadataJson.salesCreditOffsetAmount, 1000);
  assert.equal(state.ledgerEntries[1].metadataJson.salesCreditOffsetId, "sco_1");
});

test("processShopifyOrderPaidSettlement refuses sales credit custom attribute mismatches", async () => {
  const state = {
    ledgerEntries: [],
    salesCreditOffset: {
      id: "sco_1",
      sellerId: "seller_buyer",
      amount: 500,
      currencyCode: "jpy",
      status: "authorized",
      checkoutReference: "draft-order:test",
      idempotencyKey: "checkout_sales_credit_1",
      expiresAt: null,
      metadataJson: {
        targetSellerId: "seller_target",
      },
    },
  };
  const fakePrisma = {
    ledgerEntry: {
      async findFirst() {
        return null;
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `le_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
    salesCreditOffset: {
      async findUnique({ where }) {
        return where.id === state.salesCreditOffset.id
          ? state.salesCreditOffset
          : null;
      },
      async update() {
        throw new Error("mismatched sales credit should not be captured");
      },
    },
    product: {
      async findMany() {
        return [
          {
            id: "product_1",
            name: "Target Product",
            approvalStatus: "approved",
            shopifyProductId: "gid://shopify/Product/911",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStore: {
              vendorAuth: {
                id: "vendor_target",
                handle: "target",
                seller: {
                  id: "seller_target",
                  status: "active",
                  stripeAccount: null,
                },
              },
            },
          },
        ];
      },
    },
  };

  const result = await processShopifyOrderPaidSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 1003,
        admin_graphql_api_id: "gid://shopify/Order/1003",
        name: "#1003",
        currency: "JPY",
        processed_at: "2026-06-01T12:00:00Z",
        note_attributes: [
          { name: "sales_credit_offset_id", value: "sco_1" },
          { name: "sales_credit_offset_amount", value: "1000" },
          { name: "sales_credit_buyer_seller_id", value: "seller_buyer" },
        ],
        line_items: [
          {
            id: 501,
            product_id: 911,
            price: "4000.00",
            quantity: 1,
            discount_allocations: [{ amount: "1000.00" }],
          },
        ],
      },
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "sales_credit_capture_failed");
  assert.equal(
    result.salesCreditCapture.reason,
    "sales_credit_offset_amount_mismatch",
  );
  assert.equal(state.salesCreditOffset.status, "authorized");
  assert.equal(state.ledgerEntries.length, 0);
});

test("processShopifyOrderPaidSettlement allows a pending seller without a Stripe account in Shopify settlement mode", async () => {
  const state = {
    ledgerEntries: [],
  };
  const fakePrisma = {
    ledgerEntry: {
      async findFirst() {
        return null;
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: "le_1",
          ...data,
        };
      },
    },
    product: {
      async findMany() {
        return [
          {
            id: "product_1",
            name: "Test Product",
            shopifyProductId: "gid://shopify/Product/911",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStore: {
              vendorAuth: {
                id: "vendor_1",
                handle: "vendor",
                seller: {
                  id: "seller_1",
                  status: "pending",
                  stripeAccount: null,
                },
              },
            },
          },
        ];
      },
    },
  };

  const result = await processShopifyOrderPaidSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 1001,
        currency: "JPY",
        line_items: [{ product_id: 911, price: "99", quantity: 1 }],
      },
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, true);
  assert.equal(result.sellerId, "seller_1");
  assert.equal(state.ledgerEntries[0].sellerStripeAccountId, null);
  assert.equal(state.ledgerEntries[0].stripeAccountId, null);
  assert.equal(
    state.ledgerEntries[0].metadataJson.settlementMode,
    "shopify_order_to_monthly_settlement",
  );
});

test("processShopifyOrderPaidSettlement is idempotent by Shopify order id", async () => {
  const existingLedgerEntry = {
    id: "ledger_existing",
    entryType: "shopify_order_paid",
    stripeObjectId: "gid://shopify/Order/1001",
  };
  const fakePrisma = {
    ledgerEntry: {
      async findFirst() {
        return existingLedgerEntry;
      },
      async create() {
        throw new Error(
          "duplicate order should not create another ledger entry",
        );
      },
    },
    product: {
      async findMany() {
        throw new Error("duplicate order should not load products");
      },
    },
  };

  const result = await processShopifyOrderPaidSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 1001,
        currency: "JPY",
        line_items: [{ product_id: 911, price: "1000", quantity: 1 }],
      },
    },
    { prismaClient: fakePrisma },
  );

  assert.deepEqual(result, {
    ok: true,
    duplicate: true,
    ledgerEntry: existingLedgerEntry,
  });
});

test("processShopifyOrderPaidSettlement retries a missing shadow write for duplicate paid orders", async () => {
  const existingLedgerEntry = {
    id: "ledger_existing_shadow_retry",
    sellerId: "seller_1",
    entryType: "shopify_order_paid",
    stripeObjectId: "gid://shopify/Order/1001",
    amount: 900,
    currencyCode: "jpy",
  };
  const state = {
    marketplaceOrders: new Map(),
    sellerOrders: new Map(),
    sellerOrderLines: new Map(),
    sellerOrderShadowChecks: [],
  };
  let productLookups = 0;
  const fakePrisma = {
    ...createSellerOrderShadowFakeModels(state),
    ledgerEntry: {
      async findFirst() {
        return existingLedgerEntry;
      },
      async create() {
        throw new Error(
          "duplicate order should not create another ledger entry",
        );
      },
    },
    product: {
      async findMany() {
        productLookups += 1;
        return [
          {
            id: "product_1",
            name: "Duplicate Shadow Product",
            approvalStatus: "approved",
            shopifyProductId: "gid://shopify/Product/911",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStoreId: "store_1",
            vendorStore: {
              id: "store_1",
              storeName: "Shadow Store",
              seller: {
                id: "seller_1",
                status: "active",
                stripeAccount: null,
              },
              vendorAuth: null,
            },
          },
        ];
      },
    },
  };
  const order = {
    shop: "b30ize-1a.myshopify.com",
    payload: {
      id: 1001,
      admin_graphql_api_id: "gid://shopify/Order/1001",
      name: "#1001",
      currency: "JPY",
      line_items: [
        {
          id: 501,
          product_id: 911,
          price: "900",
          quantity: 1,
        },
      ],
    },
  };

  const firstResult = await processShopifyOrderPaidSettlement(order, {
    prismaClient: fakePrisma,
    env: { SELLER_ORDER_SHADOW_WRITE_ENABLED: "true" },
  });
  const secondResult = await processShopifyOrderPaidSettlement(order, {
    prismaClient: fakePrisma,
    env: { SELLER_ORDER_SHADOW_WRITE_ENABLED: "true" },
  });

  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.duplicate, true);
  assert.equal(firstResult.sellerOrderShadow.status, "matched");
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.duplicate, true);
  assert.equal(secondResult.sellerOrderShadow, undefined);
  assert.equal(productLookups, 1);
  assert.equal(state.marketplaceOrders.size, 1);
  assert.equal(state.sellerOrders.size, 1);
  assert.equal(state.sellerOrderLines.size, 1);
  assert.equal(state.sellerOrderShadowChecks.length, 1);
});

test("processShopifyOrderPaidSettlement refuses multi-seller Shopify orders", async () => {
  const state = {
    ledgerEntries: [],
  };
  const fakePrisma = {
    ledgerEntry: {
      async findFirst() {
        return null;
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return data;
      },
    },
    product: {
      async findMany() {
        return [
          {
            id: "product_1",
            name: "Product 1",
            shopifyProductId: "gid://shopify/Product/1",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStore: {
              vendorAuth: {
                id: "vendor_1",
                handle: "vendor-1",
                seller: {
                  id: "seller_1",
                  status: "active",
                  stripeAccount: {
                    id: "ssa_1",
                    stripeAccountId: "acct_1",
                  },
                },
              },
            },
          },
          {
            id: "product_2",
            name: "Product 2",
            shopifyProductId: "gid://shopify/Product/2",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStore: {
              vendorAuth: {
                id: "vendor_2",
                handle: "vendor-2",
                seller: {
                  id: "seller_2",
                  status: "active",
                  stripeAccount: {
                    id: "ssa_2",
                    stripeAccountId: "acct_2",
                  },
                },
              },
            },
          },
        ];
      },
    },
  };

  const result = await processShopifyOrderPaidSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 1002,
        currency: "JPY",
        line_items: [
          { product_id: 1, price: "1000", quantity: 1 },
          { product_id: 2, price: "2000", quantity: 1 },
        ],
      },
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "multi_seller_shopify_order_unsupported");
  assert.deepEqual(result.sellerIds, ["seller_1", "seller_2"]);
  assert.equal(state.ledgerEntries.length, 0);
});

test("processShopifyOrderPaidSettlement records a shadow check for unsupported multi-seller orders", async () => {
  const state = {
    ledgerEntries: [],
    marketplaceOrders: new Map(),
    sellerOrders: new Map(),
    sellerOrderLines: new Map(),
    sellerOrderShadowChecks: [],
  };
  const fakePrisma = {
    ...createSellerOrderShadowFakeModels(state),
    ledgerEntry: {
      async findFirst() {
        return null;
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return data;
      },
    },
    product: {
      async findMany() {
        return [
          {
            id: "product_1",
            name: "Product 1",
            shopifyProductId: "gid://shopify/Product/1",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStoreId: "store_1",
            vendorStore: {
              id: "store_1",
              vendorAuth: {
                id: "vendor_1",
                handle: "vendor-1",
                seller: {
                  id: "seller_1",
                  status: "active",
                  stripeAccount: null,
                },
              },
            },
          },
          {
            id: "product_2",
            name: "Product 2",
            shopifyProductId: "gid://shopify/Product/2",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStoreId: "store_2",
            vendorStore: {
              id: "store_2",
              vendorAuth: {
                id: "vendor_2",
                handle: "vendor-2",
                seller: {
                  id: "seller_2",
                  status: "active",
                  stripeAccount: null,
                },
              },
            },
          },
        ];
      },
    },
  };

  const result = await processShopifyOrderPaidSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 1201,
        admin_graphql_api_id: "gid://shopify/Order/1201",
        name: "#1201",
        currency: "JPY",
        line_items: [
          { id: 11, product_id: 1, price: "1000", quantity: 1 },
          { id: 12, product_id: 2, price: "2000", quantity: 1 },
        ],
      },
    },
    {
      prismaClient: fakePrisma,
      env: { SELLER_ORDER_SHADOW_WRITE_ENABLED: "true" },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "multi_seller_shopify_order_unsupported");
  assert.equal(state.ledgerEntries.length, 0);
  assert.equal(state.marketplaceOrders.size, 1);
  assert.equal(state.sellerOrders.size, 0);
  assert.equal(state.sellerOrderLines.size, 0);
  assert.equal(state.sellerOrderShadowChecks.length, 1);
  assert.equal(
    state.sellerOrderShadowChecks[0].status,
    "multi_seller_detected",
  );
  assert.equal(state.sellerOrderShadowChecks[0].currencyCode, "jpy");
  assert.deepEqual(state.sellerOrderShadowChecks[0].sellerOrderSellerIdsJson, [
    "seller_1",
    "seller_2",
  ]);
  assert.equal(
    state.sellerOrderShadowChecks[0].sellerOrderCalculatedAmount,
    3000,
  );
});

test("processShopifyOrderPaidSettlement can process active and pending multi-seller orders behind a flag", async () => {
  const state = {
    ledgerEntries: [],
    marketplaceOrders: new Map(),
    sellerOrders: new Map(),
    sellerOrderLines: new Map(),
    sellerOrderShadowChecks: [],
  };
  const fakePrisma = {
    ...createSellerOrderShadowFakeModels(state),
    ledgerEntry: {
      async findFirst() {
        return null;
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `ledger_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
    product: {
      async findMany() {
        return [
          {
            id: "product_1",
            name: "Product 1",
            shopifyProductId: "gid://shopify/Product/1",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStoreId: "store_1",
            vendorStore: {
              id: "store_1",
              vendorAuth: {
                id: "vendor_1",
                handle: "vendor-1",
                seller: {
                  id: "seller_1",
                  status: "active",
                  stripeAccount: null,
                },
              },
            },
          },
          {
            id: "product_2",
            name: "Product 2",
            shopifyProductId: "gid://shopify/Product/2",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStoreId: "store_2",
            vendorStore: {
              id: "store_2",
              vendorAuth: {
                id: "vendor_2",
                handle: "vendor-2",
                seller: {
                  id: "seller_2",
                  status: "pending",
                  stripeAccount: null,
                },
              },
            },
          },
        ];
      },
    },
  };

  const result = await processShopifyOrderPaidSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 1202,
        admin_graphql_api_id: "gid://shopify/Order/1202",
        name: "#1202",
        currency: "JPY",
        line_items: [
          { id: 21, product_id: 1, price: "1000", quantity: 1 },
          { id: 22, product_id: 2, price: "2000", quantity: 1 },
        ],
      },
    },
    {
      prismaClient: fakePrisma,
      env: {
        SELLER_ORDER_SHADOW_WRITE_ENABLED: "true",
        MULTI_SELLER_SHOPIFY_ORDER_SETTLEMENT_ENABLED: "true",
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.multiSeller, true);
  assert.deepEqual(result.sellerIds, ["seller_1", "seller_2"]);
  assert.equal(result.amount, 3000);
  assert.equal(state.ledgerEntries.length, 2);
  assert.equal(state.ledgerEntries[0].sellerId, "seller_1");
  assert.equal(state.ledgerEntries[0].amount, 1000);
  assert.equal(state.ledgerEntries[1].sellerId, "seller_2");
  assert.equal(state.ledgerEntries[1].amount, 2000);
  assert.equal(state.sellerOrders.size, 2);
  assert.equal(state.sellerOrderLines.size, 2);
  assert.equal(state.sellerOrderShadowChecks.length, 1);
  assert.equal(state.sellerOrderShadowChecks[0].status, "shadow_written");
});

test("processShopifyRefundSettlement records a seller refund debit ledger entry", async () => {
  const state = {
    ledgerEntries: [],
    sellerOrder: {
      id: "seller_order_1",
      sellerRefundAmount: 0,
      sellerPayableAmount: 99,
      sellerNetAmount: 99,
      paymentStatus: "paid",
    },
    sellerOrderLine: {
      id: "seller_order_line_1",
      shopifyLineItemId: "gid://shopify/LineItem/501",
      refundedQuantity: 0,
    },
  };
  const fakePrisma = {
    ledgerEntry: {
      async findFirst({ where }) {
        assert.deepEqual(where, {
          entryType: "refund",
          stripeObjectId: "gid://shopify/Refund/2001",
        });
        return null;
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `le_${state.ledgerEntries.length}`,
          ...data,
        };
      },
      async findMany({ where }) {
        assert.deepEqual(where.entryType.in, [
          "shopify_order_paid",
          "refund",
          "shopify_order_cancelled",
        ]);
        assert.deepEqual(where.OR, [
          { stripeObjectId: "gid://shopify/Order/1001" },
          {
            metadataJson: {
              path: ["shopifyOrderId"],
              equals: "gid://shopify/Order/1001",
            },
          },
        ]);
        return [
          {
            id: "ledger_paid",
            sellerId: "seller_1",
            sellerStripeAccountId: "ssa_1",
            stripeAccountId: "acct_123",
            entryType: "shopify_order_paid",
            stripeObjectId: "gid://shopify/Order/1001",
            amount: 99,
          },
        ];
      },
    },
    sellerOrder: {
      async findFirst({ where }) {
        assert.equal(where.shopDomain, undefined);
        assert.equal(where.shopifyOrderId, "gid://shopify/Order/1001");
        assert.equal(where.sellerId, "seller_1");
        assert.deepEqual(where.marketplaceOrder, {
          shopDomain: "b30ize-1a.myshopify.com",
        });
        return state.sellerOrder;
      },
      async update({ where, data }) {
        assert.deepEqual(where, {
          id: "seller_order_1",
        });
        state.sellerOrder = {
          ...state.sellerOrder,
          ...data,
        };
        return state.sellerOrder;
      },
    },
    sellerOrderLine: {
      async findMany({ where }) {
        assert.deepEqual(where.sellerOrderId, "seller_order_1");
        assert.ok(
          where.shopifyLineItemId.in.includes("gid://shopify/LineItem/501"),
        );
        return [state.sellerOrderLine];
      },
      async update({ where, data }) {
        assert.deepEqual(where, {
          id: "seller_order_line_1",
        });
        state.sellerOrderLine = {
          ...state.sellerOrderLine,
          ...data,
        };
        return state.sellerOrderLine;
      },
    },
    product: {
      async findMany({ where }) {
        assertShopifyProductLookupWhere(where, {
          shopDomain: "b30ize-1a.myshopify.com",
          productIds: ["gid://shopify/Product/911", "911"],
          variantIds: ["gid://shopify/ProductVariant/912", "912"],
        });
        return [
          {
            id: "product_1",
            name: "Test Product",
            approvalStatus: "approved",
            shopifyProductId: "gid://shopify/Product/911",
            shopifyVariantId: "gid://shopify/ProductVariant/912",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStoreId: "store_1",
            vendorStore: {
              id: "store_1",
              storeName: "Test Store",
              seller: null,
              vendorAuth: {
                id: "vendor_1",
                handle: "vendor",
                storeName: "Test Store",
                seller: {
                  id: "seller_1",
                  status: "active",
                  stripeAccount: {
                    id: "ssa_1",
                    stripeAccountId: "acct_123",
                  },
                },
              },
            },
          },
        ];
      },
    },
  };

  const result = await processShopifyRefundSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 2001,
        admin_graphql_api_id: "gid://shopify/Refund/2001",
        order_id: 1001,
        created_at: "2026-05-16T12:00:00Z",
        refund_line_items: [
          {
            id: 301,
            line_item_id: 501,
            quantity: 1,
            subtotal_set: {
              shop_money: {
                amount: "99",
                currency_code: "JPY",
              },
            },
            line_item: {
              id: 501,
              product_id: 911,
              variant_id: 912,
            },
          },
        ],
      },
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.sellerId, "seller_1");
  assert.equal(result.amount, 99);
  assert.equal(result.currencyCode, "jpy");
  assert.equal(state.ledgerEntries.length, 1);
  assert.equal(state.ledgerEntries[0].entryType, "refund");
  assert.equal(state.ledgerEntries[0].direction, "debit");
  assert.equal(state.ledgerEntries[0].sellerId, "seller_1");
  assert.equal(state.ledgerEntries[0].sellerStripeAccountId, "ssa_1");
  assert.equal(state.ledgerEntries[0].stripeAccountId, "acct_123");
  assert.equal(
    state.ledgerEntries[0].stripeObjectId,
    "gid://shopify/Refund/2001",
  );
  assert.equal(
    state.ledgerEntries[0].metadataJson.shopifyOrderId,
    "gid://shopify/Order/1001",
  );
  assert.equal(state.ledgerEntries[0].metadataJson.vendorHandle, "vendor");
  assert.equal(state.ledgerEntries[0].metadataJson.lineItems[0].amount, 99);
  assert.equal(state.sellerOrder.sellerRefundAmount, 99);
  assert.equal(state.sellerOrder.paymentStatus, "refunded");
  assert.equal(state.sellerOrderLine.refundedQuantity, 1);
  assert.equal(result.sellerOrderShadowRefund.updatedLineCount, 1);
});

test("processShopifyRefundSettlement reverses sales credit on full discounted refunds", async () => {
  const state = {
    ledgerEntries: [],
    salesCreditOffset: {
      id: "sco_1",
      sellerId: "seller_buyer",
      amount: 1000,
      currencyCode: "jpy",
      status: "captured",
      checkoutReference: "draft-order:test",
      metadataJson: {
        targetSellerId: "seller_target",
      },
    },
  };
  const fakePrisma = {
    ledgerEntry: {
      async findFirst({ where }) {
        if (where.entryType === "refund") {
          return null;
        }

        if (where.entryType === "sales_credit_offset_refund_reversal") {
          return null;
        }

        return null;
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `le_${state.ledgerEntries.length}`,
          ...data,
        };
      },
      async findMany() {
        return [
          {
            id: "ledger_paid",
            sellerId: "seller_target",
            entryType: "shopify_order_paid",
            stripeObjectId: "gid://shopify/Order/1002",
            amount: 4000,
            metadataJson: {
              salesCreditOffsetId: "sco_1",
              salesCreditOffsetAmount: 1000,
              salesCreditBuyerSellerId: "seller_buyer",
              cashSettlementAmount: 3000,
            },
          },
        ];
      },
    },
    salesCreditOffset: {
      async findUnique({ where }) {
        return where.id === state.salesCreditOffset.id
          ? state.salesCreditOffset
          : null;
      },
      async update({ where, data }) {
        assert.equal(where.id, state.salesCreditOffset.id);
        state.salesCreditOffset = {
          ...state.salesCreditOffset,
          ...data,
        };
        return state.salesCreditOffset;
      },
    },
    product: {
      async findMany() {
        return [
          {
            id: "product_1",
            name: "Target Product",
            shopifyProductId: "gid://shopify/Product/911",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStore: {
              vendorAuth: {
                id: "vendor_target",
                handle: "target",
                seller: {
                  id: "seller_target",
                  status: "active",
                  stripeAccount: null,
                },
              },
            },
          },
        ];
      },
    },
  };

  const result = await processShopifyRefundSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 2002,
        admin_graphql_api_id: "gid://shopify/Refund/2002",
        order_id: 1002,
        currency: "JPY",
        refund_line_items: [
          {
            id: 601,
            line_item_id: 501,
            product_id: 911,
            quantity: 1,
            subtotal: "3000.00",
            line_item: {
              product_id: 911,
              price: "4000.00",
            },
          },
        ],
      },
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, true);
  assert.equal(result.amount, 4000);
  assert.equal(result.salesCreditReversal.ok, true);
  assert.equal(state.salesCreditOffset.status, "refunded");
  assert.equal(state.ledgerEntries.length, 2);
  assert.equal(state.ledgerEntries[0].entryType, "refund");
  assert.equal(state.ledgerEntries[0].sellerId, "seller_target");
  assert.equal(state.ledgerEntries[0].direction, "debit");
  assert.equal(state.ledgerEntries[0].amount, 4000);
  assert.equal(
    state.ledgerEntries[0].metadataJson.salesCreditOffsetReversed,
    true,
  );
  assert.equal(
    state.ledgerEntries[1].entryType,
    "sales_credit_offset_refund_reversal",
  );
  assert.equal(state.ledgerEntries[1].sellerId, "seller_buyer");
  assert.equal(state.ledgerEntries[1].direction, "credit");
  assert.equal(state.ledgerEntries[1].amount, 1000);
});

test("processShopifyRefundSettlement is idempotent by Shopify refund id", async () => {
  const existingLedgerEntry = {
    id: "ledger_existing",
    entryType: "refund",
    stripeObjectId: "gid://shopify/Refund/2001",
  };
  const fakePrisma = {
    ledgerEntry: {
      async findFirst() {
        return existingLedgerEntry;
      },
      async create() {
        throw new Error(
          "duplicate refund should not create another ledger entry",
        );
      },
    },
    product: {
      async findMany() {
        throw new Error("duplicate refund should not load products");
      },
    },
  };

  const result = await processShopifyRefundSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 2001,
        order_id: 1001,
        refund_line_items: [
          {
            line_item_id: 501,
            quantity: 1,
            subtotal: 99,
            line_item: {
              product_id: 911,
            },
          },
        ],
      },
    },
    { prismaClient: fakePrisma },
  );

  assert.deepEqual(result, {
    ok: true,
    duplicate: true,
    ledgerEntry: existingLedgerEntry,
  });
});

test("processShopifyRefundSettlement refuses multi-seller Shopify refunds", async () => {
  const state = {
    ledgerEntries: [],
  };
  const fakePrisma = {
    ledgerEntry: {
      async findFirst() {
        return null;
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return data;
      },
    },
    product: {
      async findMany() {
        return [
          {
            id: "product_1",
            name: "Product 1",
            shopifyProductId: "gid://shopify/Product/1",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStore: {
              vendorAuth: {
                id: "vendor_1",
                handle: "vendor-1",
                seller: {
                  id: "seller_1",
                  status: "active",
                  stripeAccount: {
                    id: "ssa_1",
                    stripeAccountId: "acct_1",
                  },
                },
              },
            },
          },
          {
            id: "product_2",
            name: "Product 2",
            shopifyProductId: "gid://shopify/Product/2",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStore: {
              vendorAuth: {
                id: "vendor_2",
                handle: "vendor-2",
                seller: {
                  id: "seller_2",
                  status: "active",
                  stripeAccount: {
                    id: "ssa_2",
                    stripeAccountId: "acct_2",
                  },
                },
              },
            },
          },
        ];
      },
    },
  };

  const result = await processShopifyRefundSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 2002,
        order_id: 1002,
        refund_line_items: [
          {
            line_item_id: 1,
            quantity: 1,
            subtotal: 1000,
            line_item: {
              product_id: 1,
            },
          },
          {
            line_item_id: 2,
            quantity: 1,
            subtotal: 2000,
            line_item: {
              product_id: 2,
            },
          },
        ],
      },
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "multi_seller_shopify_refund_unsupported");
  assert.deepEqual(result.sellerIds, ["seller_1", "seller_2"]);
  assert.equal(state.ledgerEntries.length, 0);
});

test("processShopifyRefundSettlement can process multi-seller refunds behind a flag", async () => {
  const state = {
    ledgerEntries: [],
  };
  const fakePrisma = {
    ledgerEntry: {
      async findFirst() {
        return null;
      },
      async findMany() {
        return [
          {
            id: "ledger_paid_1",
            sellerId: "seller_1",
            entryType: "shopify_order_paid",
            stripeObjectId: "gid://shopify/Order/1003",
            amount: 1000,
          },
          {
            id: "ledger_paid_2",
            sellerId: "seller_2",
            entryType: "shopify_order_paid",
            stripeObjectId: "gid://shopify/Order/1003",
            amount: 2000,
          },
        ];
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `ledger_refund_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
    product: {
      async findMany() {
        return [
          {
            id: "product_1",
            name: "Product 1",
            shopifyProductId: "gid://shopify/Product/1",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStore: {
              vendorAuth: {
                id: "vendor_1",
                handle: "vendor-1",
                seller: {
                  id: "seller_1",
                  status: "active",
                  stripeAccount: {
                    id: "ssa_1",
                    stripeAccountId: "acct_1",
                  },
                },
              },
            },
          },
          {
            id: "product_2",
            name: "Product 2",
            shopifyProductId: "gid://shopify/Product/2",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStore: {
              vendorAuth: {
                id: "vendor_2",
                handle: "vendor-2",
                seller: {
                  id: "seller_2",
                  status: "active",
                  stripeAccount: {
                    id: "ssa_2",
                    stripeAccountId: "acct_2",
                  },
                },
              },
            },
          },
        ];
      },
    },
  };

  const result = await processShopifyRefundSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 2003,
        admin_graphql_api_id: "gid://shopify/Refund/2003",
        order_id: 1003,
        refund_line_items: [
          {
            id: 701,
            line_item_id: 1,
            quantity: 1,
            subtotal: 1000,
            line_item: {
              product_id: 1,
            },
          },
          {
            id: 702,
            line_item_id: 2,
            quantity: 1,
            subtotal: 2000,
            line_item: {
              product_id: 2,
            },
          },
        ],
      },
    },
    {
      prismaClient: fakePrisma,
      env: {
        MULTI_SELLER_SHOPIFY_REFUND_SETTLEMENT_ENABLED: "true",
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.multiSeller, true);
  assert.deepEqual(result.sellerIds, ["seller_1", "seller_2"]);
  assert.equal(result.amount, 3000);
  assert.equal(state.ledgerEntries.length, 2);
  assert.equal(state.ledgerEntries[0].sellerId, "seller_1");
  assert.equal(state.ledgerEntries[0].amount, 1000);
  assert.equal(state.ledgerEntries[1].sellerId, "seller_2");
  assert.equal(state.ledgerEntries[1].amount, 2000);
  assert.equal(
    state.ledgerEntries[0].metadataJson.multiSellerRefundSettlement,
    true,
  );
  assert.equal(
    state.ledgerEntries[1].metadataJson.multiSellerRefundSettlement,
    true,
  );
});

test("processShopifyRefundSettlement skips refund debit for sellers without paid credit", async () => {
  const state = {
    ledgerEntries: [],
  };
  const fakePrisma = {
    ledgerEntry: {
      async findFirst() {
        return null;
      },
      async findMany() {
        return [
          {
            id: "ledger_paid_1",
            sellerId: "seller_1",
            entryType: "shopify_order_paid",
            stripeObjectId: "gid://shopify/Order/1004",
            amount: 1000,
          },
        ];
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `ledger_refund_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
    product: {
      async findMany() {
        return [
          {
            id: "product_1",
            name: "Product 1",
            shopifyProductId: "gid://shopify/Product/1",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStore: {
              vendorAuth: {
                id: "vendor_1",
                handle: "vendor-1",
                seller: {
                  id: "seller_1",
                  status: "active",
                  stripeAccount: null,
                },
              },
            },
          },
          {
            id: "product_2",
            name: "Product 2",
            shopifyProductId: "gid://shopify/Product/2",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStore: {
              vendorAuth: {
                id: "vendor_2",
                handle: "vendor-2",
                seller: {
                  id: "seller_2",
                  status: "active",
                  stripeAccount: null,
                },
              },
            },
          },
        ];
      },
    },
  };

  const result = await processShopifyRefundSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 2004,
        admin_graphql_api_id: "gid://shopify/Refund/2004",
        order_id: 1004,
        refund_line_items: [
          {
            id: 801,
            line_item_id: 1,
            quantity: 1,
            subtotal: 1000,
            line_item: {
              product_id: 1,
            },
          },
          {
            id: 802,
            line_item_id: 2,
            quantity: 1,
            subtotal: 2000,
            line_item: {
              product_id: 2,
            },
          },
        ],
      },
    },
    {
      prismaClient: fakePrisma,
      env: {
        MULTI_SELLER_SHOPIFY_REFUND_SETTLEMENT_ENABLED: "true",
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.multiSeller, true);
  assert.deepEqual(result.sellerIds, ["seller_1", "seller_2"]);
  assert.equal(result.amount, 1000);
  assert.equal(state.ledgerEntries.length, 1);
  assert.equal(state.ledgerEntries[0].sellerId, "seller_1");
  assert.equal(state.ledgerEntries[0].amount, 1000);
});

test("processShopifyRefundSettlement does not double debit after order cancellation reversal", async () => {
  const state = {
    ledgerEntries: [],
  };
  const fakePrisma = {
    ledgerEntry: {
      async findFirst() {
        return null;
      },
      async findMany() {
        return [
          {
            id: "ledger_paid",
            sellerId: "seller_1",
            entryType: "shopify_order_paid",
            stripeObjectId: "gid://shopify/Order/1001",
            amount: 99,
          },
          {
            id: "ledger_cancelled",
            sellerId: "seller_1",
            entryType: "shopify_order_cancelled",
            stripeObjectId: "gid://shopify/Order/1001",
            amount: 99,
          },
        ];
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return data;
      },
    },
    product: {
      async findMany() {
        return [
          {
            id: "product_1",
            name: "Product 1",
            shopifyProductId: "gid://shopify/Product/1",
            shopDomain: "b30ize-1a.myshopify.com",
            vendorStore: {
              vendorAuth: {
                id: "vendor_1",
                handle: "vendor",
                seller: {
                  id: "seller_1",
                  status: "active",
                  stripeAccount: {
                    id: "ssa_1",
                    stripeAccountId: "acct_1",
                  },
                },
              },
            },
          },
        ];
      },
    },
  };

  const result = await processShopifyRefundSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 2003,
        order_id: 1001,
        refund_line_items: [
          {
            line_item_id: 1,
            quantity: 1,
            subtotal: 99,
            line_item: {
              product_id: 1,
            },
          },
        ],
      },
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, "shopify_refund_order_already_reversed");
  assert.equal(result.amount, 0);
  assert.equal(state.ledgerEntries.length, 0);
});

test("processShopifyOrderCancelledSettlement reverses the unpaid seller payout balance", async () => {
  const state = {
    ledgerEntries: [],
    sellerOrder: {
      id: "seller_order_1",
      sellerRefundAmount: 0,
      sellerPayableAmount: 99,
      sellerNetAmount: 99,
      paymentStatus: "paid",
    },
  };
  const fakePrisma = {
    ledgerEntry: {
      async findFirst({ where }) {
        assert.deepEqual(where, {
          entryType: "shopify_order_cancelled",
          stripeObjectId: "gid://shopify/Order/1001",
        });
        return null;
      },
      async findMany({ where }) {
        assert.deepEqual(where.entryType.in, [
          "shopify_order_paid",
          "refund",
          "shopify_order_cancelled",
        ]);
        assert.deepEqual(where.OR, [
          { stripeObjectId: "gid://shopify/Order/1001" },
          {
            metadataJson: {
              path: ["shopifyOrderId"],
              equals: "gid://shopify/Order/1001",
            },
          },
        ]);
        return [
          {
            id: "ledger_paid",
            sellerId: "seller_1",
            sellerStripeAccountId: "ssa_1",
            stripeAccountId: "acct_123",
            entryType: "shopify_order_paid",
            stripeObjectId: "gid://shopify/Order/1001",
            amount: 99,
          },
        ];
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `le_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
    sellerOrder: {
      async findFirst({ where, select }) {
        assert.deepEqual(where, {
          shopifyOrderId: "gid://shopify/Order/1001",
          sellerId: "seller_1",
          marketplaceOrder: {
            shopDomain: "b30ize-1a.myshopify.com",
          },
        });
        assert.equal(select.sellerRefundAmount, true);
        assert.equal(select.sellerPayableAmount, true);
        return state.sellerOrder;
      },
      async update({ where, data }) {
        assert.deepEqual(where, {
          id: "seller_order_1",
        });
        state.sellerOrder = {
          ...state.sellerOrder,
          ...data,
        };
        return state.sellerOrder;
      },
    },
  };

  const result = await processShopifyOrderCancelledSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 1001,
        admin_graphql_api_id: "gid://shopify/Order/1001",
        name: "#1001",
        currency: "JPY",
        cancel_reason: "customer",
        cancelled_at: "2026-05-16T12:00:00Z",
      },
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.sellerId, "seller_1");
  assert.equal(result.amount, 99);
  assert.equal(result.currencyCode, "jpy");
  assert.equal(state.ledgerEntries.length, 1);
  assert.equal(state.ledgerEntries[0].entryType, "shopify_order_cancelled");
  assert.equal(state.ledgerEntries[0].direction, "debit");
  assert.equal(state.ledgerEntries[0].sellerId, "seller_1");
  assert.equal(state.ledgerEntries[0].sellerStripeAccountId, "ssa_1");
  assert.equal(state.ledgerEntries[0].stripeAccountId, "acct_123");
  assert.equal(
    state.ledgerEntries[0].stripeObjectId,
    "gid://shopify/Order/1001",
  );
  assert.equal(state.ledgerEntries[0].metadataJson.cancelReason, "customer");
  assert.equal(state.sellerOrder.sellerRefundAmount, 99);
  assert.equal(state.sellerOrder.paymentStatus, "cancelled");
  assert.equal(result.sellerOrderShadowCancellation.ok, true);
  assert.equal(result.sellerOrderShadowCancellation.refundAmount, 99);
});

test("processShopifyOrderCancelledSettlement only reverses the remaining unpaid balance", async () => {
  const state = {
    ledgerEntries: [],
  };
  const fakePrisma = {
    ledgerEntry: {
      async findFirst() {
        return null;
      },
      async findMany() {
        return [
          {
            id: "ledger_paid",
            sellerId: "seller_1",
            sellerStripeAccountId: "ssa_1",
            stripeAccountId: "acct_123",
            entryType: "shopify_order_paid",
            stripeObjectId: "gid://shopify/Order/1001",
            amount: 1000,
          },
          {
            id: "ledger_refund",
            sellerId: "seller_1",
            entryType: "refund",
            stripeObjectId: "gid://shopify/Refund/2001",
            amount: 400,
            metadataJson: {
              shopifyOrderId: "gid://shopify/Order/1001",
            },
          },
        ];
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return data;
      },
    },
  };

  const result = await processShopifyOrderCancelledSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 1001,
        currency: "JPY",
        cancel_reason: "customer",
      },
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, true);
  assert.equal(result.amount, 600);
  assert.equal(state.ledgerEntries.length, 1);
  assert.equal(state.ledgerEntries[0].amount, 600);
});

test("processShopifyOrderCancelledSettlement can process multi-seller cancellations behind a flag", async () => {
  const state = {
    ledgerEntries: [],
  };
  const fakePrisma = {
    ledgerEntry: {
      async findFirst() {
        return null;
      },
      async findMany() {
        return [
          {
            id: "ledger_paid_1",
            sellerId: "seller_1",
            sellerStripeAccountId: "ssa_1",
            stripeAccountId: "acct_1",
            entryType: "shopify_order_paid",
            stripeObjectId: "gid://shopify/Order/1004",
            amount: 1000,
          },
          {
            id: "ledger_paid_2",
            sellerId: "seller_2",
            sellerStripeAccountId: "ssa_2",
            stripeAccountId: "acct_2",
            entryType: "shopify_order_paid",
            stripeObjectId: "gid://shopify/Order/1004",
            amount: 2000,
          },
        ];
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `ledger_cancelled_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
  };

  const result = await processShopifyOrderCancelledSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      payload: {
        id: 1004,
        admin_graphql_api_id: "gid://shopify/Order/1004",
        name: "#1004",
        currency: "JPY",
        cancel_reason: "customer",
        cancelled_at: "2026-05-16T12:00:00Z",
      },
    },
    {
      prismaClient: fakePrisma,
      env: {
        MULTI_SELLER_SHOPIFY_CANCELLED_SETTLEMENT_ENABLED: "true",
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.multiSeller, true);
  assert.deepEqual(result.sellerIds, ["seller_1", "seller_2"]);
  assert.equal(result.amount, 3000);
  assert.equal(state.ledgerEntries.length, 2);
  assert.equal(state.ledgerEntries[0].sellerId, "seller_1");
  assert.equal(state.ledgerEntries[0].amount, 1000);
  assert.equal(state.ledgerEntries[1].sellerId, "seller_2");
  assert.equal(state.ledgerEntries[1].amount, 2000);
  assert.equal(
    state.ledgerEntries[0].metadataJson.multiSellerCancelledSettlement,
    true,
  );
  assert.equal(
    state.ledgerEntries[1].metadataJson.multiSellerCancelledSettlement,
    true,
  );
});

test("processShopifyDisputeSettlement holds seller payout balance and marks seller review", async () => {
  const state = {
    seller: {
      id: "seller_1",
      status: "active",
      statusReason: null,
    },
    statusHistory: [],
    ledgerEntries: [],
    sellerOrder: {
      id: "seller_order_1",
      riskStatus: "normal",
    },
  };
  const fakePrisma = {
    ledgerEntry: {
      async findMany({ where }) {
        assert.deepEqual(where.entryType.in, [
          "shopify_order_paid",
          "refund",
          "shopify_order_cancelled",
          "dispute_created",
          "dispute_funds_reinstated",
        ]);
        assert.deepEqual(where.OR, [
          { stripeObjectId: "gid://shopify/Order/1001" },
          {
            metadataJson: {
              path: ["shopifyOrderId"],
              equals: "gid://shopify/Order/1001",
            },
          },
        ]);
        return [
          {
            id: "ledger_paid",
            sellerId: "seller_1",
            sellerStripeAccountId: "ssa_1",
            stripeAccountId: "acct_123",
            entryType: "shopify_order_paid",
            stripeObjectId: "gid://shopify/Order/1001",
            amount: 99,
            currencyCode: "jpy",
          },
        ];
      },
      async findFirst({ where }) {
        assert.deepEqual(where, {
          entryType: "dispute_created",
          stripeObjectId: "gid://shopify/ShopifyPaymentsDispute/3001",
        });
        return null;
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `le_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
    seller: {
      async findUnique({ where }) {
        assert.deepEqual(where, { id: "seller_1" });
        return state.seller;
      },
      async update({ where, data }) {
        assert.deepEqual(where, { id: "seller_1" });
        state.seller = {
          ...state.seller,
          ...data,
        };
        return state.seller;
      },
    },
    sellerStatusHistory: {
      async create({ data }) {
        state.statusHistory.push(data);
        return data;
      },
    },
    sellerOrder: {
      async findFirst({ where }) {
        assert.deepEqual(where, {
          shopifyOrderId: "gid://shopify/Order/1001",
          sellerId: "seller_1",
          marketplaceOrder: {
            shopDomain: "b30ize-1a.myshopify.com",
          },
        });
        return state.sellerOrder;
      },
      async update({ where, data }) {
        assert.deepEqual(where, {
          id: "seller_order_1",
        });
        state.sellerOrder = {
          ...state.sellerOrder,
          ...data,
        };
        return state.sellerOrder;
      },
    },
    async $transaction(callback) {
      return callback(fakePrisma);
    },
  };

  const result = await processShopifyDisputeSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      topic: "disputes/create",
      payload: {
        id: 3001,
        order_id: 1001,
        type: "chargeback",
        amount: "70",
        currency: "JPY",
        reason: "fraudulent",
        status: "needs_response",
        initiated_at: "2026-05-16T12:00:00Z",
      },
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.sellerId, "seller_1");
  assert.equal(result.amount, 70);
  assert.equal(state.seller.status, "review");
  assert.equal(state.seller.statusReason, "dispute_review_required");
  assert.equal(state.statusHistory[0].changedBy, "shopify.disputes/create");
  assert.equal(state.ledgerEntries.length, 1);
  assert.equal(state.ledgerEntries[0].entryType, "dispute_created");
  assert.equal(state.ledgerEntries[0].direction, "debit");
  assert.equal(state.ledgerEntries[0].sellerId, "seller_1");
  assert.equal(state.ledgerEntries[0].sellerStripeAccountId, "ssa_1");
  assert.equal(state.ledgerEntries[0].stripeAccountId, "acct_123");
  assert.equal(
    state.ledgerEntries[0].stripeObjectId,
    "gid://shopify/ShopifyPaymentsDispute/3001",
  );
  assert.equal(
    state.ledgerEntries[0].metadataJson.shopifyOrderId,
    "gid://shopify/Order/1001",
  );
  assert.equal(
    state.ledgerEntries[0].metadataJson.disputeStatus,
    "needs_response",
  );
  assert.equal(state.sellerOrder.riskStatus, "disputed");
  assert.equal(result.sellerOrderShadowRisk.ok, true);
});

test("processShopifyDisputeSettlement releases held funds when dispute is won", async () => {
  const state = {
    ledgerEntries: [],
    sellerOrder: {
      id: "seller_order_1",
      riskStatus: "disputed",
    },
  };
  const fakePrisma = {
    ledgerEntry: {
      async findMany() {
        return [
          {
            id: "ledger_paid",
            sellerId: "seller_1",
            sellerStripeAccountId: "ssa_1",
            stripeAccountId: "acct_123",
            entryType: "shopify_order_paid",
            stripeObjectId: "gid://shopify/Order/1001",
            amount: 99,
            currencyCode: "jpy",
          },
          {
            id: "ledger_dispute",
            sellerId: "seller_1",
            sellerStripeAccountId: "ssa_1",
            stripeAccountId: "acct_123",
            entryType: "dispute_created",
            stripeObjectId: "gid://shopify/ShopifyPaymentsDispute/3001",
            amount: 70,
            currencyCode: "jpy",
            metadataJson: {
              shopifyOrderId: "gid://shopify/Order/1001",
            },
          },
        ];
      },
      async findFirst({ where }) {
        assert.deepEqual(where, {
          entryType: "dispute_funds_reinstated",
          stripeObjectId: "gid://shopify/ShopifyPaymentsDispute/3001",
        });
        return null;
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `le_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
    sellerOrder: {
      async findFirst({ where }) {
        assert.deepEqual(where, {
          shopifyOrderId: "gid://shopify/Order/1001",
          sellerId: "seller_1",
          marketplaceOrder: {
            shopDomain: "b30ize-1a.myshopify.com",
          },
        });
        return state.sellerOrder;
      },
      async update({ where, data }) {
        assert.deepEqual(where, {
          id: "seller_order_1",
        });
        state.sellerOrder = {
          ...state.sellerOrder,
          ...data,
        };
        return state.sellerOrder;
      },
    },
  };

  const result = await processShopifyDisputeSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      topic: "disputes/update",
      payload: {
        id: 3001,
        order_id: 1001,
        type: "chargeback",
        amount: "99",
        currency: "JPY",
        reason: "fraudulent",
        status: "won",
        finalized_on: "2026-05-18T12:00:00Z",
      },
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.sellerId, "seller_1");
  assert.equal(result.amount, 70);
  assert.equal(state.ledgerEntries.length, 1);
  assert.equal(state.ledgerEntries[0].entryType, "dispute_funds_reinstated");
  assert.equal(state.ledgerEntries[0].direction, "credit");
  assert.equal(state.ledgerEntries[0].amount, 70);
  assert.equal(
    state.ledgerEntries[0].metadataJson.shopifyOrderId,
    "gid://shopify/Order/1001",
  );
  assert.equal(state.ledgerEntries[0].metadataJson.disputeStatus, "won");
  assert.equal(state.sellerOrder.riskStatus, "normal");
  assert.equal(result.sellerOrderShadowRisk.ok, true);
});

test("processShopifyDisputeSettlement can hold multi-seller disputes behind a flag", async () => {
  const state = {
    sellers: {
      seller_1: { id: "seller_1", status: "active", statusReason: null },
      seller_2: { id: "seller_2", status: "active", statusReason: null },
    },
    statusHistory: [],
    ledgerEntries: [],
    sellerOrderUpdates: [],
    riskLedgerEntries: [
      {
        id: "ledger_paid_1",
        sellerId: "seller_1",
        sellerStripeAccountId: "ssa_1",
        stripeAccountId: "acct_1",
        entryType: "shopify_order_paid",
        stripeObjectId: "gid://shopify/Order/2001",
        amount: 1000,
        currencyCode: "jpy",
      },
      {
        id: "ledger_paid_2",
        sellerId: "seller_2",
        sellerStripeAccountId: "ssa_2",
        stripeAccountId: "acct_2",
        entryType: "shopify_order_paid",
        stripeObjectId: "gid://shopify/Order/2001",
        amount: 3000,
        currencyCode: "jpy",
      },
    ],
  };
  const fakePrisma = {
    ledgerEntry: {
      async findMany() {
        return state.riskLedgerEntries;
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `le_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
    seller: {
      async findUnique({ where }) {
        return state.sellers[where.id] || null;
      },
      async update({ where, data }) {
        state.sellers[where.id] = {
          ...state.sellers[where.id],
          ...data,
        };
        return state.sellers[where.id];
      },
    },
    sellerStatusHistory: {
      async create({ data }) {
        state.statusHistory.push(data);
        return data;
      },
    },
    sellerOrder: {
      async findFirst({ where }) {
        return {
          id: `seller_order_${where.sellerId}`,
          riskStatus: "normal",
        };
      },
      async update({ where, data }) {
        state.sellerOrderUpdates.push({ where, data });
        return {
          id: where.id,
          ...data,
        };
      },
    },
    async $transaction(callback) {
      return callback(fakePrisma);
    },
  };

  const result = await processShopifyDisputeSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      topic: "disputes/create",
      payload: {
        id: 4001,
        order_id: 2001,
        type: "chargeback",
        amount: "2000",
        currency: "JPY",
        reason: "fraudulent",
        status: "needs_response",
        initiated_at: "2026-06-20T12:00:00Z",
      },
    },
    {
      prismaClient: fakePrisma,
      env: { MULTI_SELLER_SHOPIFY_DISPUTE_SETTLEMENT_ENABLED: "true" },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.multiSeller, true);
  assert.equal(result.amount, 2000);
  assert.deepEqual(
    state.ledgerEntries.map((entry) => [entry.sellerId, entry.amount]),
    [
      ["seller_1", 500],
      ["seller_2", 1500],
    ],
  );
  assert.equal(state.ledgerEntries[0].entryType, "dispute_created");
  assert.equal(state.ledgerEntries[0].metadataJson.multiSellerDisputeSettlement, true);
  assert.equal(state.sellers.seller_1.status, "review");
  assert.equal(state.sellers.seller_2.status, "review");
  assert.equal(state.statusHistory.length, 2);
  assert.deepEqual(
    state.sellerOrderUpdates.map((update) => update.data.riskStatus),
    ["disputed", "disputed"],
  );
});

test("processShopifyDisputeSettlement can release multi-seller dispute holds behind a flag", async () => {
  const state = {
    ledgerEntries: [],
    sellerOrderUpdates: [],
    riskLedgerEntries: [
      {
        id: "ledger_paid_1",
        sellerId: "seller_1",
        entryType: "shopify_order_paid",
        stripeObjectId: "gid://shopify/Order/2001",
        amount: 1000,
        currencyCode: "jpy",
      },
      {
        id: "ledger_paid_2",
        sellerId: "seller_2",
        entryType: "shopify_order_paid",
        stripeObjectId: "gid://shopify/Order/2001",
        amount: 3000,
        currencyCode: "jpy",
      },
      {
        id: "ledger_dispute_1",
        sellerId: "seller_1",
        entryType: "dispute_created",
        stripeObjectId: "gid://shopify/ShopifyPaymentsDispute/4001",
        amount: 500,
        currencyCode: "jpy",
        metadataJson: {
          shopifyOrderId: "gid://shopify/Order/2001",
        },
      },
      {
        id: "ledger_dispute_2",
        sellerId: "seller_2",
        entryType: "dispute_created",
        stripeObjectId: "gid://shopify/ShopifyPaymentsDispute/4001",
        amount: 1500,
        currencyCode: "jpy",
        metadataJson: {
          shopifyOrderId: "gid://shopify/Order/2001",
        },
      },
    ],
  };
  const fakePrisma = {
    ledgerEntry: {
      async findMany() {
        return state.riskLedgerEntries;
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `le_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
    sellerOrder: {
      async findFirst({ where }) {
        return {
          id: `seller_order_${where.sellerId}`,
          riskStatus: "disputed",
        };
      },
      async update({ where, data }) {
        state.sellerOrderUpdates.push({ where, data });
        return {
          id: where.id,
          ...data,
        };
      },
    },
    async $transaction(callback) {
      return callback(fakePrisma);
    },
  };

  const result = await processShopifyDisputeSettlement(
    {
      shop: "b30ize-1a.myshopify.com",
      topic: "disputes/update",
      payload: {
        id: 4001,
        order_id: 2001,
        type: "chargeback",
        amount: "2000",
        currency: "JPY",
        reason: "fraudulent",
        status: "won",
        finalized_on: "2026-06-21T12:00:00Z",
      },
    },
    {
      prismaClient: fakePrisma,
      env: { MULTI_SELLER_SHOPIFY_DISPUTE_SETTLEMENT_ENABLED: "true" },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.multiSeller, true);
  assert.equal(result.amount, 2000);
  assert.deepEqual(
    state.ledgerEntries.map((entry) => [entry.sellerId, entry.amount]),
    [
      ["seller_1", 500],
      ["seller_2", 1500],
    ],
  );
  assert.equal(state.ledgerEntries[0].entryType, "dispute_funds_reinstated");
  assert.equal(state.ledgerEntries[0].direction, "credit");
  assert.equal(state.ledgerEntries[0].metadataJson.multiSellerDisputeSettlement, true);
  assert.deepEqual(
    state.sellerOrderUpdates.map((update) => update.data.riskStatus),
    ["normal", "normal"],
  );
});

test("calculateSellerPayoutableLedgerBalance treats platform fees and paid payouts as deductions", () => {
  const balance = calculateSellerPayoutableLedgerBalance([
    { entryType: "shopify_order_paid", amount: 10000 },
    { entryType: "shopify_order_cancelled", amount: 800 },
    { entryType: "charge", amount: 5000 },
    { entryType: "application_fee", amount: 1000 },
    { entryType: "application_fee_refund", amount: 200 },
    { entryType: "refund", amount: 1500 },
    { entryType: "dispute_created", amount: 700 },
    { entryType: "dispute_funds_reinstated", amount: 700 },
    { entryType: "payout_created", amount: 3000 },
    { entryType: "payout_paid", amount: 2000 },
  ]);

  assert.equal(balance, 9900);
});

test("calculateSellerPayoutableLedgerBalance applies ledger adjustments", () => {
  const balance = calculateSellerPayoutableLedgerBalance([
    { entryType: "refund", amount: 130 },
    { entryType: "ledger_adjustment", amount: 130 },
  ]);

  assert.equal(balance, 0);
});

test("calculateSellerPayoutableLedgerBalance deducts applied case set-offs", () => {
  const balance = calculateSellerPayoutableLedgerBalance([
    { entryType: "shopify_order_paid", amount: 1000 },
    { entryType: "case_adjustment", amount: 300 },
  ]);

  assert.equal(balance, 700);
});

test("repairSellerNegativeLedgerBalance creates a credit adjustment", async () => {
  const state = {
    ledgerEntries: [],
  };
  const fakePrisma = {
    async $transaction(callback) {
      return callback(fakePrisma);
    },
    seller: {
      async findUnique({ where }) {
        assert.equal(where.id, "seller_1");
        return {
          id: "seller_1",
          stripeAccount: {
            id: "ssa_1",
            stripeAccountId: "acct_1",
          },
          vendor: {
            id: "vendor_1",
          },
        };
      },
    },
    ledgerEntry: {
      async findMany({ where }) {
        assert.equal(where.sellerId, "seller_1");
        assert.equal(where.currencyCode, "jpy");
        return [{ entryType: "refund", amount: 130 }];
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: "ledger_adjustment_1",
          ...data,
        };
      },
    },
  };

  const result = await repairSellerNegativeLedgerBalance(
    {
      sellerId: "seller_1",
      currencyCode: "jpy",
      repairedBy: "admin-test",
    },
    {
      prismaClient: fakePrisma,
      now: new Date("2026-06-29T00:00:00.000Z"),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.repaired, true);
  assert.equal(result.amount, 130);
  assert.equal(result.previousPayoutableLedgerBalance, -130);
  assert.equal(state.ledgerEntries.length, 1);
  assert.equal(state.ledgerEntries[0].entryType, "ledger_adjustment");
  assert.equal(state.ledgerEntries[0].direction, "credit");
  assert.equal(state.ledgerEntries[0].amount, 130);
  assert.equal(state.ledgerEntries[0].sellerId, "seller_1");
  assert.equal(state.ledgerEntries[0].sellerStripeAccountId, "ssa_1");
  assert.equal(state.ledgerEntries[0].stripeAccountId, "acct_1");
  assert.equal(
    state.ledgerEntries[0].metadataJson.previousPayoutableLedgerBalance,
    -130,
  );
});

test("listSellerLedgerRepairCandidates detects order reversal overage even when seller balance is positive", async () => {
  const fakePrisma = {
    seller: {
      async findMany() {
        return [
          {
            id: "seller_1",
            status: "pending",
            vendor: {
              storeName: "Store 1",
              vendorStore: {
                storeName: "Store 1",
              },
            },
            ledgerEntries: [
              {
                id: "ledger_paid_other",
                sellerId: "seller_1",
                entryType: "shopify_order_paid",
                stripeObjectId: "gid://shopify/Order/2000",
                amount: 1000,
                currencyCode: "jpy",
                metadataJson: {
                  shopifyOrderId: "gid://shopify/Order/2000",
                  shopifyOrderName: "#2000",
                },
                occurredAt: new Date("2026-06-29T00:00:00.000Z"),
                createdAt: new Date("2026-06-29T00:00:00.000Z"),
              },
              {
                id: "ledger_refund_orphan",
                sellerId: "seller_1",
                entryType: "refund",
                stripeObjectId: "gid://shopify/Refund/3000",
                amount: 130,
                currencyCode: "jpy",
                metadataJson: {
                  shopifyOrderId: "gid://shopify/Order/1000",
                  shopifyOrderName: "#1000",
                },
                occurredAt: new Date("2026-06-29T00:00:00.000Z"),
                createdAt: new Date("2026-06-29T00:00:00.000Z"),
              },
            ],
          },
        ];
      },
    },
  };

  const candidates = await listSellerLedgerRepairCandidates(
    { currencyCode: "jpy" },
    { prismaClient: fakePrisma },
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].reason, "shopify_order_reversal_overage");
  assert.equal(candidates[0].shopifyOrderId, "gid://shopify/Order/1000");
  assert.equal(candidates[0].repairAmount, 130);
  assert.equal(candidates[0].paidAmount, 0);
  assert.equal(candidates[0].reversedAmount, 130);
});

test("repairSellerNegativeLedgerBalance repairs a Shopify order reversal overage", async () => {
  const state = {
    ledgerEntries: [],
  };
  const fakePrisma = {
    async $transaction(callback) {
      return callback(fakePrisma);
    },
    seller: {
      async findUnique({ where }) {
        assert.equal(where.id, "seller_1");
        return {
          id: "seller_1",
          stripeAccount: null,
          vendor: {
            id: "vendor_1",
          },
        };
      },
    },
    ledgerEntry: {
      async findMany({ where }) {
        assert.equal(where.sellerId, "seller_1");
        assert.equal(where.currencyCode, "jpy");
        return [
          {
            id: "ledger_paid_other",
            entryType: "shopify_order_paid",
            stripeObjectId: "gid://shopify/Order/2000",
            amount: 1000,
            metadataJson: {
              shopifyOrderId: "gid://shopify/Order/2000",
            },
          },
          {
            id: "ledger_refund_orphan",
            entryType: "refund",
            stripeObjectId: "gid://shopify/Refund/3000",
            amount: 130,
            metadataJson: {
              shopifyOrderId: "gid://shopify/Order/1000",
              shopifyOrderName: "#1000",
            },
          },
        ];
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: "ledger_adjustment_2",
          ...data,
        };
      },
    },
  };

  const result = await repairSellerNegativeLedgerBalance(
    {
      sellerId: "seller_1",
      currencyCode: "jpy",
      repairedBy: "admin-test",
      repairScope: "shopify_order_reversal_overage",
      shopifyOrderId: "gid://shopify/Order/1000",
    },
    {
      prismaClient: fakePrisma,
      now: new Date("2026-06-29T00:00:00.000Z"),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.repaired, true);
  assert.equal(result.amount, 130);
  assert.equal(result.previousPayoutableLedgerBalance, 870);
  assert.equal(result.nextPayoutableLedgerBalance, 1000);
  assert.equal(state.ledgerEntries.length, 1);
  assert.equal(state.ledgerEntries[0].entryType, "ledger_adjustment");
  assert.equal(state.ledgerEntries[0].amount, 130);
  assert.equal(
    state.ledgerEntries[0].metadataJson.repairScope,
    "shopify_order_reversal_overage",
  );
  assert.equal(
    state.ledgerEntries[0].metadataJson.shopifyOrderId,
    "gid://shopify/Order/1000",
  );
});

const VERIFIED_PAYOUT_SELLER_FIELDS = {
  complianceProfile: { countryCode: "JP" },
  settlementControl: {
    payoutHold: false,
    reserveAmount: 0,
    directInvoiceBalance: 0,
  },
  phoneVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
  documentVerificationStatus: "VERIFIED",
  verificationNameMatched: true,
  payoutNameMatched: true,
  payoutRecipient: {
    id: "spr_manual",
    provider: "manual",
    status: "active",
    accountHolderName: "Test Store",
    accountSummary: "Bank transfer destination",
  },
};

test("calculateSellerSalesCreditAvailability allows 100% of trusted matured sales", () => {
  const now = new Date("2026-06-06T00:00:00.000Z");
  const summary = calculateSellerSalesCreditAvailability(
    [
      {
        entryType: "shopify_order_paid",
        amount: 30000,
        occurredAt: "2026-04-01T00:00:00.000Z",
        metadataJson: TRUSTED_SALES_CREDIT_METADATA,
      },
      {
        entryType: "shopify_order_paid",
        amount: 10000,
        occurredAt: "2026-06-01T00:00:00.000Z",
      },
    ],
    {
      now,
      holdDays: 45,
      riskBufferBps: 1000,
    },
  );

  assert.equal(summary.maturedSalesAmount, 30000);
  assert.equal(summary.pendingSalesAmount, 10000);
  assert.equal(summary.riskBufferAmount, 1000);
  assert.equal(summary.pendingRiskReserveAmount, 11000);
  assert.equal(summary.availableAmount, 30000);
});

test("calculateSellerSalesCreditAvailability excludes matured sales without trusted payment evidence", () => {
  const now = new Date("2026-06-06T00:00:00.000Z");
  const summary = calculateSellerSalesCreditAvailability(
    [
      {
        entryType: "shopify_order_paid",
        amount: 30000,
        occurredAt: "2026-04-01T00:00:00.000Z",
      },
    ],
    {
      now,
      holdDays: 45,
    },
  );

  assert.equal(summary.grossMaturedSalesAmount, 30000);
  assert.equal(summary.maturedSalesAmount, 0);
  assert.equal(summary.ineligibleMaturedSalesAmount, 30000);
  assert.equal(summary.availableAmount, 0);
});

test("inferShopifyOrderSalesCreditPaymentRisk treats 3DS authenticated payments as fully eligible", () => {
  const risk = inferShopifyOrderSalesCreditPaymentRisk({
    payment_gateway_names: ["Shopify Payments"],
    transactions: [
      {
        payment_details: {
          three_d_secure: {
            authenticated: true,
            liability_shifted: true,
          },
        },
      },
    ],
  });

  assert.equal(
    risk.riskClass,
    SALES_CREDIT_PAYMENT_RISK_CLASSES.CARD_3DS_AUTHENTICATED,
  );
  assert.equal(risk.rateBps, 10000);
  assert.equal(risk.threeDSecureAuthenticated, true);
});

test("inferShopifyOrderSalesCreditPaymentRisk treats non-card confirmed gateways as fully eligible", () => {
  const risk = inferShopifyOrderSalesCreditPaymentRisk({
    payment_gateway_names: ["KOMOJU konbini"],
  });

  assert.equal(
    risk.riskClass,
    SALES_CREDIT_PAYMENT_RISK_CLASSES.NON_CARD_CONFIRMED,
  );
  assert.equal(risk.rateBps, 10000);
});

test("inferShopifyOrderSalesCreditPaymentRisk does not trust card payments without a 3DS signal", () => {
  const risk = inferShopifyOrderSalesCreditPaymentRisk({
    payment_gateway_names: ["Shopify Payments"],
  });

  assert.equal(
    risk.riskClass,
    SALES_CREDIT_PAYMENT_RISK_CLASSES.CARD_UNVERIFIED,
  );
  assert.equal(risk.rateBps, 0);
});

test("calculateSellerSalesCreditAvailability subtracts offset locks and payout locks", () => {
  const now = new Date("2026-06-06T00:00:00.000Z");
  const summary = calculateSellerSalesCreditAvailability(
    [
      {
        entryType: "shopify_order_paid",
        amount: 30000,
        occurredAt: "2026-04-01T00:00:00.000Z",
        metadataJson: TRUSTED_SALES_CREDIT_METADATA,
      },
      {
        entryType: "refund",
        amount: 2000,
        occurredAt: "2026-05-01T00:00:00.000Z",
      },
    ],
    {
      now,
      offsetLocks: [
        {
          status: "authorized",
          amount: 5000,
          expiresAt: "2026-06-06T00:15:00.000Z",
        },
        {
          status: "authorized",
          amount: 9000,
          expiresAt: "2026-06-05T23:59:00.000Z",
        },
      ],
      payoutRuns: [
        {
          status: "draft",
          amount: 7000,
        },
        {
          status: "failed",
          amount: 8000,
        },
      ],
    },
  );

  assert.equal(summary.offsetLockedAmount, 5000);
  assert.equal(summary.payoutLockedAmount, 7000);
  assert.equal(summary.deductionAmount, 2000);
  assert.equal(summary.availableAmount, 16000);
});

test("authorizeSalesCreditOffset refuses sellers before first payout verification", async () => {
  const now = new Date("2026-06-06T00:00:00.000Z");
  const fakePrisma = {
    seller: {
      async findUnique({ where }) {
        assert.equal(where.id, "seller_unverified");
        return {
          id: "seller_unverified",
          status: "active",
          phoneVerifiedAt: null,
          documentVerificationStatus: "NONE",
          verificationNameMatched: false,
          payoutNameMatched: false,
          payoutRecipient: null,
        };
      },
    },
    ledgerEntry: {
      async findMany() {
        return [
          {
            entryType: "shopify_order_paid",
            amount: 20000,
            occurredAt: "2026-04-01T00:00:00.000Z",
            metadataJson: TRUSTED_SALES_CREDIT_METADATA,
          },
        ];
      },
    },
    salesCreditOffset: {
      async findMany() {
        return [];
      },
      async findUnique() {
        return null;
      },
      async create() {
        throw new Error("unverified seller should not create an offset");
      },
    },
    payoutRun: {
      async findMany() {
        return [];
      },
    },
  };

  const result = await authorizeSalesCreditOffset(
    {
      sellerId: "seller_unverified",
      amount: 1000,
      currencyCode: "jpy",
      idempotencyKey: "unverified-sales-credit",
    },
    {
      prismaClient: fakePrisma,
      now,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "seller_verification_required");
  assert.equal(result.summary.availableAmount, 20000);
});

test("authorizeSalesCreditOffset rejects non-JPY settlement offsets", async () => {
  const result = await authorizeSalesCreditOffset({
    sellerId: "seller_1",
    amount: 1000,
    currencyCode: "usd",
    checkoutReference: "draft-order:usd",
    idempotencyKey: "checkout-sales-credit-usd",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported_sales_credit_currency");
  assert.equal(result.currencyCode, "usd");
  assert.equal(result.supportedCurrencyCode, "jpy");
});

test("authorizeSalesCreditOffset rejects idempotency reuse with a different request", async () => {
  const now = new Date("2026-06-06T00:00:00.000Z");
  const existingOffset = {
    id: "offset_existing",
    sellerId: "seller_1",
    amount: 500,
    currencyCode: "jpy",
    status: "authorized",
    idempotencyKey: "sales-credit-checkout-1",
    metadataJson: {},
  };
  const fakePrisma = {
    salesCreditOffset: {
      async findUnique({ where }) {
        assert.equal(where.idempotencyKey, "sales-credit-checkout-1");
        return existingOffset;
      },
      async create() {
        throw new Error("mismatched idempotency reuse should not create");
      },
    },
  };

  const result = await authorizeSalesCreditOffset(
    {
      sellerId: "seller_1",
      amount: 1000,
      currencyCode: "jpy",
      idempotencyKey: "sales-credit-checkout-1",
    },
    {
      prismaClient: fakePrisma,
      now,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "sales_credit_idempotency_mismatch");
  assert.equal(result.mismatchReason, "sales_credit_offset_amount_mismatch");
  assert.equal(result.offset, existingOffset);
});

test("captureSalesCreditOffset rejects a mismatched expected amount before ledger mutation", async () => {
  const now = new Date("2026-06-06T00:00:00.000Z");
  let updateCalled = false;
  let ledgerCreateCalled = false;
  const fakePrisma = {
    salesCreditOffset: {
      async findUnique({ where }) {
        assert.equal(where.id, "offset_1");
        return {
          id: "offset_1",
          sellerId: "seller_1",
          amount: 500,
          currencyCode: "jpy",
          status: "authorized",
          checkoutReference: "checkout_1",
          metadataJson: {},
        };
      },
      async update() {
        updateCalled = true;
        throw new Error("mismatched capture should not update");
      },
    },
    ledgerEntry: {
      async findFirst() {
        return null;
      },
      async create() {
        ledgerCreateCalled = true;
        throw new Error("mismatched capture should not create ledger");
      },
    },
  };

  const result = await captureSalesCreditOffset(
    {
      offsetId: "offset_1",
      orderId: "order_1",
      expectedSellerId: "seller_1",
      expectedAmount: 1000,
      expectedCurrencyCode: "jpy",
    },
    {
      prismaClient: fakePrisma,
      now,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "sales_credit_offset_amount_mismatch");
  assert.equal(updateCalled, false);
  assert.equal(ledgerCreateCalled, false);
});

test("sales credit offset authorization, capture, release, and refund reversal use offset ledger entries", async () => {
  const now = new Date("2026-06-06T00:00:00.000Z");
  const state = {
    offsets: [],
    ledgerEntries: [
      {
        entryType: "shopify_order_paid",
        amount: 20000,
        occurredAt: "2026-04-01T00:00:00.000Z",
        metadataJson: TRUSTED_SALES_CREDIT_METADATA,
      },
    ],
  };
  const fakePrisma = {
    seller: {
      async findUnique({ where }) {
        assert.equal(where.id, "seller_1");
        return {
          id: "seller_1",
          status: "active",
          ...VERIFIED_PAYOUT_SELLER_FIELDS,
        };
      },
    },
    ledgerEntry: {
      async findMany() {
        return state.ledgerEntries.map((entry) => ({ ...entry }));
      },
      async findFirst({ where }) {
        return (
          state.ledgerEntries.find(
            (entry) =>
              entry.entryType === where.entryType &&
              entry.stripeObjectId === where.stripeObjectId,
          ) || null
        );
      },
      async create({ data }) {
        const entry = {
          id: `ledger_${state.ledgerEntries.length + 1}`,
          ...data,
        };
        state.ledgerEntries.push(entry);
        return entry;
      },
    },
    salesCreditOffset: {
      async findMany() {
        return state.offsets.map((offset) => ({ ...offset }));
      },
      async findUnique({ where }) {
        if (where.idempotencyKey) {
          return (
            state.offsets.find(
              (offset) => offset.idempotencyKey === where.idempotencyKey,
            ) || null
          );
        }

        return state.offsets.find((offset) => offset.id === where.id) || null;
      },
      async create({ data }) {
        const offset = {
          id: `offset_${state.offsets.length + 1}`,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        state.offsets.push(offset);
        return offset;
      },
      async update({ where, data }) {
        const offset = state.offsets.find((item) => item.id === where.id);
        Object.assign(offset, data, {
          updatedAt: now,
        });
        return { ...offset };
      },
    },
    payoutRun: {
      async findMany() {
        return [];
      },
    },
  };

  const authorized = await authorizeSalesCreditOffset(
    {
      sellerId: "seller_1",
      amount: 5000,
      currencyCode: "jpy",
      checkoutReference: "checkout_1",
      idempotencyKey: "sales-credit-checkout-1",
    },
    {
      prismaClient: fakePrisma,
      now,
    },
  );

  assert.equal(authorized.ok, true);
  assert.equal(authorized.offset.status, "authorized");
  assert.equal(authorized.offset.amount, 5000);

  const released = await releaseSalesCreditOffset(
    {
      offsetId: authorized.offset.id,
      reason: "checkout_cancelled",
    },
    {
      prismaClient: fakePrisma,
      now,
    },
  );

  assert.equal(released.ok, true);
  assert.equal(released.offset.status, "released");

  const secondAuthorized = await authorizeSalesCreditOffset(
    {
      sellerId: "seller_1",
      amount: 4000,
      currencyCode: "jpy",
      checkoutReference: "checkout_2",
      idempotencyKey: "sales-credit-checkout-2",
    },
    {
      prismaClient: fakePrisma,
      now,
    },
  );

  assert.equal(secondAuthorized.ok, true);

  const captured = await captureSalesCreditOffset(
    {
      offsetId: secondAuthorized.offset.id,
      orderId: "order_1",
    },
    {
      prismaClient: fakePrisma,
      now,
    },
  );

  assert.equal(captured.ok, true);
  assert.equal(captured.offset.status, "captured");
  assert.equal(captured.ledgerEntry.entryType, "sales_credit_offset_captured");
  assert.equal(captured.ledgerEntry.direction, "debit");
  assert.equal(captured.ledgerEntry.amount, 4000);

  const reversed = await reverseSalesCreditOffsetForRefund(
    {
      offsetId: secondAuthorized.offset.id,
      orderId: "order_1",
    },
    {
      prismaClient: fakePrisma,
      now,
    },
  );

  assert.equal(reversed.ok, true);
  assert.equal(reversed.offset.status, "refunded");
  assert.equal(
    reversed.ledgerEntry.entryType,
    "sales_credit_offset_refund_reversal",
  );
  assert.equal(reversed.ledgerEntry.direction, "credit");
  assert.equal(reversed.ledgerEntry.amount, 4000);
});

test("createPayoutRun requires first payout verification before settlement", async () => {
  let ledgerReadCalled = false;
  const fakePrisma = {
    seller: {
      async findUnique() {
        return {
          id: "seller_1",
          status: "active",
          vendor: {
            id: "vendor_1",
          },
          complianceProfile: { countryCode: "JP" },
          settlementControl: { payoutHold: false },
          stripeAccount: null,
          payoutRecipient: null,
          phoneVerifiedAt: null,
          documentVerificationStatus: "NONE",
          verificationNameMatched: false,
          payoutNameMatched: false,
        };
      },
    },
    ledgerEntry: {
      async findMany() {
        ledgerReadCalled = true;
        return [];
      },
    },
  };

  const result = await createPayoutRun(
    {
      sellerId: "seller_1",
      amount: 1000,
      currencyCode: "JPY",
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "seller_verification_required");
  assert.deepEqual(result.verification.missing, [
    "phone_verification",
    "document_verification",
    "payout_destination",
    "name_match",
    "payout_name_match",
  ]);
  assert.equal(ledgerReadCalled, false);
});

test("createPayoutRun refuses test stores before settlement", async () => {
  let ledgerReadCalled = false;
  const fakePrisma = {
    seller: {
      async findUnique() {
        return {
          id: "seller_1",
          status: "active",
          vendor: {
            id: "vendor_1",
            vendorStore: {
              id: "store_1",
              isTestStore: true,
            },
          },
          stripeAccount: null,
          payoutRecipient: null,
          ...VERIFIED_PAYOUT_SELLER_FIELDS,
        };
      },
    },
    ledgerEntry: {
      async findMany() {
        ledgerReadCalled = true;
        return [];
      },
    },
  };

  const result = await createPayoutRun(
    {
      sellerId: "seller_1",
      amount: 1000,
      currencyCode: "JPY",
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "test_store_payout_disabled");
  assert.equal(ledgerReadCalled, false);
});

test("createPayoutRun refuses the internal platform operator seller", async () => {
  let ledgerReadCalled = false;
  const fakePrisma = {
    seller: {
      async findUnique() {
        return {
          id: "platform_seller",
          status: "active",
          sellerLegalRole: "PLATFORM_OPERATOR",
          vendor: {
            id: "platform_vendor",
            vendorStore: {
              id: "platform_store",
              isPlatformStore: true,
              isTestStore: false,
            },
          },
          stripeAccount: null,
          payoutRecipient: null,
        };
      },
    },
    ledgerEntry: {
      async findMany() {
        ledgerReadCalled = true;
        return [];
      },
    },
  };

  const result = await createPayoutRun(
    {
      sellerId: "platform_seller",
      amount: 1000,
      currencyCode: "JPY",
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "platform_seller_payout_disabled");
  assert.equal(ledgerReadCalled, false);
});

test("authorizeSalesCreditOffset refuses the internal platform operator seller", async () => {
  let ledgerReadCalled = false;
  const fakePrisma = {
    seller: {
      async findUnique() {
        return {
          id: "platform_seller",
          status: "active",
          sellerLegalRole: "PLATFORM_OPERATOR",
          payoutRecipient: null,
        };
      },
    },
    ledgerEntry: {
      async findMany() {
        ledgerReadCalled = true;
        return [];
      },
    },
    salesCreditOffset: {
      async findUnique() {
        return null;
      },
    },
  };

  const result = await authorizeSalesCreditOffset(
    {
      sellerId: "platform_seller",
      amount: 1000,
      currencyCode: "jpy",
      idempotencyKey: "platform-credit-disabled",
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "platform_seller_sales_credit_disabled");
  assert.equal(ledgerReadCalled, false);
});

test("createPayoutRun refuses amounts above the seller payoutable ledger balance", async () => {
  let payoutRunCreateCalled = false;
  const fakePrisma = {
    seller: {
      async findUnique({ where }) {
        assert.deepEqual(where, { id: "seller_1" });
        return {
          id: "seller_1",
          status: "active",
          vendor: {
            id: "vendor_1",
            storeName: "Test Store",
          },
          stripeAccount: {
            id: "ssa_1",
            stripeAccountId: "acct_123",
          },
          ...VERIFIED_PAYOUT_SELLER_FIELDS,
        };
      },
    },
    ledgerEntry: {
      async findMany({ where, select }) {
        assert.equal(where.sellerId, "seller_1");
        assert.equal(where.currencyCode, "jpy");
        assert.equal(where.entryType.in.includes("shopify_order_paid"), true);
        assert.deepEqual(select, {
          entryType: true,
          amount: true,
        });
        return [
          { entryType: "shopify_order_paid", amount: 1000 },
          { entryType: "payout_paid", amount: 400 },
        ];
      },
    },
    payoutRun: {
      async create() {
        payoutRunCreateCalled = true;
        throw new Error(
          "payout run should not be created above ledger balance",
        );
      },
    },
  };

  const result = await createPayoutRun(
    {
      sellerId: "seller_1",
      amount: 700,
      currencyCode: "JPY",
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "insufficient_ledger_balance");
  assert.equal(result.availableLedgerBalance, 600);
  assert.equal(result.requestedAmount, 700);
  assert.equal(payoutRunCreateCalled, false);
});

test("createPayoutRun creates a draft only within the seller payoutable ledger balance", async () => {
  const fakePrisma = {
    seller: {
      async findUnique() {
        return {
          id: "seller_1",
          status: "active",
          vendor: {
            id: "vendor_1",
            storeName: "Test Store",
          },
          stripeAccount: {
            id: "ssa_1",
            stripeAccountId: "acct_123",
          },
          ...VERIFIED_PAYOUT_SELLER_FIELDS,
        };
      },
    },
    ledgerEntry: {
      async findMany() {
        return [
          { entryType: "shopify_order_paid", amount: 1000 },
          { entryType: "application_fee", amount: 100 },
        ];
      },
    },
    payoutRun: {
      async create({ data }) {
        assert.deepEqual(data, {
          sellerId: "seller_1",
          sellerStripeAccountId: "ssa_1",
          sellerPayoutRecipientId: null,
          stripeAccountId: "acct_123",
          amount: 900,
          currencyCode: "jpy",
          status: "draft",
          transferMethod: "manual_bank_transfer",
        });
        return {
          id: "pr_1",
          ...data,
        };
      },
    },
  };

  const result = await createPayoutRun(
    {
      sellerId: "seller_1",
      amount: 900,
      currencyCode: "jpy",
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, true);
  assert.equal(result.availableLedgerBalance, 900);
  assert.equal(result.payoutRun.id, "pr_1");
});

test("createPayoutRun cannot reserve funds already held by another open payout", async () => {
  let createCalled = false;
  const fakePrisma = {
    seller: {
      async findUnique() {
        return {
          id: "seller_1",
          status: "active",
          vendor: { id: "vendor_1", storeName: "Test Store" },
          stripeAccount: null,
          ...VERIFIED_PAYOUT_SELLER_FIELDS,
        };
      },
    },
    ledgerEntry: {
      async findMany() {
        return [{ entryType: "shopify_order_paid", amount: 1000 }];
      },
    },
    payoutRun: {
      async findMany() {
        return [{ amount: 800 }];
      },
      async create() {
        createCalled = true;
      },
    },
  };

  const result = await createPayoutRun(
    { sellerId: "seller_1", amount: 300, currencyCode: "jpy" },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "insufficient_unreserved_ledger_balance");
  assert.equal(result.reservedPayoutAmount, 800);
  assert.equal(createCalled, false);
});

test("createPayoutRun allows manual settlement without a Stripe account", async () => {
  const fakePrisma = {
    seller: {
      async findUnique() {
        return {
          id: "seller_1",
          status: "active",
          vendor: {
            id: "vendor_1",
          },
          stripeAccount: null,
          ...VERIFIED_PAYOUT_SELLER_FIELDS,
        };
      },
    },
    ledgerEntry: {
      async findMany() {
        return [{ entryType: "shopify_order_paid", amount: 1200 }];
      },
    },
    payoutRun: {
      async create({ data }) {
        assert.deepEqual(data, {
          sellerId: "seller_1",
          sellerStripeAccountId: null,
          sellerPayoutRecipientId: null,
          stripeAccountId: null,
          amount: 1200,
          currencyCode: "jpy",
          status: "draft",
          transferMethod: "manual_bank_transfer",
        });
        return {
          id: "pr_manual",
          ...data,
        };
      },
    },
  };

  const result = await createPayoutRun(
    {
      sellerId: "seller_1",
      amount: 1200,
      currencyCode: "jpy",
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, true);
  assert.equal(result.payoutRun.id, "pr_manual");
});

test("createPayoutRun creates Wise payout runs only when a Wise recipient exists", async () => {
  const originalProvider = process.env.SELLER_PAYOUT_PROVIDER;
  process.env.SELLER_PAYOUT_PROVIDER = "wise";

  try {
    const fakePrisma = {
      seller: {
        async findUnique() {
          return {
            id: "seller_1",
            status: "active",
            vendor: {
              id: "vendor_1",
              vendorStore: { isTestStore: false },
            },
            complianceProfile: { countryCode: "JP" },
            settlementControl: { payoutHold: false },
            stripeAccount: null,
            payoutRecipient: {
              id: "spr_1",
              provider: "wise",
              status: "active",
              wiseRecipientId: "123456",
            },
            phoneVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
            documentVerificationStatus: "VERIFIED",
            verificationNameMatched: true,
            payoutNameMatched: true,
          };
        },
      },
      ledgerEntry: {
        async findMany() {
          return [{ entryType: "shopify_order_paid", amount: 1200 }];
        },
      },
      payoutRun: {
        async create({ data }) {
          assert.deepEqual(data, {
            sellerId: "seller_1",
            sellerStripeAccountId: null,
            sellerPayoutRecipientId: "spr_1",
            stripeAccountId: null,
            amount: 1000,
            currencyCode: "jpy",
            status: "draft",
            transferMethod: "wise_api",
          });
          return {
            id: "pr_wise",
            ...data,
          };
        },
      },
    };

    const result = await createPayoutRun(
      {
        sellerId: "seller_1",
        amount: 1000,
        currencyCode: "jpy",
      },
      { prismaClient: fakePrisma },
    );

    assert.equal(result.ok, true);
    assert.equal(result.payoutRun.transferMethod, "wise_api");
  } finally {
    if (originalProvider) {
      process.env.SELLER_PAYOUT_PROVIDER = originalProvider;
    } else {
      delete process.env.SELLER_PAYOUT_PROVIDER;
    }
  }
});

test("account.external_account.updated keeps the seller in admin review", async () => {
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_vendor_register";

  const state = {
    savedEvent: null,
    seller: {
      id: "seller_1",
      status: "review",
      statusReason: "payout_external_account_update_required",
    },
    statusHistory: [],
  };
  const fakePrisma = {
    stripeEvent: {
      async findUnique() {
        return state.savedEvent;
      },
      async create({ data }) {
        state.savedEvent = {
          id: "sev_external_account",
          ...data,
        };
        return state.savedEvent;
      },
      async update({ data }) {
        state.savedEvent = {
          ...state.savedEvent,
          ...data,
        };
        return state.savedEvent;
      },
    },
    sellerStripeAccount: {
      async findUnique({ where }) {
        assert.equal(where.stripeAccountId, "acct_123");
        return {
          id: "ssa_1",
          sellerId: "seller_1",
          stripeAccountId: "acct_123",
        };
      },
    },
    seller: {
      async findUnique({ where }) {
        return where.id === state.seller.id ? state.seller : null;
      },
      async update({ data }) {
        state.seller = {
          ...state.seller,
          ...data,
        };
        return state.seller;
      },
    },
    sellerStatusHistory: {
      async create({ data }) {
        state.statusHistory.push(data);
        return data;
      },
    },
  };
  const fakeStripe = {
    webhooks: {
      constructEvent() {
        return {
          id: "evt_external_account",
          type: "account.external_account.updated",
          account: "acct_123",
          livemode: false,
          created: 1777777777,
          data: {
            object: {
              id: "ba_123",
              object: "bank_account",
            },
          },
        };
      },
    },
  };

  const result = await handleStripeWebhook(
    {
      rawBody: "{}",
      signature: "t=1,v1=test",
    },
    {
      prismaClient: fakePrisma,
      stripeClient: fakeStripe,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(state.seller.status, "review");
  assert.equal(
    state.seller.statusReason,
    "payout_external_account_admin_review_required",
  );
  assert.equal(
    state.statusHistory[0].changedBy,
    "stripe.account.external_account.updated",
  );
});

test("charge.dispute.created marks the order disputed and seller review required", async () => {
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_vendor_register";

  const state = {
    savedEvent: null,
    order: {
      id: "order_1",
      sellerId: "seller_1",
      sellerStripeAccountId: "ssa_1",
      stripeAccountId: "acct_123",
      stripeChargeId: "ch_123",
      status: "paid",
      currencyCode: "jpy",
    },
    seller: {
      id: "seller_1",
      status: "active",
      statusReason: null,
    },
    ledgerEntries: [],
    statusHistory: [],
  };
  const fakePrisma = {
    stripeEvent: {
      async findUnique() {
        return state.savedEvent;
      },
      async create({ data }) {
        state.savedEvent = {
          id: "sev_dispute",
          ...data,
        };
        return state.savedEvent;
      },
      async update({ data }) {
        state.savedEvent = {
          ...state.savedEvent,
          ...data,
        };
        return state.savedEvent;
      },
    },
    order: {
      async findFirst({ where }) {
        return where.stripeChargeId === "ch_123" ? state.order : null;
      },
      async update({ data }) {
        state.order = {
          ...state.order,
          ...data,
        };
        return state.order;
      },
    },
    seller: {
      async findUnique({ where }) {
        return where.id === state.seller.id ? state.seller : null;
      },
      async update({ data }) {
        state.seller = {
          ...state.seller,
          ...data,
        };
        return state.seller;
      },
    },
    sellerStatusHistory: {
      async create({ data }) {
        state.statusHistory.push(data);
        return data;
      },
    },
    ledgerEntry: {
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `le_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
  };
  const fakeStripe = {
    webhooks: {
      constructEvent() {
        return {
          id: "evt_dispute",
          type: "charge.dispute.created",
          account: "acct_123",
          livemode: false,
          created: 1777777777,
          data: {
            object: {
              id: "dp_123",
              charge: "ch_123",
              amount: 9000,
              currency: "jpy",
              status: "needs_response",
              created: 1777777777,
            },
          },
        };
      },
    },
  };

  const result = await handleStripeWebhook(
    {
      rawBody: "{}",
      signature: "t=1,v1=test",
    },
    {
      prismaClient: fakePrisma,
      stripeClient: fakeStripe,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(state.order.status, "disputed");
  assert.equal(state.seller.status, "review");
  assert.equal(state.seller.statusReason, "dispute_review_required");
  assert.equal(state.ledgerEntries[0].entryType, "dispute_created");
  assert.equal(state.ledgerEntries[0].direction, "debit");
});

test("createConnectedAccountPayout sends connected account as a Stripe header", async () => {
  const originalSecretKey = process.env.STRIPE_SECRET_KEY;
  const calls = [];
  process.env.STRIPE_SECRET_KEY = "sk_test_unit";

  try {
    const payout = await createConnectedAccountPayout({
      stripeAccountId: "acct_123",
      amount: 5000,
      currencyCode: "jpy",
      payoutRunId: "pr_1",
      sellerId: "seller_1",
      async fetchImpl(url, init) {
        calls.push({ url, init });
        return {
          ok: true,
          async json() {
            return {
              id: "po_123",
            };
          },
        };
      },
    });

    assert.equal(payout.id, "po_123");
    assert.equal(calls[0].url, "https://api.stripe.com/v1/payouts");
    assert.equal(calls[0].init.headers["Stripe-Account"], "acct_123");
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk_test_unit");
    assert.equal(
      calls[0].init.headers["Idempotency-Key"],
      "seller-payout-pr_1",
    );
    assert.match(calls[0].init.body.toString(), /amount=5000/);
    assert.doesNotMatch(calls[0].init.body.toString(), /stripeAccount/);
  } finally {
    if (originalSecretKey) {
      process.env.STRIPE_SECRET_KEY = originalSecretKey;
    } else {
      delete process.env.STRIPE_SECRET_KEY;
    }
  }
});

test("payout runs require approval and execute on the connected account only when eligible", async () => {
  const state = {
    payoutRun: {
      id: "pr_1",
      sellerId: "seller_1",
      sellerStripeAccountId: "ssa_1",
      stripeAccountId: "acct_123",
      amount: 5000,
      currencyCode: "jpy",
      status: "draft",
      stripePayoutId: null,
      seller: {
        id: "seller_1",
        status: "active",
        vendor: { id: "vendor_1", vendorStore: { isTestStore: false } },
        complianceProfile: { countryCode: "JP" },
        settlementControl: { payoutHold: false },
        phoneVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
        documentVerificationStatus: "VERIFIED",
        verificationNameMatched: true,
        payoutNameMatched: true,
        payoutRecipient: {
          id: "spr_manual",
          provider: "manual",
          status: "active",
          accountHolderName: "Test Store",
        },
        stripeAccount: {
          id: "ssa_1",
          payoutsEnabled: true,
        },
      },
      sellerPayoutRecipient: {
        id: "spr_manual",
        provider: "manual",
        status: "active",
        accountHolderName: "Test Store",
      },
    },
  };
  const payoutCalls = [];

  const fakePrisma = {
    payoutRun: {
      async findUnique() {
        return state.payoutRun;
      },
      async update({ data }) {
        state.payoutRun = {
          ...state.payoutRun,
          ...data,
        };
        return state.payoutRun;
      },
      async updateMany({ where, data }) {
        if (state.payoutRun.id !== where.id || state.payoutRun.status !== where.status) {
          return { count: 0 };
        }
        state.payoutRun = { ...state.payoutRun, ...data };
        return { count: 1 };
      },
      async findMany() {
        return [];
      },
    },
    ledgerEntry: {
      async findMany() {
        return [{ entryType: "shopify_order_paid", amount: 5000 }];
      },
    },
  };
  async function createPayout(params) {
    payoutCalls.push(params);
    return {
      id: "po_123",
    };
  }

  const approval = await approvePayoutRun(
    { payoutRunId: "pr_1", approvedBy: "admin_user" },
    { prismaClient: fakePrisma },
  );
  assert.equal(approval.ok, true);
  assert.equal(state.payoutRun.status, "approved");

  const execution = await executePayoutRun(
    { payoutRunId: "pr_1", executedBy: "admin_user" },
    {
      prismaClient: fakePrisma,
      createPayout,
    },
  );

  assert.equal(execution.ok, true);
  assert.equal(state.payoutRun.status, "executed");
  assert.equal(state.payoutRun.stripePayoutId, "po_123");
  assert.deepEqual(payoutCalls[0], {
    stripeAccountId: "acct_123",
    amount: 5000,
    currencyCode: "jpy",
    payoutRunId: "pr_1",
    sellerId: "seller_1",
  });
});

test("markPayoutRunManuallyPaid records a manual transfer debit without Stripe payout", async () => {
  const state = {
    ledgerEntries: [],
    payoutRun: {
      id: "pr_manual",
      sellerId: "seller_1",
      sellerStripeAccountId: "ssa_1",
      stripeAccountId: "acct_123",
      amount: 9900,
      currencyCode: "jpy",
      status: "approved",
      transferMethod: "manual_bank_transfer",
      stripePayoutId: null,
      seller: {
        id: "seller_1",
        status: "active",
        vendor: { id: "vendor_1", vendorStore: { isTestStore: false } },
        complianceProfile: { countryCode: "JP" },
        settlementControl: { payoutHold: false },
        phoneVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
        documentVerificationStatus: "VERIFIED",
        verificationNameMatched: true,
        payoutNameMatched: true,
        payoutRecipient: {
          id: "spr_manual",
          provider: "manual",
          status: "active",
          accountHolderName: "Test Store",
        },
        stripeAccount: {
          id: "ssa_1",
          payoutsEnabled: true,
        },
      },
      sellerPayoutRecipient: {
        id: "spr_manual",
        provider: "manual",
        status: "active",
        accountHolderName: "Test Store",
      },
    },
  };
  const fakePrisma = {
    async $transaction(callback) {
      return callback(this);
    },
    payoutRun: {
      async findUnique() {
        return state.payoutRun;
      },
      async update({ data }) {
        state.payoutRun = {
          ...state.payoutRun,
          ...data,
        };
        return state.payoutRun;
      },
      async updateMany({ where, data }) {
        if (state.payoutRun.id !== where.id || state.payoutRun.status !== where.status) {
          return { count: 0 };
        }
        state.payoutRun = { ...state.payoutRun, ...data };
        return { count: 1 };
      },
      async findMany() {
        return [];
      },
    },
    ledgerEntry: {
      async findMany() {
        return [{ entryType: "shopify_order_paid", amount: 9900 }];
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `le_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
  };

  const result = await markPayoutRunManuallyPaid(
    {
      payoutRunId: "pr_manual",
      executedBy: "admin_user",
      externalTransferId: "bank_tx_123",
      transferMemo: "May payout",
    },
    { prismaClient: fakePrisma },
  );

  assert.equal(result.ok, true);
  assert.equal(state.payoutRun.status, "executed");
  assert.equal(state.payoutRun.transferMethod, "manual_bank_transfer");
  assert.equal(state.payoutRun.externalTransferId, "bank_tx_123");
  assert.equal(state.payoutRun.transferMemo, "May payout");
  assert.equal(state.payoutRun.stripePayoutId, null);
  assert.equal(state.ledgerEntries.length, 1);
  assert.equal(state.ledgerEntries[0].entryType, "payout_paid");
  assert.equal(state.ledgerEntries[0].direction, "debit");
  assert.equal(state.ledgerEntries[0].amount, 9900);
  assert.equal(state.ledgerEntries[0].stripeObjectId, "bank_tx_123");
  assert.equal(
    state.ledgerEntries[0].metadataJson.transferMethod,
    "manual_bank_transfer",
  );
});

test("executeWisePayoutRun creates and funds a Wise transfer after approval", async () => {
  const env = {
    MARKETPLACE_SETTLEMENT_ACTIONS_ENABLED: "true",
    DOMESTIC_SELLER_SETTLEMENT_ENABLED: "true",
    SHOPIFY_MARKETPLACE_PAYMENTS_WRITTEN_APPROVAL_CONFIRMED: "true",
    SHOPIFY_MARKETPLACE_PAYMENTS_WRITTEN_APPROVAL_REFERENCE:
      "unit-test-approval",
    SELLER_PAYOUT_PROVIDER: "wise",
    WISE_API_TOKEN: "wise-token",
    WISE_PROFILE_ID: "30000000",
    WISE_API_BASE_URL: "https://api.wise-sandbox.com",
    WISE_SOURCE_CURRENCY: "JPY",
  };
  const calls = [];
  const state = {
    payoutRun: {
      id: "pr_wise",
      sellerId: "seller_1",
      sellerStripeAccountId: null,
      sellerPayoutRecipientId: "spr_1",
      stripeAccountId: null,
      amount: 9900,
      currencyCode: "jpy",
      status: "approved",
      transferMethod: "wise_api",
      wiseCustomerTransactionId: null,
      wisePayloadJson: null,
      seller: {
        id: "seller_1",
        status: "active",
        vendor: { id: "vendor_1", vendorStore: { isTestStore: false } },
        complianceProfile: { countryCode: "JP" },
        settlementControl: { payoutHold: false },
        phoneVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
        documentVerificationStatus: "VERIFIED",
        verificationNameMatched: true,
        payoutNameMatched: true,
        payoutRecipient: {
          id: "spr_1",
          provider: "wise",
          status: "active",
          wiseRecipientId: "123456",
          currencyCode: "jpy",
        },
      },
      sellerPayoutRecipient: {
        id: "spr_1",
        provider: "wise",
        status: "active",
        wiseRecipientId: "123456",
        currencyCode: "jpy",
      },
    },
  };
  const fakePrisma = {
    payoutRun: {
      async findUnique() {
        return state.payoutRun;
      },
      async update({ data }) {
        state.payoutRun = {
          ...state.payoutRun,
          ...data,
        };
        return state.payoutRun;
      },
      async updateMany({ where, data }) {
        if (state.payoutRun.id !== where.id || state.payoutRun.status !== where.status) {
          return { count: 0 };
        }
        state.payoutRun = { ...state.payoutRun, ...data };
        return { count: 1 };
      },
      async findMany() {
        return [];
      },
    },
    ledgerEntry: {
      async findMany() {
        return [{ entryType: "shopify_order_paid", amount: 9900 }];
      },
    },
  };
  async function fetchImpl(url, init) {
    calls.push({ url, init });

    if (url.endsWith("/v3/profiles/30000000/quotes")) {
      return {
        ok: true,
        async json() {
          return {
            id: "quote-uuid",
            sourceAmount: 9900,
            targetAmount: 9900,
            rate: 1,
          };
        },
      };
    }

    if (url.endsWith("/v1/transfers")) {
      return {
        ok: true,
        async json() {
          return {
            id: 987654,
            status: "incoming_payment_waiting",
          };
        },
      };
    }

    if (url.endsWith("/v3/profiles/30000000/transfers/987654/payments")) {
      return {
        ok: true,
        async json() {
          return {
            status: "processing",
          };
        },
      };
    }

    throw new Error(`Unexpected Wise URL: ${url}`);
  }

  const result = await executeWisePayoutRun(
    {
      payoutRunId: "pr_wise",
      executedBy: "admin_user",
    },
    {
      prismaClient: fakePrisma,
      fetchImpl,
      env,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.pending, true);
  assert.equal(state.payoutRun.status, "processing");
  assert.equal(state.payoutRun.wiseQuoteId, "quote-uuid");
  assert.equal(state.payoutRun.wiseTransferId, "987654");
  assert.equal(state.payoutRun.wiseTransferStatus, "processing");
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    sourceCurrency: "JPY",
    targetCurrency: "JPY",
    sourceAmount: 9900,
    targetAmount: null,
    targetAccount: 123456,
  });
  assert.equal(JSON.parse(calls[1].init.body).quoteUuid, "quote-uuid");
  assert.equal(JSON.parse(calls[2].init.body).type, "BALANCE");
});

test("syncWisePayoutRunStatus records payout_paid only after Wise completion", async () => {
  const env = {
    WISE_API_TOKEN: "wise-token",
    WISE_PROFILE_ID: "30000000",
    WISE_API_BASE_URL: "https://api.wise-sandbox.com",
    WISE_SOURCE_CURRENCY: "JPY",
  };
  const state = {
    ledgerEntries: [],
    payoutRun: {
      id: "pr_wise",
      sellerId: "seller_1",
      sellerStripeAccountId: null,
      stripeAccountId: null,
      amount: 9900,
      currencyCode: "jpy",
      status: "processing",
      transferMethod: "wise_api",
      wiseTransferId: "987654",
      wiseTransferStatus: "processing",
      wisePayloadJson: null,
      executedAt: new Date("2026-05-20T00:00:00Z"),
      executedBy: "admin_user",
    },
  };
  const fakePrisma = {
    async $transaction(callback) {
      return callback(this);
    },
    payoutRun: {
      async findUnique() {
        return state.payoutRun;
      },
      async update({ data }) {
        state.payoutRun = {
          ...state.payoutRun,
          ...data,
        };
        return state.payoutRun;
      },
    },
    ledgerEntry: {
      async findFirst() {
        return null;
      },
      async create({ data }) {
        state.ledgerEntries.push(data);
        return {
          id: `le_${state.ledgerEntries.length}`,
          ...data,
        };
      },
    },
  };
  async function fetchImpl(url) {
    assert.equal(url, "https://api.wise-sandbox.com/v1/transfers/987654");
    return {
      ok: true,
      async json() {
        return {
          id: 987654,
          status: "outgoing_payment_sent",
        };
      },
    };
  }

  const result = await syncWisePayoutRunStatus(
    {
      payoutRunId: "pr_wise",
      executedBy: "admin_user",
    },
    {
      prismaClient: fakePrisma,
      fetchImpl,
      env,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.ledgerEntryCreated, true);
  assert.equal(state.payoutRun.status, "executed");
  assert.equal(state.payoutRun.wiseTransferStatus, "outgoing_payment_sent");
  assert.equal(state.ledgerEntries.length, 1);
  assert.equal(state.ledgerEntries[0].entryType, "payout_paid");
  assert.equal(state.ledgerEntries[0].direction, "debit");
  assert.equal(state.ledgerEntries[0].stripeObjectId, "987654");
  assert.equal(state.ledgerEntries[0].metadataJson.transferMethod, "wise_api");
});

test("executePayoutRun refuses to create a payout above connected account available balance", async () => {
  const state = {
    payoutRun: {
      id: "pr_1",
      sellerId: "seller_1",
      sellerStripeAccountId: "ssa_1",
      stripeAccountId: "acct_123",
      amount: 5000,
      currencyCode: "jpy",
      status: "approved",
      seller: {
        id: "seller_1",
        status: "active",
        vendor: { id: "vendor_1", vendorStore: { isTestStore: false } },
        complianceProfile: { countryCode: "JP" },
        settlementControl: { payoutHold: false },
        ...VERIFIED_PAYOUT_SELLER_FIELDS,
        stripeAccount: {
          payoutsEnabled: true,
        },
      },
    },
  };
  let payoutCreateCalled = false;
  const fakePrisma = {
    payoutRun: {
      async findUnique() {
        return state.payoutRun;
      },
    },
    ledgerEntry: {
      async findMany() {
        return [{ entryType: "shopify_order_paid", amount: 5000 }];
      },
    },
  };
  const fakeStripe = {
    balance: {
      async retrieve(params, options) {
        assert.deepEqual(params, {});
        assert.deepEqual(options, {
          stripeAccount: "acct_123",
        });
        return {
          available: [
            {
              amount: 4000,
              currency: "jpy",
            },
          ],
        };
      },
    },
    payouts: {
      async create() {
        payoutCreateCalled = true;
      },
    },
  };

  const result = await executePayoutRun(
    { payoutRunId: "pr_1" },
    {
      prismaClient: fakePrisma,
      stripeClient: fakeStripe,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "insufficient_stripe_available_balance");
  assert.equal(result.availableBalance, 4000);
  assert.equal(payoutCreateCalled, false);
});

test("createOrderRefund requires an explicit application fee refund policy", async () => {
  const refundCalls = [];
  const fakePrisma = {
    order: {
      async findUnique() {
        return {
          id: "order_1",
          sellerId: "seller_1",
          stripeAccountId: "acct_123",
          stripeChargeId: "ch_123",
          seller: {
            stripeAccount: {
              stripeAccountId: "acct_123",
            },
          },
          sellerStripeAccount: {
            stripeAccountId: "acct_123",
          },
        };
      },
    },
  };
  const fakeStripe = {
    refunds: {
      async create(params, options) {
        refundCalls.push({ params, options });
        return {
          id: "re_123",
        };
      },
    },
  };

  const missingPolicy = await createOrderRefund(
    { orderId: "order_1" },
    {
      prismaClient: fakePrisma,
      stripeClient: fakeStripe,
    },
  );

  assert.equal(missingPolicy.ok, false);
  assert.equal(missingPolicy.reason, "refund_application_fee_required");

  const refund = await createOrderRefund(
    {
      orderId: "order_1",
      amount: 1200,
      refundApplicationFee: true,
    },
    {
      prismaClient: fakePrisma,
      stripeClient: fakeStripe,
    },
  );

  assert.equal(refund.ok, true);
  assert.deepEqual(refundCalls[0], {
    params: {
      charge: "ch_123",
      refund_application_fee: true,
      metadata: {
        orderId: "order_1",
        sellerId: "seller_1",
      },
      amount: 1200,
    },
    options: {
      stripeAccount: "acct_123",
    },
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  approvePayoutRun,
  createCheckoutOrder,
  createCheckoutOrderPaymentIntent,
  createConnectedAccountPayout,
  createOrderRefund,
  createSellerAccountSession,
  createSellerStripeAccount,
  executePayoutRun,
  handleStripeWebhook,
  resetSellerStripeAccountForRecreate,
} from "../../app/services/sellerPayments.server.js";

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
            },
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

test("handleStripeWebhook stores raw events idempotently and writes charge ledger entries", async () => {
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
        stripeAccount: {
          id: "ssa_1",
          payoutsEnabled: true,
        },
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
        status: "active",
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

import assert from "node:assert/strict";
import test from "node:test";

import {
  getProductionReadiness,
  includeCheckoutGateInProductionReadiness,
  inspectStripeEnvironment,
} from "../../app/services/productionReadiness.server.js";

const REQUIRED_SCOPE_STRING = [
  "read_products",
  "write_products",
  "read_orders",
  "read_shipping",
  "write_shipping",
  "read_inventory",
  "write_inventory",
  "read_locations",
  "read_merchant_managed_fulfillment_orders",
  "write_merchant_managed_fulfillment_orders",
  "read_publications",
  "write_publications",
  "read_draft_orders",
  "write_draft_orders",
  "read_shopify_payments_disputes",
].join(",");

function createFakePrisma({
  sellerRows = [],
  sessions = null,
  withdrawalCounts = {},
  heartbeat = undefined,
  shadowChecks = undefined,
  productSyncIssues = undefined,
  productShippingProfiles = undefined,
  internationalShippingAvailability = undefined,
} = {}) {
  const withdrawalCountQueue = [
    withdrawalCounts.openCount || 0,
    withdrawalCounts.deadlineExpiredCount || 0,
    withdrawalCounts.deadlineSoonCount || 0,
    withdrawalCounts.refundDecisionMissingCount || 0,
    withdrawalCounts.refundCompletionMismatchCount || 0,
    withdrawalCounts.returnInstructionMissingCount || 0,
    withdrawalCounts.vendorNotificationMissingCount || 0,
    withdrawalCounts.completionNotificationMissingCount || 0,
    withdrawalCounts.rejectedWithoutReasonCount || 0,
    withdrawalCounts.shopifyExternalRecordMissingCount || 0,
  ];

  const fakePrisma = {
    session: {
      findMany: async () =>
        sessions || [
          {
            id: "offline_session",
            shop: "example.myshopify.com",
            scope: REQUIRED_SCOPE_STRING,
          },
        ],
    },
    seller: {
      findMany: async () => sellerRows,
    },
    withdrawalRequest: {
      count: async () => withdrawalCountQueue.shift() || 0,
    },
    withdrawalEmailLog: {
      count: async () => withdrawalCounts.emailFailedCount || 0,
    },
  };

  if (heartbeat !== undefined) {
    fakePrisma.operationalHeartbeat = {
      findUnique: async () => heartbeat,
    };
  }
  if (shadowChecks !== undefined) {
    fakePrisma.sellerOrderShadowCheck = {
      findMany: async () => shadowChecks,
    };
  }
  if (productSyncIssues !== undefined) {
    fakePrisma.shopifyProductSyncIssue = {
      findMany: async () => productSyncIssues,
    };
  }
  if (productShippingProfiles !== undefined) {
    fakePrisma.product = {
      findMany: async () => productShippingProfiles,
    };
  }
  if (internationalShippingAvailability !== undefined) {
    fakePrisma.internationalShippingCountryAvailability = {
      findMany: async () => internationalShippingAvailability,
    };
  }

  return fakePrisma;
}

test("getProductionReadiness blocks an EU product without a valid international shipping profile", async () => {
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      productShippingProfiles: [
        {
          id: "product_1",
          name: "EU product",
          shippingWeightGrams: 500,
          shippingLengthMm: null,
          shippingWidthMm: null,
          shippingHeightMm: null,
          internationalShippingMethod: "DOMESTIC_ONLY",
          productEuStatus: "APPROVED_LOW_RISK",
        },
      ],
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
    },
  });
  const check = result.checks.find(
    (row) => row.id === "eu_product_international_shipping_profiles",
  );

  assert.equal(check.status, "fail");
  assert.equal(result.canGoLive, false);
});

test("getProductionReadiness accepts a valid Air Packet profile", async () => {
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      productShippingProfiles: [
        {
          id: "product_1",
          name: "EU product",
          shippingWeightGrams: 500,
          shippingLengthMm: 250,
          shippingWidthMm: 180,
          shippingHeightMm: 70,
          internationalShippingMethod: "AIR_PACKET",
          shippingWeightConfirmedAt: new Date("2026-07-21T00:00:00.000Z"),
          shippingWeightSource: "MANUAL_CONFIRMED",
          shopifyVariantCount: 1,
          shopifyWeightSyncStatus: "SYNCED",
          productEuStatus: "APPROVED_LOW_RISK",
        },
      ],
      internationalShippingAvailability: [
        {
          countryCode: "FR",
          status: "ACTIVE",
          checkedAt: new Date(),
        },
      ],
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
    },
  });
  const check = result.checks.find(
    (row) => row.id === "eu_product_international_shipping_profiles",
  );

  assert.equal(check.status, "pass");
});

function createActiveSeller({
  stripeAccount = true,
  payoutRecipient = false,
  isTestStore = false,
  payoutRuns = [],
} = {}) {
  return {
    id: "seller_1",
    status: "active",
    vendor: {
      handle: "vendor-one",
      storeName: "Vendor One",
      vendorStore: {
        id: "vendor_store_1",
        storeName: "Vendor One",
        isTestStore,
      },
    },
    payoutRuns,
    stripeAccount: stripeAccount
      ? {
          id: "seller_stripe_1",
          stripeAccountId: "acct_test_123",
          detailsSubmitted: false,
          chargesEnabled: false,
          payoutsEnabled: false,
        }
      : null,
    payoutRecipient: payoutRecipient
      ? {
          id: "seller_payout_recipient_1",
          provider: "wise",
          status: "active",
          currencyCode: "jpy",
          countryCode: "JP",
          wiseRecipientId: "40000000",
        }
      : null,
  };
}

test("getProductionReadiness blocks a stale withdrawal email worker", async () => {
  const now = new Date("2026-07-17T12:00:00.000Z");
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      sellerRows: [createActiveSeller({ stripeAccount: false })],
      heartbeat: {
        key: "withdrawal_email_outbox",
        lastSucceededAt: new Date("2026-07-17T11:29:00.000Z"),
        lastFailedAt: null,
      },
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
      WITHDRAWAL_OUTBOX_WORKER_TOKEN: "worker-token",
    },
    now,
  });
  const check = result.checks.find(
    (row) => row.id === "withdrawal_email_worker_heartbeat",
  );

  assert.equal(result.canGoLive, false);
  assert.equal(check.status, "fail");
  assert.match(check.detail, /31/);
});

test("getProductionReadiness blocks unresolved SellerOrder differences when multi-seller checkout is open", async () => {
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      sellerRows: [createActiveSeller({ stripeAccount: false })],
      shadowChecks: [
        {
          id: "shadow_1",
          shopDomain: "example.myshopify.com",
          shopifyOrderId: "gid://shopify/Order/1",
          shopifyOrderName: "#1001",
          status: "amount_mismatch",
          checkedAt: new Date("2026-07-17T11:00:00.000Z"),
        },
      ],
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
      MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED: "true",
      MULTI_SELLER_SHOPIFY_ORDER_SETTLEMENT_ENABLED: "true",
      MULTI_SELLER_SHOPIFY_REFUND_SETTLEMENT_ENABLED: "true",
      MULTI_SELLER_SHOPIFY_CANCELLED_SETTLEMENT_ENABLED: "true",
      MULTI_SELLER_SHOPIFY_DISPUTE_SETTLEMENT_ENABLED: "true",
      VENDOR_ORDERS_USE_SELLER_ORDERS: "true",
      SELLER_ORDER_SHADOW_WRITE_ENABLED: "true",
    },
  });
  const check = result.checks.find(
    (row) => row.id === "seller_order_unresolved_shadow_checks",
  );

  assert.equal(result.canGoLive, false);
  assert.equal(check.status, "fail");
  assert.equal(result.integrity.sellerOrderShadow.unresolvedCount, 1);
});

test("getProductionReadiness blocks pending payout runs for test stores", async () => {
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      sellerRows: [
        createActiveSeller({
          stripeAccount: false,
          isTestStore: true,
          payoutRuns: [
            {
              id: "payout_1",
              status: "approved",
              amount: 100,
              currencyCode: "jpy",
            },
          ],
        }),
      ],
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
    },
  });
  const check = result.checks.find(
    (row) => row.id === "test_store_pending_payout_runs",
  );

  assert.equal(result.canGoLive, false);
  assert.equal(check.status, "fail");
  assert.equal(result.integrity.testStores.pendingPayoutRunCount, 1);
});

test("getProductionReadiness blocks active Shopify products without a store mapping", async () => {
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      sellerRows: [createActiveSeller({ stripeAccount: false })],
      productSyncIssues: [
        {
          id: "sync_issue_1",
          payloadJson: { status: "active" },
        },
      ],
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
    },
  });
  const check = result.checks.find(
    (row) => row.id === "shopify_product_store_mapping",
  );

  assert.equal(result.canGoLive, false);
  assert.equal(check.status, "fail");
  assert.match(check.detail, /販売中 1件/);
});

test("inspectStripeEnvironment detects live Stripe keys", () => {
  const result = inspectStripeEnvironment({
    STRIPE_SECRET_KEY: "sk_live_123",
    STRIPE_PUBLISHABLE_KEY: "pk_live_123",
    STRIPE_WEBHOOK_SECRET: "whsec_platform",
    STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect",
    STRIPE_PLATFORM_FEE_BPS: "1000",
  });

  assert.equal(result.secretKeyMode, "live");
  assert.equal(result.publishableKeyMode, "live");
  assert.equal(result.isLive, true);
  assert.equal(result.modesMatch, true);
  assert.equal(result.platformFeeBpsValid, true);
});

test("inspectStripeEnvironment detects test/live mode mismatch", () => {
  const result = inspectStripeEnvironment({
    STRIPE_SECRET_KEY: "sk_test_123",
    STRIPE_PUBLISHABLE_KEY: "pk_live_123",
    STRIPE_PLATFORM_FEE_BPS: "1000",
  });

  assert.equal(result.secretKeyMode, "test");
  assert.equal(result.publishableKeyMode, "live");
  assert.equal(result.isLive, false);
  assert.equal(result.isTest, true);
  assert.equal(result.modesMatch, false);
});

test("inspectStripeEnvironment rejects invalid fee bps", () => {
  const result = inspectStripeEnvironment({
    STRIPE_SECRET_KEY: "sk_live_123",
    STRIPE_PUBLISHABLE_KEY: "pk_live_123",
    STRIPE_PLATFORM_FEE_BPS: "10001",
  });

  assert.equal(result.platformFeeBpsValid, false);
});

test("getProductionReadiness does not block missing Stripe live keys for Shopify Payments manual payout flow", async () => {
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      sellerRows: [createActiveSeller()],
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
    },
  });
  const checksById = new Map(result.checks.map((check) => [check.id, check]));

  assert.equal(result.canGoLive, true);
  assert.equal(result.operation.paymentFlow, "shopify_payments_manual_payout");
  assert.equal(result.operation.paymentProvider, "shopify_payments");
  assert.equal(result.operation.sellerPayoutProvider, "manual");
  assert.equal(result.operation.stripeConnectProductionEnabled, false);
  assert.equal(checksById.get("stripe_secret_key_live").status, "warning");
  assert.equal(checksById.get("stripe_publishable_key_live").status, "warning");
  assert.equal(checksById.get("stripe_key_modes_match").status, "pass");
  assert.equal(
    checksById.get("connected_accounts_match_current_stripe_key").status,
    "manual",
  );
  assert.equal(checksById.get("connected_accounts_ready").status, "manual");
});

test("getProductionReadiness allows manual payout flow without seller Stripe accounts", async () => {
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      sellerRows: [createActiveSeller({ stripeAccount: false })],
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
    },
  });
  const checksById = new Map(result.checks.map((check) => [check.id, check]));

  assert.equal(result.canGoLive, true);
  assert.equal(
    checksById.get("active_sellers_have_stripe_accounts").status,
    "pass",
  );
});

test("getProductionReadiness warns when withdrawal email env is incomplete", async () => {
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      sellerRows: [createActiveSeller({ stripeAccount: false })],
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
    },
  });
  const checksById = new Map(result.checks.map((check) => [check.id, check]));

  assert.equal(result.canGoLive, true);
  assert.equal(checksById.get("withdrawal_resend_api_key").status, "warning");
  assert.equal(checksById.get("withdrawal_from_email").status, "warning");
  assert.equal(checksById.get("withdrawal_support_email").status, "warning");
});

test("getProductionReadiness passes configured withdrawal email env", async () => {
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      sellerRows: [createActiveSeller({ stripeAccount: false })],
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
      RESEND_API_KEY: "re_test_123",
      WITHDRAWAL_FROM_EMAIL: "Store Support <support@example.com>",
      WITHDRAWAL_SUPPORT_EMAIL: "support@example.com",
    },
  });
  const checksById = new Map(result.checks.map((check) => [check.id, check]));

  assert.equal(checksById.get("withdrawal_resend_api_key").status, "pass");
  assert.equal(checksById.get("withdrawal_from_email").status, "pass");
  assert.equal(checksById.get("withdrawal_support_email").status, "pass");
});

test("getProductionReadiness reports withdrawal operation counts", async () => {
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      sellerRows: [createActiveSeller({ stripeAccount: false })],
      withdrawalCounts: {
        openCount: 4,
        deadlineExpiredCount: 1,
        deadlineSoonCount: 2,
        emailFailedCount: 1,
        refundDecisionMissingCount: 1,
        refundCompletionMismatchCount: 2,
        returnInstructionMissingCount: 3,
        vendorNotificationMissingCount: 4,
        completionNotificationMissingCount: 4,
        rejectedWithoutReasonCount: 5,
        shopifyExternalRecordMissingCount: 6,
      },
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
      RESEND_API_KEY: "re_test_123",
      WITHDRAWAL_FROM_EMAIL: "Store Support <support@example.com>",
      WITHDRAWAL_SUPPORT_EMAIL: "support@example.com",
    },
  });
  const checksById = new Map(result.checks.map((check) => [check.id, check]));

  assert.equal(result.withdrawals.openCount, 4);
  assert.equal(result.withdrawals.processingIssueCount, 25);
  assert.equal(
    checksById.get("withdrawal_operations_available").status,
    "pass",
  );
  assert.equal(checksById.get("withdrawal_open_requests").status, "manual");
  assert.equal(checksById.get("withdrawal_deadlines").status, "warning");
  assert.equal(checksById.get("withdrawal_email_failures").status, "warning");
  assert.equal(
    checksById.get("withdrawal_processing_integrity").status,
    "warning",
  );
});

test("getProductionReadiness treats write grants as satisfying paired Shopify read scopes", async () => {
  const grantedScopeString = [
    "write_products",
    "read_orders",
    "write_shipping",
    "write_inventory",
    "read_locations",
    "write_merchant_managed_fulfillment_orders",
    "write_publications",
    "write_draft_orders",
    "read_shopify_payments_disputes",
  ].join(",");

  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      sellerRows: [createActiveSeller({ stripeAccount: false })],
      sessions: [
        {
          id: "offline_session",
          shop: "example.myshopify.com",
          scope: grantedScopeString,
        },
      ],
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
    },
  });
  const checksById = new Map(result.checks.map((check) => [check.id, check]));

  assert.equal(checksById.get("shopify_configured_scopes").status, "pass");
  assert.equal(checksById.get("shopify_granted_scopes").status, "pass");
});

test("getProductionReadiness blocks Wise mode when active sellers have no Wise recipient", async () => {
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      sellerRows: [createActiveSeller({ stripeAccount: false })],
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
      PAYMENT_PROVIDER: "shopify_payments",
      SELLER_PAYOUT_PROVIDER: "wise",
      WISE_API_TOKEN: "wise-token",
      WISE_PROFILE_ID: "30000000",
      WISE_API_BASE_URL: "https://api.wise-sandbox.com",
      WISE_WEBHOOK_SECRET: "wise-webhook-secret",
      WISE_SOURCE_CURRENCY: "JPY",
    },
  });
  const checksById = new Map(result.checks.map((check) => [check.id, check]));

  assert.equal(result.canGoLive, false);
  assert.equal(
    checksById.get("active_sellers_have_stripe_accounts").status,
    "fail",
  );
});

test("getProductionReadiness blocks Stripe env checks when Connect production checks are enabled", async () => {
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      sellerRows: [createActiveSeller()],
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
      STRIPE_CONNECT_PRODUCTION_ENABLED: "true",
    },
  });
  const checksById = new Map(result.checks.map((check) => [check.id, check]));

  assert.equal(result.canGoLive, false);
  assert.equal(result.operation.stripeConnectProductionEnabled, true);
  assert.equal(checksById.get("stripe_secret_key_live").status, "fail");
  assert.equal(checksById.get("stripe_publishable_key_live").status, "fail");
  assert.equal(checksById.get("stripe_connect_webhook_secret").status, "fail");
});

test("getProductionReadiness allows Shopify Payments and Wise mode without Stripe accounts when Wise env and recipients exist", async () => {
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      sellerRows: [
        createActiveSeller({
          stripeAccount: false,
          payoutRecipient: true,
        }),
      ],
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
      PAYMENT_PROVIDER: "shopify_payments",
      SELLER_PAYOUT_PROVIDER: "wise",
      WISE_API_TOKEN: "wise-token",
      WISE_PROFILE_ID: "30000000",
      WISE_API_BASE_URL: "https://api.wise-sandbox.com",
      WISE_WEBHOOK_SECRET: "wise-webhook-secret",
      WISE_SOURCE_CURRENCY: "JPY",
    },
  });
  const checksById = new Map(result.checks.map((check) => [check.id, check]));

  assert.equal(result.canGoLive, true);
  assert.equal(result.operation.paymentFlow, "shopify_payments_wise_payout");
  assert.equal(result.operation.paymentProvider, "shopify_payments");
  assert.equal(result.operation.sellerPayoutProvider, "wise");
  assert.equal(result.operation.stripeConnectProductionEnabled, false);
  assert.equal(checksById.get("stripe_secret_key_live").status, "warning");
  assert.equal(
    checksById.get("active_sellers_have_stripe_accounts").status,
    "pass",
  );
  assert.equal(checksById.get("wise_api_environment").status, "pass");
  assert.equal(checksById.get("wise_webhook_secret").status, "pass");
});

test("getProductionReadiness blocks Wise mode when Wise env is incomplete", async () => {
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      sellerRows: [
        createActiveSeller({
          stripeAccount: false,
          payoutRecipient: true,
        }),
      ],
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
      PAYMENT_PROVIDER: "shopify_payments",
      SELLER_PAYOUT_PROVIDER: "wise",
    },
  });
  const checksById = new Map(result.checks.map((check) => [check.id, check]));

  assert.equal(result.canGoLive, false);
  assert.equal(checksById.get("wise_api_environment").status, "fail");
});

test("getProductionReadiness blocks partially enabled multi-seller settlement flags", async () => {
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      sellerRows: [createActiveSeller({ stripeAccount: false })],
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
      MULTI_SELLER_SHOPIFY_ORDER_SETTLEMENT_ENABLED: "true",
    },
  });
  const checksById = new Map(result.checks.map((check) => [check.id, check]));
  const check = checksById.get("multi_seller_backend_settlement_flags");

  assert.equal(result.canGoLive, false);
  assert.equal(check.status, "fail");
  assert.match(check.detail, /Missing: refund, cancelled, dispute/);
});

test("getProductionReadiness warns when all multi-seller settlement flags are enabled", async () => {
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      sellerRows: [createActiveSeller({ stripeAccount: false })],
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
      MULTI_SELLER_SHOPIFY_ORDER_SETTLEMENT_ENABLED: "true",
      MULTI_SELLER_SHOPIFY_REFUND_SETTLEMENT_ENABLED: "true",
      MULTI_SELLER_SHOPIFY_CANCELLED_SETTLEMENT_ENABLED: "true",
      MULTI_SELLER_SHOPIFY_DISPUTE_SETTLEMENT_ENABLED: "true",
    },
  });
  const checksById = new Map(result.checks.map((check) => [check.id, check]));
  const check = checksById.get("multi_seller_backend_settlement_flags");

  assert.equal(result.canGoLive, true);
  assert.equal(check.status, "warning");
  assert.match(check.action, /storefront multi-seller checkout disabled/);
});

test("getProductionReadiness blocks storefront multi-seller checkout without prerequisites", async () => {
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      sellerRows: [createActiveSeller({ stripeAccount: false })],
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
      MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED: "true",
    },
  });
  const checksById = new Map(result.checks.map((check) => [check.id, check]));
  const check = checksById.get("multi_seller_storefront_checkout_flag");

  assert.equal(result.canGoLive, false);
  assert.equal(check.status, "fail");
  assert.match(check.detail, /missing prerequisites/);
  assert.match(check.detail, /paid/);
  assert.match(check.detail, /seller order reads/);
});

test("getProductionReadiness warns when storefront multi-seller checkout is fully enabled", async () => {
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      sellerRows: [createActiveSeller({ stripeAccount: false })],
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
      MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED: "true",
      MULTI_SELLER_SHOPIFY_ORDER_SETTLEMENT_ENABLED: "true",
      MULTI_SELLER_SHOPIFY_REFUND_SETTLEMENT_ENABLED: "true",
      MULTI_SELLER_SHOPIFY_CANCELLED_SETTLEMENT_ENABLED: "true",
      MULTI_SELLER_SHOPIFY_DISPUTE_SETTLEMENT_ENABLED: "true",
      VENDOR_ORDERS_USE_SELLER_ORDERS: "true",
      SELLER_ORDER_SHADOW_WRITE_ENABLED: "true",
    },
  });
  const checksById = new Map(result.checks.map((check) => [check.id, check]));
  const check = checksById.get("multi_seller_storefront_checkout_flag");

  assert.equal(result.canGoLive, true);
  assert.equal(check.status, "warning");
  assert.match(check.detail, /Storefront multi-seller checkout is enabled/);
});

test("getProductionReadiness warns when SellerOrder vendor reads are enabled without shadow write", async () => {
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      sellerRows: [createActiveSeller({ stripeAccount: false })],
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
      VENDOR_ORDERS_USE_SELLER_ORDERS: "true",
    },
  });
  const checksById = new Map(result.checks.map((check) => [check.id, check]));
  const check = checksById.get("seller_order_vendor_order_reads");

  assert.equal(result.canGoLive, true);
  assert.equal(check.status, "warning");
  assert.match(check.detail, /SELLER_ORDER_SHADOW_WRITE_ENABLED is disabled/);
});

test("getProductionReadiness shows SellerOrder vendor reads fallback when shadow write is enabled", async () => {
  const result = await getProductionReadiness({
    prismaClient: createFakePrisma({
      sellerRows: [createActiveSeller({ stripeAccount: false })],
    }),
    env: {
      NODE_ENV: "production",
      SCOPES: REQUIRED_SCOPE_STRING,
      VENDOR_ORDERS_USE_SELLER_ORDERS: "true",
      SELLER_ORDER_SHADOW_WRITE_ENABLED: "true",
    },
  });
  const checksById = new Map(result.checks.map((check) => [check.id, check]));
  const check = checksById.get("seller_order_vendor_order_reads");

  assert.equal(result.canGoLive, true);
  assert.equal(check.status, "warning");
  assert.match(check.detail, /fall back to the legacy ledger path/);
});

test("includeCheckoutGateInProductionReadiness blocks launch when the checkout boundary is inactive", () => {
  const result = includeCheckoutGateInProductionReadiness(
    {
      checks: [
        {
          id: "existing_check",
          status: "pass",
          title: "Existing check",
          detail: "ready",
        },
      ],
      summary: {
        fail: 0,
        warning: 0,
        pass: 1,
        external: 0,
        total: 1,
      },
      canGoLive: true,
    },
    {
      available: true,
      active: false,
      publicationConfigurationReady: true,
      exposedProductCount: 1,
      failedProductCount: 0,
    },
  );

  const check = result.checks.find(
    (entry) => entry.id === "marketplace_checkout_publication_boundary",
  );

  assert.equal(result.canGoLive, false);
  assert.equal(result.summary.blockingCount, 1);
  assert.equal(check.status, "fail");
  assert.match(check.detail, /公開中 1件/);
});

test("includeCheckoutGateInProductionReadiness passes only a verified checkout boundary", () => {
  const result = includeCheckoutGateInProductionReadiness(
    {
      checks: [],
      summary: {
        fail: 0,
        warning: 0,
        pass: 0,
        external: 0,
        total: 0,
      },
      canGoLive: true,
    },
    {
      available: true,
      active: true,
      publicationConfigurationReady: true,
      exposedProductCount: 0,
      failedProductCount: 0,
    },
  );

  assert.equal(result.canGoLive, true);
  assert.equal(result.summary.blockingCount, 0);
  assert.equal(
    result.checks[0].id,
    "marketplace_checkout_publication_boundary",
  );
  assert.equal(result.checks[0].status, "pass");
});

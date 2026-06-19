import assert from "node:assert/strict";
import test from "node:test";

import {
  getProductionReadiness,
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
  "read_shopify_payments_disputes",
].join(",");

function createFakePrisma({ sellerRows = [], sessions = null } = {}) {
  return {
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
  };
}

function createActiveSeller({
  stripeAccount = true,
  payoutRecipient = false,
} = {}) {
  return {
    id: "seller_1",
    status: "active",
    vendor: {
      handle: "vendor-one",
      storeName: "Vendor One",
    },
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

test("getProductionReadiness treats write grants as satisfying paired Shopify read scopes", async () => {
  const grantedScopeString = [
    "write_products",
    "read_orders",
    "write_shipping",
    "write_inventory",
    "read_locations",
    "write_merchant_managed_fulfillment_orders",
    "write_publications",
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

import Stripe from "stripe";

import prisma from "../db.server.js";

const STRIPE_ACCOUNT_PROBE_LIMIT = 10;

const REQUIRED_OPERATIONAL_SHOPIFY_SCOPES = [
  "read_products",
  "write_products",
  "read_orders",
  "read_shipping",
  "write_shipping",
  "read_publications",
  "write_publications",
  "read_shopify_payments_disputes",
];

function normalizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function parseScopes(value) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return [];
  }

  return normalized
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function detectStripeKeyMode(value, { livePrefix, testPrefix }) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return "missing";
  }

  if (normalized.startsWith(livePrefix)) {
    return "live";
  }

  if (normalized.startsWith(testPrefix)) {
    return "test";
  }

  return "unknown";
}

function sanitizeStripeErrorMessage(message) {
  return String(message || "")
    .replace(/sk_(live|test)_[A-Za-z0-9_]+/g, "sk_$1_***")
    .replace(/rk_(live|test)_[A-Za-z0-9_]+/g, "rk_$1_***");
}

function createCheck({ id, category, status, title, detail, action }) {
  return {
    id,
    category,
    status,
    title,
    detail: detail || "",
    action: action || "",
  };
}

export function inspectStripeEnvironment(env = process.env) {
  const secretKey = normalizeText(env.STRIPE_SECRET_KEY);
  const publishableKey = normalizeText(env.STRIPE_PUBLISHABLE_KEY);
  const secretKeyMode = detectStripeKeyMode(secretKey, {
    livePrefix: "sk_live_",
    testPrefix: "sk_test_",
  });
  const publishableKeyMode = detectStripeKeyMode(publishableKey, {
    livePrefix: "pk_live_",
    testPrefix: "pk_test_",
  });
  const webhookSecret = normalizeText(env.STRIPE_WEBHOOK_SECRET);
  const connectWebhookSecret = normalizeText(env.STRIPE_CONNECT_WEBHOOK_SECRET);
  const platformFeeBps = Number(env.STRIPE_PLATFORM_FEE_BPS || "");

  return {
    secretKey,
    publishableKey,
    secretKeyMode,
    publishableKeyMode,
    isLive:
      secretKeyMode === "live" &&
      publishableKeyMode === "live",
    isTest:
      secretKeyMode === "test" ||
      publishableKeyMode === "test",
    modesMatch:
      secretKeyMode !== "missing" &&
      publishableKeyMode !== "missing" &&
      secretKeyMode === publishableKeyMode,
    hasPlatformWebhookSecret: Boolean(webhookSecret),
    hasConnectWebhookSecret: Boolean(connectWebhookSecret),
    platformWebhookSecretLooksValid:
      !webhookSecret || webhookSecret.startsWith("whsec_"),
    connectWebhookSecretLooksValid:
      !connectWebhookSecret || connectWebhookSecret.startsWith("whsec_"),
    platformFeeBps,
    platformFeeBpsValid:
      Number.isInteger(platformFeeBps) &&
      platformFeeBps >= 0 &&
      platformFeeBps <= 10000,
  };
}

function buildEnvironmentChecks({ stripeEnv, env }) {
  const checks = [];
  const isProductionRuntime = env.NODE_ENV === "production";

  checks.push(
    createCheck({
      id: "stripe_secret_key_live",
      category: "stripe",
      status: stripeEnv.secretKeyMode === "live" ? "pass" : "fail",
      title: "Stripe secret key",
      detail:
        stripeEnv.secretKeyMode === "live"
          ? "STRIPE_SECRET_KEY is a live key."
          : `Current mode is ${stripeEnv.secretKeyMode}. Live operation needs sk_live_...`,
      action:
        stripeEnv.secretKeyMode === "live"
          ? ""
          : "Set the live secret key in Render, then redeploy or restart the service.",
    }),
  );

  checks.push(
    createCheck({
      id: "stripe_publishable_key_live",
      category: "stripe",
      status: stripeEnv.publishableKeyMode === "live" ? "pass" : "fail",
      title: "Stripe publishable key",
      detail:
        stripeEnv.publishableKeyMode === "live"
          ? "STRIPE_PUBLISHABLE_KEY is a live key."
          : `Current mode is ${stripeEnv.publishableKeyMode}. Live operation needs pk_live_...`,
      action:
        stripeEnv.publishableKeyMode === "live"
          ? ""
          : "Set the live publishable key in Render, then redeploy or restart the service.",
    }),
  );

  checks.push(
    createCheck({
      id: "stripe_key_modes_match",
      category: "stripe",
      status: stripeEnv.modesMatch ? "pass" : "fail",
      title: "Stripe key mode match",
      detail: stripeEnv.modesMatch
        ? "Secret key and publishable key use the same mode."
        : `Secret key mode is ${stripeEnv.secretKeyMode}; publishable key mode is ${stripeEnv.publishableKeyMode}.`,
      action: stripeEnv.modesMatch
        ? ""
        : "Use keys from the same Stripe account and the same live/test mode.",
    }),
  );

  checks.push(
    createCheck({
      id: "stripe_platform_webhook_secret",
      category: "stripe",
      status:
        stripeEnv.hasPlatformWebhookSecret &&
        stripeEnv.platformWebhookSecretLooksValid
          ? "pass"
          : "fail",
      title: "Stripe platform webhook secret",
      detail: stripeEnv.hasPlatformWebhookSecret
        ? "STRIPE_WEBHOOK_SECRET is configured."
        : "STRIPE_WEBHOOK_SECRET is missing.",
      action:
        stripeEnv.hasPlatformWebhookSecret &&
        stripeEnv.platformWebhookSecretLooksValid
          ? ""
          : "Create the live platform webhook endpoint in Stripe and set its whsec_... value.",
    }),
  );

  checks.push(
    createCheck({
      id: "stripe_connect_webhook_secret",
      category: "stripe",
      status:
        stripeEnv.hasConnectWebhookSecret &&
        stripeEnv.connectWebhookSecretLooksValid
          ? "pass"
          : "fail",
      title: "Stripe Connect webhook secret",
      detail: stripeEnv.hasConnectWebhookSecret
        ? "STRIPE_CONNECT_WEBHOOK_SECRET is configured."
        : "STRIPE_CONNECT_WEBHOOK_SECRET is missing.",
      action:
        stripeEnv.hasConnectWebhookSecret &&
        stripeEnv.connectWebhookSecretLooksValid
          ? ""
          : "Create a live Connect webhook endpoint for events on connected accounts and set its whsec_... value.",
    }),
  );

  checks.push(
    createCheck({
      id: "stripe_platform_fee_bps",
      category: "stripe",
      status: stripeEnv.platformFeeBpsValid ? "pass" : "fail",
      title: "Stripe platform fee bps",
      detail: stripeEnv.platformFeeBpsValid
        ? `STRIPE_PLATFORM_FEE_BPS is ${stripeEnv.platformFeeBps}.`
        : "STRIPE_PLATFORM_FEE_BPS must be an integer from 0 to 10000.",
      action: stripeEnv.platformFeeBpsValid
        ? ""
        : "Set STRIPE_PLATFORM_FEE_BPS explicitly in Render.",
    }),
  );

  checks.push(
    createCheck({
      id: "production_runtime",
      category: "app",
      status: isProductionRuntime ? "pass" : "warning",
      title: "Runtime mode",
      detail: isProductionRuntime
        ? "NODE_ENV is production."
        : `NODE_ENV is ${env.NODE_ENV || "not set"}.`,
      action: isProductionRuntime
        ? ""
        : "Render production should run with NODE_ENV=production.",
    }),
  );

  return checks;
}

function buildShopifyChecks({ configuredScopes, grantedScopes }) {
  const configuredMissingScopes = REQUIRED_OPERATIONAL_SHOPIFY_SCOPES.filter(
    (scope) => !configuredScopes.includes(scope),
  );
  const grantedMissingScopes = REQUIRED_OPERATIONAL_SHOPIFY_SCOPES.filter(
    (scope) => !grantedScopes.includes(scope),
  );

  return [
    createCheck({
      id: "shopify_configured_scopes",
      category: "shopify",
      status: configuredMissingScopes.length === 0 ? "pass" : "fail",
      title: "Shopify configured scopes",
      detail:
        configuredMissingScopes.length === 0
          ? "SCOPES includes the operational scopes."
          : `Missing from SCOPES: ${configuredMissingScopes.join(", ")}`,
      action:
        configuredMissingScopes.length === 0
          ? ""
          : "Update production SCOPES / Shopify config, deploy a new version, then re-authorize the app.",
    }),
    createCheck({
      id: "shopify_granted_scopes",
      category: "shopify",
      status:
        grantedScopes.length > 0 && grantedMissingScopes.length === 0
          ? "pass"
          : "fail",
      title: "Shopify granted scopes",
      detail:
        grantedScopes.length === 0
          ? "No offline Shopify session scope was found."
          : grantedMissingScopes.length === 0
            ? "The installed app has the operational scopes."
            : `Missing from installed app grant: ${grantedMissingScopes.join(", ")}`,
      action:
        grantedScopes.length > 0 && grantedMissingScopes.length === 0
          ? ""
          : "Open the app in Shopify admin and approve the new permissions, or uninstall/reinstall if re-authorization does not appear.",
    }),
    createCheck({
      id: "shopify_payments_bank_account",
      category: "shopify",
      status: "manual",
      title: "Shopify Payments payout bank",
      detail:
        "The app cannot verify the payout bank account configured in Shopify Payments.",
      action:
        "In Shopify admin, confirm Shopify Payments is active and its payout bank account is the intended business or Wise receiving account.",
    }),
  ];
}

function buildPayoutChecks({ env }) {
  const hasWiseApi = Boolean(normalizeText(env.WISE_API_TOKEN));

  return [
    createCheck({
      id: "seller_payout_transfer_mode",
      category: "payout",
      status: "manual",
      title: "Seller payout transfer mode",
      detail:
        "This app records seller payouts as manual bank/Wise transfers. It does not send money through Wise API.",
      action:
        "After the actual transfer is completed outside the app, record the external transfer ID on the payout run.",
    }),
    createCheck({
      id: "wise_api_connection",
      category: "payout",
      status: hasWiseApi ? "warning" : "manual",
      title: "Wise API connection",
      detail: hasWiseApi
        ? "WISE_API_TOKEN is present, but the current payout code still uses manual payout records."
        : "No Wise API token is configured. This is expected for the current manual payout flow.",
      action:
        "For automated seller remittance, add a separate Wise API integration and reconciliation flow before enabling it.",
    }),
  ];
}

async function getPlatformStripeAccount(stripeEnv) {
  if (!stripeEnv.secretKey || stripeEnv.secretKeyMode === "missing") {
    return {
      ok: false,
      reason: "missing_secret_key",
    };
  }

  try {
    const stripe = new Stripe(stripeEnv.secretKey);
    const account = await stripe.accounts.retrieve();

    return {
      ok: true,
      account: {
        id: account.id,
        country: account.country || null,
        defaultCurrency: account.default_currency || null,
        chargesEnabled: Boolean(account.charges_enabled),
        payoutsEnabled: Boolean(account.payouts_enabled),
        detailsSubmitted: Boolean(account.details_submitted),
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: "stripe_account_retrieve_failed",
      message: sanitizeStripeErrorMessage(error?.message),
      code: normalizeText(error?.code),
    };
  }
}

async function probeConnectedAccounts({ stripeEnv, sellerRows }) {
  if (!stripeEnv.secretKey || stripeEnv.secretKeyMode === "missing") {
    return [];
  }

  const stripe = new Stripe(stripeEnv.secretKey);
  const rowsToProbe = sellerRows
    .filter((row) => row.stripeAccount?.stripeAccountId)
    .slice(0, STRIPE_ACCOUNT_PROBE_LIMIT);
  const results = [];

  for (const row of rowsToProbe) {
    const stripeAccountId = row.stripeAccount.stripeAccountId;

    try {
      const account = await stripe.accounts.retrieve(stripeAccountId);
      results.push({
        ok: true,
        sellerId: row.id,
        vendorHandle: row.vendor?.handle || null,
        storeName: row.vendor?.storeName || null,
        stripeAccountId,
        chargesEnabled: Boolean(account.charges_enabled),
        payoutsEnabled: Boolean(account.payouts_enabled),
        detailsSubmitted: Boolean(account.details_submitted),
      });
    } catch (error) {
      results.push({
        ok: false,
        sellerId: row.id,
        vendorHandle: row.vendor?.handle || null,
        storeName: row.vendor?.storeName || null,
        stripeAccountId,
        code: normalizeText(error?.code),
        message: sanitizeStripeErrorMessage(error?.message),
      });
    }
  }

  return results;
}

function buildSellerChecks({ sellerRows, connectedAccountProbe }) {
  const activeSellers = sellerRows.filter((row) => row.status === "active");
  const activeSellersWithoutStripe = activeSellers.filter(
    (row) => !row.stripeAccount?.stripeAccountId,
  );
  const invalidConnectedAccounts = connectedAccountProbe.filter((row) => !row.ok);
  const unavailableConnectedAccounts = connectedAccountProbe.filter(
    (row) => row.ok && (!row.detailsSubmitted || !row.chargesEnabled || !row.payoutsEnabled),
  );

  return [
    createCheck({
      id: "active_sellers_have_stripe_accounts",
      category: "seller",
      status: activeSellersWithoutStripe.length === 0 ? "pass" : "fail",
      title: "Active sellers have payout records",
      detail:
        activeSellersWithoutStripe.length === 0
          ? "All active sellers have a Stripe account record."
          : `${activeSellersWithoutStripe.length} active seller(s) have no Stripe account record.`,
      action:
        activeSellersWithoutStripe.length === 0
          ? ""
          : "Create or reconnect the seller payment account before allowing payouts.",
    }),
    createCheck({
      id: "connected_accounts_match_current_stripe_key",
      category: "seller",
      status: invalidConnectedAccounts.length === 0 ? "pass" : "fail",
      title: "Connected accounts match current Stripe key",
      detail:
        invalidConnectedAccounts.length === 0
          ? "Connected account probes succeeded for the sampled sellers."
          : `${invalidConnectedAccounts.length} sampled connected account(s) could not be retrieved with the current Stripe key.`,
      action:
        invalidConnectedAccounts.length === 0
          ? ""
          : "Accounts created under a test platform cannot be used with live keys. Recreate those seller Stripe accounts after switching to live keys.",
    }),
    createCheck({
      id: "connected_accounts_ready",
      category: "seller",
      status: unavailableConnectedAccounts.length === 0 ? "pass" : "warning",
      title: "Connected accounts are enabled",
      detail:
        unavailableConnectedAccounts.length === 0
          ? "Sampled connected accounts are submitted and enabled."
          : `${unavailableConnectedAccounts.length} sampled connected account(s) are not fully enabled.`,
      action:
        unavailableConnectedAccounts.length === 0
          ? ""
          : "Ask the seller to complete the embedded payment settings, then review the seller before payout.",
    }),
  ];
}

export async function getProductionReadiness(
  { prismaClient = prisma, env = process.env } = {},
) {
  const stripeEnv = inspectStripeEnvironment(env);
  const [sessions, sellerRows, platformStripeAccount] = await Promise.all([
    prismaClient.session.findMany({
      where: {
        isOnline: false,
      },
      select: {
        id: true,
        shop: true,
        scope: true,
      },
    }),
    prismaClient.seller.findMany({
      orderBy: [{ createdAt: "desc" }],
      include: {
        vendor: true,
        stripeAccount: true,
      },
    }),
    getPlatformStripeAccount(stripeEnv),
  ]);

  const connectedAccountProbe = await probeConnectedAccounts({
    stripeEnv,
    sellerRows,
  });
  const configuredScopes = parseScopes(env.SCOPES);
  const grantedScopes = parseScopes(sessions[0]?.scope);
  const checks = [
    ...buildEnvironmentChecks({ stripeEnv, env }),
    ...buildShopifyChecks({ configuredScopes, grantedScopes }),
    ...buildSellerChecks({ sellerRows, connectedAccountProbe }),
    ...buildPayoutChecks({ env }),
  ];
  const blockingChecks = checks.filter((check) => check.status === "fail");
  const warningChecks = checks.filter((check) => check.status === "warning");
  const manualChecks = checks.filter((check) => check.status === "manual");

  return {
    generatedAt: new Date(),
    canGoLive: blockingChecks.length === 0,
    summary: {
      totalChecks: checks.length,
      blockingCount: blockingChecks.length,
      warningCount: warningChecks.length,
      manualCount: manualChecks.length,
    },
    stripe: {
      mode: stripeEnv.isLive ? "live" : stripeEnv.isTest ? "test" : "unknown",
      secretKeyMode: stripeEnv.secretKeyMode,
      publishableKeyMode: stripeEnv.publishableKeyMode,
      platformAccount: platformStripeAccount,
    },
    shopify: {
      configuredScopes,
      grantedScopes,
      offlineSessionShops: sessions.map((session) => session.shop).filter(Boolean),
    },
    sellers: {
      totalCount: sellerRows.length,
      activeCount: sellerRows.filter((seller) => seller.status === "active").length,
      connectedAccountProbe,
      probeLimit: STRIPE_ACCOUNT_PROBE_LIMIT,
    },
    checks,
  };
}

import Stripe from "stripe";

import prisma from "../db.server.js";
import {
  EU_PRODUCT_ALLOWED_STATUSES,
  EU_SELLER_ALLOWED_STATUSES,
} from "../utils/deliveryEligibility.js";

const STRIPE_ACCOUNT_PROBE_LIMIT = 10;
const STRIPE_CONNECT_PRODUCTION_ENABLED_VALUES = new Set([
  "1",
  "true",
  "yes",
  "on",
]);

const PAYMENT_PROVIDER_SHOPIFY_PAYMENTS = "shopify_payments";
const SELLER_PAYOUT_PROVIDER_MANUAL = "manual";
const SELLER_PAYOUT_PROVIDER_WISE = "wise";
const DEFAULT_PAYMENT_PROVIDER = PAYMENT_PROVIDER_SHOPIFY_PAYMENTS;
const DEFAULT_SELLER_PAYOUT_PROVIDER = SELLER_PAYOUT_PROVIDER_MANUAL;
const SUPPORTED_PAYMENT_PROVIDERS = new Set([
  PAYMENT_PROVIDER_SHOPIFY_PAYMENTS,
]);
const SUPPORTED_SELLER_PAYOUT_PROVIDERS = new Set([
  SELLER_PAYOUT_PROVIDER_MANUAL,
  SELLER_PAYOUT_PROVIDER_WISE,
]);
const PAYMENT_PROVIDER_LABELS = {
  [PAYMENT_PROVIDER_SHOPIFY_PAYMENTS]: "Shopify Payments",
};
const SELLER_PAYOUT_PROVIDER_LABELS = {
  [SELLER_PAYOUT_PROVIDER_MANUAL]: "Manual bank/Wise transfer",
  [SELLER_PAYOUT_PROVIDER_WISE]: "Wise API payout",
};
const MULTI_SELLER_SETTLEMENT_FLAGS = [
  {
    key: "MULTI_SELLER_SHOPIFY_ORDER_SETTLEMENT_ENABLED",
    label: "paid",
  },
  {
    key: "MULTI_SELLER_SHOPIFY_REFUND_SETTLEMENT_ENABLED",
    label: "refund",
  },
  {
    key: "MULTI_SELLER_SHOPIFY_CANCELLED_SETTLEMENT_ENABLED",
    label: "cancelled",
  },
  {
    key: "MULTI_SELLER_SHOPIFY_DISPUTE_SETTLEMENT_ENABLED",
    label: "dispute",
  },
];
const MULTI_SELLER_STOREFRONT_CHECKOUT_FLAG =
  "MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED";
const SELLER_ORDER_SHADOW_WRITE_FLAG = "SELLER_ORDER_SHADOW_WRITE_ENABLED";
const VENDOR_ORDER_SELLER_ORDER_READ_FLAG = "VENDOR_ORDERS_USE_SELLER_ORDERS";
const MULTI_SELLER_STOREFRONT_REQUIRED_FLAGS = [
  ...MULTI_SELLER_SETTLEMENT_FLAGS,
  {
    key: VENDOR_ORDER_SELLER_ORDER_READ_FLAG,
    label: "seller order reads",
  },
];
const WITHDRAWAL_OPEN_STATUSES = [
  "REQUESTED",
  "ACKNOWLEDGED",
  "UNDER_REVIEW",
  "APPROVED",
  "RETURN_REQUESTED",
  "RETURN_RECEIVED",
  "REFUND_PENDING",
  "ERROR",
];
const URGENT_WITHDRAWAL_DEADLINE_DAYS = 3;

const REQUIRED_OPERATIONAL_SHOPIFY_SCOPES = [
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
];

const WRITE_SCOPES_THAT_SATISFY_READ_SCOPES = {
  read_inventory: "write_inventory",
  read_merchant_managed_fulfillment_orders:
    "write_merchant_managed_fulfillment_orders",
  read_products: "write_products",
  read_publications: "write_publications",
  read_shipping: "write_shipping",
};

function normalizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function extractEmailAddress(value) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return null;
  }

  const displayAddressMatch = normalized.match(/<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>/);
  if (displayAddressMatch) {
    return displayAddressMatch[1].toLowerCase();
  }

  return /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(normalized)
    ? normalized.toLowerCase()
    : null;
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

function hasGrantedShopifyScope(grantedScopes, requiredScope) {
  if (grantedScopes.includes(requiredScope)) {
    return true;
  }

  const impliedByWriteScope = WRITE_SCOPES_THAT_SATISFY_READ_SCOPES[requiredScope];
  return Boolean(impliedByWriteScope && grantedScopes.includes(impliedByWriteScope));
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

function isStripeConnectProductionEnabled(env) {
  return STRIPE_CONNECT_PRODUCTION_ENABLED_VALUES.has(
    String(env.STRIPE_CONNECT_PRODUCTION_ENABLED || "")
      .trim()
      .toLowerCase(),
  );
}

function isEnabledEnvFlag(env, key) {
  return STRIPE_CONNECT_PRODUCTION_ENABLED_VALUES.has(
    String(env[key] || "")
      .trim()
      .toLowerCase(),
  );
}

function inspectMultiSellerSettlementFlags(env) {
  const flags = MULTI_SELLER_SETTLEMENT_FLAGS.map((flag) => ({
    ...flag,
    enabled: isEnabledEnvFlag(env, flag.key),
  }));
  const enabled = flags.filter((flag) => flag.enabled);
  const disabled = flags.filter((flag) => !flag.enabled);

  return {
    flags,
    enabled,
    disabled,
    anyEnabled: enabled.length > 0,
    allEnabled: enabled.length === flags.length,
  };
}

function inspectMultiSellerStorefrontCheckoutFlag(env) {
  const enabled = isEnabledEnvFlag(env, MULTI_SELLER_STOREFRONT_CHECKOUT_FLAG);
  const prerequisites = MULTI_SELLER_STOREFRONT_REQUIRED_FLAGS.map((flag) => ({
    ...flag,
    enabled: isEnabledEnvFlag(env, flag.key),
  }));
  const missing = prerequisites.filter((flag) => !flag.enabled);

  return {
    enabled,
    prerequisites,
    missing,
    ready: enabled && missing.length === 0,
  };
}

function inspectWithdrawalEmailEnvironment(env) {
  const resendApiKey = normalizeText(env.RESEND_API_KEY);
  const withdrawalFromEmail = normalizeText(env.WITHDRAWAL_FROM_EMAIL);
  const fallbackFromEmail = normalizeText(env.MAIL_FROM || env.ADMIN_EMAIL);
  const supportEmail = normalizeText(env.WITHDRAWAL_SUPPORT_EMAIL);
  const publicBaseUrl = normalizeText(env.WITHDRAWAL_PUBLIC_BASE_URL);
  const returnAddress = normalizeText(env.WITHDRAWAL_RETURN_ADDRESS);
  const outboxWorkerToken = normalizeText(env.WITHDRAWAL_OUTBOX_WORKER_TOKEN);

  return {
    hasResendApiKey: Boolean(resendApiKey),
    resendApiKeyLooksValid: Boolean(resendApiKey && resendApiKey.startsWith("re_")),
    withdrawalFromEmail,
    fallbackFromEmail,
    fromEmailAddress: extractEmailAddress(withdrawalFromEmail || fallbackFromEmail),
    hasExplicitFromEmail: Boolean(withdrawalFromEmail),
    supportEmail,
    supportEmailAddress: extractEmailAddress(supportEmail),
    publicBaseUrl,
    publicBaseUrlLooksValid: Boolean(publicBaseUrl && /^https?:\/\//i.test(publicBaseUrl)),
    returnAddress,
    hasOutboxWorkerToken: Boolean(
      outboxWorkerToken && outboxWorkerToken.length >= 24,
    ),
  };
}

async function inspectWithdrawalOperations({ prismaClient = prisma } = {}) {
  if (!prismaClient.withdrawalRequest || !prismaClient.withdrawalEmailLog) {
    return {
      available: false,
      openCount: 0,
      deadlineExpiredCount: 0,
      deadlineSoonCount: 0,
      emailFailedCount: 0,
      processingIssueCount: 0,
      refundDecisionMissingCount: 0,
      refundCompletionMismatchCount: 0,
      returnInstructionMissingCount: 0,
      vendorNotificationMissingCount: 0,
      completionNotificationMissingCount: 0,
      rejectedWithoutReasonCount: 0,
      shopifyExternalRecordMissingCount: 0,
      outboxPendingCount: 0,
      outboxDeadLetterCount: 0,
      legacyLocaleMissingCount: 0,
      publishedLegalBundleCount: 0,
      error: "withdrawal_tables_unavailable",
    };
  }

  const now = new Date();
  const soon = new Date(
    now.getTime() + URGENT_WITHDRAWAL_DEADLINE_DAYS * 24 * 60 * 60 * 1000,
  );

  try {
    const [
      openCount,
      deadlineExpiredCount,
      deadlineSoonCount,
      emailFailedCount,
      refundDecisionMissingCount,
      refundCompletionMismatchCount,
      returnInstructionMissingCount,
      vendorNotificationMissingCount,
      completionNotificationMissingCount,
      rejectedWithoutReasonCount,
      shopifyExternalRecordMissingCount,
      outboxPendingCount,
      outboxDeadLetterCount,
      legacyLocaleMissingCount,
      publishedLegalBundleCount,
    ] = await Promise.all([
      prismaClient.withdrawalRequest.count({
        where: { status: { in: WITHDRAWAL_OPEN_STATUSES } },
      }),
      prismaClient.withdrawalRequest.count({
        where: {
          status: { in: WITHDRAWAL_OPEN_STATUSES },
          deadlineAt: { lt: now },
        },
      }),
      prismaClient.withdrawalRequest.count({
        where: {
          status: { in: WITHDRAWAL_OPEN_STATUSES },
          deadlineAt: { gte: now, lte: soon },
        },
      }),
      prismaClient.withdrawalEmailLog.count({
        where: { status: "failed" },
      }),
      prismaClient.withdrawalRequest.count({
        where: {
          status: { in: ["APPROVED", "REFUND_PENDING"] },
          refundDecisionStatus: "UNDECIDED",
        },
      }),
      prismaClient.withdrawalRequest.count({
        where: {
          OR: [
            {
              completionStatus: { in: ["REFUNDED", "PARTIALLY_REFUNDED"] },
              completionRefundedAmount: null,
            },
            {
              status: { in: ["REFUNDED", "CANCELLED"] },
              completionStatus: "UNDECIDED",
            },
            {
              completionStatus: { in: ["NO_REFUND_CLOSED", "REJECTED_CLOSED"] },
              completionAction: null,
              completionNotes: null,
            },
          ],
        },
      }),
      prismaClient.withdrawalRequest.count({
        where: {
          status: "RETURN_REQUESTED",
          emailLogs: {
            none: {
              emailType: "return_instructions",
              status: "sent",
            },
          },
        },
      }),
      prismaClient.withdrawalRequest.count({
        where: {
          status: {
            notIn: ["REJECTED", "EXPIRED"],
          },
          emailLogs: {
            none: {
              emailType: "vendor_notification",
              status: "sent",
            },
          },
        },
      }),
      prismaClient.withdrawalRequest.count({
        where: {
          completedAt: { not: null },
          completionStatus: { not: "UNDECIDED" },
          completionNotifiedAt: null,
        },
      }),
      prismaClient.withdrawalRequest.count({
        where: {
          status: "REJECTED",
          rejectionReason: null,
        },
      }),
      prismaClient.withdrawalRequest.count({
        where: {
          OR: [
            {
              completionStatus: { in: ["REFUNDED", "PARTIALLY_REFUNDED"] },
              completionShopifyRefundId: null,
            },
            {
              completionStatus: "CANCELLED",
              completionShopifyCancelId: null,
            },
          ],
        },
      }),
      prismaClient.withdrawalEmailOutbox?.count
        ? prismaClient.withdrawalEmailOutbox.count({
            where: { status: { in: ["PENDING", "PROCESSING", "FAILED"] } },
          })
        : Promise.resolve(0),
      prismaClient.withdrawalEmailOutbox?.count
        ? prismaClient.withdrawalEmailOutbox.count({
            where: { status: "DEAD_LETTER" },
          })
        : Promise.resolve(0),
      prismaClient.withdrawalRequest.count({
        where: {
          OR: [
            { submittedAt: null },
            { submittedViewLocale: null },
            { correspondenceLocale: null },
          ],
        },
      }),
      prismaClient.withdrawalLegalBundle?.count
        ? prismaClient.withdrawalLegalBundle.count({
            where: { status: "PUBLISHED" },
          })
        : Promise.resolve(0),
    ]);
    const processingIssueCount =
      refundDecisionMissingCount +
      refundCompletionMismatchCount +
      returnInstructionMissingCount +
      vendorNotificationMissingCount +
      completionNotificationMissingCount +
      rejectedWithoutReasonCount +
      shopifyExternalRecordMissingCount;

    return {
      available: true,
      openCount,
      deadlineExpiredCount,
      deadlineSoonCount,
      emailFailedCount,
      processingIssueCount,
      refundDecisionMissingCount,
      refundCompletionMismatchCount,
      returnInstructionMissingCount,
      vendorNotificationMissingCount,
      completionNotificationMissingCount,
      rejectedWithoutReasonCount,
      shopifyExternalRecordMissingCount,
      outboxPendingCount,
      outboxDeadLetterCount,
      legacyLocaleMissingCount,
      publishedLegalBundleCount,
      error: null,
    };
  } catch (error) {
    console.error("withdrawal readiness inspect error:", error);
    return {
      available: false,
      openCount: 0,
      deadlineExpiredCount: 0,
      deadlineSoonCount: 0,
      emailFailedCount: 0,
      processingIssueCount: 0,
      refundDecisionMissingCount: 0,
      refundCompletionMismatchCount: 0,
      returnInstructionMissingCount: 0,
      vendorNotificationMissingCount: 0,
      completionNotificationMissingCount: 0,
      rejectedWithoutReasonCount: 0,
      shopifyExternalRecordMissingCount: 0,
      outboxPendingCount: 0,
      outboxDeadLetterCount: 0,
      legacyLocaleMissingCount: 0,
      publishedLegalBundleCount: 0,
      error: error?.code || "withdrawal_readiness_failed",
    };
  }
}

async function inspectDirectReturnReadiness({ prismaClient = prisma } = {}) {
  if (
    !prismaClient?.withdrawalWorkflowPolicy?.findFirst ||
    !prismaClient?.vendorStore?.findMany
  ) {
    return {
      available: false,
      activePolicy: null,
      relevantStoreCount: 0,
      missingAddressStores: [],
      error: "direct_return_tables_unavailable",
    };
  }
  try {
    const [activePolicy, relevantStores] = await Promise.all([
      prismaClient.withdrawalWorkflowPolicy.findFirst({
        where: { active: true, directReturnEnabled: true },
        orderBy: [{ version: "desc" }],
      }),
      prismaClient.vendorStore.findMany({
        where: {
          seller: { euSellerStatus: { in: [...EU_SELLER_ALLOWED_STATUSES] } },
          products: {
            some: {
              OR: [
                { productEuStatus: { in: [...EU_PRODUCT_ALLOWED_STATUSES] } },
                { euSaleRequested: true },
              ],
            },
          },
        },
        select: {
          id: true,
          storeName: true,
          returnAddresses: {
            where: { status: "ACTIVE" },
            select: {
              id: true,
              countryCode: true,
              internationalRecipientName: true,
              internationalAddressLines: true,
              locales: {
                where: { locale: "en-GB" },
                select: { id: true },
              },
            },
            take: 1,
          },
        },
      }),
    ]);
    return {
      available: true,
      activePolicy,
      relevantStoreCount: relevantStores.length,
      missingAddressStores: relevantStores
        .filter((store) => store.returnAddresses.length === 0)
        .map((store) => ({ id: store.id, storeName: store.storeName })),
      incompleteInternationalAddressStores: relevantStores
        .filter((store) => {
          const address = store.returnAddresses[0];
          if (!address) return false;
          const lines = Array.isArray(address.internationalAddressLines)
            ? address.internationalAddressLines.filter(Boolean)
            : [];
          return (
            !address.internationalRecipientName ||
            lines.length === 0 ||
            address.locales.length === 0
          );
        })
        .map((store) => ({ id: store.id, storeName: store.storeName })),
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      activePolicy: null,
      relevantStoreCount: 0,
      missingAddressStores: [],
      incompleteInternationalAddressStores: [],
      error: error?.code || "direct_return_readiness_failed",
    };
  }
}

function buildDirectReturnChecks({ directReturns }) {
  if (!directReturns.available) {
    return [
      createCheck({
        id: "withdrawal_direct_return_tables",
        category: "app",
        status: "warning",
        title: "店舗別返送のデータベース",
        detail: `店舗別返送の準備状況を取得できません: ${directReturns.error}.`,
        action: "Prisma migrationを適用してから再確認してください。",
      }),
    ];
  }
  const missing = directReturns.missingAddressStores;
  const incompleteInternational =
    directReturns.incompleteInternationalAddressStores || [];
  return [
    createCheck({
      id: "withdrawal_direct_return_policy",
      category: "app",
      status: directReturns.activePolicy ? "pass" : "warning",
      title: "店舗別返送の運用方針",
      detail: directReturns.activePolicy
        ? `方針v${directReturns.activePolicy.version} / 規約版 ${directReturns.activePolicy.termsVersion} を新規申請に適用中です。`
        : "店舗別返送V2の有効な方針はありません。既存のV1運用は継続します。",
      action: directReturns.activePolicy
        ? ""
        : "/app/withdrawal-settings で契約形態と規約版を確認してから有効化してください。",
    }),
    createCheck({
      id: "withdrawal_direct_return_addresses",
      category: "app",
      status: missing.length > 0 ? "warning" : "pass",
      title: "EU販売店舗の返送先",
      detail:
        missing.length > 0
          ? `${directReturns.relevantStoreCount}店舗中${missing.length}店舗に有効な返送先がありません: ${missing.map((store) => store.storeName).join("、")}`
          : `${directReturns.relevantStoreCount}件のEU販売対象店舗に有効な返送先があります。`,
      action:
        missing.length > 0
          ? "各店舗の「返送先設定」で、実際に返品を受領できる住所を確認して有効化してください。"
          : "",
    }),
    createCheck({
      id: "withdrawal_direct_return_international_addresses",
      category: "app",
      status: incompleteInternational.length > 0 ? "warning" : "pass",
      title: "海外購入者向け返送先表記",
      detail:
        incompleteInternational.length > 0
          ? `${incompleteInternational.length}店舗で英字の宛名・住所・案内が不足しています: ${incompleteInternational.map((store) => store.storeName).join("、")}`
          : "EU販売対象店舗の有効な返送先に英字表記があります。",
      action:
        incompleteInternational.length > 0
          ? "各店舗の「返品受取先」で海外から返送できる英字表記を登録し、返送先を再度有効化してください。"
          : "",
    }),
  ];
}

function normalizeProvider(value, fallback) {
  return String(value || fallback)
    .trim()
    .toLowerCase();
}

function inspectOperationEnvironment(env = process.env) {
  const configuredPaymentProvider = normalizeText(env.PAYMENT_PROVIDER);
  const configuredSellerPayoutProvider = normalizeText(
    env.SELLER_PAYOUT_PROVIDER,
  );
  const paymentProvider = normalizeProvider(
    configuredPaymentProvider,
    DEFAULT_PAYMENT_PROVIDER,
  );
  const sellerPayoutProvider = normalizeProvider(
    configuredSellerPayoutProvider,
    DEFAULT_SELLER_PAYOUT_PROVIDER,
  );
  const stripeConnectProductionEnabled =
    isStripeConnectProductionEnabled(env) ||
    paymentProvider === "stripe_connect" ||
    sellerPayoutProvider === "stripe_connect";

  return {
    paymentProvider,
    sellerPayoutProvider,
    paymentProviderLabel:
      PAYMENT_PROVIDER_LABELS[paymentProvider] || paymentProvider,
    sellerPayoutProviderLabel:
      SELLER_PAYOUT_PROVIDER_LABELS[sellerPayoutProvider] ||
      sellerPayoutProvider,
    paymentProviderConfigured: Boolean(configuredPaymentProvider),
    sellerPayoutProviderConfigured: Boolean(configuredSellerPayoutProvider),
    paymentProviderSupported: SUPPORTED_PAYMENT_PROVIDERS.has(paymentProvider),
    sellerPayoutProviderSupported:
      SUPPORTED_SELLER_PAYOUT_PROVIDERS.has(sellerPayoutProvider),
    stripeConnectProductionEnabled,
  };
}

function requiredOrWarningStatus(passes, required) {
  if (passes) {
    return "pass";
  }

  return required ? "fail" : "warning";
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
    isLive: secretKeyMode === "live" && publishableKeyMode === "live",
    isTest: secretKeyMode === "test" || publishableKeyMode === "test",
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

function buildEnvironmentChecks({ stripeEnv, env, operationEnv }) {
  const checks = [];
  const isProductionRuntime = env.NODE_ENV === "production";
  const multiSellerSettlementFlags = inspectMultiSellerSettlementFlags(env);
  const multiSellerStorefrontCheckout =
    inspectMultiSellerStorefrontCheckoutFlag(env);
  const withdrawalEmailEnv = inspectWithdrawalEmailEnvironment(env);
  const sellerOrderShadowWriteEnabled = isEnabledEnvFlag(
    env,
    SELLER_ORDER_SHADOW_WRITE_FLAG,
  );
  const sellerOrderVendorOrderReadsEnabled = isEnabledEnvFlag(
    env,
    VENDOR_ORDER_SELLER_ORDER_READ_FLAG,
  );
  const {
    paymentProvider,
    sellerPayoutProvider,
    paymentProviderLabel,
    sellerPayoutProviderLabel,
    paymentProviderConfigured,
    sellerPayoutProviderConfigured,
    paymentProviderSupported,
    sellerPayoutProviderSupported,
    stripeConnectProductionEnabled,
  } = operationEnv;
  const stripeSecretKeyLive = stripeEnv.secretKeyMode === "live";
  const stripePublishableKeyLive = stripeEnv.publishableKeyMode === "live";
  const stripeKeysBothMissing =
    stripeEnv.secretKeyMode === "missing" &&
    stripeEnv.publishableKeyMode === "missing";
  const stripeKeyModesAcceptable =
    stripeEnv.modesMatch ||
    (!stripeConnectProductionEnabled && stripeKeysBothMissing);

  checks.push(
    createCheck({
      id: "payment_provider",
      category: "app",
      status: paymentProviderSupported
        ? paymentProviderConfigured
          ? "pass"
          : "warning"
        : "fail",
      title: "Payment provider",
      detail: paymentProviderSupported
        ? paymentProviderConfigured
          ? `PAYMENT_PROVIDER is ${paymentProvider}.`
          : `PAYMENT_PROVIDER is not set. Defaulting to ${DEFAULT_PAYMENT_PROVIDER}.`
        : `PAYMENT_PROVIDER is ${paymentProvider}. The current production flow supports ${DEFAULT_PAYMENT_PROVIDER}.`,
      action: paymentProviderSupported
        ? paymentProviderConfigured
          ? ""
          : "Set PAYMENT_PROVIDER=shopify_payments in Render so the production mode is explicit."
        : "Keep Shopify Checkout / Shopify Payments as the production payment provider, or add a separate readiness profile for another provider.",
    }),
  );

  checks.push(
    createCheck({
      id: "seller_payout_provider",
      category: "payout",
      status: sellerPayoutProviderSupported
        ? sellerPayoutProviderConfigured
          ? "pass"
          : "warning"
        : "fail",
      title: "Seller payout provider",
      detail: sellerPayoutProviderSupported
        ? sellerPayoutProviderConfigured
          ? `SELLER_PAYOUT_PROVIDER is ${sellerPayoutProvider}.`
          : `SELLER_PAYOUT_PROVIDER is not set. Defaulting to ${DEFAULT_SELLER_PAYOUT_PROVIDER}.`
        : `SELLER_PAYOUT_PROVIDER is ${sellerPayoutProvider}. Supported values are manual or wise.`,
      action: sellerPayoutProviderSupported
        ? sellerPayoutProviderConfigured
          ? ""
          : "Set SELLER_PAYOUT_PROVIDER=manual or SELLER_PAYOUT_PROVIDER=wise in Render."
        : "Use manual payouts or Wise API payouts for the Shopify Payments production flow.",
    }),
  );

  checks.push(
    createCheck({
      id: "production_payment_flow",
      category: "app",
      status: "manual",
      title: "Production payment flow",
      detail: stripeConnectProductionEnabled
        ? "Stripe Connect production checks are enabled by STRIPE_CONNECT_PRODUCTION_ENABLED or provider configuration."
        : `Production checkout uses ${paymentProviderLabel}. Seller payouts use ${sellerPayoutProviderLabel}.`,
      action: stripeConnectProductionEnabled
        ? "Complete live Stripe Connect keys, webhooks, connected accounts, and payout readiness before using this mode."
        : "Keep Stripe Connect direct charges and Connect payouts disabled unless the policy changes.",
    }),
  );

  checks.push(
    createCheck({
      id: "withdrawal_resend_api_key",
      category: "app",
      status: withdrawalEmailEnv.resendApiKeyLooksValid ? "pass" : "warning",
      title: "Withdrawal request email API",
      detail: withdrawalEmailEnv.hasResendApiKey
        ? withdrawalEmailEnv.resendApiKeyLooksValid
          ? "RESEND_API_KEY is configured for withdrawal request emails."
          : "RESEND_API_KEY is set, but it does not look like a Resend re_... key."
        : "RESEND_API_KEY is not set. Withdrawal requests can be stored, but acknowledgement emails will be skipped.",
      action: withdrawalEmailEnv.resendApiKeyLooksValid
        ? ""
        : "Set RESEND_API_KEY in Render before relying on EU withdrawal acknowledgement emails.",
    }),
  );

  checks.push(
    createCheck({
      id: "withdrawal_from_email",
      category: "app",
      status: withdrawalEmailEnv.fromEmailAddress
        ? withdrawalEmailEnv.hasExplicitFromEmail
          ? "pass"
          : "warning"
        : "warning",
      title: "Withdrawal email sender",
      detail: withdrawalEmailEnv.fromEmailAddress
        ? withdrawalEmailEnv.hasExplicitFromEmail
          ? `WITHDRAWAL_FROM_EMAIL is configured as ${withdrawalEmailEnv.fromEmailAddress}.`
          : `Using fallback sender ${withdrawalEmailEnv.fromEmailAddress}.`
        : "No valid withdrawal email sender was found.",
      action: withdrawalEmailEnv.fromEmailAddress
        ? withdrawalEmailEnv.hasExplicitFromEmail
          ? ""
          : "Set WITHDRAWAL_FROM_EMAIL explicitly, for example Store Support <support@example.com>."
        : "Set WITHDRAWAL_FROM_EMAIL to a verified sender on the Resend domain.",
    }),
  );

  checks.push(
    createCheck({
      id: "withdrawal_support_email",
      category: "app",
      status: withdrawalEmailEnv.supportEmailAddress ? "pass" : "warning",
      title: "Withdrawal support email",
      detail: withdrawalEmailEnv.supportEmailAddress
        ? `WITHDRAWAL_SUPPORT_EMAIL is ${withdrawalEmailEnv.supportEmailAddress}.`
        : "WITHDRAWAL_SUPPORT_EMAIL is not configured.",
      action: withdrawalEmailEnv.supportEmailAddress
        ? ""
        : "Set WITHDRAWAL_SUPPORT_EMAIL so customer withdrawal emails include a clear support contact.",
    }),
  );

  checks.push(
    createCheck({
      id: "withdrawal_public_base_url",
      category: "app",
      status: withdrawalEmailEnv.publicBaseUrlLooksValid ? "pass" : "warning",
      title: "Withdrawal public link domain",
      detail: withdrawalEmailEnv.publicBaseUrl
        ? withdrawalEmailEnv.publicBaseUrlLooksValid
          ? `WITHDRAWAL_PUBLIC_BASE_URL is ${withdrawalEmailEnv.publicBaseUrl}.`
          : "WITHDRAWAL_PUBLIC_BASE_URL is set, but it is not an http(s) URL."
        : "WITHDRAWAL_PUBLIC_BASE_URL is not configured. Return proof links will fall back to APP_URL.",
      action: withdrawalEmailEnv.publicBaseUrlLooksValid
        ? ""
        : "Set WITHDRAWAL_PUBLIC_BASE_URL to the storefront origin, for example https://oja-immanuel-bacchus.com.",
    }),
  );

  checks.push(
    createCheck({
      id: "withdrawal_outbox_worker_token",
      category: "app",
      status: withdrawalEmailEnv.hasOutboxWorkerToken ? "pass" : "warning",
      title: "撤回メール再送ワーカー",
      detail: withdrawalEmailEnv.hasOutboxWorkerToken
        ? "WITHDRAWAL_OUTBOX_WORKER_TOKENが設定されています。"
        : "WITHDRAWAL_OUTBOX_WORKER_TOKENが未設定または短すぎます。初回送信に失敗したメールを定期再送できません。",
      action: withdrawalEmailEnv.hasOutboxWorkerToken
        ? ""
        : "24文字以上のランダムなWITHDRAWAL_OUTBOX_WORKER_TOKENを設定し、内部ワーカーを定期実行してください。",
    }),
  );

  checks.push(
    createCheck({
      id: "withdrawal_return_address_legacy",
      category: "app",
      status: "manual",
      title: "旧申請用の共通返送先",
      detail: withdrawalEmailEnv.returnAddress
        ? "WITHDRAWAL_RETURN_ADDRESSはV1申請専用として設定されています。V2では使用しません。"
        : "WITHDRAWAL_RETURN_ADDRESSは未設定です。V2では店舗別の返送先だけを使用します。",
      action:
        "未処理のV1申請に共通返送先が必要な場合だけ設定してください。V2のフォールバックには使用しません。",
    }),
  );

  checks.push(
    createCheck({
      id: "multi_seller_backend_settlement_flags",
      category: "app",
      status: !multiSellerSettlementFlags.anyEnabled
        ? "pass"
        : multiSellerSettlementFlags.allEnabled
          ? "warning"
          : "fail",
      title: "Multi-seller backend settlement flags",
      detail: !multiSellerSettlementFlags.anyEnabled
        ? "Multi-seller settlement flags are disabled. Current live checkout should remain single-seller."
        : multiSellerSettlementFlags.allEnabled
          ? `Backend settlement flags are enabled for ${multiSellerSettlementFlags.enabled
              .map((flag) => flag.label)
              .join(", ")}. This is for controlled backend testing only.`
          : `Only some backend settlement flags are enabled: ${multiSellerSettlementFlags.enabled
              .map((flag) => flag.label)
              .join(", ") || "none"}. Missing: ${multiSellerSettlementFlags.disabled
              .map((flag) => flag.label)
              .join(", ")}.`,
      action: !multiSellerSettlementFlags.anyEnabled
        ? "No action is needed unless running controlled multi-seller backend tests."
        : multiSellerSettlementFlags.allEnabled
          ? "Keep storefront multi-seller checkout disabled until ready; enable MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED only with VENDOR_ORDERS_USE_SELLER_ORDERS and seller-specific fulfillment verified."
          : "Disable all multi-seller settlement flags, or enable paid/refund/cancelled/dispute together only for controlled backend tests.",
    }),
  );

  checks.push(
    createCheck({
      id: "seller_order_shadow_write",
      category: "app",
      status: sellerOrderShadowWriteEnabled
        ? "pass"
        : multiSellerStorefrontCheckout.enabled
          ? "fail"
          : multiSellerSettlementFlags.anyEnabled
            ? "warning"
            : "manual",
      title: "SellerOrder shadow write",
      detail: sellerOrderShadowWriteEnabled
        ? "SELLER_ORDER_SHADOW_WRITE_ENABLED is enabled. New paid orders will create SellerOrder verification records."
        : "SELLER_ORDER_SHADOW_WRITE_ENABLED is disabled. New paid orders will not accumulate SellerOrder verification records.",
      action: sellerOrderShadowWriteEnabled
        ? "Review /app/seller-order-shadow after test orders or backfill runs."
        : multiSellerStorefrontCheckout.enabled
          ? "Disable MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED, or set SELLER_ORDER_SHADOW_WRITE_ENABLED=true and verify SellerOrder checks before opening this path."
          : multiSellerSettlementFlags.anyEnabled
            ? "Set SELLER_ORDER_SHADOW_WRITE_ENABLED=true while running controlled multi-seller backend tests."
            : "Set SELLER_ORDER_SHADOW_WRITE_ENABLED=true when collecting SellerOrder validation data.",
    }),
  );

  checks.push(
    createCheck({
      id: "seller_order_vendor_order_reads",
      category: "app",
      status: sellerOrderVendorOrderReadsEnabled ? "warning" : "pass",
      title: "Vendor order SellerOrder reads",
      detail: !sellerOrderVendorOrderReadsEnabled
        ? "VENDOR_ORDERS_USE_SELLER_ORDERS is disabled. Vendor order pages use the legacy ledger path."
        : sellerOrderShadowWriteEnabled
          ? "VENDOR_ORDERS_USE_SELLER_ORDERS is enabled. Vendor order pages prefer SellerOrder reads and fall back to the legacy ledger path if SellerOrder reads fail."
          : "VENDOR_ORDERS_USE_SELLER_ORDERS is enabled, but SELLER_ORDER_SHADOW_WRITE_ENABLED is disabled. Vendor order pages can fall back to the legacy ledger path, but new verification data will not accumulate.",
      action: !sellerOrderVendorOrderReadsEnabled
        ? "Enable this only after SellerOrder shadow checks are matched enough for controlled testing."
        : sellerOrderShadowWriteEnabled
          ? "Review /app/seller-order-shadow and keep the legacy fallback in place during the read switch."
          : "Set SELLER_ORDER_SHADOW_WRITE_ENABLED=true before relying on SellerOrder reads for ongoing validation.",
    }),
  );

  checks.push(
    createCheck({
      id: "multi_seller_storefront_checkout_flag",
      category: "app",
      status: !multiSellerStorefrontCheckout.enabled
        ? "pass"
        : multiSellerStorefrontCheckout.ready
          ? "warning"
          : "fail",
      title: "Multi-seller storefront checkout",
      detail: !multiSellerStorefrontCheckout.enabled
        ? "Storefront multi-seller checkout is disabled."
        : multiSellerStorefrontCheckout.ready
          ? "Storefront multi-seller checkout is enabled with backend settlement flags and SellerOrder reads."
          : `MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED is enabled, but missing prerequisites: ${multiSellerStorefrontCheckout.missing
              .map((flag) => flag.label)
              .join(", ")}.`,
      action: !multiSellerStorefrontCheckout.enabled
        ? "No action is needed unless intentionally opening multi-seller checkout."
        : multiSellerStorefrontCheckout.ready
          ? "Keep enabled only after controlled checkout, settlement, refund, cancellation, dispute, and seller-specific fulfillment tests pass."
          : "Disable MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED, or enable all backend settlement flags and VENDOR_ORDERS_USE_SELLER_ORDERS before opening this path.",
    }),
  );

  checks.push(
    createCheck({
      id: "stripe_secret_key_live",
      category: "stripe",
      status: requiredOrWarningStatus(
        stripeSecretKeyLive,
        stripeConnectProductionEnabled,
      ),
      title: "Stripe secret key",
      detail: stripeSecretKeyLive
        ? "STRIPE_SECRET_KEY is a live key."
        : stripeConnectProductionEnabled
          ? `Current mode is ${stripeEnv.secretKeyMode}. Live Stripe Connect operation needs sk_live_...`
          : `Current mode is ${stripeEnv.secretKeyMode}. This is not a production blocker while Shopify Payments and manual seller payouts are the active flow.`,
      action: stripeSecretKeyLive
        ? ""
        : stripeConnectProductionEnabled
          ? "Set the live secret key in Render, then redeploy or restart the service."
          : "Only set a live Stripe secret key before enabling Stripe Connect direct charges or Connect payouts.",
    }),
  );

  checks.push(
    createCheck({
      id: "stripe_publishable_key_live",
      category: "stripe",
      status: requiredOrWarningStatus(
        stripePublishableKeyLive,
        stripeConnectProductionEnabled,
      ),
      title: "Stripe publishable key",
      detail: stripePublishableKeyLive
        ? "STRIPE_PUBLISHABLE_KEY is a live key."
        : stripeConnectProductionEnabled
          ? `Current mode is ${stripeEnv.publishableKeyMode}. Live Stripe Connect operation needs pk_live_...`
          : `Current mode is ${stripeEnv.publishableKeyMode}. This is not a production blocker while Shopify Payments and manual seller payouts are the active flow.`,
      action: stripePublishableKeyLive
        ? ""
        : stripeConnectProductionEnabled
          ? "Set the live publishable key in Render, then redeploy or restart the service."
          : "Only set a live Stripe publishable key before enabling embedded Stripe Connect account management.",
    }),
  );

  checks.push(
    createCheck({
      id: "stripe_key_modes_match",
      category: "stripe",
      status: requiredOrWarningStatus(
        stripeKeyModesAcceptable,
        stripeConnectProductionEnabled,
      ),
      title: "Stripe key mode match",
      detail: stripeKeyModesAcceptable
        ? stripeKeysBothMissing
          ? "No Stripe keys are configured. This is acceptable for the current Shopify Payments flow."
          : "Secret key and publishable key use the same mode."
        : `Secret key mode is ${stripeEnv.secretKeyMode}; publishable key mode is ${stripeEnv.publishableKeyMode}.`,
      action: stripeKeyModesAcceptable
        ? ""
        : stripeConnectProductionEnabled
          ? "Use keys from the same Stripe account and the same live/test mode."
          : "Clean this up before enabling Stripe Connect features in production.",
    }),
  );

  checks.push(
    createCheck({
      id: "stripe_platform_webhook_secret",
      category: "stripe",
      status: requiredOrWarningStatus(
        stripeEnv.hasPlatformWebhookSecret &&
          stripeEnv.platformWebhookSecretLooksValid,
        stripeConnectProductionEnabled,
      ),
      title: "Stripe platform webhook secret",
      detail:
        stripeEnv.hasPlatformWebhookSecret &&
        stripeEnv.platformWebhookSecretLooksValid
          ? "STRIPE_WEBHOOK_SECRET is configured."
          : stripeConnectProductionEnabled
            ? "STRIPE_WEBHOOK_SECRET is missing or invalid."
            : "STRIPE_WEBHOOK_SECRET is missing or invalid. This is only required for live Stripe webhook processing.",
      action:
        stripeEnv.hasPlatformWebhookSecret &&
        stripeEnv.platformWebhookSecretLooksValid
          ? ""
          : stripeConnectProductionEnabled
            ? "Create the live platform webhook endpoint in Stripe and set its whsec_... value."
            : "Leave unset unless Stripe platform webhook events are enabled for production.",
    }),
  );

  checks.push(
    createCheck({
      id: "stripe_connect_webhook_secret",
      category: "stripe",
      status: requiredOrWarningStatus(
        stripeEnv.hasConnectWebhookSecret &&
          stripeEnv.connectWebhookSecretLooksValid,
        stripeConnectProductionEnabled,
      ),
      title: "Stripe Connect webhook secret",
      detail:
        stripeEnv.hasConnectWebhookSecret &&
        stripeEnv.connectWebhookSecretLooksValid
          ? "STRIPE_CONNECT_WEBHOOK_SECRET is configured."
          : stripeConnectProductionEnabled
            ? "STRIPE_CONNECT_WEBHOOK_SECRET is missing or invalid."
            : "STRIPE_CONNECT_WEBHOOK_SECRET is missing or invalid. This is only required for live Connect events.",
      action:
        stripeEnv.hasConnectWebhookSecret &&
        stripeEnv.connectWebhookSecretLooksValid
          ? ""
          : stripeConnectProductionEnabled
            ? "Create a live Connect webhook endpoint for events on connected accounts and set its whsec_... value."
            : "Leave unset unless Stripe Connect account events are enabled for production.",
    }),
  );

  checks.push(
    createCheck({
      id: "stripe_platform_fee_bps",
      category: "stripe",
      status: requiredOrWarningStatus(
        stripeEnv.platformFeeBpsValid,
        stripeConnectProductionEnabled,
      ),
      title: "Stripe platform fee bps",
      detail: stripeEnv.platformFeeBpsValid
        ? `STRIPE_PLATFORM_FEE_BPS is ${stripeEnv.platformFeeBps}.`
        : stripeConnectProductionEnabled
          ? "STRIPE_PLATFORM_FEE_BPS must be an integer from 0 to 10000."
          : "STRIPE_PLATFORM_FEE_BPS is invalid, but Stripe fee collection is not part of the current production flow.",
      action: stripeEnv.platformFeeBpsValid
        ? ""
        : stripeConnectProductionEnabled
          ? "Set STRIPE_PLATFORM_FEE_BPS explicitly in Render."
          : "Fix this before enabling Stripe Connect checkout or fee collection.",
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
    (scope) => !hasGrantedShopifyScope(grantedScopes, scope),
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

function buildPayoutChecks({ env, operationEnv }) {
  const wiseChecks = [];
  const wiseConfig = {
    hasApiToken: Boolean(normalizeText(env.WISE_API_TOKEN)),
    hasProfileId: Boolean(normalizeText(env.WISE_PROFILE_ID)),
    hasApiBaseUrl: Boolean(normalizeText(env.WISE_API_BASE_URL)),
    hasWebhookSecret: Boolean(normalizeText(env.WISE_WEBHOOK_SECRET)),
    sourceCurrency: normalizeText(env.WISE_SOURCE_CURRENCY),
  };
  const wiseConfigReady =
    wiseConfig.hasApiToken &&
    wiseConfig.hasProfileId &&
    wiseConfig.hasApiBaseUrl &&
    Boolean(wiseConfig.sourceCurrency);

  if (operationEnv.sellerPayoutProvider === SELLER_PAYOUT_PROVIDER_WISE) {
    wiseChecks.push(
      createCheck({
        id: "wise_api_environment",
        category: "payout",
        status: wiseConfigReady ? "pass" : "fail",
        title: "Wise API environment",
        detail: wiseConfigReady
          ? `Wise API env is configured for source currency ${wiseConfig.sourceCurrency}.`
          : "Wise payout mode needs WISE_API_TOKEN, WISE_PROFILE_ID, WISE_API_BASE_URL, and WISE_SOURCE_CURRENCY.",
        action: wiseConfigReady
          ? ""
          : "Configure Wise sandbox or production credentials in Render before enabling Wise payout execution.",
      }),
      createCheck({
        id: "wise_webhook_secret",
        category: "payout",
        status: wiseConfig.hasWebhookSecret ? "pass" : "warning",
        title: "Wise webhook secret",
        detail: wiseConfig.hasWebhookSecret
          ? "WISE_WEBHOOK_SECRET is configured."
          : "WISE_WEBHOOK_SECRET is missing. Polling can be used during early testing, but webhook verification should be configured before relying on asynchronous completion.",
        action: wiseConfig.hasWebhookSecret
          ? ""
          : "Create a Wise transfer state-change webhook subscription and set the webhook verification secret.",
      }),
      createCheck({
        id: "wise_execution_safety",
        category: "payout",
        status: "manual",
        title: "Wise execution safety",
        detail:
          "Wise payout execution must stay behind admin approval, idempotency keys, and sandbox/dry-run testing until live transfers are explicitly enabled.",
        action:
          "Do not execute live Wise funding from an automatic job until sandbox transfer, failure, retry, and webhook idempotency tests pass.",
      }),
    );
  } else {
    wiseChecks.push(
      createCheck({
        id: "wise_api_connection",
        category: "payout",
        status: wiseConfig.hasApiToken ? "warning" : "manual",
        title: "Wise API connection",
        detail: wiseConfig.hasApiToken
          ? "WISE_API_TOKEN is present, but SELLER_PAYOUT_PROVIDER is not wise."
          : "No Wise API token is configured. This is expected for the current manual payout flow.",
        action:
          "Set SELLER_PAYOUT_PROVIDER=wise only after recipient storage, quote/transfer creation, funding, and webhook handling are tested.",
      }),
    );
  }

  return [
    createCheck({
      id: "seller_payout_transfer_mode",
      category: "payout",
      status: "manual",
      title: "Seller payout transfer mode",
      detail:
        operationEnv.sellerPayoutProvider === SELLER_PAYOUT_PROVIDER_WISE
          ? "Seller payouts are configured for Wise API payout runs, with admin approval required before execution."
          : "Seller payouts are recorded as manual bank/Wise transfers after the real transfer is completed outside the app.",
      action:
        operationEnv.sellerPayoutProvider === SELLER_PAYOUT_PROVIDER_WISE
          ? "Use Wise API only after the payout run is approved and the ledger balance is recalculated."
          : "After the actual transfer is completed outside the app, record the external transfer ID on the payout run.",
    }),
    ...wiseChecks,
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

function buildSellerChecks({
  sellerRows,
  connectedAccountProbe,
  operationEnv,
}) {
  const { sellerPayoutProvider, stripeConnectProductionEnabled } = operationEnv;
  const activeSellers = sellerRows.filter((row) => row.status === "active");
  const activeSellersWithoutPayoutRecord =
    sellerPayoutProvider === SELLER_PAYOUT_PROVIDER_WISE
      ? activeSellers.filter((row) => !row.payoutRecipient?.wiseRecipientId)
      : [];
  const invalidConnectedAccounts = connectedAccountProbe.filter(
    (row) => !row.ok,
  );
  const unavailableConnectedAccounts = connectedAccountProbe.filter(
    (row) =>
      row.ok &&
      (!row.detailsSubmitted || !row.chargesEnabled || !row.payoutsEnabled),
  );

  return [
    createCheck({
      id: "active_sellers_have_stripe_accounts",
      category: "seller",
      status: activeSellersWithoutPayoutRecord.length === 0 ? "pass" : "fail",
      title: "Active sellers have payout recipient records",
      detail:
        activeSellersWithoutPayoutRecord.length === 0
          ? sellerPayoutProvider === SELLER_PAYOUT_PROVIDER_WISE
            ? "All active sellers have Wise recipient records."
            : "Manual settlement mode does not require seller Stripe accounts or Wise recipient records before go-live."
          : sellerPayoutProvider === SELLER_PAYOUT_PROVIDER_WISE
            ? `${activeSellersWithoutPayoutRecord.length} active seller(s) have no Wise recipient record.`
            : `${activeSellersWithoutPayoutRecord.length} active seller(s) have no seller payout bookkeeping record.`,
      action:
        activeSellersWithoutPayoutRecord.length === 0
          ? ""
          : sellerPayoutProvider === SELLER_PAYOUT_PROVIDER_WISE
            ? "Collect and verify the seller's Wise recipient details, or keep the seller inactive until payouts are not required."
            : "Keep manual settlement approval based on ledger balance and external transfer records.",
    }),
    createCheck({
      id: "connected_accounts_match_current_stripe_key",
      category: "seller",
      status: stripeConnectProductionEnabled
        ? invalidConnectedAccounts.length === 0
          ? "pass"
          : "fail"
        : "manual",
      title: "Connected accounts match current Stripe key",
      detail: stripeConnectProductionEnabled
        ? invalidConnectedAccounts.length === 0
          ? "Connected account probes succeeded for the sampled sellers."
          : `${invalidConnectedAccounts.length} sampled connected account(s) could not be retrieved with the current Stripe key.`
        : "Skipped because Stripe Connect is not the production checkout or payout rail.",
      action: stripeConnectProductionEnabled
        ? invalidConnectedAccounts.length === 0
          ? ""
          : "Accounts created under a test platform cannot be used with live keys. Recreate those seller Stripe accounts after switching to live keys."
        : "Only verify or recreate connected accounts if enabling Stripe Connect direct charges or Connect payouts.",
    }),
    createCheck({
      id: "connected_accounts_ready",
      category: "seller",
      status: stripeConnectProductionEnabled
        ? unavailableConnectedAccounts.length === 0
          ? "pass"
          : "warning"
        : "manual",
      title: "Connected accounts are enabled",
      detail: stripeConnectProductionEnabled
        ? unavailableConnectedAccounts.length === 0
          ? "Sampled connected accounts are submitted and enabled."
          : `${unavailableConnectedAccounts.length} sampled connected account(s) are not fully enabled.`
        : "Not required for the current manual seller payout flow.",
      action: stripeConnectProductionEnabled
        ? unavailableConnectedAccounts.length === 0
          ? ""
          : "Ask the seller to complete the embedded payment settings, then review the seller before payout."
        : "Keep seller payout approval based on ledger balance and the external bank/Wise transfer record.",
    }),
  ];
}

function buildWithdrawalOperationChecks({ withdrawalOperations }) {
  const checks = [];

  checks.push(
    createCheck({
      id: "withdrawal_operations_available",
      category: "app",
      status: withdrawalOperations.available ? "pass" : "warning",
      title: "Withdrawal request operation data",
      detail: withdrawalOperations.available
        ? "Withdrawal request tables are available for operational readiness checks."
        : `Withdrawal request operation data could not be loaded: ${withdrawalOperations.error}.`,
      action: withdrawalOperations.available
        ? ""
        : "Apply Prisma migrations and reload this page before relying on withdrawal request counts.",
    }),
  );

  checks.push(
    createCheck({
      id: "withdrawal_open_requests",
      category: "app",
      status:
        withdrawalOperations.available && withdrawalOperations.openCount > 0
          ? "manual"
          : "pass",
      title: "Open withdrawal requests",
      detail: withdrawalOperations.available
        ? `${withdrawalOperations.openCount} open withdrawal request(s) need normal operation review.`
        : "Skipped because withdrawal request tables are unavailable.",
      action:
        withdrawalOperations.available && withdrawalOperations.openCount > 0
          ? "Review /app/withdrawals and keep each request moving through return, refund, or closure."
          : "",
    }),
  );

  checks.push(
    createCheck({
      id: "withdrawal_deadlines",
      category: "app",
      status:
        withdrawalOperations.deadlineExpiredCount > 0
          ? "warning"
          : withdrawalOperations.deadlineSoonCount > 0
            ? "manual"
            : "pass",
      title: "Withdrawal request deadlines",
      detail: withdrawalOperations.available
        ? `${withdrawalOperations.deadlineExpiredCount} expired, ${withdrawalOperations.deadlineSoonCount} due within ${URGENT_WITHDRAWAL_DEADLINE_DAYS} days.`
        : "Skipped because withdrawal request tables are unavailable.",
      action:
        withdrawalOperations.deadlineExpiredCount > 0
          ? "Open /app/withdrawals and handle expired withdrawal requests first."
          : withdrawalOperations.deadlineSoonCount > 0
            ? "Review requests approaching their deadline from /app/withdrawals."
            : "",
    }),
  );

  checks.push(
    createCheck({
      id: "withdrawal_email_failures",
      category: "app",
      status:
        withdrawalOperations.emailFailedCount > 0 ? "warning" : "pass",
      title: "Withdrawal email failures",
      detail: withdrawalOperations.available
        ? `${withdrawalOperations.emailFailedCount} withdrawal email failure(s) are recorded.`
        : "Skipped because withdrawal email logs are unavailable.",
      action:
        withdrawalOperations.emailFailedCount > 0
          ? "Open /app/withdrawals, filter by email failures, and resend or confirm the customer address."
          : "",
    }),
  );

  checks.push(
    createCheck({
      id: "withdrawal_email_outbox",
      category: "app",
      status:
        withdrawalOperations.outboxDeadLetterCount > 0
          ? "warning"
          : withdrawalOperations.outboxPendingCount > 0
            ? "manual"
            : "pass",
      title: "撤回メール送信キュー",
      detail: withdrawalOperations.available
        ? `再送待ち ${withdrawalOperations.outboxPendingCount}件、手動確認が必要 ${withdrawalOperations.outboxDeadLetterCount}件です。`
        : "撤回メール送信キューを確認できませんでした。",
      action:
        withdrawalOperations.outboxDeadLetterCount > 0
          ? "失敗理由と宛先を確認し、修正後に再送してください。"
          : withdrawalOperations.outboxPendingCount > 0
            ? "内部メールワーカーが定期実行されていることを確認してください。"
            : "",
    }),
  );

  checks.push(
    createCheck({
      id: "withdrawal_locale_and_legal_snapshots",
      category: "app",
      status:
        withdrawalOperations.legacyLocaleMissingCount > 0
          ? "warning"
          : withdrawalOperations.publishedLegalBundleCount === 0
            ? "manual"
            : "pass",
      title: "撤回申請の言語・法務スナップショット",
      detail: withdrawalOperations.available
        ? `言語または受付日時が不足する既存申請 ${withdrawalOperations.legacyLocaleMissingCount}件、公開済み法務文面 ${withdrawalOperations.publishedLegalBundleCount}件です。`
        : "撤回申請の言語・法務スナップショットを確認できませんでした。",
      action:
        withdrawalOperations.legacyLocaleMissingCount > 0
          ? "既存申請は互換表示できますが、必要に応じてバックフィルしてください。新規申請は受付時の値を固定保存します。"
          : withdrawalOperations.publishedLegalBundleCount === 0
            ? "国別法務文面が未公開の間は中立的な受付文面を使い、個別判断を管理者確認にしてください。"
            : "",
    }),
  );

  checks.push(
    createCheck({
      id: "withdrawal_processing_integrity",
      category: "app",
      status:
        withdrawalOperations.processingIssueCount > 0 ? "warning" : "pass",
      title: "Withdrawal processing integrity",
      detail: withdrawalOperations.available
        ? [
            `${withdrawalOperations.processingIssueCount} processing issue(s) detected.`,
            `refund decision missing: ${withdrawalOperations.refundDecisionMissingCount}`,
            `completion mismatch: ${withdrawalOperations.refundCompletionMismatchCount}`,
            `return instruction missing: ${withdrawalOperations.returnInstructionMissingCount}`,
            `vendor notification missing: ${withdrawalOperations.vendorNotificationMissingCount}`,
            `completion email missing: ${withdrawalOperations.completionNotificationMissingCount}`,
            `rejected without reason: ${withdrawalOperations.rejectedWithoutReasonCount}`,
            `Shopify external record missing: ${withdrawalOperations.shopifyExternalRecordMissingCount}`,
          ].join(" ")
        : "Skipped because withdrawal request tables are unavailable.",
      action:
        withdrawalOperations.processingIssueCount > 0
          ? "Open /app/withdrawals and resolve the flagged request state before treating withdrawal operations as complete."
          : "",
    }),
  );

  return checks;
}

export async function getProductionReadiness({
  prismaClient = prisma,
  env = process.env,
} = {}) {
  const stripeEnv = inspectStripeEnvironment(env);
  const operationEnv = inspectOperationEnvironment(env);
  const stripeConnectProductionEnabled =
    operationEnv.stripeConnectProductionEnabled;
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
        payoutRecipient: true,
      },
    }),
    stripeConnectProductionEnabled
      ? getPlatformStripeAccount(stripeEnv)
      : Promise.resolve({
          ok: false,
          reason: "stripe_connect_not_enabled",
        }),
  ]);
  const withdrawalOperations = await inspectWithdrawalOperations({
    prismaClient,
  });
  const directReturns = await inspectDirectReturnReadiness({ prismaClient });

  const connectedAccountProbe = stripeConnectProductionEnabled
    ? await probeConnectedAccounts({
        stripeEnv,
        sellerRows,
      })
    : [];
  const configuredScopes = parseScopes(env.SCOPES);
  const grantedScopes = parseScopes(sessions[0]?.scope);
  const checks = [
    ...buildEnvironmentChecks({
      stripeEnv,
      env,
      operationEnv,
    }),
    ...buildWithdrawalOperationChecks({ withdrawalOperations }),
    ...buildDirectReturnChecks({ directReturns }),
    ...buildShopifyChecks({ configuredScopes, grantedScopes }),
    ...buildSellerChecks({
      sellerRows,
      connectedAccountProbe,
      operationEnv,
    }),
    ...buildPayoutChecks({ env, operationEnv }),
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
    operation: {
      paymentFlow: `${operationEnv.paymentProvider}_${operationEnv.sellerPayoutProvider}_payout`,
      paymentFlowLabel: `${operationEnv.paymentProviderLabel} + ${operationEnv.sellerPayoutProviderLabel}`,
      paymentProvider: operationEnv.paymentProvider,
      paymentProviderLabel: operationEnv.paymentProviderLabel,
      sellerPayoutProvider: operationEnv.sellerPayoutProvider,
      sellerPayoutProviderLabel: operationEnv.sellerPayoutProviderLabel,
      stripeConnectProductionEnabled,
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
      offlineSessionShops: sessions
        .map((session) => session.shop)
        .filter(Boolean),
    },
    sellers: {
      totalCount: sellerRows.length,
      activeCount: sellerRows.filter((seller) => seller.status === "active")
        .length,
      connectedAccountProbe,
      probeLimit: STRIPE_ACCOUNT_PROBE_LIMIT,
    },
    withdrawals: { ...withdrawalOperations, directReturns },
    checks,
  };
}

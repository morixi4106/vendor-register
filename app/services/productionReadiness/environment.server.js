import { DEFAULT_PAYMENT_PROVIDER, DEFAULT_SELLER_PAYOUT_PROVIDER, PAYMENT_PROVIDER_LABELS, SELLER_PAYOUT_PROVIDER_LABELS, STRIPE_CONNECT_PRODUCTION_ENABLED_VALUES, SUPPORTED_PAYMENT_PROVIDERS, SUPPORTED_SELLER_PAYOUT_PROVIDERS, createCheck, detectStripeKeyMode, extractEmailAddress, isEnabledEnvFlag, normalizeText, requiredOrWarningStatus } from "./common.js";
const MULTI_SELLER_SETTLEMENT_FLAGS = [{
  key: "MULTI_SELLER_SHOPIFY_ORDER_SETTLEMENT_ENABLED",
  label: "paid"
}, {
  key: "MULTI_SELLER_SHOPIFY_REFUND_SETTLEMENT_ENABLED",
  label: "refund"
}, {
  key: "MULTI_SELLER_SHOPIFY_CANCELLED_SETTLEMENT_ENABLED",
  label: "cancelled"
}, {
  key: "MULTI_SELLER_SHOPIFY_DISPUTE_SETTLEMENT_ENABLED",
  label: "dispute"
}];
export const MULTI_SELLER_STOREFRONT_CHECKOUT_FLAG = "MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED";
const PUBLIC_DRAFT_ORDER_CHECKOUT_FLAG = "PUBLIC_DRAFT_ORDER_CHECKOUT_ENABLED";
const SELLER_ORDER_SHADOW_WRITE_FLAG = "SELLER_ORDER_SHADOW_WRITE_ENABLED";
const VENDOR_ORDER_SELLER_ORDER_READ_FLAG = "VENDOR_ORDERS_USE_SELLER_ORDERS";
const MULTI_SELLER_STOREFRONT_REQUIRED_FLAGS = [...MULTI_SELLER_SETTLEMENT_FLAGS, {
  key: VENDOR_ORDER_SELLER_ORDER_READ_FLAG,
  label: "seller order reads"
}];
function isStripeConnectProductionEnabled(env) {
  return STRIPE_CONNECT_PRODUCTION_ENABLED_VALUES.has(String(env.STRIPE_CONNECT_PRODUCTION_ENABLED || "").trim().toLowerCase());
}
function inspectMultiSellerSettlementFlags(env) {
  const flags = MULTI_SELLER_SETTLEMENT_FLAGS.map(flag => ({
    ...flag,
    enabled: isEnabledEnvFlag(env, flag.key)
  }));
  const enabled = flags.filter(flag => flag.enabled);
  const disabled = flags.filter(flag => !flag.enabled);
  return {
    flags,
    enabled,
    disabled,
    anyEnabled: enabled.length > 0,
    allEnabled: enabled.length === flags.length
  };
}
function inspectMultiSellerStorefrontCheckoutFlag(env) {
  const enabled = isEnabledEnvFlag(env, MULTI_SELLER_STOREFRONT_CHECKOUT_FLAG);
  const prerequisites = MULTI_SELLER_STOREFRONT_REQUIRED_FLAGS.map(flag => ({
    ...flag,
    enabled: isEnabledEnvFlag(env, flag.key)
  }));
  const missing = prerequisites.filter(flag => !flag.enabled);
  return {
    enabled,
    prerequisites,
    missing,
    ready: enabled && missing.length === 0
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
    hasOutboxWorkerToken: Boolean(outboxWorkerToken && outboxWorkerToken.length >= 24)
  };
}
function normalizeProvider(value, fallback) {
  return String(value || fallback).trim().toLowerCase();
}
export function inspectOperationEnvironment(env = process.env) {
  const configuredPaymentProvider = normalizeText(env.PAYMENT_PROVIDER);
  const configuredSellerPayoutProvider = normalizeText(env.SELLER_PAYOUT_PROVIDER);
  const paymentProvider = normalizeProvider(configuredPaymentProvider, DEFAULT_PAYMENT_PROVIDER);
  const sellerPayoutProvider = normalizeProvider(configuredSellerPayoutProvider, DEFAULT_SELLER_PAYOUT_PROVIDER);
  const stripeConnectProductionEnabled = isStripeConnectProductionEnabled(env) || paymentProvider === "stripe_connect" || sellerPayoutProvider === "stripe_connect";
  return {
    paymentProvider,
    sellerPayoutProvider,
    paymentProviderLabel: PAYMENT_PROVIDER_LABELS[paymentProvider] || paymentProvider,
    sellerPayoutProviderLabel: SELLER_PAYOUT_PROVIDER_LABELS[sellerPayoutProvider] || sellerPayoutProvider,
    paymentProviderConfigured: Boolean(configuredPaymentProvider),
    sellerPayoutProviderConfigured: Boolean(configuredSellerPayoutProvider),
    paymentProviderSupported: SUPPORTED_PAYMENT_PROVIDERS.has(paymentProvider),
    sellerPayoutProviderSupported: SUPPORTED_SELLER_PAYOUT_PROVIDERS.has(sellerPayoutProvider),
    stripeConnectProductionEnabled
  };
}
export function inspectStripeEnvironment(env = process.env) {
  const secretKey = normalizeText(env.STRIPE_SECRET_KEY);
  const publishableKey = normalizeText(env.STRIPE_PUBLISHABLE_KEY);
  const secretKeyMode = detectStripeKeyMode(secretKey, {
    livePrefix: "sk_live_",
    testPrefix: "sk_test_"
  });
  const publishableKeyMode = detectStripeKeyMode(publishableKey, {
    livePrefix: "pk_live_",
    testPrefix: "pk_test_"
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
    modesMatch: secretKeyMode !== "missing" && publishableKeyMode !== "missing" && secretKeyMode === publishableKeyMode,
    hasPlatformWebhookSecret: Boolean(webhookSecret),
    hasConnectWebhookSecret: Boolean(connectWebhookSecret),
    platformWebhookSecretLooksValid: !webhookSecret || webhookSecret.startsWith("whsec_"),
    connectWebhookSecretLooksValid: !connectWebhookSecret || connectWebhookSecret.startsWith("whsec_"),
    platformFeeBps,
    platformFeeBpsValid: Number.isInteger(platformFeeBps) && platformFeeBps >= 0 && platformFeeBps <= 10000
  };
}
export function buildEnvironmentChecks({
  stripeEnv,
  env,
  operationEnv
}) {
  const checks = [];
  const isProductionRuntime = env.NODE_ENV === "production";
  const multiSellerSettlementFlags = inspectMultiSellerSettlementFlags(env);
  const multiSellerStorefrontCheckout = inspectMultiSellerStorefrontCheckoutFlag(env);
  const withdrawalEmailEnv = inspectWithdrawalEmailEnvironment(env);
  const sellerOrderShadowWriteEnabled = isEnabledEnvFlag(env, SELLER_ORDER_SHADOW_WRITE_FLAG);
  const sellerOrderVendorOrderReadsEnabled = isEnabledEnvFlag(env, VENDOR_ORDER_SELLER_ORDER_READ_FLAG);
  const {
    paymentProvider,
    sellerPayoutProvider,
    paymentProviderLabel,
    sellerPayoutProviderLabel,
    paymentProviderConfigured,
    sellerPayoutProviderConfigured,
    paymentProviderSupported,
    sellerPayoutProviderSupported,
    stripeConnectProductionEnabled
  } = operationEnv;
  const stripeSecretKeyLive = stripeEnv.secretKeyMode === "live";
  const stripePublishableKeyLive = stripeEnv.publishableKeyMode === "live";
  const stripeKeysBothMissing = stripeEnv.secretKeyMode === "missing" && stripeEnv.publishableKeyMode === "missing";
  const stripeKeyModesAcceptable = stripeEnv.modesMatch || !stripeConnectProductionEnabled && stripeKeysBothMissing;
  checks.push(createCheck({
    id: "public_draft_order_checkout_disabled",
    category: "app",
    status: isEnabledEnvFlag(env, PUBLIC_DRAFT_ORDER_CHECKOUT_FLAG) ? "fail" : "pass",
    title: "Public Draft Order checkout",
    detail: isEnabledEnvFlag(env, PUBLIC_DRAFT_ORDER_CHECKOUT_FLAG) ? "The public Draft Order checkout endpoint is enabled." : "The public Draft Order checkout endpoint is disabled.",
    action: isEnabledEnvFlag(env, PUBLIC_DRAFT_ORDER_CHECKOUT_FLAG) ? "Set PUBLIC_DRAFT_ORDER_CHECKOUT_ENABLED=false before opening the storefront." : ""
  }));
  checks.push(createCheck({
    id: "payment_provider",
    category: "app",
    status: paymentProviderSupported ? paymentProviderConfigured ? "pass" : "warning" : "fail",
    title: "Payment provider",
    detail: paymentProviderSupported ? paymentProviderConfigured ? `PAYMENT_PROVIDER is ${paymentProvider}.` : `PAYMENT_PROVIDER is not set. Defaulting to ${DEFAULT_PAYMENT_PROVIDER}.` : `PAYMENT_PROVIDER is ${paymentProvider}. The current production flow supports ${DEFAULT_PAYMENT_PROVIDER}.`,
    action: paymentProviderSupported ? paymentProviderConfigured ? "" : "Set PAYMENT_PROVIDER=shopify_payments in Render so the production mode is explicit." : "Keep Shopify Checkout / Shopify Payments as the production payment provider, or add a separate readiness profile for another provider."
  }));
  checks.push(createCheck({
    id: "seller_payout_provider",
    category: "payout",
    status: sellerPayoutProviderSupported ? sellerPayoutProviderConfigured ? "pass" : "warning" : "fail",
    title: "Seller payout provider",
    detail: sellerPayoutProviderSupported ? sellerPayoutProviderConfigured ? `SELLER_PAYOUT_PROVIDER is ${sellerPayoutProvider}.` : `SELLER_PAYOUT_PROVIDER is not set. Defaulting to ${DEFAULT_SELLER_PAYOUT_PROVIDER}.` : `SELLER_PAYOUT_PROVIDER is ${sellerPayoutProvider}. Supported values are manual or wise.`,
    action: sellerPayoutProviderSupported ? sellerPayoutProviderConfigured ? "" : "Set SELLER_PAYOUT_PROVIDER=manual or SELLER_PAYOUT_PROVIDER=wise in Render." : "Use manual payouts or Wise API payouts for the Shopify Payments production flow."
  }));
  checks.push(createCheck({
    id: "production_payment_flow",
    category: "app",
    status: paymentProviderConfigured && sellerPayoutProviderConfigured && paymentProviderSupported && sellerPayoutProviderSupported && !stripeConnectProductionEnabled ? "pass" : "fail",
    title: "Production payment flow",
    detail: stripeConnectProductionEnabled ? "Stripe Connect production checks are enabled by STRIPE_CONNECT_PRODUCTION_ENABLED or provider configuration." : `Production checkout uses ${paymentProviderLabel}. Seller payouts use ${sellerPayoutProviderLabel}.`,
    action: stripeConnectProductionEnabled ? "Complete live Stripe Connect keys, webhooks, connected accounts, and payout readiness before using this mode." : paymentProviderConfigured && sellerPayoutProviderConfigured ? "Keep Stripe Connect direct charges and Connect payouts disabled unless the policy changes." : "Set PAYMENT_PROVIDER=shopify_payments and SELLER_PAYOUT_PROVIDER=manual explicitly in Render."
  }));
  checks.push(createCheck({
    id: "withdrawal_resend_api_key",
    category: "app",
    status: withdrawalEmailEnv.resendApiKeyLooksValid ? "pass" : "warning",
    title: "Withdrawal request email API",
    detail: withdrawalEmailEnv.hasResendApiKey ? withdrawalEmailEnv.resendApiKeyLooksValid ? "RESEND_API_KEY is configured for withdrawal request emails." : "RESEND_API_KEY is set, but it does not look like a Resend re_... key." : "RESEND_API_KEY is not set. Withdrawal requests can be stored, but acknowledgement emails will be skipped.",
    action: withdrawalEmailEnv.resendApiKeyLooksValid ? "" : "Set RESEND_API_KEY in Render before relying on EU withdrawal acknowledgement emails."
  }));
  checks.push(createCheck({
    id: "withdrawal_from_email",
    category: "app",
    status: withdrawalEmailEnv.fromEmailAddress ? withdrawalEmailEnv.hasExplicitFromEmail ? "pass" : "warning" : "warning",
    title: "Withdrawal email sender",
    detail: withdrawalEmailEnv.fromEmailAddress ? withdrawalEmailEnv.hasExplicitFromEmail ? `WITHDRAWAL_FROM_EMAIL is configured as ${withdrawalEmailEnv.fromEmailAddress}.` : `Using fallback sender ${withdrawalEmailEnv.fromEmailAddress}.` : "No valid withdrawal email sender was found.",
    action: withdrawalEmailEnv.fromEmailAddress ? withdrawalEmailEnv.hasExplicitFromEmail ? "" : "Set WITHDRAWAL_FROM_EMAIL explicitly, for example Store Support <support@example.com>." : "Set WITHDRAWAL_FROM_EMAIL to a verified sender on the Resend domain."
  }));
  checks.push(createCheck({
    id: "withdrawal_support_email",
    category: "app",
    status: withdrawalEmailEnv.supportEmailAddress ? "pass" : "warning",
    title: "Withdrawal support email",
    detail: withdrawalEmailEnv.supportEmailAddress ? `WITHDRAWAL_SUPPORT_EMAIL is ${withdrawalEmailEnv.supportEmailAddress}.` : "WITHDRAWAL_SUPPORT_EMAIL is not configured.",
    action: withdrawalEmailEnv.supportEmailAddress ? "" : "Set WITHDRAWAL_SUPPORT_EMAIL so customer withdrawal emails include a clear support contact."
  }));
  checks.push(createCheck({
    id: "withdrawal_public_base_url",
    category: "app",
    status: withdrawalEmailEnv.publicBaseUrlLooksValid ? "pass" : "warning",
    title: "Withdrawal public link domain",
    detail: withdrawalEmailEnv.publicBaseUrl ? withdrawalEmailEnv.publicBaseUrlLooksValid ? `WITHDRAWAL_PUBLIC_BASE_URL is ${withdrawalEmailEnv.publicBaseUrl}.` : "WITHDRAWAL_PUBLIC_BASE_URL is set, but it is not an http(s) URL." : "WITHDRAWAL_PUBLIC_BASE_URL is not configured. Return proof links will fall back to APP_URL.",
    action: withdrawalEmailEnv.publicBaseUrlLooksValid ? "" : "Set WITHDRAWAL_PUBLIC_BASE_URL to the storefront origin, for example https://oja-immanuel-bacchus.com."
  }));
  checks.push(createCheck({
    id: "withdrawal_outbox_worker_token",
    category: "app",
    status: withdrawalEmailEnv.hasOutboxWorkerToken ? "pass" : "warning",
    title: "撤回メール再送ワーカー",
    detail: withdrawalEmailEnv.hasOutboxWorkerToken ? "WITHDRAWAL_OUTBOX_WORKER_TOKENが設定されています。" : "WITHDRAWAL_OUTBOX_WORKER_TOKENが未設定または短すぎます。初回送信に失敗したメールを定期再送できません。",
    action: withdrawalEmailEnv.hasOutboxWorkerToken ? "" : "24文字以上のランダムなWITHDRAWAL_OUTBOX_WORKER_TOKENを設定し、内部ワーカーを定期実行してください。"
  }));
  checks.push(createCheck({
    id: "withdrawal_return_address_legacy",
    category: "app",
    status: "manual",
    title: "旧申請用の共通返送先",
    detail: withdrawalEmailEnv.returnAddress ? "WITHDRAWAL_RETURN_ADDRESSはV1申請専用として設定されています。V2では使用しません。" : "WITHDRAWAL_RETURN_ADDRESSは未設定です。V2では店舗別の返送先だけを使用します。",
    action: "未処理のV1申請に共通返送先が必要な場合だけ設定してください。V2のフォールバックには使用しません。"
  }));
  checks.push(createCheck({
    id: "multi_seller_backend_settlement_flags",
    category: "app",
    status: !multiSellerSettlementFlags.anyEnabled ? "pass" : multiSellerSettlementFlags.allEnabled ? "warning" : "fail",
    title: "Multi-seller backend settlement flags",
    detail: !multiSellerSettlementFlags.anyEnabled ? "Multi-seller settlement flags are disabled. Current live checkout should remain single-seller." : multiSellerSettlementFlags.allEnabled ? `Backend settlement flags are enabled for ${multiSellerSettlementFlags.enabled.map(flag => flag.label).join(", ")}. This is for controlled backend testing only.` : `Only some backend settlement flags are enabled: ${multiSellerSettlementFlags.enabled.map(flag => flag.label).join(", ") || "none"}. Missing: ${multiSellerSettlementFlags.disabled.map(flag => flag.label).join(", ")}.`,
    action: !multiSellerSettlementFlags.anyEnabled ? "No action is needed unless running controlled multi-seller backend tests." : multiSellerSettlementFlags.allEnabled ? "Keep storefront multi-seller checkout disabled until ready; enable MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED only with VENDOR_ORDERS_USE_SELLER_ORDERS and seller-specific fulfillment verified." : "Disable all multi-seller settlement flags, or enable paid/refund/cancelled/dispute together only for controlled backend tests."
  }));
  checks.push(createCheck({
    id: "seller_order_shadow_write",
    category: "app",
    status: sellerOrderShadowWriteEnabled ? "pass" : multiSellerStorefrontCheckout.enabled ? "fail" : multiSellerSettlementFlags.anyEnabled ? "warning" : "manual",
    title: "SellerOrder shadow write",
    detail: sellerOrderShadowWriteEnabled ? "SELLER_ORDER_SHADOW_WRITE_ENABLED is enabled. New paid orders will create SellerOrder verification records." : "SELLER_ORDER_SHADOW_WRITE_ENABLED is disabled. New paid orders will not accumulate SellerOrder verification records.",
    action: sellerOrderShadowWriteEnabled ? "Review /app/seller-order-shadow after test orders or backfill runs." : multiSellerStorefrontCheckout.enabled ? "Disable MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED, or set SELLER_ORDER_SHADOW_WRITE_ENABLED=true and verify SellerOrder checks before opening this path." : multiSellerSettlementFlags.anyEnabled ? "Set SELLER_ORDER_SHADOW_WRITE_ENABLED=true while running controlled multi-seller backend tests." : "Set SELLER_ORDER_SHADOW_WRITE_ENABLED=true when collecting SellerOrder validation data."
  }));
  checks.push(createCheck({
    id: "seller_order_vendor_order_reads",
    category: "app",
    status: sellerOrderVendorOrderReadsEnabled ? "warning" : "pass",
    title: "Vendor order SellerOrder reads",
    detail: !sellerOrderVendorOrderReadsEnabled ? "VENDOR_ORDERS_USE_SELLER_ORDERS is disabled. Vendor order pages use the legacy ledger path." : sellerOrderShadowWriteEnabled ? "VENDOR_ORDERS_USE_SELLER_ORDERS is enabled. Vendor order pages prefer SellerOrder reads and fall back to the legacy ledger path if SellerOrder reads fail." : "VENDOR_ORDERS_USE_SELLER_ORDERS is enabled, but SELLER_ORDER_SHADOW_WRITE_ENABLED is disabled. Vendor order pages can fall back to the legacy ledger path, but new verification data will not accumulate.",
    action: !sellerOrderVendorOrderReadsEnabled ? "Enable this only after SellerOrder shadow checks are matched enough for controlled testing." : sellerOrderShadowWriteEnabled ? "Review /app/seller-order-shadow and keep the legacy fallback in place during the read switch." : "Set SELLER_ORDER_SHADOW_WRITE_ENABLED=true before relying on SellerOrder reads for ongoing validation."
  }));
  checks.push(createCheck({
    id: "multi_seller_storefront_checkout_flag",
    category: "app",
    status: !multiSellerStorefrontCheckout.enabled ? "pass" : multiSellerStorefrontCheckout.ready ? "warning" : "fail",
    title: "Multi-seller storefront checkout",
    detail: !multiSellerStorefrontCheckout.enabled ? "Storefront multi-seller checkout is disabled." : multiSellerStorefrontCheckout.ready ? "Storefront multi-seller checkout is enabled with backend settlement flags and SellerOrder reads." : `MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED is enabled, but missing prerequisites: ${multiSellerStorefrontCheckout.missing.map(flag => flag.label).join(", ")}.`,
    action: !multiSellerStorefrontCheckout.enabled ? "No action is needed unless intentionally opening multi-seller checkout." : multiSellerStorefrontCheckout.ready ? "Keep enabled only after controlled checkout, settlement, refund, cancellation, dispute, and seller-specific fulfillment tests pass." : "Disable MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED, or enable all backend settlement flags and VENDOR_ORDERS_USE_SELLER_ORDERS before opening this path."
  }));
  checks.push(createCheck({
    id: "stripe_secret_key_live",
    category: "stripe",
    status: requiredOrWarningStatus(stripeSecretKeyLive, stripeConnectProductionEnabled),
    title: "Stripe secret key",
    detail: stripeSecretKeyLive ? "STRIPE_SECRET_KEY is a live key." : stripeConnectProductionEnabled ? `Current mode is ${stripeEnv.secretKeyMode}. Live Stripe Connect operation needs sk_live_...` : `Current mode is ${stripeEnv.secretKeyMode}. This is not a production blocker while Shopify Payments and manual seller payouts are the active flow.`,
    action: stripeSecretKeyLive ? "" : stripeConnectProductionEnabled ? "Set the live secret key in Render, then redeploy or restart the service." : "Only set a live Stripe secret key before enabling Stripe Connect direct charges or Connect payouts."
  }));
  checks.push(createCheck({
    id: "stripe_publishable_key_live",
    category: "stripe",
    status: requiredOrWarningStatus(stripePublishableKeyLive, stripeConnectProductionEnabled),
    title: "Stripe publishable key",
    detail: stripePublishableKeyLive ? "STRIPE_PUBLISHABLE_KEY is a live key." : stripeConnectProductionEnabled ? `Current mode is ${stripeEnv.publishableKeyMode}. Live Stripe Connect operation needs pk_live_...` : `Current mode is ${stripeEnv.publishableKeyMode}. This is not a production blocker while Shopify Payments and manual seller payouts are the active flow.`,
    action: stripePublishableKeyLive ? "" : stripeConnectProductionEnabled ? "Set the live publishable key in Render, then redeploy or restart the service." : "Only set a live Stripe publishable key before enabling embedded Stripe Connect account management."
  }));
  checks.push(createCheck({
    id: "stripe_key_modes_match",
    category: "stripe",
    status: requiredOrWarningStatus(stripeKeyModesAcceptable, stripeConnectProductionEnabled),
    title: "Stripe key mode match",
    detail: stripeKeyModesAcceptable ? stripeKeysBothMissing ? "No Stripe keys are configured. This is acceptable for the current Shopify Payments flow." : "Secret key and publishable key use the same mode." : `Secret key mode is ${stripeEnv.secretKeyMode}; publishable key mode is ${stripeEnv.publishableKeyMode}.`,
    action: stripeKeyModesAcceptable ? "" : stripeConnectProductionEnabled ? "Use keys from the same Stripe account and the same live/test mode." : "Clean this up before enabling Stripe Connect features in production."
  }));
  checks.push(createCheck({
    id: "stripe_platform_webhook_secret",
    category: "stripe",
    status: requiredOrWarningStatus(stripeEnv.hasPlatformWebhookSecret && stripeEnv.platformWebhookSecretLooksValid, stripeConnectProductionEnabled),
    title: "Stripe platform webhook secret",
    detail: stripeEnv.hasPlatformWebhookSecret && stripeEnv.platformWebhookSecretLooksValid ? "STRIPE_WEBHOOK_SECRET is configured." : stripeConnectProductionEnabled ? "STRIPE_WEBHOOK_SECRET is missing or invalid." : "STRIPE_WEBHOOK_SECRET is missing or invalid. This is only required for live Stripe webhook processing.",
    action: stripeEnv.hasPlatformWebhookSecret && stripeEnv.platformWebhookSecretLooksValid ? "" : stripeConnectProductionEnabled ? "Create the live platform webhook endpoint in Stripe and set its whsec_... value." : "Leave unset unless Stripe platform webhook events are enabled for production."
  }));
  checks.push(createCheck({
    id: "stripe_connect_webhook_secret",
    category: "stripe",
    status: requiredOrWarningStatus(stripeEnv.hasConnectWebhookSecret && stripeEnv.connectWebhookSecretLooksValid, stripeConnectProductionEnabled),
    title: "Stripe Connect webhook secret",
    detail: stripeEnv.hasConnectWebhookSecret && stripeEnv.connectWebhookSecretLooksValid ? "STRIPE_CONNECT_WEBHOOK_SECRET is configured." : stripeConnectProductionEnabled ? "STRIPE_CONNECT_WEBHOOK_SECRET is missing or invalid." : "STRIPE_CONNECT_WEBHOOK_SECRET is missing or invalid. This is only required for live Connect events.",
    action: stripeEnv.hasConnectWebhookSecret && stripeEnv.connectWebhookSecretLooksValid ? "" : stripeConnectProductionEnabled ? "Create a live Connect webhook endpoint for events on connected accounts and set its whsec_... value." : "Leave unset unless Stripe Connect account events are enabled for production."
  }));
  checks.push(createCheck({
    id: "stripe_platform_fee_bps",
    category: "stripe",
    status: requiredOrWarningStatus(stripeEnv.platformFeeBpsValid, stripeConnectProductionEnabled),
    title: "Stripe platform fee bps",
    detail: stripeEnv.platformFeeBpsValid ? `STRIPE_PLATFORM_FEE_BPS is ${stripeEnv.platformFeeBps}.` : stripeConnectProductionEnabled ? "STRIPE_PLATFORM_FEE_BPS must be an integer from 0 to 10000." : "STRIPE_PLATFORM_FEE_BPS is invalid, but Stripe fee collection is not part of the current production flow.",
    action: stripeEnv.platformFeeBpsValid ? "" : stripeConnectProductionEnabled ? "Set STRIPE_PLATFORM_FEE_BPS explicitly in Render." : "Fix this before enabling Stripe Connect checkout or fee collection."
  }));
  checks.push(createCheck({
    id: "production_runtime",
    category: "app",
    status: isProductionRuntime ? "pass" : "warning",
    title: "Runtime mode",
    detail: isProductionRuntime ? "NODE_ENV is production." : `NODE_ENV is ${env.NODE_ENV || "not set"}.`,
    action: isProductionRuntime ? "" : "Render production should run with NODE_ENV=production."
  }));
  return checks;
}

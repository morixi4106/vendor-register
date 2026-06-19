import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import Stripe from "stripe";
import isoCountries from "i18n-iso-countries";

import prisma from "../db.server.js";
import { formatMoney } from "../utils/money.js";

const require = createRequire(import.meta.url);
const jaLocale = require("i18n-iso-countries/langs/ja.json");

isoCountries.registerLocale(jaLocale);

export const SELLER_STATUSES = [
  "pending",
  "active",
  "review",
  "restricted",
  "banned",
];

export const SELLER_VERIFICATION_STATUSES = [
  "NONE",
  "PHONE_REQUIRED",
  "PHONE_VERIFIED",
  "DOCUMENT_REQUIRED",
  "DOCUMENT_PENDING",
  "VERIFIED",
  "REJECTED",
  "SUSPENDED",
];

export const DOCUMENT_VERIFICATION_STATUSES = [
  "NONE",
  "PENDING",
  "VERIFIED",
  "REJECTED",
];

export const SELLER_EU_STATUSES = [
  "DISABLED",
  "SELF_CERT_REQUIRED",
  "PHONE_REQUIRED",
  "ALLOWED_UNDER_SMALL_PLATFORM_POLICY",
  "FULL_KYBC_REQUIRED",
  "FULL_KYBC_APPROVED",
  "SUSPENDED",
];

export const PAYOUT_RUN_STATUSES = [
  "draft",
  "approved",
  "processing",
  "executed",
  "failed",
];

export const PAYOUT_TRANSFER_METHODS = [
  "manual_bank_transfer",
  "wise_api",
  "stripe_connect_payout",
];

export const SALES_CREDIT_OFFSET_STATUSES = [
  "authorized",
  "captured",
  "released",
  "refunded",
  "expired",
];

export const ORDER_STATUSES = [
  "draft",
  "payment_intent_created",
  "paid",
  "refunded",
  "disputed",
  "failed",
];

export const LEDGER_ENTRY_TYPES = [
  "charge",
  "shopify_order_paid",
  "shopify_order_cancelled",
  "application_fee",
  "application_fee_refund",
  "refund",
  "dispute_created",
  "dispute_updated",
  "dispute_closed",
  "dispute_funds_withdrawn",
  "dispute_funds_reinstated",
  "payout_created",
  "payout_paid",
  "payout_failed",
  "sales_credit_offset_captured",
  "sales_credit_offset_refund_reversal",
];

const DEFAULT_PLATFORM_FEE_BPS = 1000;
const DEFAULT_ORDER_CURRENCY = "jpy";
const SALES_CREDIT_SUPPORTED_CURRENCY = DEFAULT_ORDER_CURRENCY;
export const DEFAULT_SALES_CREDIT_HOLD_DAYS = 45;
export const DEFAULT_SALES_CREDIT_RISK_BUFFER_BPS = 0;
const DEFAULT_SALES_CREDIT_LOCK_MINUTES = 30;
export const SALES_CREDIT_PAYMENT_RISK_CLASSES = {
  CARD_3DS_AUTHENTICATED: "card_3ds_authenticated",
  NON_CARD_CONFIRMED: "non_card_confirmed",
  SALES_CREDIT_RESTORED: "sales_credit_restored",
  CARD_UNVERIFIED: "card_unverified",
  UNKNOWN: "unknown",
};
export const SALES_CREDIT_PAYMENT_RISK_RATE_BPS = {
  [SALES_CREDIT_PAYMENT_RISK_CLASSES.CARD_3DS_AUTHENTICATED]: 10000,
  [SALES_CREDIT_PAYMENT_RISK_CLASSES.NON_CARD_CONFIRMED]: 10000,
  [SALES_CREDIT_PAYMENT_RISK_CLASSES.SALES_CREDIT_RESTORED]: 10000,
  [SALES_CREDIT_PAYMENT_RISK_CLASSES.CARD_UNVERIFIED]: 0,
  [SALES_CREDIT_PAYMENT_RISK_CLASSES.UNKNOWN]: 0,
};
const SELLER_REVIEW_REASON_PAYOUT_FAILED =
  "payout_external_account_update_required";
const SELLER_REVIEW_REASON_EXTERNAL_ACCOUNT_UPDATED =
  "payout_external_account_admin_review_required";
const SELLER_REVIEW_REASON_DISPUTE = "dispute_review_required";
const STRIPE_ACCOUNT_RESET_REASON = "stripe_account_recreate_requested";
const STRIPE_ACCOUNT_RESETTABLE_ORDER_STATUSES = new Set([
  "draft",
  "payment_intent_created",
  "failed",
]);
const SHOPIFY_ORDER_REVERSAL_ENTRY_TYPES = [
  "refund",
  "shopify_order_cancelled",
];
const SHOPIFY_ORDER_SETTLEMENT_ENTRY_TYPES = [
  "shopify_order_paid",
  ...SHOPIFY_ORDER_REVERSAL_ENTRY_TYPES,
];
const SHOPIFY_ORDER_DISPUTE_ENTRY_TYPES = [
  "dispute_created",
  "dispute_funds_reinstated",
];
const SHOPIFY_ORDER_RISK_ENTRY_TYPES = [
  ...SHOPIFY_ORDER_SETTLEMENT_ENTRY_TYPES,
  ...SHOPIFY_ORDER_DISPUTE_ENTRY_TYPES,
];
const SHOPIFY_DISPUTE_RELEASE_STATUSES = new Set(["charge_refunded", "won"]);
const SELLER_ORDER_SHADOW_CHECK_STATUSES = {
  MATCHED: "matched",
  AMOUNT_MISMATCH: "amount_mismatch",
  SELLER_MISMATCH: "seller_mismatch",
  MULTI_SELLER_DETECTED: "multi_seller_detected",
  SHADOW_WRITTEN: "shadow_written",
  FAILED: "failed",
};
const SHOPIFY_ORDER_PAYMENT_RISK_QUERY = `#graphql
  query SalesCreditOrderPaymentRisk($id: ID!) {
    order(id: $id) {
      id
      paymentGatewayNames
      sourceName
      transactions {
        id
        kind
        status
        gateway
        formattedGateway
        receiptJson
        paymentDetails {
          __typename
          ... on CardPaymentDetails {
            company
            paymentMethodName
            wallet
            avsResultCode
            cvvResultCode
          }
        }
      }
    }
  }
`;

let stripeClientSingleton = null;

function normalizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeLowercase(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeUppercase(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toUpperCase() : null;
}

function normalizeBooleanInput(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (value == null) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(
    String(value).trim().toLowerCase(),
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toPositiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}

function clampInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.round(numeric));
}

function getSalesCreditOffsetMetadata(offset) {
  return isPlainObject(offset?.metadataJson) ? offset.metadataJson : {};
}

function validateSalesCreditOffsetExpectation(
  offset,
  {
    expectedSellerId = null,
    expectedAmount = null,
    expectedCurrencyCode = null,
    expectedTargetSellerId = null,
  } = {},
) {
  const normalizedSellerId = normalizeText(expectedSellerId);
  const normalizedAmount = toPositiveInteger(expectedAmount);
  const normalizedCurrencyCode = normalizeLowercase(expectedCurrencyCode);
  const normalizedTargetSellerId = normalizeText(expectedTargetSellerId);

  if (normalizedSellerId && offset.sellerId !== normalizedSellerId) {
    return { ok: false, reason: "sales_credit_offset_seller_mismatch" };
  }

  if (normalizedAmount != null && offset.amount !== normalizedAmount) {
    return { ok: false, reason: "sales_credit_offset_amount_mismatch" };
  }

  if (
    normalizedCurrencyCode &&
    normalizeLowercase(offset.currencyCode) !== normalizedCurrencyCode
  ) {
    return { ok: false, reason: "sales_credit_offset_currency_mismatch" };
  }

  if (normalizedTargetSellerId) {
    const metadataTargetSellerId = normalizeText(
      getSalesCreditOffsetMetadata(offset).targetSellerId,
    );

    if (
      metadataTargetSellerId &&
      metadataTargetSellerId !== normalizedTargetSellerId
    ) {
      return { ok: false, reason: "sales_credit_offset_target_mismatch" };
    }
  }

  return { ok: true };
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function subtractDays(date, days) {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}

function clampBasisPoints(value, fallback = 0) {
  const numeric = clampInteger(value, fallback);
  return Math.min(10000, Math.max(0, numeric));
}

async function runInTransaction(prismaClient, callback) {
  if (typeof prismaClient?.$transaction === "function") {
    return prismaClient.$transaction(callback);
  }

  return callback(prismaClient);
}

const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);

function moneyAmountToMinorUnits(value, currencyCode = DEFAULT_ORDER_CURRENCY) {
  const normalizedValue = normalizeText(value);

  if (!normalizedValue) {
    return 0;
  }

  const numeric = Number(normalizedValue.replace(/,/g, ""));

  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  const normalizedCurrency =
    normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;

  return ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency)
    ? Math.round(numeric)
    : Math.round(numeric * 100);
}

function normalizeShopifyGid(kind, value) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return null;
  }

  if (normalized.startsWith(`gid://shopify/${kind}/`)) {
    return normalized;
  }

  if (/^\d+$/.test(normalized)) {
    return `gid://shopify/${kind}/${normalized}`;
  }

  return normalized;
}

function normalizeShopifyDisputeId(payload) {
  return (
    normalizeText(payload?.admin_graphql_api_id) ||
    normalizeShopifyGid("ShopifyPaymentsDispute", payload?.id)
  );
}

function normalizeShopifyDisputeOrderId(payload) {
  return (
    normalizeShopifyGid("Order", payload?.order_id) ||
    normalizeShopifyGid("Order", payload?.order?.admin_graphql_api_id) ||
    normalizeShopifyGid("Order", payload?.order?.id)
  );
}

function uniqueValues(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function toIsoCountryCode(value) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return "JP";
  }

  if (/^[A-Za-z]{2}$/.test(normalized)) {
    return normalized.toUpperCase();
  }

  return (
    isoCountries.getAlpha2Code(normalized, "ja") ||
    isoCountries.getAlpha2Code(normalized, "en") ||
    "JP"
  );
}

function toDisplayPrice(product) {
  const calculatedPrice = Number(product?.calculatedPrice);
  if (Number.isFinite(calculatedPrice) && calculatedPrice > 0) {
    return Math.round(calculatedPrice);
  }

  const basePrice = Number(product?.price);
  if (Number.isFinite(basePrice) && basePrice > 0) {
    return Math.round(basePrice);
  }

  return 0;
}

function calculatePlatformFeeAmount(
  totalAmount,
  feeBps = DEFAULT_PLATFORM_FEE_BPS,
) {
  const normalizedTotal = clampInteger(totalAmount, 0);
  const normalizedBps = Number.isFinite(Number(feeBps))
    ? Math.max(0, Math.round(Number(feeBps)))
    : DEFAULT_PLATFORM_FEE_BPS;

  return Math.min(
    normalizedTotal,
    Math.floor((normalizedTotal * normalizedBps) / 10000),
  );
}

export function getPlatformFeeBps() {
  return Number(
    process.env.STRIPE_PLATFORM_FEE_BPS || DEFAULT_PLATFORM_FEE_BPS,
  );
}

function getStripeSecretKey() {
  const secretKey = normalizeText(process.env.STRIPE_SECRET_KEY);

  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY_MISSING");
  }

  return secretKey;
}

export function getStripePublishableKey() {
  return normalizeText(process.env.STRIPE_PUBLISHABLE_KEY);
}

function getStripeWebhookSecrets() {
  const secrets = [
    {
      type: "connect",
      secret: normalizeText(process.env.STRIPE_CONNECT_WEBHOOK_SECRET),
    },
    {
      type: "platform",
      secret: normalizeText(process.env.STRIPE_WEBHOOK_SECRET),
    },
  ].filter((item) => item.secret);
  const uniqueSecrets = [];

  for (const item of secrets) {
    if (!uniqueSecrets.some((existing) => existing.secret === item.secret)) {
      uniqueSecrets.push(item);
    }
  }

  if (uniqueSecrets.length === 0) {
    throw new Error("STRIPE_WEBHOOK_SECRET_MISSING");
  }

  return uniqueSecrets;
}

export function getStripeClient() {
  if (!stripeClientSingleton) {
    stripeClientSingleton = new Stripe(getStripeSecretKey());
  }

  return stripeClientSingleton;
}

function getConfiguredSellerPayoutProvider(env = process.env) {
  return normalizeLowercase(env.SELLER_PAYOUT_PROVIDER) === "wise"
    ? "wise"
    : "manual";
}

function getWisePayoutConfig(env = process.env) {
  const apiBaseUrl = normalizeText(env.WISE_API_BASE_URL)?.replace(/\/+$/, "");
  const apiToken = normalizeText(env.WISE_API_TOKEN);
  const profileId = normalizeText(env.WISE_PROFILE_ID);
  const sourceCurrency =
    normalizeUppercase(env.WISE_SOURCE_CURRENCY) ||
    DEFAULT_ORDER_CURRENCY.toUpperCase();
  const liveTransfersEnabled = ["1", "true", "yes", "on"].includes(
    normalizeLowercase(env.WISE_LIVE_TRANSFERS_ENABLED) || "",
  );
  const normalizedBaseUrl = apiBaseUrl || "https://api.wise-sandbox.com";

  const missing = [];
  if (!apiToken) missing.push("WISE_API_TOKEN");
  if (!profileId) missing.push("WISE_PROFILE_ID");
  if (!normalizedBaseUrl) missing.push("WISE_API_BASE_URL");
  if (!sourceCurrency) missing.push("WISE_SOURCE_CURRENCY");

  return {
    apiBaseUrl: normalizedBaseUrl,
    apiToken,
    profileId,
    sourceCurrency,
    missing,
    isSandbox: /sandbox/i.test(normalizedBaseUrl),
    liveTransfersEnabled,
  };
}

function isSellerOrderShadowWriteEnabled(env = process.env) {
  return normalizeLowercase(env.SELLER_ORDER_SHADOW_WRITE_ENABLED) === "true";
}

function hasSellerOrderShadowModels(prismaClient) {
  return Boolean(
    prismaClient?.marketplaceOrder?.upsert &&
      prismaClient?.sellerOrder?.upsert &&
      prismaClient?.sellerOrderLine?.upsert &&
      prismaClient?.sellerOrderShadowCheck?.create,
  );
}

function decimalAmountFromMinorUnits(
  amount,
  currencyCode = DEFAULT_ORDER_CURRENCY,
) {
  const normalizedAmount = clampInteger(amount, 0);
  const normalizedCurrency =
    normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;

  if (ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency)) {
    return normalizedAmount;
  }

  return Math.round(normalizedAmount) / 100;
}

function normalizeWiseRecipientId(value) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return null;
  }

  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : normalized;
}

function normalizeWiseTransferId(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function createWiseReference(payoutRunId) {
  return `Settlement ${String(payoutRunId || "").slice(0, 24)}`;
}

async function wiseApiRequest(
  { path, method = "GET", body = null },
  { config, fetchImpl = fetch } = {},
) {
  const response = await fetchImpl(`${config.apiBaseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    const firstError = errors[0] || payload?.error || payload;
    const message =
      normalizeText(firstError?.message) ||
      normalizeText(firstError?.code) ||
      `Wise API request failed with ${response.status}.`;
    const error = new Error(message);
    error.status = response.status;
    error.code =
      normalizeText(firstError?.code) || normalizeText(payload?.code);
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function createWiseQuote(
  { payoutRun, recipient, config },
  { fetchImpl = fetch } = {},
) {
  const sourceCurrency =
    normalizeUppercase(config.sourceCurrency) ||
    DEFAULT_ORDER_CURRENCY.toUpperCase();
  const targetCurrency =
    normalizeUppercase(recipient.currencyCode) ||
    normalizeUppercase(payoutRun.currencyCode) ||
    sourceCurrency;

  return wiseApiRequest(
    {
      path: `/v3/profiles/${config.profileId}/quotes`,
      method: "POST",
      body: {
        sourceCurrency,
        targetCurrency,
        sourceAmount: decimalAmountFromMinorUnits(
          payoutRun.amount,
          sourceCurrency,
        ),
        targetAmount: null,
        targetAccount: normalizeWiseRecipientId(recipient.wiseRecipientId),
      },
    },
    { config, fetchImpl },
  );
}

async function createWiseTransfer(
  { payoutRun, recipient, quote, customerTransactionId, config },
  { fetchImpl = fetch } = {},
) {
  return wiseApiRequest(
    {
      path: "/v1/transfers",
      method: "POST",
      body: {
        targetAccount: normalizeWiseRecipientId(recipient.wiseRecipientId),
        quoteUuid: normalizeText(quote?.id),
        customerTransactionId,
        details: {
          reference: createWiseReference(payoutRun.id),
        },
      },
    },
    { config, fetchImpl },
  );
}

async function fundWiseTransfer(
  { transferId, config },
  { fetchImpl = fetch } = {},
) {
  return wiseApiRequest(
    {
      path: `/v3/profiles/${config.profileId}/transfers/${transferId}/payments`,
      method: "POST",
      body: {
        type: "BALANCE",
      },
    },
    { config, fetchImpl },
  );
}

async function retrieveWiseTransfer(
  { transferId, config },
  { fetchImpl = fetch } = {},
) {
  return wiseApiRequest(
    {
      path: `/v1/transfers/${transferId}`,
    },
    { config, fetchImpl },
  );
}

export async function createConnectedAccountPayout({
  stripeAccountId,
  amount,
  currencyCode,
  payoutRunId,
  sellerId,
  fetchImpl = fetch,
}) {
  const normalizedStripeAccountId = normalizeText(stripeAccountId);

  if (!normalizedStripeAccountId) {
    throw new Error("STRIPE_CONNECTED_ACCOUNT_ID_MISSING");
  }

  const body = new URLSearchParams();
  body.set("amount", String(clampInteger(amount)));
  body.set(
    "currency",
    normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY,
  );
  body.set("description", `Manual payout ${payoutRunId}`);
  body.set("metadata[payoutRunId]", payoutRunId);
  body.set("metadata[sellerId]", sellerId);

  const response = await fetchImpl("https://api.stripe.com/v1/payouts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getStripeSecretKey()}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Account": normalizedStripeAccountId,
    },
    body,
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const stripeError = payload?.error || {};
    const error = new Error(
      normalizeText(stripeError.message) || "Stripe payout creation failed.",
    );
    error.code = normalizeText(stripeError.code);
    error.type = normalizeText(stripeError.type);
    error.param = normalizeText(stripeError.param);
    throw error;
  }

  return payload;
}

function createSellerStatusLabel(status) {
  switch (status) {
    case "pending":
      return "未設定";
    case "active":
      return "有効";
    case "review":
      return "確認中";
    case "restricted":
      return "制限中";
    case "banned":
      return "停止中";
    default:
      return status || "-";
  }
}

function createPayoutRunStatusLabel(status) {
  switch (status) {
    case "draft":
      return "下書き";
    case "approved":
      return "承認済み";
    case "processing":
      return "送金処理中";
    case "executed":
      return "実行済み";
    case "failed":
      return "失敗";
    default:
      return status || "-";
  }
}

function createSellerVerificationStatusLabel(status) {
  switch (status) {
    case "VERIFIED":
      return "確認済み";
    case "PHONE_REQUIRED":
      return "電話確認待ち";
    case "PHONE_VERIFIED":
      return "電話確認済み";
    case "DOCUMENT_REQUIRED":
      return "本人確認書類待ち";
    case "DOCUMENT_PENDING":
      return "本人確認中";
    case "REJECTED":
      return "差し戻し";
    case "SUSPENDED":
      return "停止中";
    case "NONE":
    default:
      return "未確認";
  }
}

function createDocumentVerificationStatusLabel(status) {
  switch (status) {
    case "VERIFIED":
      return "確認済み";
    case "PENDING":
      return "確認中";
    case "REJECTED":
      return "差し戻し";
    case "NONE":
    default:
      return "未確認";
  }
}

function createSellerEuStatusLabel(status) {
  switch (status) {
    case "SELF_CERT_REQUIRED":
      return "自己申告待ち";
    case "PHONE_REQUIRED":
      return "電話確認待ち";
    case "ALLOWED_UNDER_SMALL_PLATFORM_POLICY":
      return "限定許可";
    case "FULL_KYBC_REQUIRED":
      return "KYBC待ち";
    case "FULL_KYBC_APPROVED":
      return "EU販売確認済み";
    case "SUSPENDED":
      return "停止中";
    case "DISABLED":
    default:
      return "EU販売OFF";
  }
}

function createPayoutTransferMethodLabel(method) {
  switch (method) {
    case "manual_bank_transfer":
      return "手動精算";
    case "wise_api":
      return "Wise API送金";
    case "stripe_connect_payout":
      return "Stripe Connect payout (legacy)";
    default:
      return method || "-";
  }
}

function serializeStripeAccountSummary(stripeAccount) {
  if (!stripeAccount) {
    return null;
  }

  return {
    id: stripeAccount.id,
    sellerId: stripeAccount.sellerId,
    stripeAccountId: stripeAccount.stripeAccountId,
    countryCode: stripeAccount.countryCode || null,
    defaultCurrency: stripeAccount.defaultCurrency || null,
    detailsSubmitted: Boolean(stripeAccount.detailsSubmitted),
    chargesEnabled: Boolean(stripeAccount.chargesEnabled),
    payoutsEnabled: Boolean(stripeAccount.payoutsEnabled),
    payoutSchedule: stripeAccount.payoutSchedule || "manual",
    dashboardType: stripeAccount.dashboardType || "none",
    onboardingCompletedAt: stripeAccount.onboardingCompletedAt || null,
    updatedAt: stripeAccount.updatedAt,
  };
}

function serializePayoutRecipientSummary(payoutRecipient) {
  if (!payoutRecipient) {
    return null;
  }

  return {
    id: payoutRecipient.id,
    sellerId: payoutRecipient.sellerId,
    provider: payoutRecipient.provider || "wise",
    status: payoutRecipient.status || "pending",
    countryCode: payoutRecipient.countryCode || null,
    currencyCode: payoutRecipient.currencyCode || DEFAULT_ORDER_CURRENCY,
    legalType: payoutRecipient.legalType || null,
    accountHolderName: payoutRecipient.accountHolderName || null,
    wiseProfileId: payoutRecipient.wiseProfileId || null,
    wiseRecipientId: payoutRecipient.wiseRecipientId || null,
    accountSummary: payoutRecipient.accountSummary || null,
    longAccountSummary: payoutRecipient.longAccountSummary || null,
    lastSyncedAt: payoutRecipient.lastSyncedAt || null,
    createdAt: payoutRecipient.createdAt,
    updatedAt: payoutRecipient.updatedAt,
  };
}

function isActivePayoutRecipient(payoutRecipient) {
  return Boolean(
    payoutRecipient &&
      payoutRecipient.status === "active" &&
      (payoutRecipient.wiseRecipientId ||
        payoutRecipient.accountHolderName ||
        payoutRecipient.accountSummary),
  );
}

export function getSellerPayoutVerificationState(seller) {
  const phoneVerified = Boolean(seller?.phoneVerifiedAt);
  const documentVerified =
    normalizeUppercase(seller?.documentVerificationStatus) === "VERIFIED";
  const payoutDestinationRegistered = isActivePayoutRecipient(
    seller?.payoutRecipient,
  );
  const nameMatched = Boolean(seller?.verificationNameMatched);
  const payoutNameMatched = Boolean(seller?.payoutNameMatched);
  const complete =
    phoneVerified &&
    documentVerified &&
    payoutDestinationRegistered &&
    nameMatched &&
    payoutNameMatched;

  const missing = [];
  if (!phoneVerified) missing.push("phone_verification");
  if (!documentVerified) missing.push("document_verification");
  if (!payoutDestinationRegistered) missing.push("payout_destination");
  if (!nameMatched) missing.push("name_match");
  if (!payoutNameMatched) missing.push("payout_name_match");

  return {
    complete,
    missing,
    phoneVerified,
    phoneVerifiedAt: seller?.phoneVerifiedAt || null,
    documentVerificationStatus:
      normalizeUppercase(seller?.documentVerificationStatus) || "NONE",
    documentVerificationStatusLabel: createDocumentVerificationStatusLabel(
      normalizeUppercase(seller?.documentVerificationStatus) || "NONE",
    ),
    documentVerifiedAt: seller?.documentVerifiedAt || null,
    payoutDestinationRegistered,
    nameMatched,
    payoutNameMatched,
    sellerVerificationStatus:
      normalizeUppercase(seller?.sellerVerificationStatus) || "NONE",
    sellerVerificationStatusLabel: createSellerVerificationStatusLabel(
      normalizeUppercase(seller?.sellerVerificationStatus) || "NONE",
    ),
    euSellerStatus: normalizeUppercase(seller?.euSellerStatus) || "DISABLED",
    euSellerStatusLabel: createSellerEuStatusLabel(
      normalizeUppercase(seller?.euSellerStatus) || "DISABLED",
    ),
    reviewNotes: seller?.verificationReviewNotes || null,
  };
}

function serializeSellerSummary(vendor) {
  const seller = vendor?.seller;
  const stripeAccount = seller?.stripeAccount;
  const payoutRecipient = seller?.payoutRecipient;
  const verification = getSellerPayoutVerificationState({
    ...seller,
    payoutRecipient,
  });

  return {
    vendorId: vendor.id,
    vendorStoreId: vendor.vendorStoreId,
    vendorHandle: vendor.handle,
    vendorStoreName: vendor.storeName,
    managementEmail: vendor.managementEmail,
    sellerId: seller?.id || null,
    sellerStatus: seller?.status || null,
    sellerStatusLabel: createSellerStatusLabel(seller?.status),
    sellerVerificationStatus: verification.sellerVerificationStatus,
    sellerVerificationStatusLabel: verification.sellerVerificationStatusLabel,
    euSellerStatus: verification.euSellerStatus,
    euSellerStatusLabel: verification.euSellerStatusLabel,
    payoutVerification: verification,
    stripeAccount: serializeStripeAccountSummary(stripeAccount),
    payoutRecipient: serializePayoutRecipientSummary(payoutRecipient),
    createdAt: seller?.createdAt || vendor.createdAt,
    updatedAt: seller?.updatedAt || vendor.updatedAt,
  };
}

async function loadVendorForSellerInitialization(
  vendorId,
  prismaClient = prisma,
) {
  return prismaClient.vendor.findUnique({
    where: { id: vendorId },
    include: {
      vendorStore: true,
      seller: {
        include: {
          stripeAccount: true,
          payoutRecipient: true,
          verificationRecords: {
            orderBy: [{ createdAt: "desc" }],
            take: 3,
          },
        },
      },
    },
  });
}

export async function ensureSellerForVendor(
  vendorId,
  {
    prismaClient = prisma,
    defaultStatus = "pending",
    changedBy = "system",
    reason = "seller_initialized",
  } = {},
) {
  const vendor = await loadVendorForSellerInitialization(
    vendorId,
    prismaClient,
  );

  if (!vendor?.vendorStore) {
    throw new Error("VENDOR_NOT_FOUND");
  }

  if (vendor.seller) {
    return {
      created: false,
      seller: vendor.seller,
      vendor,
    };
  }

  const seller = await prismaClient.$transaction(async (tx) => {
    const createdSeller = await tx.seller.create({
      data: {
        vendorId: vendor.id,
        vendorStoreId: vendor.vendorStoreId,
        status: defaultStatus,
      },
    });

    await tx.sellerStatusHistory.create({
      data: {
        sellerId: createdSeller.id,
        fromStatus: null,
        toStatus: defaultStatus,
        changedBy,
        reason,
      },
    });

    return tx.seller.findUnique({
      where: { id: createdSeller.id },
      include: {
        stripeAccount: true,
      },
    });
  });

  return {
    created: true,
    seller,
    vendor,
  };
}

export async function listAdminSellerRows({ prismaClient = prisma } = {}) {
  const vendors = await prismaClient.vendor.findMany({
    orderBy: [{ createdAt: "desc" }],
    include: {
      vendorStore: true,
      seller: {
        include: {
          stripeAccount: true,
          payoutRecipient: true,
        },
      },
    },
  });

  return vendors.map(serializeSellerSummary);
}

export async function getAdminSellerDetail(
  sellerId,
  { prismaClient = prisma } = {},
) {
  const seller = await prismaClient.seller.findUnique({
    where: { id: sellerId },
    include: {
      vendor: {
        include: {
          vendorStore: true,
        },
      },
      stripeAccount: true,
      payoutRecipient: true,
      statusHistory: {
        orderBy: [{ createdAt: "desc" }],
        take: 20,
      },
      verificationRecords: {
        orderBy: [{ createdAt: "desc" }],
        take: 10,
      },
      orders: {
        orderBy: [{ createdAt: "desc" }],
        take: 20,
      },
      payoutRuns: {
        orderBy: [{ createdAt: "desc" }],
        take: 20,
      },
      ledgerEntries: {
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
        take: 50,
      },
    },
  });

  if (!seller?.vendor?.vendorStore) {
    return null;
  }

  const stripeEvents = seller.stripeAccount?.stripeAccountId
    ? await prismaClient.stripeEvent.findMany({
        where: {
          stripeAccountId: seller.stripeAccount.stripeAccountId,
        },
        orderBy: [{ createdAt: "desc" }],
        take: 50,
      })
    : [];

  return {
    seller: {
      id: seller.id,
      status: seller.status,
      statusLabel: createSellerStatusLabel(seller.status),
      statusReason: seller.statusReason || null,
      sellerLegalRole: seller.sellerLegalRole || "MARKETPLACE_SELLER",
      verificationStatus: seller.sellerVerificationStatus || "NONE",
      verificationStatusLabel: createSellerVerificationStatusLabel(
        seller.sellerVerificationStatus || "NONE",
      ),
      euSellerStatus: seller.euSellerStatus || "DISABLED",
      euSellerStatusLabel: createSellerEuStatusLabel(
        seller.euSellerStatus || "DISABLED",
      ),
      phoneVerifiedAt: seller.phoneVerifiedAt || null,
      documentVerificationStatus:
        seller.documentVerificationStatus || "NONE",
      documentVerificationStatusLabel:
        createDocumentVerificationStatusLabel(
          seller.documentVerificationStatus || "NONE",
        ),
      documentVerifiedAt: seller.documentVerifiedAt || null,
      documentVerifiedBy: seller.documentVerifiedBy || null,
      verificationNameMatched: Boolean(seller.verificationNameMatched),
      payoutNameMatched: Boolean(seller.payoutNameMatched),
      verificationReviewNotes: seller.verificationReviewNotes || null,
      payoutVerification: getSellerPayoutVerificationState(seller),
      createdAt: seller.createdAt,
      updatedAt: seller.updatedAt,
    },
    vendor: {
      id: seller.vendor.id,
      handle: seller.vendor.handle,
      storeName: seller.vendor.storeName,
      managementEmail: seller.vendor.managementEmail,
      vendorStoreId: seller.vendor.vendorStoreId,
    },
    store: {
      id: seller.vendor.vendorStore.id,
      storeName: seller.vendor.vendorStore.storeName,
      ownerName: seller.vendor.vendorStore.ownerName,
      email: seller.vendor.vendorStore.email,
      phone: seller.vendor.vendorStore.phone,
      address: seller.vendor.vendorStore.address,
      country: seller.vendor.vendorStore.country,
      category: seller.vendor.vendorStore.category,
    },
    stripeAccount: serializeStripeAccountSummary(seller.stripeAccount),
    payoutRecipient: serializePayoutRecipientSummary(seller.payoutRecipient),
    statusHistory: seller.statusHistory,
    verificationRecords: seller.verificationRecords,
    orders: seller.orders,
    payoutRuns: seller.payoutRuns.map((run) => ({
      ...run,
      statusLabel: createPayoutRunStatusLabel(run.status),
    })),
    ledgerEntries: seller.ledgerEntries,
    stripeEvents,
  };
}

export async function updateSellerStatus(
  { sellerId, nextStatus, changedBy = "admin", reason = null },
  { prismaClient = prisma } = {},
) {
  if (!SELLER_STATUSES.includes(nextStatus)) {
    return {
      ok: false,
      reason: "invalid_status",
    };
  }

  const seller = await prismaClient.seller.findUnique({
    where: { id: sellerId },
  });

  if (!seller) {
    return {
      ok: false,
      reason: "seller_not_found",
    };
  }

  if (seller.status === nextStatus && seller.statusReason === reason) {
    return {
      ok: true,
      changed: false,
      seller,
    };
  }

  const updatedSeller = await prismaClient.$transaction(async (tx) => {
    const nextSeller = await tx.seller.update({
      where: { id: sellerId },
      data: {
        status: nextStatus,
        statusReason: normalizeText(reason),
      },
    });

    await tx.sellerStatusHistory.create({
      data: {
        sellerId,
        fromStatus: seller.status,
        toStatus: nextStatus,
        changedBy,
        reason: normalizeText(reason),
      },
    });

    return nextSeller;
  });

  return {
    ok: true,
    changed: true,
    seller: updatedSeller,
  };
}

export async function upsertSellerWiseRecipient(
  {
    sellerId,
    wiseRecipientId,
    currencyCode = DEFAULT_ORDER_CURRENCY,
    countryCode = null,
    accountHolderName = null,
    accountSummary = null,
    status = "active",
  },
  { prismaClient = prisma } = {},
) {
  const normalizedSellerId = normalizeText(sellerId);
  const normalizedWiseRecipientId = normalizeText(wiseRecipientId);
  const normalizedCurrency =
    normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;
  const normalizedStatus = normalizeLowercase(status) || "active";

  if (!normalizedSellerId || !normalizedWiseRecipientId) {
    return {
      ok: false,
      reason: "invalid_wise_recipient",
    };
  }

  const seller = await prismaClient.seller.findUnique({
    where: { id: normalizedSellerId },
  });

  if (!seller) {
    return {
      ok: false,
      reason: "seller_not_found",
    };
  }

  const payoutRecipient = await prismaClient.sellerPayoutRecipient.upsert({
    where: { sellerId: normalizedSellerId },
    create: {
      sellerId: normalizedSellerId,
      provider: "wise",
      status: normalizedStatus,
      countryCode: normalizeUppercase(countryCode),
      currencyCode: normalizedCurrency,
      accountHolderName: normalizeText(accountHolderName),
      wiseProfileId: normalizeText(process.env.WISE_PROFILE_ID),
      wiseRecipientId: normalizedWiseRecipientId,
      accountSummary: normalizeText(accountSummary),
      lastSyncedAt: new Date(),
    },
    update: {
      provider: "wise",
      status: normalizedStatus,
      countryCode: normalizeUppercase(countryCode),
      currencyCode: normalizedCurrency,
      accountHolderName: normalizeText(accountHolderName),
      wiseProfileId: normalizeText(process.env.WISE_PROFILE_ID),
      wiseRecipientId: normalizedWiseRecipientId,
      accountSummary: normalizeText(accountSummary),
      lastSyncedAt: new Date(),
    },
  });

  return {
    ok: true,
    payoutRecipient,
  };
}

function deriveSellerVerificationStatus({
  phoneVerified,
  documentVerificationStatus,
  nameMatched,
  payoutNameMatched,
}) {
  const normalizedDocumentStatus =
    normalizeUppercase(documentVerificationStatus) || "NONE";

  if (normalizedDocumentStatus === "REJECTED") {
    return "REJECTED";
  }

  if (!phoneVerified) {
    return "PHONE_REQUIRED";
  }

  if (normalizedDocumentStatus === "PENDING") {
    return "DOCUMENT_PENDING";
  }

  if (normalizedDocumentStatus !== "VERIFIED") {
    return "DOCUMENT_REQUIRED";
  }

  if (!nameMatched || !payoutNameMatched) {
    return "DOCUMENT_PENDING";
  }

  return "VERIFIED";
}

export async function updateSellerVerification(
  {
    sellerId,
    phoneVerified = false,
    documentVerificationStatus = "NONE",
    verificationNameMatched = false,
    payoutNameMatched = false,
    documentType = null,
    documentCountry = null,
    documentLast4 = null,
    reviewNotes = null,
    changedBy = "admin",
  },
  { prismaClient = prisma } = {},
) {
  const normalizedSellerId = normalizeText(sellerId);
  const normalizedDocumentStatus =
    normalizeUppercase(documentVerificationStatus) || "NONE";

  if (!normalizedSellerId) {
    return { ok: false, reason: "seller_not_found" };
  }

  if (!DOCUMENT_VERIFICATION_STATUSES.includes(normalizedDocumentStatus)) {
    return {
      ok: false,
      reason: "invalid_document_verification_status",
    };
  }

  const seller = await prismaClient.seller.findUnique({
    where: { id: normalizedSellerId },
  });

  if (!seller) {
    return { ok: false, reason: "seller_not_found" };
  }

  const now = new Date();
  const nextPhoneVerifiedAt = normalizeBooleanInput(phoneVerified)
    ? seller.phoneVerifiedAt || now
    : null;
  const nextDocumentVerifiedAt =
    normalizedDocumentStatus === "VERIFIED"
      ? seller.documentVerifiedAt || now
      : null;
  const nameMatched = normalizeBooleanInput(verificationNameMatched);
  const payoutMatched = normalizeBooleanInput(payoutNameMatched);
  const nextVerificationStatus = deriveSellerVerificationStatus({
    phoneVerified: Boolean(nextPhoneVerifiedAt),
    documentVerificationStatus: normalizedDocumentStatus,
    nameMatched,
    payoutNameMatched: payoutMatched,
  });

  const updatedSeller = await prismaClient.$transaction(async (tx) => {
    const updated = await tx.seller.update({
      where: { id: normalizedSellerId },
      data: {
        sellerVerificationStatus: nextVerificationStatus,
        phoneVerifiedAt: nextPhoneVerifiedAt,
        documentVerificationStatus: normalizedDocumentStatus,
        documentVerifiedAt: nextDocumentVerifiedAt,
        documentVerifiedBy:
          normalizedDocumentStatus === "VERIFIED"
            ? normalizeText(changedBy) || seller.documentVerifiedBy
            : null,
        verificationNameMatched: nameMatched,
        payoutNameMatched: payoutMatched,
        verificationReviewNotes: normalizeText(reviewNotes),
      },
    });

    await tx.sellerVerificationRecord.create({
      data: {
        sellerId: normalizedSellerId,
        status: nextVerificationStatus,
        verifiedAt: nextVerificationStatus === "VERIFIED" ? now : null,
        verifiedBy:
          nextVerificationStatus === "VERIFIED"
            ? normalizeText(changedBy) || "admin"
            : null,
        verificationMethod: "admin_review",
        documentType: normalizeText(documentType),
        documentCountry: normalizeUppercase(documentCountry),
        documentLast4: normalizeText(documentLast4),
        nameMatched,
        payoutNameMatched: payoutMatched,
        phoneVerifiedAt: nextPhoneVerifiedAt,
        reviewNotes: normalizeText(reviewNotes),
      },
    });

    return updated;
  });

  return {
    ok: true,
    seller: updatedSeller,
    verification: getSellerPayoutVerificationState(updatedSeller),
  };
}

function createStripeAccountResetBlockers(seller) {
  const blockingOrders = (seller?.orders || []).filter((order) => {
    if (order.paidAt || order.stripeChargeId) return true;
    return !STRIPE_ACCOUNT_RESETTABLE_ORDER_STATUSES.has(order.status);
  });
  const blockingPayoutRuns = seller?.payoutRuns || [];
  const blockingLedgerEntries = seller?.ledgerEntries || [];

  return {
    orders: blockingOrders.map((order) => ({
      id: order.id,
      status: order.status,
    })),
    payoutRuns: blockingPayoutRuns.map((run) => ({
      id: run.id,
      status: run.status,
    })),
    ledgerEntries: blockingLedgerEntries.map((entry) => ({
      id: entry.id,
      entryType: entry.entryType,
    })),
  };
}

function hasStripeAccountResetBlockers(blockers) {
  return (
    blockers.orders.length > 0 ||
    blockers.payoutRuns.length > 0 ||
    blockers.ledgerEntries.length > 0
  );
}

export async function resetSellerStripeAccountForRecreate(
  { sellerId, changedBy = "admin", reason = STRIPE_ACCOUNT_RESET_REASON },
  { prismaClient = prisma } = {},
) {
  const seller = await prismaClient.seller.findUnique({
    where: { id: sellerId },
    include: {
      stripeAccount: true,
      orders: {
        select: {
          id: true,
          status: true,
          paidAt: true,
          stripeChargeId: true,
        },
      },
      payoutRuns: {
        select: {
          id: true,
          status: true,
        },
      },
      ledgerEntries: {
        select: {
          id: true,
          entryType: true,
        },
        take: 10,
      },
    },
  });

  if (!seller) {
    return {
      ok: false,
      reason: "seller_not_found",
    };
  }

  if (!seller.stripeAccount) {
    return {
      ok: true,
      reset: false,
      reason: "stripe_account_missing",
      seller,
    };
  }

  const blockers = createStripeAccountResetBlockers(seller);

  if (hasStripeAccountResetBlockers(blockers)) {
    return {
      ok: false,
      reason: "stripe_account_reset_blocked",
      blockers,
    };
  }

  const normalizedReason = normalizeText(reason) || STRIPE_ACCOUNT_RESET_REASON;
  const resetInTransaction = async (tx) => {
    const staleOrders = await tx.order.updateMany({
      where: {
        sellerId: seller.id,
        sellerStripeAccountId: seller.stripeAccount.id,
        status: {
          in: Array.from(STRIPE_ACCOUNT_RESETTABLE_ORDER_STATUSES),
        },
        paidAt: null,
        stripeChargeId: null,
      },
      data: {
        status: "failed",
        sellerStripeAccountId: null,
        stripeAccountId: null,
      },
    });

    await tx.sellerStripeAccount.delete({
      where: {
        id: seller.stripeAccount.id,
      },
    });

    const updatedSeller = await tx.seller.update({
      where: { id: seller.id },
      data: {
        status: "pending",
        statusReason: normalizedReason,
      },
    });

    await tx.sellerStatusHistory.create({
      data: {
        sellerId: seller.id,
        fromStatus: seller.status,
        toStatus: "pending",
        changedBy,
        reason: normalizedReason,
      },
    });

    return {
      ok: true,
      reset: true,
      seller: updatedSeller,
      removedStripeAccountId: seller.stripeAccount.stripeAccountId,
      staleOrdersUpdated: staleOrders.count || 0,
    };
  };

  if (typeof prismaClient.$transaction === "function") {
    return prismaClient.$transaction(resetInTransaction);
  }

  return resetInTransaction(prismaClient);
}

async function setSellerReviewStatus(
  { sellerId, reason, changedBy = "system.stripe" },
  { prismaClient = prisma } = {},
) {
  if (!sellerId) {
    return null;
  }

  const seller = await prismaClient.seller.findUnique({
    where: { id: sellerId },
  });

  if (!seller) {
    return null;
  }

  const normalizedReason = normalizeText(reason);

  if (seller.status === "review" && seller.statusReason === normalizedReason) {
    return seller;
  }

  if (typeof prismaClient.$transaction === "function") {
    return prismaClient.$transaction(async (tx) => {
      const updatedSeller = await tx.seller.update({
        where: { id: sellerId },
        data: {
          status: "review",
          statusReason: normalizedReason,
        },
      });

      await tx.sellerStatusHistory.create({
        data: {
          sellerId,
          fromStatus: seller.status,
          toStatus: "review",
          changedBy,
          reason: normalizedReason,
        },
      });

      return updatedSeller;
    });
  }

  const updatedSeller = await prismaClient.seller.update({
    where: { id: sellerId },
    data: {
      status: "review",
      statusReason: normalizedReason,
    },
  });

  if (prismaClient.sellerStatusHistory?.create) {
    await prismaClient.sellerStatusHistory.create({
      data: {
        sellerId,
        fromStatus: seller.status,
        toStatus: "review",
        changedBy,
        reason: normalizedReason,
      },
    });
  }

  return updatedSeller;
}

async function loadSellerWithStripeContext(sellerId, prismaClient = prisma) {
  return prismaClient.seller.findUnique({
    where: { id: sellerId },
    include: {
      vendor: {
        include: {
          vendorStore: true,
        },
      },
      stripeAccount: true,
    },
  });
}

function buildStripeConnectedAccountCreateParams(seller) {
  const countryCode = toIsoCountryCode(seller?.vendor?.vendorStore?.country);

  return {
    country: countryCode,
    email: seller.vendor.managementEmail,
    business_profile: {
      name: seller.vendor.storeName,
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
      sellerId: seller.id,
      vendorId: seller.vendor.id,
      vendorHandle: seller.vendor.handle,
      vendorStoreId: seller.vendor.vendorStore.id,
    },
  };
}

function normalizeStripeError(error) {
  const raw = error?.raw || {};
  const message = normalizeText(raw.message || error?.message);

  return {
    message: message || "Stripe API request failed.",
    type: normalizeText(raw.type || error?.type),
    code: normalizeText(raw.code || error?.code),
    param: normalizeText(raw.param || error?.param),
    requestId: normalizeText(raw.requestId || error?.requestId),
  };
}

async function setConnectedAccountManualPayouts(stripeClient, stripeAccountId) {
  try {
    await stripeClient.balanceSettings.update(
      {
        payments: {
          payouts: {
            schedule: {
              interval: "manual",
            },
          },
        },
      },
      {
        stripeAccount: stripeAccountId,
      },
    );

    return {
      ok: true,
      method: "balance_settings",
    };
  } catch (balanceSettingsError) {
    const balanceSettingsStripeError =
      normalizeStripeError(balanceSettingsError);

    if (!stripeClient.accounts?.update) {
      return {
        ok: false,
        reason: "manual_payout_schedule_failed",
        stripeError: balanceSettingsStripeError,
      };
    }

    try {
      await stripeClient.accounts.update(stripeAccountId, {
        settings: {
          payouts: {
            schedule: {
              interval: "manual",
            },
          },
        },
      });

      return {
        ok: true,
        method: "account_settings",
        fallbackFrom: balanceSettingsStripeError,
      };
    } catch (accountSettingsError) {
      return {
        ok: false,
        reason: "manual_payout_schedule_failed",
        stripeError: normalizeStripeError(accountSettingsError),
        fallbackFrom: balanceSettingsStripeError,
      };
    }
  }
}

export async function createSellerStripeAccount(
  { sellerId },
  { prismaClient = prisma, stripeClient = getStripeClient() } = {},
) {
  const seller = await loadSellerWithStripeContext(sellerId, prismaClient);

  if (!seller?.vendor?.vendorStore) {
    return {
      ok: false,
      reason: "seller_not_found",
    };
  }

  if (seller.stripeAccount) {
    return {
      ok: true,
      created: false,
      seller,
      stripeAccount: serializeStripeAccountSummary(seller.stripeAccount),
    };
  }

  let account = null;

  try {
    account = await stripeClient.accounts.create(
      buildStripeConnectedAccountCreateParams(seller),
    );
  } catch (error) {
    const stripeError = normalizeStripeError(error);

    return {
      ok: false,
      reason: "stripe_account_create_failed",
      message: stripeError.message,
      stripeError,
    };
  }

  const manualPayoutResult = await setConnectedAccountManualPayouts(
    stripeClient,
    account.id,
  );

  if (!manualPayoutResult.ok) {
    return {
      ok: false,
      reason: manualPayoutResult.reason,
      message: manualPayoutResult.stripeError?.message,
      stripeAccountId: account.id,
      stripeError: manualPayoutResult.stripeError,
      fallbackFrom: manualPayoutResult.fallbackFrom,
    };
  }

  const savedStripeAccount = await prismaClient.sellerStripeAccount.create({
    data: {
      sellerId: seller.id,
      stripeAccountId: account.id,
      countryCode: account.country || null,
      defaultCurrency: account.default_currency || DEFAULT_ORDER_CURRENCY,
      detailsSubmitted: Boolean(account.details_submitted),
      chargesEnabled: Boolean(account.charges_enabled),
      payoutsEnabled: Boolean(account.payouts_enabled),
      payoutSchedule: "manual",
      dashboardType: "none",
      onboardingCompletedAt: account.details_submitted ? new Date() : null,
      requirementsJson: isPlainObject(account.requirements)
        ? account.requirements
        : null,
    },
  });

  return {
    ok: true,
    created: true,
    seller,
    stripeAccount: serializeStripeAccountSummary(savedStripeAccount),
  };
}

export async function syncSellerStripeAccountFromAccountUpdate(
  account,
  { prismaClient = prisma } = {},
) {
  const stripeAccountId = normalizeText(account?.id);

  if (!stripeAccountId) {
    return null;
  }

  const existing = await prismaClient.sellerStripeAccount.findUnique({
    where: { stripeAccountId },
  });

  if (!existing) {
    return null;
  }

  return prismaClient.sellerStripeAccount.update({
    where: { stripeAccountId },
    data: {
      countryCode: normalizeUppercase(account?.country),
      defaultCurrency: normalizeLowercase(account?.default_currency),
      detailsSubmitted: Boolean(account?.details_submitted),
      chargesEnabled: Boolean(account?.charges_enabled),
      payoutsEnabled: Boolean(account?.payouts_enabled),
      onboardingCompletedAt:
        account?.details_submitted && !existing.onboardingCompletedAt
          ? new Date()
          : existing.onboardingCompletedAt,
      requirementsJson: isPlainObject(account?.requirements)
        ? account.requirements
        : null,
    },
  });
}

async function processAccountUpdated(event, { prismaClient = prisma } = {}) {
  const updatedStripeAccount = await syncSellerStripeAccountFromAccountUpdate(
    event.data?.object,
    { prismaClient },
  );

  if (!updatedStripeAccount?.sellerId) {
    return;
  }

  const seller = await prismaClient.seller.findUnique({
    where: { id: updatedStripeAccount.sellerId },
  });

  if (
    seller?.status === "review" &&
    seller.statusReason === SELLER_REVIEW_REASON_PAYOUT_FAILED &&
    event.data?.object?.payouts_enabled === true
  ) {
    await setSellerReviewStatus(
      {
        sellerId: updatedStripeAccount.sellerId,
        reason: SELLER_REVIEW_REASON_EXTERNAL_ACCOUNT_UPDATED,
        changedBy: "stripe.account.updated",
      },
      { prismaClient },
    );
  }
}

async function processExternalAccountUpdated(
  event,
  { prismaClient = prisma } = {},
) {
  const stripeAccountId = normalizeText(event.account);

  if (!stripeAccountId) {
    return;
  }

  const stripeAccount = await prismaClient.sellerStripeAccount.findUnique({
    where: { stripeAccountId },
  });

  if (!stripeAccount?.sellerId) {
    return;
  }

  await setSellerReviewStatus(
    {
      sellerId: stripeAccount.sellerId,
      reason: SELLER_REVIEW_REASON_EXTERNAL_ACCOUNT_UPDATED,
      changedBy: "stripe.account.external_account.updated",
    },
    { prismaClient },
  );
}

export async function getSellerPaymentsPageData(
  { vendorId },
  { prismaClient = prisma } = {},
) {
  const vendor = await prismaClient.vendor.findUnique({
    where: { id: vendorId },
    include: {
      vendorStore: true,
      seller: {
        include: {
          stripeAccount: true,
          payoutRecipient: true,
        },
      },
    },
  });

  if (!vendor?.vendorStore) {
    throw new Error("VENDOR_NOT_FOUND");
  }

  const salesCreditSummary = vendor.seller
    ? await getSellerSalesCreditSummary(
        {
          sellerId: vendor.seller.id,
          currencyCode: DEFAULT_ORDER_CURRENCY,
        },
        { prismaClient },
      )
    : await getSellerSalesCreditSummary(
        {
          sellerId: null,
          currencyCode: DEFAULT_ORDER_CURRENCY,
        },
        { prismaClient },
      );

  return {
    vendor: {
      id: vendor.id,
      handle: vendor.handle,
      storeName: vendor.storeName,
      managementEmail: vendor.managementEmail,
    },
    store: {
      id: vendor.vendorStore.id,
      storeName: vendor.vendorStore.storeName,
    },
    seller: vendor.seller
      ? {
          id: vendor.seller.id,
          status: vendor.seller.status,
          statusLabel: createSellerStatusLabel(vendor.seller.status),
          statusReason: vendor.seller.statusReason || null,
          verificationStatus:
            vendor.seller.sellerVerificationStatus || "NONE",
          verificationStatusLabel: createSellerVerificationStatusLabel(
            vendor.seller.sellerVerificationStatus || "NONE",
          ),
          euSellerStatus: vendor.seller.euSellerStatus || "DISABLED",
          euSellerStatusLabel: createSellerEuStatusLabel(
            vendor.seller.euSellerStatus || "DISABLED",
          ),
          payoutVerification: getSellerPayoutVerificationState(
            vendor.seller,
          ),
        }
      : null,
    stripeAccount: serializeStripeAccountSummary(vendor.seller?.stripeAccount),
    payoutRecipient: serializePayoutRecipientSummary(
      vendor.seller?.payoutRecipient,
    ),
    payoutProvider: getConfiguredSellerPayoutProvider(),
    salesCreditSummary,
  };
}

function buildAccountSessionComponents() {
  return {
    notification_banner: {
      enabled: true,
      features: {},
    },
    account_onboarding: {
      enabled: true,
      features: {
        external_account_collection: true,
      },
    },
    account_management: {
      enabled: true,
      features: {
        external_account_collection: true,
      },
    },
  };
}

export async function createSellerAccountSession(
  { vendorId },
  { prismaClient = prisma, stripeClient = getStripeClient() } = {},
) {
  const vendor = await prismaClient.vendor.findUnique({
    where: { id: vendorId },
    include: {
      seller: {
        include: {
          stripeAccount: true,
        },
      },
    },
  });

  if (!vendor?.seller?.stripeAccount?.stripeAccountId) {
    return {
      ok: false,
      reason: "stripe_account_missing",
    };
  }

  const accountSession = await stripeClient.accountSessions.create({
    account: vendor.seller.stripeAccount.stripeAccountId,
    components: buildAccountSessionComponents(),
  });

  return {
    ok: true,
    clientSecret: accountSession.client_secret,
    expiresAt: accountSession.expires_at,
  };
}

function normalizeCheckoutItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => {
      const productId = normalizeText(
        item?.productId || item?.id || item?.localProductId,
      );
      const quantity = toPositiveInteger(item?.quantity || item?.qty);

      if (!productId || quantity == null) {
        return null;
      }

      return {
        productId,
        quantity,
      };
    })
    .filter(Boolean);
}

function normalizeShippingAddress(address) {
  if (!isPlainObject(address)) {
    return null;
  }

  const normalized = {
    firstName: normalizeText(address.firstName),
    lastName: normalizeText(address.lastName),
    address1: normalizeText(address.address1),
    address2: normalizeText(address.address2),
    city: normalizeText(address.city),
    province: normalizeText(address.province),
    postalCode: normalizeText(address.postalCode),
    country: normalizeText(address.country),
    phone: normalizeText(address.phone),
  };

  return normalized.address1 &&
    normalized.city &&
    normalized.postalCode &&
    normalized.country
    ? normalized
    : null;
}

function normalizeCheckoutCustomer(customer) {
  if (!isPlainObject(customer)) {
    return null;
  }

  const normalized = {
    firstName: normalizeText(customer.firstName),
    lastName: normalizeText(customer.lastName),
    email: normalizeLowercase(customer.email),
    phone: normalizeText(customer.phone),
  };

  return normalized.email ? normalized : null;
}

function serializeOrderLineItems(productsById, items) {
  return items.map((item) => {
    const product = productsById.get(item.productId);
    const unitAmount = toDisplayPrice(product);

    return {
      productId: product.id,
      name: product.name,
      quantity: item.quantity,
      unitAmount,
      totalAmount: unitAmount * item.quantity,
    };
  });
}

async function loadVendorForCheckout(handle, prismaClient = prisma) {
  const normalizedHandle = normalizeText(handle);

  if (!normalizedHandle) {
    return null;
  }

  return prismaClient.vendor.findUnique({
    where: { handle: normalizedHandle },
    include: {
      vendorStore: true,
      seller: {
        include: {
          stripeAccount: true,
        },
      },
    },
  });
}

export async function createCheckoutOrder(
  payload,
  { prismaClient = prisma } = {},
) {
  const vendorHandle = normalizeText(payload?.vendorHandle || payload?.handle);
  const items = normalizeCheckoutItems(payload?.items);
  const customer = normalizeCheckoutCustomer(payload?.customer);
  const shippingAddress = normalizeShippingAddress(payload?.shippingAddress);

  if (!vendorHandle || items.length === 0 || !customer || !shippingAddress) {
    return {
      ok: false,
      reason: "invalid_payload",
    };
  }

  const vendor = await loadVendorForCheckout(vendorHandle, prismaClient);

  if (!vendor?.vendorStore?.id || !vendor?.seller) {
    return {
      ok: false,
      reason: "seller_not_found",
    };
  }

  if (vendor.seller.status !== "active") {
    return {
      ok: false,
      reason: "seller_not_active",
    };
  }

  if (!vendor.seller.stripeAccount?.stripeAccountId) {
    return {
      ok: false,
      reason: "stripe_account_missing",
    };
  }

  const uniqueProductIds = Array.from(
    new Set(items.map((item) => item.productId)),
  );
  const products = await prismaClient.product.findMany({
    where: {
      id: { in: uniqueProductIds },
      vendorStoreId: vendor.vendorStore.id,
      approvalStatus: "approved",
    },
    select: {
      id: true,
      name: true,
      price: true,
      calculatedPrice: true,
    },
  });

  if (products.length !== uniqueProductIds.length) {
    return {
      ok: false,
      reason: "invalid_items",
    };
  }

  const productsById = new Map(
    products.map((product) => [product.id, product]),
  );
  const lineItems = serializeOrderLineItems(productsById, items);
  const subtotalAmount = lineItems.reduce(
    (sum, lineItem) => sum + lineItem.totalAmount,
    0,
  );
  const applicationFeeAmount = calculatePlatformFeeAmount(
    subtotalAmount,
    getPlatformFeeBps(),
  );

  const order = await prismaClient.order.create({
    data: {
      sellerId: vendor.seller.id,
      sellerStripeAccountId: vendor.seller.stripeAccount.id,
      stripeAccountId: vendor.seller.stripeAccount.stripeAccountId,
      status: "draft",
      currencyCode: DEFAULT_ORDER_CURRENCY,
      subtotalAmount,
      applicationFeeAmount,
      totalAmount: subtotalAmount,
      customerEmail: customer.email,
      customerFirstName: customer.firstName,
      customerLastName: customer.lastName,
      customerPhone: customer.phone,
      shippingAddressJson: shippingAddress,
      lineItemsJson: lineItems,
    },
  });

  return {
    ok: true,
    order: {
      id: order.id,
      status: order.status,
      currencyCode: order.currencyCode,
      subtotalAmount: order.subtotalAmount,
      applicationFeeAmount: order.applicationFeeAmount,
      totalAmount: order.totalAmount,
      lineItems,
    },
  };
}

async function loadCheckoutOrder(orderId, prismaClient = prisma) {
  return prismaClient.order.findUnique({
    where: { id: orderId },
    include: {
      seller: {
        include: {
          vendor: true,
          stripeAccount: true,
        },
      },
      sellerStripeAccount: true,
    },
  });
}

export async function createCheckoutOrderPaymentIntent(
  { orderId },
  { prismaClient = prisma, stripeClient = getStripeClient() } = {},
) {
  const order = await loadCheckoutOrder(orderId, prismaClient);

  if (!order?.seller) {
    return {
      ok: false,
      reason: "order_not_found",
    };
  }

  if (order.seller.status !== "active") {
    return {
      ok: false,
      reason: "seller_not_active",
    };
  }

  const stripeAccountId =
    order.sellerStripeAccount?.stripeAccountId || order.stripeAccountId;

  if (!stripeAccountId) {
    return {
      ok: false,
      reason: "stripe_account_missing",
    };
  }

  if (order.stripePaymentIntentId) {
    try {
      const existingIntent = await stripeClient.paymentIntents.retrieve(
        order.stripePaymentIntentId,
        {},
        {
          stripeAccount: stripeAccountId,
        },
      );

      return {
        ok: true,
        created: false,
        paymentIntentId: existingIntent.id,
        clientSecret: existingIntent.client_secret,
        status: existingIntent.status,
        publishableKey: getStripePublishableKey(),
      };
    } catch (error) {
      const code = normalizeText(error?.code);

      if (code !== "resource_missing") {
        throw error;
      }
    }
  }

  const paymentIntent = await stripeClient.paymentIntents.create(
    {
      amount: order.totalAmount,
      currency:
        normalizeLowercase(order.currencyCode) || DEFAULT_ORDER_CURRENCY,
      application_fee_amount: order.applicationFeeAmount,
      automatic_payment_methods: {
        enabled: true,
      },
      receipt_email: order.customerEmail,
      metadata: {
        orderId: order.id,
        sellerId: order.sellerId,
        vendorId: order.seller.vendorId,
      },
    },
    {
      stripeAccount: stripeAccountId,
    },
  );

  await prismaClient.order.update({
    where: { id: order.id },
    data: {
      status: "payment_intent_created",
      stripePaymentIntentId: paymentIntent.id,
    },
  });

  return {
    ok: true,
    created: true,
    paymentIntentId: paymentIntent.id,
    clientSecret: paymentIntent.client_secret,
    status: paymentIntent.status,
    publishableKey: getStripePublishableKey(),
  };
}

export async function createOrderRefund(
  { orderId, amount = null, refundApplicationFee },
  { prismaClient = prisma, stripeClient = getStripeClient() } = {},
) {
  if (typeof refundApplicationFee !== "boolean") {
    return {
      ok: false,
      reason: "refund_application_fee_required",
    };
  }

  const order = await loadCheckoutOrder(orderId, prismaClient);

  if (!order) {
    return {
      ok: false,
      reason: "order_not_found",
    };
  }

  const stripeAccountId =
    order.sellerStripeAccount?.stripeAccountId || order.stripeAccountId;

  if (!stripeAccountId) {
    return {
      ok: false,
      reason: "stripe_account_missing",
    };
  }

  if (!order.stripeChargeId) {
    return {
      ok: false,
      reason: "charge_missing",
    };
  }

  const refundParams = {
    charge: order.stripeChargeId,
    refund_application_fee: refundApplicationFee,
    metadata: {
      orderId: order.id,
      sellerId: order.sellerId,
    },
  };
  const refundAmount = toPositiveInteger(amount);

  if (refundAmount != null) {
    refundParams.amount = refundAmount;
  }

  const refund = await stripeClient.refunds.create(refundParams, {
    stripeAccount: stripeAccountId,
  });

  return {
    ok: true,
    refund,
  };
}

function normalizeShopifyOrderId(payload) {
  return (
    normalizeShopifyGid("Order", payload?.admin_graphql_api_id) ||
    normalizeShopifyGid("Order", payload?.id)
  );
}

function getShopifyOrderAttribute(payload, key) {
  const targetKey = normalizeText(key);

  if (!targetKey) {
    return null;
  }

  const candidates = [
    ...(Array.isArray(payload?.note_attributes) ? payload.note_attributes : []),
    ...(Array.isArray(payload?.custom_attributes)
      ? payload.custom_attributes
      : []),
    ...(Array.isArray(payload?.customAttributes) ? payload.customAttributes : []),
  ];

  for (const attribute of candidates) {
    const attributeKey = normalizeText(attribute?.name || attribute?.key);

    if (attributeKey === targetKey) {
      return normalizeText(attribute?.value);
    }
  }

  return null;
}

function getShopifyOrderSalesCreditOffset(payload) {
  const offsetId = getShopifyOrderAttribute(payload, "sales_credit_offset_id");
  const amount = toPositiveInteger(
    getShopifyOrderAttribute(payload, "sales_credit_offset_amount"),
  );

  if (!offsetId || amount == null) {
    return null;
  }

  return {
    offsetId,
    amount,
    buyerSellerId: getShopifyOrderAttribute(
      payload,
      "sales_credit_buyer_seller_id",
    ),
  };
}

function getSalesCreditOffsetFromPaidEntries(entries = []) {
  for (const entry of Array.isArray(entries) ? entries : []) {
    const metadata = isPlainObject(entry?.metadataJson)
      ? entry.metadataJson
      : null;
    const offsetId = normalizeText(metadata?.salesCreditOffsetId);
    const amount = toPositiveInteger(metadata?.salesCreditOffsetAmount);

    if (offsetId && amount != null) {
      return {
        offsetId,
        amount,
        buyerSellerId: normalizeText(metadata?.salesCreditBuyerSellerId),
      };
    }
  }

  return null;
}

function normalizeShopifyRefundId(payload) {
  return (
    normalizeShopifyGid("Refund", payload?.admin_graphql_api_id) ||
    normalizeShopifyGid("Refund", payload?.id)
  );
}

function getShopifyLineProductIdCandidates(lineItem) {
  return uniqueValues([
    normalizeShopifyGid("Product", lineItem?.product_id),
    normalizeShopifyGid("Product", lineItem?.product?.id),
    normalizeShopifyGid("Product", lineItem?.product?.admin_graphql_api_id),
    normalizeText(lineItem?.product_id),
  ]);
}

function getLineDiscountAmount(lineItem, currencyCode) {
  const discountAllocations = Array.isArray(lineItem?.discount_allocations)
    ? lineItem.discount_allocations
    : [];

  if (discountAllocations.length > 0) {
    return discountAllocations.reduce((total, allocation) => {
      const amount =
        allocation?.amount_set?.shop_money?.amount ??
        allocation?.amount_set?.presentment_money?.amount ??
        allocation?.amount;

      return total + moneyAmountToMinorUnits(amount, currencyCode);
    }, 0);
  }

  return moneyAmountToMinorUnits(lineItem?.total_discount, currencyCode);
}

function getShopifyLineNetAmount(lineItem, currencyCode) {
  const quantity = toPositiveInteger(lineItem?.quantity) || 0;
  const unitAmount = moneyAmountToMinorUnits(
    lineItem?.price_set?.shop_money?.amount ??
      lineItem?.price_set?.presentment_money?.amount ??
      lineItem?.price,
    currencyCode,
  );
  const grossAmount = unitAmount * quantity;
  const discountAmount = getLineDiscountAmount(lineItem, currencyCode);

  return Math.max(0, grossAmount - discountAmount);
}

function normalizeStringList(values = []) {
  return uniqueValues(
    (Array.isArray(values) ? values : [values])
      .map((value) => normalizeText(value))
      .filter(Boolean),
  );
}

function collectShopifyPaymentGatewayNames(payload) {
  return normalizeStringList([
    ...(Array.isArray(payload?.payment_gateway_names)
      ? payload.payment_gateway_names
      : []),
    payload?.gateway,
    payload?.payment_gateway_name,
    payload?.processing_method,
    payload?.source_name,
    ...(Array.isArray(payload?.transactions)
      ? payload.transactions.flatMap((transaction) => [
          transaction?.gateway,
          transaction?.payment_gateway_name,
          transaction?.source_name,
        ])
      : []),
  ]);
}

function isTruthyPaymentRiskValue(value) {
  if (value === true) {
    return true;
  }

  const normalized = normalizeLowercase(value);
  return [
    "1",
    "true",
    "yes",
    "y",
    "authenticated",
    "successful",
    "success",
    "passed",
  ].includes(normalized);
}

function isThreeDSecureAuthenticatedValue(value) {
  if (isTruthyPaymentRiskValue(value)) {
    return true;
  }

  if (!isPlainObject(value)) {
    return false;
  }

  if (
    isTruthyPaymentRiskValue(value.liability_shifted) ||
    isTruthyPaymentRiskValue(value.liabilityShifted) ||
    isTruthyPaymentRiskValue(value.authenticated)
  ) {
    return true;
  }

  const statusCandidates = [
    value.status,
    value.result,
    value.authentication_status,
    value.authenticationStatus,
    value.trans_status,
    value.transStatus,
  ];

  if (statusCandidates.some(isTruthyPaymentRiskValue)) {
    return true;
  }

  const eci = normalizeText(value.eci);
  return eci === "05" || eci === "02";
}

function collectThreeDSecureCandidates(value, depth = 0) {
  if (depth > 4 || value == null) {
    return [];
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      return [];
    }

    try {
      return collectThreeDSecureCandidates(JSON.parse(trimmed), depth + 1);
    } catch {
      return [];
    }
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      collectThreeDSecureCandidates(item, depth + 1),
    );
  }

  if (!isPlainObject(value)) {
    return [];
  }

  const candidates = [];

  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = normalizeLowercase(key) || "";

    if (
      normalizedKey.includes("3d") ||
      normalizedKey.includes("three_d") ||
      normalizedKey.includes("threed") ||
      normalizedKey.includes("liability_shift") ||
      normalizedKey === "eci"
    ) {
      candidates.push(nestedValue);

      if (isPlainObject(nestedValue)) {
        candidates.push(nestedValue);
      }
    }

    candidates.push(...collectThreeDSecureCandidates(nestedValue, depth + 1));
  }

  return candidates;
}

function hasThreeDSecureAuthentication(payload) {
  const transactions = Array.isArray(payload?.transactions)
    ? payload.transactions
    : [];
  const candidates = [
    payload?.three_d_secure,
    payload?.threeDSecure,
    payload?.payment_details?.three_d_secure,
    payload?.payment_details?.threeDSecure,
    payload?.paymentDetails?.three_d_secure,
    payload?.paymentDetails?.threeDSecure,
    ...transactions.flatMap((transaction) => [
      transaction?.three_d_secure,
      transaction?.threeDSecure,
      transaction?.payment_details?.three_d_secure,
      transaction?.payment_details?.threeDSecure,
      transaction?.paymentDetails?.three_d_secure,
      transaction?.paymentDetails?.threeDSecure,
      transaction?.receipt?.three_d_secure,
      transaction?.receipt?.threeDSecure,
      transaction?.receiptJson?.three_d_secure,
      transaction?.receiptJson?.threeDSecure,
    ]),
    ...collectThreeDSecureCandidates(payload?.receiptJson),
    ...transactions.flatMap((transaction) =>
      collectThreeDSecureCandidates(transaction?.receiptJson),
    ),
  ];

  return candidates.some(isThreeDSecureAuthenticatedValue);
}

function gatewayNamesContainAny(gatewayNames, needles) {
  const normalizedNames = gatewayNames.map((name) => normalizeLowercase(name));
  return normalizedNames.some((name) =>
    needles.some((needle) => name?.includes(needle)),
  );
}

export function inferShopifyOrderSalesCreditPaymentRisk(payload = {}) {
  const gatewayNames = collectShopifyPaymentGatewayNames(payload);
  const threeDSecureAuthenticated = hasThreeDSecureAuthentication(payload);

  if (threeDSecureAuthenticated) {
    return {
      riskClass: SALES_CREDIT_PAYMENT_RISK_CLASSES.CARD_3DS_AUTHENTICATED,
      rateBps:
        SALES_CREDIT_PAYMENT_RISK_RATE_BPS[
          SALES_CREDIT_PAYMENT_RISK_CLASSES.CARD_3DS_AUTHENTICATED
        ],
      reason: "three_d_secure_authenticated",
      gatewayNames,
      threeDSecureAuthenticated,
    };
  }

  if (
    gatewayNamesContainAny(gatewayNames, [
      "bank transfer",
      "bank_transfer",
      "furikomi",
      "convenience",
      "konbini",
      "cash on delivery",
      "cod",
      "manual",
      "銀行振込",
      "コンビニ",
    ])
  ) {
    return {
      riskClass: SALES_CREDIT_PAYMENT_RISK_CLASSES.NON_CARD_CONFIRMED,
      rateBps:
        SALES_CREDIT_PAYMENT_RISK_RATE_BPS[
          SALES_CREDIT_PAYMENT_RISK_CLASSES.NON_CARD_CONFIRMED
        ],
      reason: "non_card_confirmed_gateway",
      gatewayNames,
      threeDSecureAuthenticated,
    };
  }

  if (
    gatewayNamesContainAny(gatewayNames, [
      "card",
      "visa",
      "mastercard",
      "master card",
      "jcb",
      "american express",
      "amex",
      "shopify payments",
      "shopify_payments",
    ])
  ) {
    return {
      riskClass: SALES_CREDIT_PAYMENT_RISK_CLASSES.CARD_UNVERIFIED,
      rateBps:
        SALES_CREDIT_PAYMENT_RISK_RATE_BPS[
          SALES_CREDIT_PAYMENT_RISK_CLASSES.CARD_UNVERIFIED
        ],
      reason: "card_without_3ds_signal",
      gatewayNames,
      threeDSecureAuthenticated,
    };
  }

  return {
    riskClass: SALES_CREDIT_PAYMENT_RISK_CLASSES.UNKNOWN,
    rateBps:
      SALES_CREDIT_PAYMENT_RISK_RATE_BPS[
        SALES_CREDIT_PAYMENT_RISK_CLASSES.UNKNOWN
      ],
    reason: "payment_risk_unknown",
    gatewayNames,
    threeDSecureAuthenticated,
  };
}

function buildShopifyOrderPaymentRiskPayload(payload, orderData) {
  const transactions = Array.isArray(orderData?.transactions)
    ? orderData.transactions.map((transaction) => ({
        gateway: transaction?.gateway,
        payment_gateway_name: transaction?.formattedGateway,
        source_name: transaction?.paymentDetails?.paymentMethodName,
        manualPaymentGateway: transaction?.manualPaymentGateway,
        kind: transaction?.kind,
        status: transaction?.status,
        payment_details: transaction?.paymentDetails,
        receiptJson: transaction?.receiptJson,
      }))
    : [];

  return {
    ...payload,
    payment_gateway_names: normalizeStringList([
      ...(Array.isArray(payload?.payment_gateway_names)
        ? payload.payment_gateway_names
        : []),
      ...(Array.isArray(orderData?.paymentGatewayNames)
        ? orderData.paymentGatewayNames
        : []),
    ]),
    source_name: payload?.source_name || orderData?.sourceName,
    transactions: [
      ...(Array.isArray(payload?.transactions) ? payload.transactions : []),
      ...transactions,
    ],
  };
}

async function resolveShopifyOrderSalesCreditPaymentRisk(
  { payload, shopDomain, shopifyOrderId },
  { shopifyGraphQLWithOfflineSessionImpl = null } = {},
) {
  const payloadRisk = inferShopifyOrderSalesCreditPaymentRisk(payload);

  if (
    payloadRisk.rateBps > 0 ||
    typeof shopifyGraphQLWithOfflineSessionImpl !== "function" ||
    !shopDomain ||
    !shopifyOrderId
  ) {
    return payloadRisk;
  }

  try {
    const { data } = await shopifyGraphQLWithOfflineSessionImpl({
      shopDomain,
      apiVersion: "2026-04",
      query: SHOPIFY_ORDER_PAYMENT_RISK_QUERY,
      variables: {
        id: shopifyOrderId,
      },
    });
    const orderPayload = buildShopifyOrderPaymentRiskPayload(
      payload,
      data?.order,
    );
    const adminRisk = inferShopifyOrderSalesCreditPaymentRisk(orderPayload);

    return {
      ...adminRisk,
      reason:
        adminRisk.rateBps > payloadRisk.rateBps
          ? `${adminRisk.reason}_from_admin_transaction`
          : adminRisk.reason,
      adminLookupAttempted: true,
      adminLookupSucceeded: Boolean(data?.order),
      payloadRiskClass: payloadRisk.riskClass,
      payloadRiskRateBps: payloadRisk.rateBps,
    };
  } catch (error) {
    return {
      ...payloadRisk,
      adminLookupAttempted: true,
      adminLookupSucceeded: false,
      adminLookupError:
        error instanceof Error ? error.message : String(error || ""),
    };
  }
}

function getShopifyRefundLineProductIdCandidates(refundLineItem) {
  const lineItem = refundLineItem?.line_item || refundLineItem;

  return uniqueValues([
    normalizeShopifyGid("Product", refundLineItem?.product_id),
    normalizeShopifyGid("Product", lineItem?.product_id),
    normalizeShopifyGid("Product", lineItem?.product?.id),
    normalizeShopifyGid("Product", lineItem?.product?.admin_graphql_api_id),
    normalizeText(refundLineItem?.product_id),
    normalizeText(lineItem?.product_id),
  ]);
}

function getShopifyRefundCurrencyCode(payload, refundLineItems) {
  return (
    normalizeLowercase(payload?.currency) ||
    normalizeLowercase(
      refundLineItems[0]?.subtotal_set?.shop_money?.currency_code,
    ) ||
    normalizeLowercase(
      refundLineItems[0]?.subtotal_set?.presentment_money?.currency_code,
    ) ||
    DEFAULT_ORDER_CURRENCY
  );
}

function getShopifyRefundLineAmount(refundLineItem, currencyCode) {
  const subtotal =
    refundLineItem?.subtotal_set?.shop_money?.amount ??
    refundLineItem?.subtotal_set?.presentment_money?.amount ??
    refundLineItem?.subtotal;

  const subtotalAmount = moneyAmountToMinorUnits(subtotal, currencyCode);

  if (subtotalAmount > 0) {
    return subtotalAmount;
  }

  const lineItem = refundLineItem?.line_item || refundLineItem;
  const quantity = toPositiveInteger(refundLineItem?.quantity) || 0;
  const unitAmount = moneyAmountToMinorUnits(
    lineItem?.price_set?.shop_money?.amount ??
      lineItem?.price_set?.presentment_money?.amount ??
      lineItem?.price,
    currencyCode,
  );

  return Math.max(0, unitAmount * quantity);
}

function getShopifyRefundLineItemIdCandidates(refundLineItem) {
  const lineItem = refundLineItem?.line_item || refundLineItem;

  return uniqueValues([
    normalizeShopifyGid("LineItem", refundLineItem?.line_item_id),
    normalizeShopifyGid("LineItem", refundLineItem?.admin_graphql_api_id),
    normalizeShopifyGid("LineItem", lineItem?.id),
    normalizeShopifyGid("LineItem", lineItem?.admin_graphql_api_id),
    normalizeText(refundLineItem?.line_item_id),
    normalizeText(refundLineItem?.id),
    normalizeText(lineItem?.id),
  ]);
}

function getSellerOrderPaymentStatusAfterRefund({
  paidAmount,
  refundAmount,
  fallback = "paid",
}) {
  const normalizedPaidAmount = clampInteger(paidAmount);
  const normalizedRefundAmount = clampInteger(refundAmount);

  if (normalizedPaidAmount > 0 && normalizedRefundAmount >= normalizedPaidAmount) {
    return "refunded";
  }

  if (normalizedRefundAmount > 0) {
    return "partially_refunded";
  }

  return fallback || "paid";
}

async function updateSellerOrderShadowForRefund(
  {
    shopDomain,
    shopifyOrderId,
    sellerId,
    matchedLines,
    settlementAmount,
  },
  { prismaClient = prisma } = {},
) {
  if (
    !prismaClient?.sellerOrder?.findFirst ||
    !prismaClient?.sellerOrder?.update ||
    !prismaClient?.sellerOrderLine?.findMany ||
    !prismaClient?.sellerOrderLine?.update
  ) {
    return { ok: true, skipped: true, reason: "shadow_models_unavailable" };
  }

  const sellerOrder = await prismaClient.sellerOrder.findFirst({
    where: {
      shopifyOrderId,
      sellerId,
      marketplaceOrder: {
        shopDomain,
      },
    },
    select: {
      id: true,
      sellerRefundAmount: true,
      sellerPayableAmount: true,
      sellerNetAmount: true,
      paymentStatus: true,
    },
  });

  if (!sellerOrder?.id) {
    return { ok: true, skipped: true, reason: "seller_order_not_found" };
  }

  const lineIdCandidates = uniqueValues(
    (Array.isArray(matchedLines) ? matchedLines : []).flatMap(
      ({ refundLineItem }) => getShopifyRefundLineItemIdCandidates(refundLineItem),
    ),
  );
  const sellerOrderLines =
    lineIdCandidates.length > 0
      ? await prismaClient.sellerOrderLine.findMany({
          where: {
            sellerOrderId: sellerOrder.id,
            shopifyLineItemId: {
              in: lineIdCandidates,
            },
          },
          select: {
            id: true,
            shopifyLineItemId: true,
            refundedQuantity: true,
          },
        })
      : [];
  const sellerOrderLineByShopifyLineItemId = new Map(
    sellerOrderLines.map((line) => [line.shopifyLineItemId, line]),
  );
  let updatedLineCount = 0;

  for (const { refundLineItem } of Array.isArray(matchedLines) ? matchedLines : []) {
    const matchedLine = getShopifyRefundLineItemIdCandidates(refundLineItem)
      .map((candidate) => sellerOrderLineByShopifyLineItemId.get(candidate))
      .find(Boolean);

    if (!matchedLine?.id) {
      continue;
    }

    const refundQuantity = toPositiveInteger(refundLineItem?.quantity) || 0;
    await prismaClient.sellerOrderLine.update({
      where: {
        id: matchedLine.id,
      },
      data: {
        refundedQuantity:
          clampInteger(matchedLine.refundedQuantity) + refundQuantity,
      },
    });
    updatedLineCount += 1;
  }

  const nextRefundAmount =
    clampInteger(sellerOrder.sellerRefundAmount) + clampInteger(settlementAmount);
  const paidAmount =
    clampInteger(sellerOrder.sellerPayableAmount) ||
    clampInteger(sellerOrder.sellerNetAmount);
  const updatedSellerOrder = await prismaClient.sellerOrder.update({
    where: {
      id: sellerOrder.id,
    },
    data: {
      sellerRefundAmount: nextRefundAmount,
      paymentStatus: getSellerOrderPaymentStatusAfterRefund({
        paidAmount,
        refundAmount: nextRefundAmount,
        fallback: sellerOrder.paymentStatus,
      }),
    },
  });

  return {
    ok: true,
    sellerOrder: updatedSellerOrder,
    updatedLineCount,
    refundAmount: nextRefundAmount,
  };
}

async function updateSellerOrderShadowForCancellation(
  {
    shopDomain,
    shopifyOrderId,
    sellerId,
    settlementAmount,
  },
  { prismaClient = prisma } = {},
) {
  if (
    !prismaClient?.sellerOrder?.findFirst ||
    !prismaClient?.sellerOrder?.update
  ) {
    return { ok: true, skipped: true, reason: "shadow_models_unavailable" };
  }

  const sellerOrder = await prismaClient.sellerOrder.findFirst({
    where: {
      shopifyOrderId,
      sellerId,
      marketplaceOrder: {
        shopDomain,
      },
    },
    select: {
      id: true,
      sellerRefundAmount: true,
      sellerPayableAmount: true,
      sellerNetAmount: true,
      paymentStatus: true,
    },
  });

  if (!sellerOrder?.id) {
    return { ok: true, skipped: true, reason: "seller_order_not_found" };
  }

  const nextRefundAmount =
    clampInteger(sellerOrder.sellerRefundAmount) + clampInteger(settlementAmount);
  const paidAmount =
    clampInteger(sellerOrder.sellerPayableAmount) ||
    clampInteger(sellerOrder.sellerNetAmount);
  const nextPaymentStatus =
    paidAmount > 0 && nextRefundAmount >= paidAmount
      ? "cancelled"
      : getSellerOrderPaymentStatusAfterRefund({
          paidAmount,
          refundAmount: nextRefundAmount,
          fallback: sellerOrder.paymentStatus,
        });

  const updatedSellerOrder = await prismaClient.sellerOrder.update({
    where: {
      id: sellerOrder.id,
    },
    data: {
      sellerRefundAmount: nextRefundAmount,
      paymentStatus: nextPaymentStatus,
    },
  });

  return {
    ok: true,
    sellerOrder: updatedSellerOrder,
    refundAmount: nextRefundAmount,
  };
}

async function updateSellerOrderShadowRiskStatus(
  {
    shopDomain,
    shopifyOrderId,
    sellerId,
    riskStatus,
  },
  { prismaClient = prisma } = {},
) {
  if (
    !prismaClient?.sellerOrder?.findFirst ||
    !prismaClient?.sellerOrder?.update
  ) {
    return { ok: true, skipped: true, reason: "shadow_models_unavailable" };
  }

  const sellerOrder = await prismaClient.sellerOrder.findFirst({
    where: {
      shopifyOrderId,
      sellerId,
      marketplaceOrder: {
        shopDomain,
      },
    },
    select: {
      id: true,
      riskStatus: true,
    },
  });

  if (!sellerOrder?.id) {
    return { ok: true, skipped: true, reason: "seller_order_not_found" };
  }

  if (sellerOrder.riskStatus === riskStatus) {
    return { ok: true, sellerOrder, unchanged: true };
  }

  const updatedSellerOrder = await prismaClient.sellerOrder.update({
    where: {
      id: sellerOrder.id,
    },
    data: {
      riskStatus,
    },
  });

  return {
    ok: true,
    sellerOrder: updatedSellerOrder,
  };
}

async function findShopifyOrderLedgerEntries(shopifyOrderId, prismaClient) {
  if (!shopifyOrderId) {
    return [];
  }

  return prismaClient.ledgerEntry.findMany({
    where: {
      entryType: {
        in: SHOPIFY_ORDER_SETTLEMENT_ENTRY_TYPES,
      },
      OR: [
        {
          stripeObjectId: shopifyOrderId,
        },
        {
          metadataJson: {
            path: ["shopifyOrderId"],
            equals: shopifyOrderId,
          },
        },
      ],
    },
  });
}

async function findShopifyOrderRiskLedgerEntries(shopifyOrderId, prismaClient) {
  if (!shopifyOrderId) {
    return [];
  }

  return prismaClient.ledgerEntry.findMany({
    where: {
      entryType: {
        in: SHOPIFY_ORDER_RISK_ENTRY_TYPES,
      },
      OR: [
        {
          stripeObjectId: shopifyOrderId,
        },
        {
          metadataJson: {
            path: ["shopifyOrderId"],
            equals: shopifyOrderId,
          },
        },
      ],
    },
  });
}

function summarizeShopifyOrderLedgerEntries(entries, sellerId = null) {
  const sellerLedgerEntries = sellerId
    ? entries.filter((entry) => entry?.sellerId === sellerId)
    : entries;
  const paidAmount = sellerLedgerEntries
    .filter((entry) => entry?.entryType === "shopify_order_paid")
    .reduce((total, entry) => total + clampInteger(entry?.amount), 0);
  const reversedAmount = sellerLedgerEntries
    .filter((entry) =>
      SHOPIFY_ORDER_REVERSAL_ENTRY_TYPES.includes(entry?.entryType),
    )
    .reduce((total, entry) => total + clampInteger(entry?.amount), 0);

  return {
    paidAmount,
    reversedAmount,
    remainingAmount: Math.max(0, paidAmount - reversedAmount),
    hasPaidEntry: paidAmount > 0,
  };
}

function summarizeShopifyOrderRiskLedgerEntries(entries, sellerId = null) {
  const settlementSummary = summarizeShopifyOrderLedgerEntries(
    entries,
    sellerId,
  );
  const sellerLedgerEntries = sellerId
    ? entries.filter((entry) => entry?.sellerId === sellerId)
    : entries;
  const disputeHoldAmount = sellerLedgerEntries
    .filter((entry) => entry?.entryType === "dispute_created")
    .reduce((total, entry) => total + clampInteger(entry?.amount), 0);
  const disputeReleasedAmount = sellerLedgerEntries
    .filter((entry) => entry?.entryType === "dispute_funds_reinstated")
    .reduce((total, entry) => total + clampInteger(entry?.amount), 0);
  const disputeHeldAmount = Math.max(
    0,
    disputeHoldAmount - disputeReleasedAmount,
  );

  return {
    ...settlementSummary,
    disputeHeldAmount,
    remainingHoldableAmount: Math.max(
      0,
      settlementSummary.remainingAmount - disputeHeldAmount,
    ),
  };
}

function capShopifyOrderReversalAmount(requestedAmount, orderLedgerSummary) {
  const normalizedAmount = clampInteger(requestedAmount);

  if (!orderLedgerSummary?.hasPaidEntry) {
    return normalizedAmount;
  }

  return Math.min(normalizedAmount, orderLedgerSummary.remainingAmount);
}

function compareProductMatchPriority(a, b, shopDomain) {
  const aExact = normalizeLowercase(a?.shopDomain) === shopDomain ? 0 : 1;
  const bExact = normalizeLowercase(b?.shopDomain) === shopDomain ? 0 : 1;

  return aExact - bExact;
}

function getProductSeller(product) {
  return (
    product?.vendorStore?.seller ||
    product?.vendorStore?.vendorAuth?.seller ||
    null
  );
}

function getProductVendor(product) {
  return (
    product?.vendorStore?.vendorAuth ||
    getProductSeller(product)?.vendor ||
    null
  );
}

function buildProductCandidateMap(products, shopDomain) {
  const sortedProducts = [...products].sort((a, b) =>
    compareProductMatchPriority(a, b, shopDomain),
  );
  const productMap = new Map();

  for (const product of sortedProducts) {
    for (const candidate of uniqueValues([
      product?.shopifyProductId,
      product?.shopifyProductId?.replace("gid://shopify/Product/", ""),
    ])) {
      if (!productMap.has(candidate)) {
        productMap.set(candidate, product);
      }
    }
  }

  return productMap;
}

function normalizeShopifyLineItemId(lineItem, index = 0) {
  return (
    normalizeShopifyGid("LineItem", lineItem?.admin_graphql_api_id) ||
    normalizeShopifyGid("LineItem", lineItem?.id) ||
    normalizeText(lineItem?.id) ||
    `line:${index + 1}`
  );
}

function normalizeShopifyVariantId(lineItem) {
  return (
    normalizeShopifyGid("ProductVariant", lineItem?.variant_id) ||
    normalizeShopifyGid("ProductVariant", lineItem?.variant?.id) ||
    normalizeShopifyGid(
      "ProductVariant",
      lineItem?.variant?.admin_graphql_api_id,
    ) ||
    normalizeText(lineItem?.variant_id)
  );
}

function getShopifyLineTaxAmount(lineItem, currencyCode) {
  const taxLines = Array.isArray(lineItem?.tax_lines) ? lineItem.tax_lines : [];

  return taxLines.reduce((total, taxLine) => {
    const amount =
      taxLine?.price_set?.shop_money?.amount ??
      taxLine?.price_set?.presentment_money?.amount ??
      taxLine?.price;

    return total + moneyAmountToMinorUnits(amount, currencyCode);
  }, 0);
}

function getShopifyLineAmountBreakdown(lineItem, currencyCode) {
  const quantity = toPositiveInteger(lineItem?.quantity) || 0;
  const unitAmount = moneyAmountToMinorUnits(
    lineItem?.price_set?.shop_money?.amount ??
      lineItem?.price_set?.presentment_money?.amount ??
      lineItem?.price,
    currencyCode,
  );
  const lineSubtotalAmount = unitAmount * quantity;
  const discountAmount = getLineDiscountAmount(lineItem, currencyCode);
  const taxAmount = getShopifyLineTaxAmount(lineItem, currencyCode);

  return {
    quantity,
    unitAmount,
    lineSubtotalAmount,
    discountAmount,
    taxAmount,
    netAmount: Math.max(0, lineSubtotalAmount - discountAmount),
  };
}

function getShopifyOrderShippingAmount(payload, currencyCode) {
  const shippingLines = Array.isArray(payload?.shipping_lines)
    ? payload.shipping_lines
    : [];

  return shippingLines.reduce((total, shippingLine) => {
    const amount =
      shippingLine?.price_set?.shop_money?.amount ??
      shippingLine?.price_set?.presentment_money?.amount ??
      shippingLine?.price;

    return total + moneyAmountToMinorUnits(amount, currencyCode);
  }, 0);
}

function normalizeDateValue(value) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return null;
  }

  const date = new Date(normalized);

  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeBuyerName(payload) {
  const customer = isPlainObject(payload?.customer) ? payload.customer : {};
  return normalizeText(
    [
      payload?.billing_address?.first_name ||
        payload?.shipping_address?.first_name ||
        customer?.first_name,
      payload?.billing_address?.last_name ||
        payload?.shipping_address?.last_name ||
        customer?.last_name,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function buildMarketplaceOrderSnapshot({
  payload,
  shopDomain,
  shopifyOrderId,
  shopifyOrderName,
  currencyCode,
}) {
  return {
    shopDomain,
    shopifyOrderId,
    shopifyOrderName,
    shopifyOrderNumber: normalizeText(payload?.order_number),
    buyerEmail: normalizeText(payload?.email || payload?.customer?.email),
    buyerName: normalizeBuyerName(payload),
    totalAmount: moneyAmountToMinorUnits(
      payload?.total_price_set?.shop_money?.amount ??
        payload?.total_price_set?.presentment_money?.amount ??
        payload?.total_price,
      currencyCode,
    ),
    subtotalAmount: moneyAmountToMinorUnits(
      payload?.subtotal_price_set?.shop_money?.amount ??
        payload?.subtotal_price_set?.presentment_money?.amount ??
        payload?.subtotal_price,
      currencyCode,
    ),
    shippingAmount: getShopifyOrderShippingAmount(payload, currencyCode),
    discountAmount: moneyAmountToMinorUnits(
      payload?.total_discounts_set?.shop_money?.amount ??
        payload?.total_discounts_set?.presentment_money?.amount ??
        payload?.total_discounts,
      currencyCode,
    ),
    taxAmount: moneyAmountToMinorUnits(
      payload?.total_tax_set?.shop_money?.amount ??
        payload?.total_tax_set?.presentment_money?.amount ??
        payload?.total_tax,
      currencyCode,
    ),
    currencyCode,
    financialStatus: normalizeLowercase(payload?.financial_status),
    fulfillmentStatus: normalizeLowercase(payload?.fulfillment_status),
    processedAt: normalizeDateValue(payload?.processed_at || payload?.created_at),
    cancelledAt: normalizeDateValue(payload?.cancelled_at),
    metadataJson: {
      source: "shopify_order_paid_shadow",
      shopifyOrderNumericId: normalizeText(payload?.id),
      lineItemCount: Array.isArray(payload?.line_items)
        ? payload.line_items.length
        : 0,
    },
  };
}

function buildSellerOrderShadowBuckets({
  matchedLines,
  currencyCode,
  salesCreditOffset,
}) {
  const bucketsBySellerId = new Map();

  matchedLines.forEach(({ lineItem, product }, index) => {
    const seller = getProductSeller(product);
    const sellerId = normalizeText(seller?.id);

    if (!sellerId) {
      return;
    }

    const vendor = getProductVendor(product);
    const vendorStoreId = normalizeText(
      product?.vendorStoreId || product?.vendorStore?.id,
    );
    const breakdown = getShopifyLineAmountBreakdown(lineItem, currencyCode);
    const bucket =
      bucketsBySellerId.get(sellerId) ||
      {
        sellerId,
        vendorStoreId,
        vendorId: normalizeText(vendor?.id),
        vendorHandle: normalizeText(vendor?.handle),
        sellerSubtotalAmount: 0,
        sellerDiscountAmount: 0,
        sellerTaxAmount: 0,
        sellerNetItemAmount: 0,
        sellerNetAmount: 0,
        sellerPayableAmount: 0,
        salesCreditOffsetAmount: 0,
        lines: [],
      };

    bucket.sellerSubtotalAmount += breakdown.lineSubtotalAmount;
    bucket.sellerDiscountAmount += breakdown.discountAmount;
    bucket.sellerTaxAmount += breakdown.taxAmount;
    bucket.sellerNetItemAmount += breakdown.netAmount;
    bucket.sellerNetAmount += breakdown.netAmount;
    bucket.sellerPayableAmount += breakdown.netAmount;
    bucket.lines.push({
      shopifyLineItemId: normalizeShopifyLineItemId(lineItem, index),
      shopifyProductId:
        normalizeText(product?.shopifyProductId) ||
        getShopifyLineProductIdCandidates(lineItem)[0] ||
        null,
      shopifyVariantId: normalizeShopifyVariantId(lineItem),
      productId: normalizeText(product?.id),
      title: normalizeText(lineItem?.title || product?.name),
      sku: normalizeText(lineItem?.sku),
      ...breakdown,
      currencyCode,
      metadataJson: {
        shopifyProductIdFromLine: normalizeText(lineItem?.product_id),
        localProductName: normalizeText(product?.name),
      },
    });

    bucketsBySellerId.set(sellerId, bucket);
  });

  const buckets = Array.from(bucketsBySellerId.values());
  const salesCreditAmount = clampInteger(salesCreditOffset?.amount);

  if (salesCreditAmount > 0 && buckets.length === 1) {
    buckets[0].salesCreditOffsetAmount = salesCreditAmount;
    buckets[0].sellerNetAmount += salesCreditAmount;
    buckets[0].sellerPayableAmount += salesCreditAmount;
  }

  return buckets;
}

function buildSellerOrderShadowStatus({
  ledgerEntry,
  sellerBuckets,
  multiSellerDetected,
}) {
  if (multiSellerDetected) {
    return SELLER_ORDER_SHADOW_CHECK_STATUSES.MULTI_SELLER_DETECTED;
  }

  if (!ledgerEntry) {
    return SELLER_ORDER_SHADOW_CHECK_STATUSES.SHADOW_WRITTEN;
  }

  const calculatedAmount = sellerBuckets.reduce(
    (total, bucket) => total + bucket.sellerPayableAmount,
    0,
  );
  const sellerIds = uniqueValues(sellerBuckets.map((bucket) => bucket.sellerId));

  if (
    ledgerEntry.sellerId &&
    sellerIds.length === 1 &&
    sellerIds[0] !== ledgerEntry.sellerId
  ) {
    return SELLER_ORDER_SHADOW_CHECK_STATUSES.SELLER_MISMATCH;
  }

  if (ledgerEntry.amount !== calculatedAmount) {
    return SELLER_ORDER_SHADOW_CHECK_STATUSES.AMOUNT_MISMATCH;
  }

  return SELLER_ORDER_SHADOW_CHECK_STATUSES.MATCHED;
}

async function createSellerOrderShadowFailureCheck(
  {
    prismaClient,
    shopDomain,
    shopifyOrderId,
    shopifyOrderName,
    currencyCode = DEFAULT_ORDER_CURRENCY,
    error,
  },
) {
  if (!prismaClient?.sellerOrderShadowCheck?.create) {
    return null;
  }

  try {
    return await prismaClient.sellerOrderShadowCheck.create({
      data: {
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        status: SELLER_ORDER_SHADOW_CHECK_STATUSES.FAILED,
        currencyCode: normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY,
        errorMessage:
          normalizeText(error?.message) || "seller_order_shadow_failed",
      },
    });
  } catch (shadowError) {
    console.error("seller order shadow failure check error:", shadowError);
    return null;
  }
}

async function recordShopifyOrderSellerOrderShadow(
  {
    payload,
    shopDomain,
    shopifyOrderId,
    shopifyOrderName,
    currencyCode,
    matchedLines,
    ledgerEntry = null,
    salesCreditOffset = null,
    multiSellerDetected = false,
    writeSellerOrders = true,
  },
  { prismaClient = prisma, env = process.env } = {},
) {
  if (!isSellerOrderShadowWriteEnabled(env)) {
    return { ok: true, skipped: true, reason: "shadow_write_disabled" };
  }

  if (!hasSellerOrderShadowModels(prismaClient)) {
    return { ok: true, skipped: true, reason: "shadow_models_unavailable" };
  }

  try {
    const normalizedCurrencyCode =
      normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;
    const marketplaceData = buildMarketplaceOrderSnapshot({
      payload,
      shopDomain,
      shopifyOrderId,
      shopifyOrderName,
      currencyCode: normalizedCurrencyCode,
    });
    const sellerBuckets = buildSellerOrderShadowBuckets({
      matchedLines,
      currencyCode: normalizedCurrencyCode,
      salesCreditOffset,
    });
    const calculatedAmount = sellerBuckets.reduce(
      (total, bucket) => total + bucket.sellerPayableAmount,
      0,
    );
    const sellerIds = uniqueValues(
      sellerBuckets.map((bucket) => bucket.sellerId),
    );
    const marketplaceOrder = await prismaClient.marketplaceOrder.upsert({
      where: {
        shopDomain_shopifyOrderId: {
          shopDomain,
          shopifyOrderId,
        },
      },
      update: marketplaceData,
      create: marketplaceData,
    });
    const writtenSellerOrders = [];

    if (writeSellerOrders && !multiSellerDetected) {
      for (const bucket of sellerBuckets) {
        const sellerOrderData = {
          marketplaceOrderId: marketplaceOrder.id,
          shopifyOrderId,
          shopifyOrderName,
          sellerId: bucket.sellerId,
          vendorStoreId: bucket.vendorStoreId,
          sellerSubtotalAmount: bucket.sellerSubtotalAmount,
          sellerDiscountAmount: bucket.sellerDiscountAmount,
          sellerRefundAmount: 0,
          sellerNetAmount: bucket.sellerNetAmount,
          sellerPayableAmount: bucket.sellerPayableAmount,
          shippingQuotedAmount: 0,
          shippingChargedAmount: 0,
          shippingAllocationMethod: "not_allocated",
          currencyCode: normalizedCurrencyCode,
          paymentStatus: "paid",
          fulfillmentStatus: "unfulfilled",
          settlementStatus: "shadow",
          riskStatus: "normal",
          metadataJson: {
            vendorId: bucket.vendorId,
            vendorHandle: bucket.vendorHandle,
            sellerNetItemAmount: bucket.sellerNetItemAmount,
            sellerTaxAmount: bucket.sellerTaxAmount,
            salesCreditOffsetId: salesCreditOffset?.offsetId || null,
            salesCreditOffsetAmount: bucket.salesCreditOffsetAmount,
          },
        };
        const sellerOrder = await prismaClient.sellerOrder.upsert({
          where: {
            marketplaceOrderId_sellerId: {
              marketplaceOrderId: marketplaceOrder.id,
              sellerId: bucket.sellerId,
            },
          },
          update: sellerOrderData,
          create: sellerOrderData,
        });

        writtenSellerOrders.push(sellerOrder);

        for (const line of bucket.lines) {
          await prismaClient.sellerOrderLine.upsert({
            where: {
              sellerOrderId_shopifyLineItemId: {
                sellerOrderId: sellerOrder.id,
                shopifyLineItemId: line.shopifyLineItemId,
              },
            },
            update: line,
            create: {
              ...line,
              sellerOrderId: sellerOrder.id,
            },
          });
        }
      }
    }

    const status = buildSellerOrderShadowStatus({
      ledgerEntry,
      sellerBuckets,
      multiSellerDetected,
    });
    const shadowCheck = await prismaClient.sellerOrderShadowCheck.create({
      data: {
        marketplaceOrderId: marketplaceOrder.id,
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        status,
        currencyCode: normalizedCurrencyCode,
        legacyLedgerAmount: ledgerEntry?.amount ?? null,
        sellerOrderCalculatedAmount: calculatedAmount,
        legacySellerIdsJson: ledgerEntry?.sellerId ? [ledgerEntry.sellerId] : [],
        sellerOrderSellerIdsJson: sellerIds,
        differencesJson: {
          legacyLedgerEntryId: ledgerEntry?.id || null,
          multiSellerDetected,
          sellerOrderCount: writtenSellerOrders.length,
          lineCount: sellerBuckets.reduce(
            (total, bucket) => total + bucket.lines.length,
            0,
          ),
        },
      },
    });

    return {
      ok: true,
      marketplaceOrder,
      sellerOrders: writtenSellerOrders,
      shadowCheck,
      status,
    };
  } catch (error) {
    console.error("seller order shadow write error:", error);
    await createSellerOrderShadowFailureCheck({
      prismaClient,
      shopDomain,
      shopifyOrderId,
      shopifyOrderName,
      currencyCode,
      error,
    });

    return {
      ok: false,
      reason: "seller_order_shadow_write_failed",
      errorMessage: normalizeText(error?.message),
    };
  }
}

function getLedgerMetadataJson(ledgerEntry) {
  return isPlainObject(ledgerEntry?.metadataJson)
    ? ledgerEntry.metadataJson
    : {};
}

function getBackfillLedgerShopifyOrderId(ledgerEntry) {
  const metadata = getLedgerMetadataJson(ledgerEntry);
  return (
    normalizeText(ledgerEntry?.stripeObjectId) ||
    normalizeText(metadata.shopifyOrderId)
  );
}

function getBackfillLedgerShopDomain(ledgerEntry) {
  const metadata = getLedgerMetadataJson(ledgerEntry);
  return normalizeLowercase(metadata.shopDomain);
}

function getBackfillLedgerLineItems(ledgerEntry) {
  const metadata = getLedgerMetadataJson(ledgerEntry);
  return Array.isArray(metadata.lineItems) ? metadata.lineItems : [];
}

function buildSyntheticShopifyOrderPayloadFromLedger({
  ledgerEntry,
  shopDomain,
  shopifyOrderId,
  shopifyOrderName,
  currencyCode,
  lineItems,
}) {
  const metadata = getLedgerMetadataJson(ledgerEntry);
  const processedAt =
    ledgerEntry?.occurredAt || ledgerEntry?.createdAt || new Date();
  const totalAmount = decimalAmountFromMinorUnits(
    ledgerEntry?.amount,
    currencyCode,
  );

  return {
    id: normalizeText(metadata.shopifyOrderNumericId),
    admin_graphql_api_id: shopifyOrderId,
    name: shopifyOrderName,
    order_number: normalizeText(metadata.shopifyOrderNumber),
    shop_domain: shopDomain,
    currency: normalizeUppercase(currencyCode),
    financial_status: "paid",
    processed_at:
      processedAt instanceof Date
        ? processedAt.toISOString()
        : normalizeText(processedAt),
    total_price: totalAmount,
    subtotal_price: totalAmount,
    total_discounts: "0",
    total_tax: "0",
    line_items: lineItems,
  };
}

function buildSyntheticShopifyLineItemFromLedgerLine({
  line,
  product,
  currencyCode,
  index,
}) {
  const lineAmount = clampInteger(line?.amount);
  const quantity = toPositiveInteger(line?.quantity) || 1;
  const unitAmount = quantity > 0 ? Math.ceil(lineAmount / quantity) : lineAmount;
  const discountAmount = Math.max(0, unitAmount * quantity - lineAmount);
  const shopifyLineItemId =
    normalizeShopifyGid("LineItem", line?.shopifyLineItemId) ||
    normalizeText(line?.shopifyLineItemId) ||
    `backfill:${index + 1}`;

  return {
    id: shopifyLineItemId,
    admin_graphql_api_id: shopifyLineItemId,
    product_id: normalizeText(line?.shopifyProductId || product?.shopifyProductId),
    title: normalizeText(line?.localProductName || product?.name),
    sku: normalizeText(line?.sku),
    price: decimalAmountFromMinorUnits(unitAmount, currencyCode),
    quantity,
    discount_allocations:
      discountAmount > 0
        ? [{ amount: decimalAmountFromMinorUnits(discountAmount, currencyCode) }]
        : [],
    tax_lines: [],
    properties: [
      {
        name: "backfill_ledger_line_amount",
        value: String(lineAmount),
      },
    ],
  };
}

function buildSalesCreditOffsetFromLedger(ledgerEntry) {
  const metadata = getLedgerMetadataJson(ledgerEntry);
  const amount = clampInteger(metadata.salesCreditOffsetAmount);

  if (amount <= 0) {
    return null;
  }

  return {
    offsetId: normalizeText(metadata.salesCreditOffsetId),
    amount,
    buyerSellerId: normalizeText(metadata.salesCreditBuyerSellerId),
  };
}

async function createSellerOrderShadowBackfillFailureCheck(
  {
    prismaClient,
    ledgerEntry,
    shopDomain,
    shopifyOrderId,
    shopifyOrderName,
    currencyCode,
    reason,
    differences = {},
  },
) {
  if (!prismaClient?.sellerOrderShadowCheck?.create) {
    return null;
  }

  return prismaClient.sellerOrderShadowCheck.create({
    data: {
      shopDomain: shopDomain || "unknown",
      shopifyOrderId: shopifyOrderId || `ledger:${ledgerEntry?.id || "unknown"}`,
      shopifyOrderName,
      status: SELLER_ORDER_SHADOW_CHECK_STATUSES.FAILED,
      currencyCode: normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY,
      legacyLedgerAmount: clampInteger(ledgerEntry?.amount),
      sellerOrderCalculatedAmount: 0,
      legacySellerIdsJson: ledgerEntry?.sellerId ? [ledgerEntry.sellerId] : [],
      sellerOrderSellerIdsJson: [],
      differencesJson: {
        source: "seller_order_shadow_backfill",
        legacyLedgerEntryId: ledgerEntry?.id || null,
        reason,
        ...differences,
      },
      errorMessage: reason,
    },
  });
}

export async function backfillSellerOrderShadowChecks(
  { days = 30, limit = 100, retryFailed = false, now = new Date() } = {},
  { prismaClient = prisma } = {},
) {
  if (
    !hasSellerOrderShadowModels(prismaClient) ||
    !prismaClient?.sellerOrderShadowCheck?.findFirst ||
    !prismaClient?.ledgerEntry?.findMany ||
    !prismaClient?.product?.findMany
  ) {
    return {
      ok: false,
      reason: "seller_order_shadow_backfill_unavailable",
      scanned: 0,
      created: 0,
      skippedExisting: 0,
      failed: 0,
      results: [],
    };
  }

  const normalizedLimit = Math.min(
    Math.max(clampInteger(limit, 100), 1),
    300,
  );
  const normalizedDays = Math.min(Math.max(clampInteger(days, 30), 1), 365);
  const shouldRetryFailed = normalizeBooleanInput(retryFailed);
  const since = subtractDays(now, normalizedDays);
  const ledgerEntries = await prismaClient.ledgerEntry.findMany({
    where: {
      entryType: "shopify_order_paid",
      direction: "credit",
      occurredAt: {
        gte: since,
      },
    },
    orderBy: {
      occurredAt: "desc",
    },
    take: normalizedLimit,
  });
  const results = [];
  let created = 0;
  let skippedExisting = 0;
  let failed = 0;

  for (const ledgerEntry of ledgerEntries) {
    const metadata = getLedgerMetadataJson(ledgerEntry);
    const shopDomain = getBackfillLedgerShopDomain(ledgerEntry);
    const shopifyOrderId = getBackfillLedgerShopifyOrderId(ledgerEntry);
    const shopifyOrderName = normalizeText(metadata.shopifyOrderName);
    const currencyCode =
      normalizeLowercase(ledgerEntry?.currencyCode || metadata.currencyCode) ||
      DEFAULT_ORDER_CURRENCY;

    if (!shopDomain || !shopifyOrderId) {
      const shadowCheck = await createSellerOrderShadowBackfillFailureCheck({
        prismaClient,
        ledgerEntry,
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        currencyCode,
        reason: "backfill_order_identity_missing",
      });

      failed += 1;
      results.push({
        ok: false,
        status: SELLER_ORDER_SHADOW_CHECK_STATUSES.FAILED,
        reason: "backfill_order_identity_missing",
        ledgerEntryId: ledgerEntry?.id,
        shadowCheckId: shadowCheck?.id || null,
      });
      continue;
    }

    const existingShadowCheck =
      await prismaClient.sellerOrderShadowCheck.findFirst({
        where: {
          shopDomain,
          shopifyOrderId,
        },
        orderBy: {
          checkedAt: "desc",
        },
      });

    if (
      existingShadowCheck &&
      !(
        shouldRetryFailed &&
        existingShadowCheck.status === SELLER_ORDER_SHADOW_CHECK_STATUSES.FAILED
      )
    ) {
      skippedExisting += 1;
      results.push({
        ok: true,
        skipped: true,
        reason: "shadow_check_exists",
        ledgerEntryId: ledgerEntry?.id,
        shopifyOrderId,
        shadowCheckId: existingShadowCheck.id,
      });
      continue;
    }

    const ledgerLineItems = getBackfillLedgerLineItems(ledgerEntry);

    if (ledgerLineItems.length === 0) {
      const shadowCheck = await createSellerOrderShadowBackfillFailureCheck({
        prismaClient,
        ledgerEntry,
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        currencyCode,
        reason: "backfill_line_items_missing",
      });

      failed += 1;
      results.push({
        ok: false,
        status: SELLER_ORDER_SHADOW_CHECK_STATUSES.FAILED,
        reason: "backfill_line_items_missing",
        ledgerEntryId: ledgerEntry?.id,
        shopifyOrderId,
        shadowCheckId: shadowCheck?.id || null,
      });
      continue;
    }

    const localProductIds = uniqueValues(
      ledgerLineItems.map((line) => line?.localProductId),
    );
    const shopifyProductIds = uniqueValues(
      ledgerLineItems.flatMap((line) => [
        line?.shopifyProductId,
        normalizeShopifyGid("Product", line?.shopifyProductId),
      ]),
    );
    const productWhereClauses = [];

    if (localProductIds.length > 0) {
      productWhereClauses.push({
        id: {
          in: localProductIds,
        },
      });
    }

    if (shopifyProductIds.length > 0) {
      productWhereClauses.push({
        shopifyProductId: {
          in: shopifyProductIds,
        },
      });
    }

    const products =
      productWhereClauses.length > 0
        ? await prismaClient.product.findMany({
            where: {
              OR: productWhereClauses,
            },
            select: {
              id: true,
              name: true,
              approvalStatus: true,
              shopifyProductId: true,
              shopDomain: true,
              vendorStoreId: true,
              vendorStore: {
                select: {
                  id: true,
                  storeName: true,
                  seller: {
                    select: {
                      id: true,
                      status: true,
                      stripeAccount: true,
                    },
                  },
                  vendorAuth: {
                    select: {
                      id: true,
                      handle: true,
                      storeName: true,
                      seller: {
                        select: {
                          id: true,
                          status: true,
                          stripeAccount: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          })
        : [];
    const productsByLocalId = new Map(
      products.map((product) => [normalizeText(product?.id), product]),
    );
    const productMap = buildProductCandidateMap(products, shopDomain);
    const matchedLines = [];
    const unmatchedLines = [];
    const syntheticLineItems = [];

    ledgerLineItems.forEach((line, index) => {
      const product =
        productsByLocalId.get(normalizeText(line?.localProductId)) ||
        productMap.get(normalizeText(line?.shopifyProductId)) ||
        productMap.get(normalizeShopifyGid("Product", line?.shopifyProductId));

      if (!product) {
        unmatchedLines.push({
          index,
          shopifyLineItemId: normalizeText(line?.shopifyLineItemId),
          shopifyProductId: normalizeText(line?.shopifyProductId),
          localProductId: normalizeText(line?.localProductId),
        });
        return;
      }

      const lineItem = buildSyntheticShopifyLineItemFromLedgerLine({
        line,
        product,
        currencyCode,
        index,
      });

      syntheticLineItems.push(lineItem);
      matchedLines.push({
        lineItem,
        product,
        amount: clampInteger(line?.amount),
      });
    });

    if (matchedLines.length === 0 || unmatchedLines.length > 0) {
      const shadowCheck = await createSellerOrderShadowBackfillFailureCheck({
        prismaClient,
        ledgerEntry,
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        currencyCode,
        reason:
          matchedLines.length === 0
            ? "backfill_no_matching_products"
            : "backfill_unmatched_products",
        differences: {
          unmatchedLines,
          matchedLineCount: matchedLines.length,
        },
      });

      failed += 1;
      results.push({
        ok: false,
        status: SELLER_ORDER_SHADOW_CHECK_STATUSES.FAILED,
        reason:
          matchedLines.length === 0
            ? "backfill_no_matching_products"
            : "backfill_unmatched_products",
        ledgerEntryId: ledgerEntry?.id,
        shopifyOrderId,
        shadowCheckId: shadowCheck?.id || null,
      });
      continue;
    }

    const payload = buildSyntheticShopifyOrderPayloadFromLedger({
      ledgerEntry,
      shopDomain,
      shopifyOrderId,
      shopifyOrderName,
      currencyCode,
      lineItems: syntheticLineItems,
    });
    const shadowResult = await recordShopifyOrderSellerOrderShadow(
      {
        payload,
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        currencyCode,
        matchedLines,
        ledgerEntry,
        salesCreditOffset: buildSalesCreditOffsetFromLedger(ledgerEntry),
      },
      {
        prismaClient,
        env: { SELLER_ORDER_SHADOW_WRITE_ENABLED: "true" },
      },
    );

    if (shadowResult.ok) {
      created += 1;
      results.push({
        ok: true,
        status: shadowResult.status,
        ledgerEntryId: ledgerEntry?.id,
        shopifyOrderId,
        shadowCheckId: shadowResult.shadowCheck?.id || null,
      });
    } else {
      failed += 1;
      results.push({
        ok: false,
        status: SELLER_ORDER_SHADOW_CHECK_STATUSES.FAILED,
        reason: shadowResult.reason,
        ledgerEntryId: ledgerEntry?.id,
        shopifyOrderId,
        errorMessage: shadowResult.errorMessage,
      });
    }
  }

  return {
    ok: true,
    days: normalizedDays,
    limit: normalizedLimit,
    retryFailed: shouldRetryFailed,
    scanned: ledgerEntries.length,
    created,
    skippedExisting,
    failed,
    results,
  };
}

export async function processShopifyOrderPaidSettlement(
  { payload, shop },
  {
    prismaClient = prisma,
    shopifyGraphQLWithOfflineSessionImpl = null,
    env = process.env,
  } = {},
) {
  const shopDomain = normalizeLowercase(
    shop || payload?.shop_domain || payload?.shop,
  );
  const shopifyOrderId = normalizeShopifyOrderId(payload);
  const shopifyOrderName = normalizeText(
    payload?.name || payload?.order_number,
  );
  const currencyCode =
    normalizeLowercase(payload?.currency || payload?.presentment_currency) ||
    DEFAULT_ORDER_CURRENCY;
  const lineItems = Array.isArray(payload?.line_items)
    ? payload.line_items
    : [];
  const salesCreditOffset = getShopifyOrderSalesCreditOffset(payload);

  if (!shopDomain || !shopifyOrderId || lineItems.length === 0) {
    return {
      ok: false,
      reason: "invalid_shopify_order_payload",
    };
  }

  const paymentRisk = await resolveShopifyOrderSalesCreditPaymentRisk(
    {
      payload,
      shopDomain,
      shopifyOrderId,
    },
    {
      shopifyGraphQLWithOfflineSessionImpl,
    },
  );

  const existingLedgerEntry = await prismaClient.ledgerEntry.findFirst({
    where: {
      entryType: "shopify_order_paid",
      stripeObjectId: shopifyOrderId,
    },
  });

  if (existingLedgerEntry) {
    let salesCreditCapture = null;

    if (salesCreditOffset?.offsetId) {
      salesCreditCapture = await captureSalesCreditOffset(
        {
          offsetId: salesCreditOffset.offsetId,
          expectedSellerId: salesCreditOffset.buyerSellerId,
          expectedAmount: salesCreditOffset.amount,
          expectedCurrencyCode: currencyCode,
          metadataJson: {
            shopDomain,
            shopifyOrderId,
            shopifyOrderName,
            shopifyOrderNumericId: normalizeText(payload?.id),
          },
        },
        { prismaClient, now: new Date() },
      );
    }

    const response = {
      ok: true,
      duplicate: true,
      ledgerEntry: existingLedgerEntry,
    };

    if (salesCreditCapture) {
      response.salesCreditCapture = salesCreditCapture;
    }

    return response;
  }

  const productIdCandidates = uniqueValues(
    lineItems.flatMap(getShopifyLineProductIdCandidates),
  );

  if (productIdCandidates.length === 0) {
    return {
      ok: false,
      reason: "shopify_order_products_missing",
    };
  }

  const products = await prismaClient.product.findMany({
    where: {
      shopifyProductId: {
        in: productIdCandidates,
      },
      OR: [
        {
          shopDomain,
        },
        {
          shopDomain: null,
        },
      ],
    },
    select: {
      id: true,
      name: true,
      approvalStatus: true,
      shopifyProductId: true,
      shopDomain: true,
      vendorStoreId: true,
      vendorStore: {
        select: {
          id: true,
          storeName: true,
          seller: {
            select: {
              id: true,
              status: true,
              stripeAccount: true,
            },
          },
          vendorAuth: {
            select: {
              id: true,
              handle: true,
              storeName: true,
              seller: {
                select: {
                  id: true,
                  status: true,
                  stripeAccount: true,
                },
              },
            },
          },
        },
      },
    },
  });

  const productMap = buildProductCandidateMap(products, shopDomain);
  const matchedLines = [];
  const unmatchedProductIds = [];

  for (const lineItem of lineItems) {
    const candidates = getShopifyLineProductIdCandidates(lineItem);
    const product = candidates
      .map((candidate) => productMap.get(candidate))
      .find(Boolean);

    if (!product) {
      unmatchedProductIds.push(
        candidates[0] || normalizeText(lineItem?.product_id) || null,
      );
      continue;
    }

    matchedLines.push({
      lineItem,
      product,
      amount: getShopifyLineNetAmount(lineItem, currencyCode),
    });
  }

  if (matchedLines.length === 0) {
    return {
      ok: false,
      reason: "shopify_order_no_matching_products",
      unmatchedProductIds: unmatchedProductIds.filter(Boolean),
    };
  }

  const sellerIds = uniqueValues(
    matchedLines.map(({ product }) => getProductSeller(product)?.id),
  );

  if (sellerIds.length === 0) {
    return {
      ok: false,
      reason: "shopify_order_seller_missing",
    };
  }

  if (sellerIds.length > 1) {
    await recordShopifyOrderSellerOrderShadow(
      {
        payload,
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        currencyCode,
        matchedLines,
        salesCreditOffset,
        multiSellerDetected: true,
        writeSellerOrders: false,
      },
      { prismaClient, env },
    );

    return {
      ok: false,
      reason: "multi_seller_shopify_order_unsupported",
      sellerIds,
    };
  }

  const seller = getProductSeller(matchedLines[0].product);

  if (seller.status !== "active") {
    return {
      ok: false,
      reason: "seller_not_active",
      sellerId: seller.id,
    };
  }

  const cashSettlementAmount = matchedLines.reduce(
    (total, matchedLine) => total + matchedLine.amount,
    0,
  );
  const salesCreditSettlementAmount = clampInteger(salesCreditOffset?.amount);
  const settlementAmount = cashSettlementAmount + salesCreditSettlementAmount;

  if (settlementAmount <= 0) {
    return {
      ok: false,
      reason: "shopify_order_settlement_amount_empty",
      sellerId: seller.id,
    };
  }

  if (salesCreditOffset?.offsetId && !salesCreditOffset.buyerSellerId) {
    return {
      ok: false,
      reason: "sales_credit_buyer_seller_missing",
      sellerId: seller.id,
      amount: settlementAmount,
      currencyCode,
    };
  }

  const occurredAt = payload?.processed_at
    ? new Date(payload.processed_at)
    : payload?.created_at
      ? new Date(payload.created_at)
      : new Date();
  const vendor = getProductVendor(matchedLines[0].product);
  return runInTransaction(prismaClient, async (tx) => {
    let salesCreditCapture = null;

    if (salesCreditOffset?.offsetId) {
      if (salesCreditOffset.buyerSellerId === seller.id) {
        return {
          ok: false,
          reason: "sales_credit_self_purchase_detected",
          sellerId: seller.id,
          amount: settlementAmount,
          currencyCode,
        };
      }

      salesCreditCapture = await captureSalesCreditOffset(
        {
          offsetId: salesCreditOffset.offsetId,
          expectedSellerId: salesCreditOffset.buyerSellerId,
          expectedAmount: salesCreditSettlementAmount,
          expectedCurrencyCode: currencyCode,
          expectedTargetSellerId: seller.id,
          metadataJson: {
            shopDomain,
            shopifyOrderId,
            shopifyOrderName,
            shopifyOrderNumericId: normalizeText(payload?.id),
            settlementSellerId: seller.id,
          },
        },
        { prismaClient: tx, now: occurredAt },
      );

      if (!salesCreditCapture.ok) {
        return {
          ok: false,
          reason: "sales_credit_capture_failed",
          sellerId: seller.id,
          amount: settlementAmount,
          currencyCode,
          salesCreditCapture,
        };
      }
    }

    const ledgerEntry = await createLedgerEntry(
      {
        sellerId: seller.id,
        sellerStripeAccountId: seller.stripeAccount?.id || null,
        stripeAccountId: seller.stripeAccount?.stripeAccountId || null,
        entryType: "shopify_order_paid",
        stripeObjectId: shopifyOrderId,
        amount: settlementAmount,
        currencyCode,
        direction: "credit",
        description: "Shopify order paid",
        metadataJson: {
          shopDomain,
          shopifyOrderId,
          shopifyOrderName,
          shopifyOrderNumericId: normalizeText(payload?.id),
          vendorId: normalizeText(vendor?.id),
          vendorHandle: normalizeText(vendor?.handle),
          settlementMode: "shopify_order_to_monthly_settlement",
          cashSettlementAmount,
          salesCreditPaymentRiskClass: paymentRisk.riskClass,
          salesCreditPaymentRiskRateBps: paymentRisk.rateBps,
          salesCreditPaymentRiskReason: paymentRisk.reason,
          shopifyPaymentGatewayNames: paymentRisk.gatewayNames,
          threeDSecureAuthenticated: paymentRisk.threeDSecureAuthenticated,
          salesCreditPaymentRiskAdminLookupAttempted: Boolean(
            paymentRisk.adminLookupAttempted,
          ),
          salesCreditPaymentRiskAdminLookupSucceeded: Boolean(
            paymentRisk.adminLookupSucceeded,
          ),
          salesCreditOffsetId: salesCreditOffset?.offsetId || null,
          salesCreditOffsetAmount: salesCreditSettlementAmount,
          salesCreditBuyerSellerId: salesCreditOffset?.buyerSellerId || null,
          matchedLineCount: matchedLines.length,
          unmatchedProductIds: unmatchedProductIds.filter(Boolean),
          lineItems: matchedLines.map(({ lineItem, product, amount }) => ({
            shopifyLineItemId: normalizeText(lineItem?.id),
            shopifyProductId: normalizeText(product.shopifyProductId),
            localProductId: product.id,
            localProductName: product.name,
            quantity: toPositiveInteger(lineItem?.quantity) || 0,
            amount,
          })),
        },
        occurredAt,
      },
      { prismaClient: tx },
    );
    const sellerOrderShadow = await recordShopifyOrderSellerOrderShadow(
      {
        payload,
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        currencyCode,
        matchedLines,
        ledgerEntry,
        salesCreditOffset,
      },
      { prismaClient: tx, env },
    );

    return {
      ok: true,
      duplicate: false,
      ledgerEntry,
      sellerId: seller.id,
      amount: settlementAmount,
      currencyCode,
      paymentRisk,
      matchedLineCount: matchedLines.length,
      unmatchedProductIds: unmatchedProductIds.filter(Boolean),
      salesCreditCapture,
      sellerOrderShadow,
    };
  });
}

export async function processShopifyRefundSettlement(
  { payload, shop },
  { prismaClient = prisma } = {},
) {
  const shopDomain = normalizeLowercase(
    shop || payload?.shop_domain || payload?.shop,
  );
  const shopifyRefundId = normalizeShopifyRefundId(payload);
  const shopifyOrderId = normalizeShopifyGid("Order", payload?.order_id);
  const refundLineItems = Array.isArray(payload?.refund_line_items)
    ? payload.refund_line_items
    : [];
  const currencyCode = getShopifyRefundCurrencyCode(payload, refundLineItems);

  if (!shopDomain || !shopifyRefundId || refundLineItems.length === 0) {
    return {
      ok: false,
      reason: "invalid_shopify_refund_payload",
    };
  }

  const existingLedgerEntry = await prismaClient.ledgerEntry.findFirst({
    where: {
      entryType: "refund",
      stripeObjectId: shopifyRefundId,
    },
  });

  if (existingLedgerEntry) {
    return {
      ok: true,
      duplicate: true,
      ledgerEntry: existingLedgerEntry,
    };
  }

  const productIdCandidates = uniqueValues(
    refundLineItems.flatMap(getShopifyRefundLineProductIdCandidates),
  );

  if (productIdCandidates.length === 0) {
    return {
      ok: false,
      reason: "shopify_refund_products_missing",
    };
  }

  const products = await prismaClient.product.findMany({
    where: {
      shopifyProductId: {
        in: productIdCandidates,
      },
      OR: [
        {
          shopDomain,
        },
        {
          shopDomain: null,
        },
      ],
    },
    select: {
      id: true,
      name: true,
      approvalStatus: true,
      shopifyProductId: true,
      shopDomain: true,
      vendorStoreId: true,
      vendorStore: {
        select: {
          id: true,
          storeName: true,
          seller: {
            select: {
              id: true,
              status: true,
              stripeAccount: true,
            },
          },
          vendorAuth: {
            select: {
              id: true,
              handle: true,
              storeName: true,
              seller: {
                select: {
                  id: true,
                  status: true,
                  stripeAccount: true,
                },
              },
            },
          },
        },
      },
    },
  });

  const productMap = buildProductCandidateMap(products, shopDomain);
  const matchedLines = [];
  const unmatchedProductIds = [];

  for (const refundLineItem of refundLineItems) {
    const candidates = getShopifyRefundLineProductIdCandidates(refundLineItem);
    const product = candidates
      .map((candidate) => productMap.get(candidate))
      .find(Boolean);

    if (!product) {
      unmatchedProductIds.push(
        candidates[0] ||
          normalizeText(refundLineItem?.line_item?.product_id) ||
          normalizeText(refundLineItem?.product_id) ||
          null,
      );
      continue;
    }

    matchedLines.push({
      refundLineItem,
      product,
      amount: getShopifyRefundLineAmount(refundLineItem, currencyCode),
    });
  }

  if (matchedLines.length === 0) {
    return {
      ok: false,
      reason: "shopify_refund_no_matching_products",
      unmatchedProductIds: unmatchedProductIds.filter(Boolean),
    };
  }

  const sellerIds = uniqueValues(
    matchedLines.map(({ product }) => getProductSeller(product)?.id),
  );

  if (sellerIds.length === 0) {
    return {
      ok: false,
      reason: "shopify_refund_seller_missing",
    };
  }

  if (sellerIds.length > 1) {
    return {
      ok: false,
      reason: "multi_seller_shopify_refund_unsupported",
      sellerIds,
    };
  }

  const seller = getProductSeller(matchedLines[0].product);

  const requestedSettlementAmount = matchedLines.reduce(
    (total, matchedLine) => total + matchedLine.amount,
    0,
  );
  const orderLedgerEntries = await findShopifyOrderLedgerEntries(
    shopifyOrderId,
    prismaClient,
  );
  const orderLedgerSummary = summarizeShopifyOrderLedgerEntries(
    orderLedgerEntries,
    seller.id,
  );
  const salesCreditOffset = getSalesCreditOffsetFromPaidEntries(
    orderLedgerEntries.filter((entry) => entry?.entryType === "shopify_order_paid"),
  );
  const salesCreditRefundAmount = clampInteger(salesCreditOffset?.amount);
  const cashRemainingAmount = Math.max(
    0,
    orderLedgerSummary.remainingAmount - salesCreditRefundAmount,
  );
  const shouldReverseSalesCredit =
    Boolean(salesCreditOffset?.offsetId) &&
    requestedSettlementAmount >= cashRemainingAmount;
  const settlementAmount = capShopifyOrderReversalAmount(
    requestedSettlementAmount +
      (shouldReverseSalesCredit ? salesCreditRefundAmount : 0),
    orderLedgerSummary,
  );

  if (settlementAmount <= 0) {
    return {
      ok: true,
      reason: "shopify_refund_order_already_reversed",
      sellerId: seller.id,
      amount: 0,
      currencyCode,
    };
  }

  const occurredAt = payload?.processed_at
    ? new Date(payload.processed_at)
    : payload?.created_at
      ? new Date(payload.created_at)
      : new Date();
  const vendor = getProductVendor(matchedLines[0].product);

  return runInTransaction(prismaClient, async (tx) => {
    const ledgerEntry = await createLedgerEntry(
      {
        sellerId: seller.id,
        sellerStripeAccountId: seller.stripeAccount?.id || null,
        stripeAccountId: seller.stripeAccount?.stripeAccountId || null,
        entryType: "refund",
        stripeObjectId: shopifyRefundId,
        amount: settlementAmount,
        currencyCode,
        direction: "debit",
        description: "Shopify refund",
        metadataJson: {
          shopDomain,
          shopifyRefundId,
          shopifyRefundNumericId: normalizeText(payload?.id),
          shopifyOrderId,
          shopifyOrderNumericId: normalizeText(payload?.order_id),
          vendorId: normalizeText(vendor?.id),
          vendorHandle: normalizeText(vendor?.handle),
          settlementMode: "shopify_refund_to_monthly_settlement",
          salesCreditOffsetId: salesCreditOffset?.offsetId || null,
          salesCreditOffsetReversed: shouldReverseSalesCredit,
          matchedLineCount: matchedLines.length,
          unmatchedProductIds: unmatchedProductIds.filter(Boolean),
          lineItems: matchedLines.map(({ refundLineItem, product, amount }) => ({
            shopifyRefundLineItemId: normalizeText(refundLineItem?.id),
            shopifyLineItemId: normalizeText(refundLineItem?.line_item_id),
            shopifyProductId: normalizeText(product.shopifyProductId),
            localProductId: product.id,
            localProductName: product.name,
            quantity: toPositiveInteger(refundLineItem?.quantity) || 0,
            amount,
          })),
        },
        occurredAt,
      },
      { prismaClient: tx },
    );

    const salesCreditReversal = shouldReverseSalesCredit
      ? await reverseSalesCreditOffsetForRefund(
          {
            offsetId: salesCreditOffset.offsetId,
            metadataJson: {
              shopDomain,
              shopifyRefundId,
              shopifyOrderId,
              reversalReason: "shopify_refund",
            },
          },
          { prismaClient: tx, now: occurredAt },
        )
      : null;
    const sellerOrderShadowRefund = await updateSellerOrderShadowForRefund(
      {
        shopDomain,
        shopifyOrderId,
        sellerId: seller.id,
        matchedLines,
        settlementAmount,
      },
      { prismaClient: tx },
    );

    return {
      ok: true,
      duplicate: false,
      ledgerEntry,
      sellerId: seller.id,
      amount: settlementAmount,
      currencyCode,
      matchedLineCount: matchedLines.length,
      unmatchedProductIds: unmatchedProductIds.filter(Boolean),
      salesCreditReversal,
      sellerOrderShadowRefund,
    };
  });
}

export async function processShopifyOrderCancelledSettlement(
  { payload, shop },
  { prismaClient = prisma } = {},
) {
  const shopDomain = normalizeLowercase(
    shop || payload?.shop_domain || payload?.shop,
  );
  const shopifyOrderId = normalizeShopifyOrderId(payload);
  const shopifyOrderName = normalizeText(
    payload?.name || payload?.order_number,
  );
  const currencyCode =
    normalizeLowercase(payload?.currency || payload?.presentment_currency) ||
    DEFAULT_ORDER_CURRENCY;

  if (!shopDomain || !shopifyOrderId) {
    return {
      ok: false,
      reason: "invalid_shopify_cancelled_order_payload",
    };
  }

  const existingCancellationEntry = await prismaClient.ledgerEntry.findFirst({
    where: {
      entryType: "shopify_order_cancelled",
      stripeObjectId: shopifyOrderId,
    },
  });

  if (existingCancellationEntry) {
    return {
      ok: true,
      duplicate: true,
      ledgerEntry: existingCancellationEntry,
    };
  }

  const orderLedgerEntries = await findShopifyOrderLedgerEntries(
    shopifyOrderId,
    prismaClient,
  );
  const paidEntries = orderLedgerEntries.filter(
    (entry) => entry?.entryType === "shopify_order_paid",
  );
  const sellerIds = uniqueValues(paidEntries.map((entry) => entry?.sellerId));

  if (sellerIds.length === 0) {
    return {
      ok: true,
      reason: "shopify_cancelled_order_not_settled",
      amount: 0,
      currencyCode,
    };
  }

  if (sellerIds.length > 1) {
    return {
      ok: false,
      reason: "multi_seller_shopify_cancelled_order_unsupported",
      sellerIds,
    };
  }

  const sellerId = sellerIds[0];
  const orderLedgerSummary = summarizeShopifyOrderLedgerEntries(
    orderLedgerEntries,
    sellerId,
  );
  const settlementAmount = orderLedgerSummary.remainingAmount;

  if (settlementAmount <= 0) {
    return {
      ok: true,
      reason: "shopify_cancelled_order_already_reversed",
      sellerId,
      amount: 0,
      currencyCode,
    };
  }

  const paidEntry = paidEntries.find((entry) => entry?.sellerId === sellerId);
  const salesCreditOffset = getSalesCreditOffsetFromPaidEntries(paidEntries);
  const occurredAt = payload?.cancelled_at
    ? new Date(payload.cancelled_at)
    : payload?.updated_at
      ? new Date(payload.updated_at)
      : new Date();
  return runInTransaction(prismaClient, async (tx) => {
    const ledgerEntry = await createLedgerEntry(
      {
        sellerId,
        sellerStripeAccountId: paidEntry?.sellerStripeAccountId || null,
        stripeAccountId: paidEntry?.stripeAccountId || null,
        entryType: "shopify_order_cancelled",
        stripeObjectId: shopifyOrderId,
        amount: settlementAmount,
        currencyCode,
        direction: "debit",
        description: "Shopify order cancelled",
        metadataJson: {
          shopDomain,
          shopifyOrderId,
          shopifyOrderName,
          shopifyOrderNumericId: normalizeText(payload?.id),
          cancelReason: normalizeText(payload?.cancel_reason),
          cancelledAt: normalizeText(payload?.cancelled_at),
          settlementMode: "shopify_cancelled_order_to_monthly_settlement",
          paidAmount: orderLedgerSummary.paidAmount,
          reversedAmountBeforeCancellation: orderLedgerSummary.reversedAmount,
          salesCreditOffsetId: salesCreditOffset?.offsetId || null,
          salesCreditOffsetReversed: Boolean(salesCreditOffset?.offsetId),
        },
        occurredAt,
      },
      { prismaClient: tx },
    );

    const salesCreditReversal = salesCreditOffset?.offsetId
      ? await reverseSalesCreditOffsetForRefund(
          {
            offsetId: salesCreditOffset.offsetId,
            metadataJson: {
              shopDomain,
              shopifyOrderId,
              reversalReason: "shopify_order_cancelled",
            },
          },
          { prismaClient: tx, now: occurredAt },
        )
      : null;
    const sellerOrderShadowCancellation =
      await updateSellerOrderShadowForCancellation(
        {
          shopDomain,
          shopifyOrderId,
          sellerId,
          settlementAmount,
        },
        { prismaClient: tx },
      );

    return {
      ok: true,
      duplicate: false,
      ledgerEntry,
      sellerId,
      amount: settlementAmount,
      currencyCode,
      salesCreditReversal,
      sellerOrderShadowCancellation,
    };
  });
}

export async function processShopifyDisputeSettlement(
  { payload, shop, topic },
  { prismaClient = prisma } = {},
) {
  const shopDomain = normalizeLowercase(
    shop || payload?.shop_domain || payload?.shop,
  );
  const shopifyDisputeId = normalizeShopifyDisputeId(payload);
  const shopifyOrderId = normalizeShopifyDisputeOrderId(payload);
  const disputeStatus = normalizeLowercase(payload?.status);
  const disputeType = normalizeLowercase(payload?.type);
  const disputeReason = normalizeLowercase(payload?.reason);
  const normalizedTopic = normalizeText(topic) || "disputes/create";

  if (!shopDomain || !shopifyDisputeId || !shopifyOrderId) {
    return {
      ok: false,
      reason: "invalid_shopify_dispute_payload",
    };
  }

  const orderLedgerEntries = await findShopifyOrderRiskLedgerEntries(
    shopifyOrderId,
    prismaClient,
  );
  const paidEntries = orderLedgerEntries.filter(
    (entry) => entry?.entryType === "shopify_order_paid",
  );
  const sellerIds = uniqueValues(paidEntries.map((entry) => entry?.sellerId));

  if (sellerIds.length === 0) {
    return {
      ok: true,
      reason: "shopify_dispute_order_not_settled",
      amount: 0,
    };
  }

  if (sellerIds.length > 1) {
    return {
      ok: false,
      reason: "multi_seller_shopify_dispute_unsupported",
      sellerIds,
    };
  }

  const sellerId = sellerIds[0];
  const paidEntry = paidEntries.find((entry) => entry?.sellerId === sellerId);
  const currencyCode =
    normalizeLowercase(payload?.currency) ||
    normalizeLowercase(paidEntry?.currencyCode) ||
    DEFAULT_ORDER_CURRENCY;
  const requestedDisputeAmount = moneyAmountToMinorUnits(
    payload?.amount,
    currencyCode,
  );
  const orderRiskSummary = summarizeShopifyOrderRiskLedgerEntries(
    orderLedgerEntries,
    sellerId,
  );
  const occurredAt = payload?.initiated_at
    ? new Date(payload.initiated_at)
    : payload?.finalized_on
      ? new Date(payload.finalized_on)
      : new Date();
  const metadataJson = {
    shopDomain,
    shopifyDisputeId,
    shopifyDisputeNumericId: normalizeText(payload?.id),
    shopifyOrderId,
    shopifyOrderNumericId: normalizeText(payload?.order_id),
    disputeType,
    disputeStatus,
    disputeReason,
    networkReasonCode: normalizeText(payload?.network_reason_code),
    evidenceDueBy: normalizeText(payload?.evidence_due_by),
    evidenceSentOn: normalizeText(payload?.evidence_sent_on),
    finalizedOn: normalizeText(payload?.finalized_on),
    disputeEventType: normalizedTopic,
    settlementMode: "shopify_dispute_to_monthly_settlement",
  };

  if (SHOPIFY_DISPUTE_RELEASE_STATUSES.has(disputeStatus)) {
    const existingReleaseEntry = await prismaClient.ledgerEntry.findFirst({
      where: {
        entryType: "dispute_funds_reinstated",
        stripeObjectId: shopifyDisputeId,
      },
    });

    if (existingReleaseEntry) {
      return {
        ok: true,
        duplicate: true,
        ledgerEntry: existingReleaseEntry,
      };
    }

    const settlementAmount = Math.min(
      requestedDisputeAmount || orderRiskSummary.disputeHeldAmount,
      orderRiskSummary.disputeHeldAmount,
    );

    if (settlementAmount <= 0) {
      return {
        ok: true,
        reason: "shopify_dispute_no_held_funds_to_release",
        sellerId,
        amount: 0,
        currencyCode,
      };
    }

    const ledgerEntry = await createLedgerEntry(
      {
        sellerId,
        sellerStripeAccountId: paidEntry?.sellerStripeAccountId || null,
        stripeAccountId: paidEntry?.stripeAccountId || null,
        entryType: "dispute_funds_reinstated",
        stripeObjectId: shopifyDisputeId,
        amount: settlementAmount,
        currencyCode,
        direction: "credit",
        description: "Shopify dispute funds released",
        metadataJson: {
          ...metadataJson,
          heldAmountBeforeRelease: orderRiskSummary.disputeHeldAmount,
        },
        occurredAt,
      },
      { prismaClient },
    );
    const sellerOrderShadowRisk = await updateSellerOrderShadowRiskStatus(
      {
        shopDomain,
        shopifyOrderId,
        sellerId,
        riskStatus: "normal",
      },
      { prismaClient },
    );

    return {
      ok: true,
      duplicate: false,
      ledgerEntry,
      sellerId,
      amount: settlementAmount,
      currencyCode,
      sellerOrderShadowRisk,
    };
  }

  await setSellerReviewStatus(
    {
      sellerId,
      reason: SELLER_REVIEW_REASON_DISPUTE,
      changedBy: `shopify.${normalizedTopic}`,
    },
    { prismaClient },
  );

  const existingHoldEntry = await prismaClient.ledgerEntry.findFirst({
    where: {
      entryType: "dispute_created",
      stripeObjectId: shopifyDisputeId,
    },
  });

  if (existingHoldEntry) {
    return {
      ok: true,
      duplicate: true,
      ledgerEntry: existingHoldEntry,
    };
  }

  const settlementAmount = Math.min(
    requestedDisputeAmount || orderRiskSummary.remainingHoldableAmount,
    orderRiskSummary.remainingHoldableAmount,
  );

  if (settlementAmount <= 0) {
    return {
      ok: true,
      reason: "shopify_dispute_order_already_reversed_or_held",
      sellerId,
      amount: 0,
      currencyCode,
    };
  }

  const ledgerEntry = await createLedgerEntry(
    {
      sellerId,
      sellerStripeAccountId: paidEntry?.sellerStripeAccountId || null,
      stripeAccountId: paidEntry?.stripeAccountId || null,
      entryType: "dispute_created",
      stripeObjectId: shopifyDisputeId,
      amount: settlementAmount,
      currencyCode,
      direction: "debit",
      description: "Shopify dispute opened",
      metadataJson: {
        ...metadataJson,
        remainingHoldableAmountBeforeDispute:
          orderRiskSummary.remainingHoldableAmount,
      },
      occurredAt,
    },
    { prismaClient },
  );
  const sellerOrderShadowRisk = await updateSellerOrderShadowRiskStatus(
    {
      shopDomain,
      shopifyOrderId,
      sellerId,
      riskStatus: "disputed",
    },
    { prismaClient },
  );

  return {
    ok: true,
    duplicate: false,
    ledgerEntry,
    sellerId,
    amount: settlementAmount,
    currencyCode,
    sellerOrderShadowRisk,
  };
}

async function createLedgerEntry(data, { prismaClient = prisma } = {}) {
  return prismaClient.ledgerEntry.create({ data });
}

async function markStripeEventProcessed(
  stripeEventId,
  { prismaClient = prisma } = {},
) {
  return prismaClient.stripeEvent.update({
    where: { stripeEventId },
    data: {
      processingStatus: "processed",
      processedAt: new Date(),
      errorMessage: null,
    },
  });
}

async function markStripeEventFailed(
  stripeEventId,
  message,
  { prismaClient = prisma } = {},
) {
  return prismaClient.stripeEvent.update({
    where: { stripeEventId },
    data: {
      processingStatus: "failed",
      errorMessage: normalizeText(message) || "stripe_event_processing_failed",
    },
  });
}

async function findOrderByChargeId(chargeId, prismaClient = prisma) {
  if (!chargeId) {
    return null;
  }

  return prismaClient.order.findFirst({
    where: { stripeChargeId: chargeId },
  });
}

async function findOrderByPaymentIntentId(
  paymentIntentId,
  prismaClient = prisma,
) {
  if (!paymentIntentId) {
    return null;
  }

  return prismaClient.order.findFirst({
    where: { stripePaymentIntentId: paymentIntentId },
  });
}

async function findPayoutRunByStripeReference(
  { stripePayoutId, payoutRunId },
  prismaClient = prisma,
) {
  if (stripePayoutId) {
    const byPayoutId = await prismaClient.payoutRun.findFirst({
      where: { stripePayoutId },
    });

    if (byPayoutId) {
      return byPayoutId;
    }
  }

  if (payoutRunId) {
    return prismaClient.payoutRun.findUnique({
      where: { id: payoutRunId },
    });
  }

  return null;
}

async function processPaymentIntentSucceeded(
  event,
  { prismaClient = prisma, stripeEventRecordId = null } = {},
) {
  const paymentIntent = event.data?.object;
  const paymentIntentId = normalizeText(paymentIntent?.id);
  const orderId = normalizeText(paymentIntent?.metadata?.orderId);
  const latestChargeId =
    normalizeText(paymentIntent?.latest_charge?.id) ||
    normalizeText(paymentIntent?.latest_charge);
  const stripeAccountId = normalizeText(event.account);
  const occurredAt = new Date((paymentIntent?.created || event.created) * 1000);

  const order = orderId
    ? await prismaClient.order.findUnique({ where: { id: orderId } })
    : await findOrderByPaymentIntentId(paymentIntentId, prismaClient);

  if (!order) {
    return;
  }

  await prismaClient.order.update({
    where: { id: order.id },
    data: {
      status: "paid",
      paidAt: order.paidAt || new Date(),
      stripePaymentIntentId: paymentIntentId || order.stripePaymentIntentId,
      stripeChargeId: latestChargeId || order.stripeChargeId,
      stripeAccountId: stripeAccountId || order.stripeAccountId,
    },
  });

  await createLedgerEntry(
    {
      sellerId: order.sellerId,
      sellerStripeAccountId: order.sellerStripeAccountId,
      orderId: order.id,
      stripeEventId: stripeEventRecordId,
      stripeAccountId: stripeAccountId || order.stripeAccountId,
      entryType: "charge",
      stripeObjectId: latestChargeId || paymentIntentId,
      amount: clampInteger(
        paymentIntent?.amount_received ?? paymentIntent?.amount,
      ),
      currencyCode:
        normalizeLowercase(paymentIntent?.currency) || order.currencyCode,
      direction: "credit",
      description: "Direct charge paid",
      metadataJson: {
        paymentIntentId,
      },
      occurredAt,
    },
    { prismaClient },
  );
}

async function processApplicationFeeCreated(
  event,
  { prismaClient = prisma, stripeEventRecordId = null } = {},
) {
  const applicationFee = event.data?.object;
  const chargeId = normalizeText(applicationFee?.charge);
  const order = await findOrderByChargeId(chargeId, prismaClient);
  const occurredAt = new Date(
    (applicationFee?.created || event.created) * 1000,
  );

  await createLedgerEntry(
    {
      sellerId: order?.sellerId || null,
      sellerStripeAccountId: order?.sellerStripeAccountId || null,
      orderId: order?.id || null,
      stripeEventId: stripeEventRecordId,
      stripeAccountId:
        normalizeText(event.account) || order?.stripeAccountId || null,
      entryType: "application_fee",
      stripeObjectId: normalizeText(applicationFee?.id),
      amount: clampInteger(applicationFee?.amount),
      currencyCode:
        normalizeLowercase(applicationFee?.currency) || DEFAULT_ORDER_CURRENCY,
      direction: "credit",
      description: "Application fee created",
      metadataJson: {
        chargeId,
      },
      occurredAt,
    },
    { prismaClient },
  );
}

async function processApplicationFeeRefunded(
  event,
  { prismaClient = prisma, stripeEventRecordId = null } = {},
) {
  const object = event.data?.object;
  const chargeId = normalizeText(object?.charge);
  const order = await findOrderByChargeId(chargeId, prismaClient);
  const occurredAt = new Date((object?.created || event.created) * 1000);

  await createLedgerEntry(
    {
      sellerId: order?.sellerId || null,
      sellerStripeAccountId: order?.sellerStripeAccountId || null,
      orderId: order?.id || null,
      stripeEventId: stripeEventRecordId,
      stripeAccountId:
        normalizeText(event.account) || order?.stripeAccountId || null,
      entryType: "application_fee_refund",
      stripeObjectId: normalizeText(object?.id),
      amount: clampInteger(object?.amount_refunded ?? object?.amount),
      currencyCode:
        normalizeLowercase(object?.currency) || DEFAULT_ORDER_CURRENCY,
      direction: "debit",
      description: "Application fee refunded",
      metadataJson: {
        chargeId,
        feeId: normalizeText(object?.fee),
      },
      occurredAt,
    },
    { prismaClient },
  );
}

async function processChargeRefunded(
  event,
  { prismaClient = prisma, stripeEventRecordId = null } = {},
) {
  const charge = event.data?.object;
  const chargeId = normalizeText(charge?.id);
  const order = await findOrderByChargeId(chargeId, prismaClient);
  const occurredAt = new Date((charge?.created || event.created) * 1000);

  if (order) {
    await prismaClient.order.update({
      where: { id: order.id },
      data: {
        status: "refunded",
      },
    });
  }

  await createLedgerEntry(
    {
      sellerId: order?.sellerId || null,
      sellerStripeAccountId: order?.sellerStripeAccountId || null,
      orderId: order?.id || null,
      stripeEventId: stripeEventRecordId,
      stripeAccountId:
        normalizeText(event.account) || order?.stripeAccountId || null,
      entryType: "refund",
      stripeObjectId: chargeId,
      amount: clampInteger(charge?.amount_refunded),
      currencyCode:
        normalizeLowercase(charge?.currency) || DEFAULT_ORDER_CURRENCY,
      direction: "debit",
      description: "Charge refunded",
      metadataJson: {
        refunded: Boolean(charge?.refunded),
      },
      occurredAt,
    },
    { prismaClient },
  );
}

async function processRefundEvent(
  event,
  { prismaClient = prisma, stripeEventRecordId = null } = {},
) {
  const refund = event.data?.object;
  const chargeId = normalizeText(refund?.charge);
  const order = await findOrderByChargeId(chargeId, prismaClient);
  const occurredAt = new Date((refund?.created || event.created) * 1000);

  if (order && normalizeText(refund?.status) === "succeeded") {
    await prismaClient.order.update({
      where: { id: order.id },
      data: {
        status: "refunded",
      },
    });
  }

  await createLedgerEntry(
    {
      sellerId: order?.sellerId || null,
      sellerStripeAccountId: order?.sellerStripeAccountId || null,
      orderId: order?.id || null,
      stripeEventId: stripeEventRecordId,
      stripeAccountId:
        normalizeText(event.account) || order?.stripeAccountId || null,
      entryType: "refund",
      stripeObjectId: normalizeText(refund?.id),
      amount: clampInteger(refund?.amount),
      currencyCode:
        normalizeLowercase(refund?.currency) || DEFAULT_ORDER_CURRENCY,
      direction: "debit",
      description: "Refund updated",
      metadataJson: {
        chargeId,
        refundStatus: normalizeText(refund?.status),
      },
      occurredAt,
    },
    { prismaClient },
  );
}

async function processDisputeEvent(
  event,
  type,
  { prismaClient = prisma, stripeEventRecordId = null } = {},
) {
  const dispute = event.data?.object;
  const chargeId = normalizeText(dispute?.charge);
  const order = await findOrderByChargeId(chargeId, prismaClient);
  const occurredAt = new Date((dispute?.created || event.created) * 1000);
  const disputeStatus = normalizeText(dispute?.status);

  if (order) {
    await prismaClient.order.update({
      where: { id: order.id },
      data: {
        status:
          type === "dispute_created"
            ? "disputed"
            : disputeStatus === "won"
              ? "paid"
              : "disputed",
      },
    });

    if (
      type === "dispute_created" ||
      type === "dispute_updated" ||
      type === "dispute_funds_withdrawn" ||
      (type === "dispute_closed" && disputeStatus !== "won")
    ) {
      await setSellerReviewStatus(
        {
          sellerId: order.sellerId,
          reason: SELLER_REVIEW_REASON_DISPUTE,
          changedBy: `stripe.${event.type}`,
        },
        { prismaClient },
      );
    }
  }

  await createLedgerEntry(
    {
      sellerId: order?.sellerId || null,
      sellerStripeAccountId: order?.sellerStripeAccountId || null,
      orderId: order?.id || null,
      stripeEventId: stripeEventRecordId,
      stripeAccountId:
        normalizeText(event.account) || order?.stripeAccountId || null,
      entryType: type,
      stripeObjectId: normalizeText(dispute?.id),
      amount: clampInteger(dispute?.amount),
      currencyCode:
        normalizeLowercase(dispute?.currency) || DEFAULT_ORDER_CURRENCY,
      direction: type === "dispute_funds_reinstated" ? "credit" : "debit",
      description:
        type === "dispute_created"
          ? "Charge dispute opened"
          : type === "dispute_funds_withdrawn"
            ? "Dispute funds withdrawn"
            : type === "dispute_funds_reinstated"
              ? "Dispute funds reinstated"
              : "Charge dispute updated",
      metadataJson: {
        chargeId,
        disputeStatus,
        disputeEventType: event.type,
      },
      occurredAt,
    },
    { prismaClient },
  );
}

async function processPayoutEvent(
  event,
  type,
  { prismaClient = prisma, stripeEventRecordId = null } = {},
) {
  const payout = event.data?.object;
  const payoutRun = await findPayoutRunByStripeReference(
    {
      stripePayoutId: normalizeText(payout?.id),
      payoutRunId: normalizeText(payout?.metadata?.payoutRunId),
    },
    prismaClient,
  );
  const occurredAt = new Date((payout?.created || event.created) * 1000);
  const nextStatus =
    type === "payout_failed"
      ? "failed"
      : payoutRun?.status === "approved"
        ? "executed"
        : payoutRun?.status || "executed";

  if (payoutRun) {
    await prismaClient.payoutRun.update({
      where: { id: payoutRun.id },
      data: {
        stripePayoutId: normalizeText(payout?.id) || payoutRun.stripePayoutId,
        status: nextStatus,
        failureCode:
          type === "payout_failed"
            ? normalizeText(payout?.failure_code)
            : payoutRun.failureCode,
        failureMessage:
          type === "payout_failed"
            ? normalizeText(payout?.failure_message)
            : payoutRun.failureMessage,
      },
    });

    if (type === "payout_failed") {
      await setSellerReviewStatus(
        {
          sellerId: payoutRun.sellerId,
          reason: SELLER_REVIEW_REASON_PAYOUT_FAILED,
          changedBy: "stripe.payout.failed",
        },
        { prismaClient },
      );
    }
  }

  if (type === "payout_paid") {
    await createLedgerEntry(
      {
        sellerId: payoutRun?.sellerId || null,
        sellerStripeAccountId: payoutRun?.sellerStripeAccountId || null,
        stripeEventId: stripeEventRecordId,
        payoutRunId: payoutRun?.id || null,
        stripeAccountId:
          normalizeText(event.account) || payoutRun?.stripeAccountId || null,
        entryType: type,
        stripeObjectId: normalizeText(payout?.id),
        amount: clampInteger(payout?.amount),
        currencyCode:
          normalizeLowercase(payout?.currency) || DEFAULT_ORDER_CURRENCY,
        direction: "debit",
        description: `Payout ${type}`,
        metadataJson: {
          destination: normalizeText(payout?.destination),
          arrivalDate: payout?.arrival_date || null,
        },
        occurredAt,
      },
      { prismaClient },
    );
  }
}

async function processStripeEventByType(
  event,
  { prismaClient = prisma, stripeEventRecordId = null } = {},
) {
  switch (event.type) {
    case "account.updated":
      await processAccountUpdated(event, { prismaClient });
      return;
    case "account.external_account.updated":
      await processExternalAccountUpdated(event, { prismaClient });
      return;
    case "payment_intent.succeeded":
      await processPaymentIntentSucceeded(event, {
        prismaClient,
        stripeEventRecordId,
      });
      return;
    case "application_fee.created":
      await processApplicationFeeCreated(event, {
        prismaClient,
        stripeEventRecordId,
      });
      return;
    case "application_fee.refunded":
    case "application_fee.refund.updated":
      await processApplicationFeeRefunded(event, {
        prismaClient,
        stripeEventRecordId,
      });
      return;
    case "charge.refunded":
      await processChargeRefunded(event, { prismaClient, stripeEventRecordId });
      return;
    case "refund.created":
    case "refund.updated":
      await processRefundEvent(event, { prismaClient, stripeEventRecordId });
      return;
    case "charge.dispute.created":
      await processDisputeEvent(event, "dispute_created", {
        prismaClient,
        stripeEventRecordId,
      });
      return;
    case "charge.dispute.updated":
      await processDisputeEvent(event, "dispute_updated", {
        prismaClient,
        stripeEventRecordId,
      });
      return;
    case "charge.dispute.funds_withdrawn":
      await processDisputeEvent(event, "dispute_funds_withdrawn", {
        prismaClient,
        stripeEventRecordId,
      });
      return;
    case "charge.dispute.funds_reinstated":
      await processDisputeEvent(event, "dispute_funds_reinstated", {
        prismaClient,
        stripeEventRecordId,
      });
      return;
    case "charge.dispute.closed":
      await processDisputeEvent(event, "dispute_closed", {
        prismaClient,
        stripeEventRecordId,
      });
      return;
    case "payout.created":
      await processPayoutEvent(event, "payout_created", {
        prismaClient,
        stripeEventRecordId,
      });
      return;
    case "payout.paid":
      await processPayoutEvent(event, "payout_paid", {
        prismaClient,
        stripeEventRecordId,
      });
      return;
    case "payout.failed":
      await processPayoutEvent(event, "payout_failed", {
        prismaClient,
        stripeEventRecordId,
      });
      return;
    default:
      return;
  }
}

export async function handleStripeWebhook(
  { rawBody, signature },
  { prismaClient = prisma, stripeClient = getStripeClient() } = {},
) {
  const webhookSecrets = getStripeWebhookSecrets();
  let event = null;
  let webhookSecretType = null;
  let signatureError = null;

  for (const webhookSecret of webhookSecrets) {
    try {
      event = stripeClient.webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret.secret,
      );
      webhookSecretType = webhookSecret.type;
      break;
    } catch (error) {
      signatureError = error;
    }
  }

  if (!event) {
    throw signatureError || new Error("STRIPE_WEBHOOK_SIGNATURE_INVALID");
  }

  const existingEvent = await prismaClient.stripeEvent.findUnique({
    where: { stripeEventId: event.id },
  });

  if (existingEvent) {
    return {
      ok: true,
      duplicate: true,
      eventId: event.id,
      webhookSecretType,
    };
  }

  const savedEvent = await prismaClient.stripeEvent.create({
    data: {
      stripeEventId: event.id,
      stripeAccountId: normalizeText(event.account),
      type: event.type,
      livemode: Boolean(event.livemode),
      payloadJson: {
        ...event,
        webhookSecretType,
      },
      processingStatus: "pending",
    },
  });

  try {
    await processStripeEventByType(event, {
      prismaClient,
      stripeEventRecordId: savedEvent.id,
    });
    await markStripeEventProcessed(event.id, { prismaClient });

    return {
      ok: true,
      duplicate: false,
      eventId: event.id,
      webhookSecretType,
    };
  } catch (error) {
    console.error("stripe webhook processing error:", error);
    await markStripeEventFailed(
      event.id,
      error instanceof Error ? error.message : String(error),
      { prismaClient },
    );
    throw error;
  }
}

export async function listPayoutRuns({ prismaClient = prisma } = {}) {
  const runs = await prismaClient.payoutRun.findMany({
    orderBy: [{ createdAt: "desc" }],
    include: {
      seller: {
        include: {
          vendor: true,
        },
      },
    },
  });

  return runs.map((run) => ({
    ...run,
    statusLabel: createPayoutRunStatusLabel(run.status),
    transferMethodLabel: createPayoutTransferMethodLabel(run.transferMethod),
    sellerStoreName: run.seller?.vendor?.storeName || "-",
  }));
}

export async function getPayoutRunDetail(
  payoutRunId,
  { prismaClient = prisma } = {},
) {
  const payoutRun = await prismaClient.payoutRun.findUnique({
    where: { id: payoutRunId },
    include: {
      seller: {
        include: {
          vendor: true,
          stripeAccount: true,
          payoutRecipient: true,
        },
      },
      sellerPayoutRecipient: true,
      ledgerEntries: {
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      },
    },
  });

  if (!payoutRun?.seller?.vendor) {
    return null;
  }

  return {
    ...payoutRun,
    statusLabel: createPayoutRunStatusLabel(payoutRun.status),
    transferMethodLabel: createPayoutTransferMethodLabel(
      payoutRun.transferMethod,
    ),
    sellerStoreName: payoutRun.seller.vendor.storeName,
    stripeAccount: serializeStripeAccountSummary(
      payoutRun.seller.stripeAccount,
    ),
    payoutRecipient: serializePayoutRecipientSummary(
      payoutRun.sellerPayoutRecipient || payoutRun.seller.payoutRecipient,
    ),
  };
}

const SELLER_PAYOUT_LEDGER_ENTRY_SIGNS = {
  shopify_order_paid: 1,
  shopify_order_cancelled: -1,
  charge: 1,
  application_fee: -1,
  application_fee_refund: 1,
  refund: -1,
  dispute_created: -1,
  dispute_funds_reinstated: 1,
  payout_paid: -1,
  sales_credit_offset_captured: -1,
  sales_credit_offset_refund_reversal: 1,
};

const SELLER_SALES_CREDIT_ENTRY_SIGNS = {
  ...SELLER_PAYOUT_LEDGER_ENTRY_SIGNS,
};

const IMMEDIATE_MATURE_SALES_CREDIT_ENTRY_TYPES = new Set([
  "sales_credit_offset_refund_reversal",
  "dispute_funds_reinstated",
]);

const SALES_CREDIT_OFFSET_LOCK_STATUSES = new Set(["authorized"]);
const SALES_CREDIT_PAYOUT_LOCK_STATUSES = new Set([
  "draft",
  "approved",
  "processing",
]);

function getLedgerEntryMetadata(entry) {
  return isPlainObject(entry?.metadataJson) ? entry.metadataJson : {};
}

function getSalesCreditEntryRiskProfile(entry) {
  if (IMMEDIATE_MATURE_SALES_CREDIT_ENTRY_TYPES.has(entry?.entryType)) {
    return {
      riskClass: SALES_CREDIT_PAYMENT_RISK_CLASSES.SALES_CREDIT_RESTORED,
      rateBps:
        SALES_CREDIT_PAYMENT_RISK_RATE_BPS[
          SALES_CREDIT_PAYMENT_RISK_CLASSES.SALES_CREDIT_RESTORED
        ],
    };
  }

  const metadata = getLedgerEntryMetadata(entry);
  const riskClass =
    normalizeText(metadata.salesCreditPaymentRiskClass) ||
    normalizeText(metadata.paymentRiskClass) ||
    SALES_CREDIT_PAYMENT_RISK_CLASSES.UNKNOWN;
  const configuredRate = SALES_CREDIT_PAYMENT_RISK_RATE_BPS[riskClass];
  const rateBps =
    configuredRate == null
      ? clampBasisPoints(metadata.salesCreditPaymentRiskRateBps, 0)
      : configuredRate;

  return {
    riskClass,
    rateBps: clampBasisPoints(rateBps, 0),
  };
}

export function calculateSellerPayoutableLedgerBalance(entries = []) {
  if (!Array.isArray(entries)) {
    return 0;
  }

  return entries.reduce((total, entry) => {
    const sign = SELLER_PAYOUT_LEDGER_ENTRY_SIGNS[entry?.entryType] || 0;

    if (sign === 0) {
      return total;
    }

    return total + sign * clampInteger(entry?.amount);
  }, 0);
}

function isActiveSalesCreditOffsetLock(offset, now) {
  if (!SALES_CREDIT_OFFSET_LOCK_STATUSES.has(offset?.status)) {
    return false;
  }

  if (!offset?.expiresAt) {
    return true;
  }

  return new Date(offset.expiresAt).getTime() > now.getTime();
}

function sumActiveSalesCreditOffsetLocks(offsets = [], now = new Date()) {
  if (!Array.isArray(offsets)) {
    return 0;
  }

  return offsets.reduce((total, offset) => {
    if (!isActiveSalesCreditOffsetLock(offset, now)) {
      return total;
    }

    return total + clampInteger(offset?.amount);
  }, 0);
}

function sumPayoutRunLocks(payoutRuns = []) {
  if (!Array.isArray(payoutRuns)) {
    return 0;
  }

  return payoutRuns.reduce((total, payoutRun) => {
    if (!SALES_CREDIT_PAYOUT_LOCK_STATUSES.has(payoutRun?.status)) {
      return total;
    }

    return total + clampInteger(payoutRun?.amount);
  }, 0);
}

export function calculateSellerSalesCreditAvailability(
  entries = [],
  {
    offsetLocks = [],
    payoutRuns = [],
    now = new Date(),
    holdDays = DEFAULT_SALES_CREDIT_HOLD_DAYS,
    riskBufferBps = DEFAULT_SALES_CREDIT_RISK_BUFFER_BPS,
  } = {},
) {
  const normalizedNow = now instanceof Date ? now : new Date(now);
  const effectiveNow = Number.isNaN(normalizedNow.getTime())
    ? new Date()
    : normalizedNow;
  const maturityCutoff = subtractDays(effectiveNow, clampInteger(holdDays));
  const normalizedRiskBufferBps = clampInteger(riskBufferBps);

  let maturedSalesAmount = 0;
  let grossMaturedSalesAmount = 0;
  let ineligibleMaturedSalesAmount = 0;
  let pendingSalesAmount = 0;
  let deductionAmount = 0;

  for (const entry of Array.isArray(entries) ? entries : []) {
    const sign = SELLER_SALES_CREDIT_ENTRY_SIGNS[entry?.entryType] || 0;
    const amount = clampInteger(entry?.amount);

    if (sign > 0) {
      const occurredAt = entry?.occurredAt
        ? new Date(entry.occurredAt)
        : effectiveNow;
      const forceMature = IMMEDIATE_MATURE_SALES_CREDIT_ENTRY_TYPES.has(
        entry?.entryType,
      );

      if (
        forceMature ||
        (!Number.isNaN(occurredAt.getTime()) && occurredAt <= maturityCutoff)
      ) {
        const riskProfile = getSalesCreditEntryRiskProfile(entry);
        const eligibleAmount = Math.floor(
          (amount * riskProfile.rateBps) / 10000,
        );
        grossMaturedSalesAmount += amount;
        maturedSalesAmount += eligibleAmount;
        ineligibleMaturedSalesAmount += Math.max(0, amount - eligibleAmount);
      } else {
        pendingSalesAmount += amount;
      }
    } else if (sign < 0) {
      deductionAmount += amount;
    }
  }

  const riskBufferAmount = Math.ceil(
    (pendingSalesAmount * normalizedRiskBufferBps) / 10000,
  );
  const pendingRiskReserveAmount = pendingSalesAmount + riskBufferAmount;
  const offsetLockedAmount = sumActiveSalesCreditOffsetLocks(
    offsetLocks,
    effectiveNow,
  );
  const payoutLockedAmount = sumPayoutRunLocks(payoutRuns);
  const totalLedgerBalance = calculateSellerPayoutableLedgerBalance(entries);
  // Only matured, trusted sales become spendable. Pending sales stay outside
  // the source amount instead of reducing already-matured sales.
  const grossAvailableAmount =
    maturedSalesAmount -
    deductionAmount -
    offsetLockedAmount -
    payoutLockedAmount;
  const cappedByLedgerAmount =
    totalLedgerBalance - offsetLockedAmount - payoutLockedAmount;
  const availableAmount = Math.max(
    0,
    Math.min(grossAvailableAmount, cappedByLedgerAmount),
  );

  return {
    availableAmount,
    totalLedgerBalance,
    maturedSalesAmount,
    grossMaturedSalesAmount,
    ineligibleMaturedSalesAmount,
    pendingSalesAmount,
    riskBufferAmount,
    pendingRiskReserveAmount,
    deductionAmount,
    offsetLockedAmount,
    payoutLockedAmount,
    holdDays: clampInteger(holdDays),
    riskBufferBps: normalizedRiskBufferBps,
    maturityCutoff,
  };
}

function createSalesCreditSummaryLabels(summary, currencyCode) {
  const displayCurrency = normalizeUppercase(currencyCode) || "JPY";

  return {
    availableAmountLabel: formatMoney(summary.availableAmount, displayCurrency),
    totalLedgerBalanceLabel: formatMoney(
      summary.totalLedgerBalance,
      displayCurrency,
    ),
    maturedSalesAmountLabel: formatMoney(
      summary.maturedSalesAmount,
      displayCurrency,
    ),
    grossMaturedSalesAmountLabel: formatMoney(
      summary.grossMaturedSalesAmount,
      displayCurrency,
    ),
    ineligibleMaturedSalesAmountLabel: formatMoney(
      summary.ineligibleMaturedSalesAmount,
      displayCurrency,
    ),
    pendingSalesAmountLabel: formatMoney(
      summary.pendingSalesAmount,
      displayCurrency,
    ),
    pendingRiskReserveAmountLabel: formatMoney(
      summary.pendingRiskReserveAmount,
      displayCurrency,
    ),
    offsetLockedAmountLabel: formatMoney(
      summary.offsetLockedAmount,
      displayCurrency,
    ),
    payoutLockedAmountLabel: formatMoney(
      summary.payoutLockedAmount,
      displayCurrency,
    ),
  };
}

export async function getSellerSalesCreditSummary(
  { sellerId, vendorId, currencyCode },
  { prismaClient = prisma, now = new Date() } = {},
) {
  const normalizedCurrency =
    normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;
  let seller = null;

  if (normalizeText(sellerId)) {
    seller = await prismaClient.seller.findUnique({
      where: { id: normalizeText(sellerId) },
      include: {
        payoutRecipient: true,
      },
    });
  } else if (normalizeText(vendorId)) {
    seller = await prismaClient.seller.findUnique({
      where: { vendorId: normalizeText(vendorId) },
      include: {
        payoutRecipient: true,
      },
    });
  }

  if (!seller) {
    const empty = calculateSellerSalesCreditAvailability([], { now });
    return {
      sellerId: null,
      currencyCode: normalizedCurrency,
      ...empty,
      ...createSalesCreditSummaryLabels(empty, normalizedCurrency),
      canUseSalesCredit: false,
      unavailableReason: "seller_not_found",
    };
  }

  const [entries, offsetLocks, payoutRuns] = await Promise.all([
    prismaClient.ledgerEntry.findMany({
      where: {
        sellerId: seller.id,
        currencyCode: normalizedCurrency,
        entryType: {
          in: Object.keys(SELLER_SALES_CREDIT_ENTRY_SIGNS),
        },
      },
      select: {
        entryType: true,
        amount: true,
        occurredAt: true,
        metadataJson: true,
      },
    }),
    prismaClient.salesCreditOffset.findMany({
      where: {
        sellerId: seller.id,
        currencyCode: normalizedCurrency,
        status: {
          in: Array.from(SALES_CREDIT_OFFSET_LOCK_STATUSES),
        },
      },
      select: {
        amount: true,
        status: true,
        expiresAt: true,
      },
    }),
    prismaClient.payoutRun.findMany({
      where: {
        sellerId: seller.id,
        currencyCode: normalizedCurrency,
        status: {
          in: Array.from(SALES_CREDIT_PAYOUT_LOCK_STATUSES),
        },
      },
      select: {
        amount: true,
        status: true,
      },
    }),
  ]);

  const summary = calculateSellerSalesCreditAvailability(entries, {
    offsetLocks,
    payoutRuns,
    now,
  });
  const payoutVerification = getSellerPayoutVerificationState(seller);
  const sellerRestricted = ["restricted", "banned"].includes(seller.status);
  const canUseSalesCredit =
    seller.status === "active" &&
    !sellerRestricted &&
    payoutVerification.complete &&
    summary.availableAmount > 0;
  let unavailableReason = null;

  if (sellerRestricted) {
    unavailableReason = "seller_restricted";
  } else if (seller.status !== "active") {
    unavailableReason = "seller_not_active";
  } else if (!payoutVerification.complete) {
    unavailableReason = "seller_verification_required";
  } else if (summary.availableAmount <= 0) {
    unavailableReason = "no_available_sales_credit";
  }

  return {
    sellerId: seller.id,
    currencyCode: normalizedCurrency,
    ...summary,
    ...createSalesCreditSummaryLabels(summary, normalizedCurrency),
    canUseSalesCredit,
    unavailableReason,
    payoutVerification,
  };
}

export async function authorizeSalesCreditOffset(
  {
    sellerId,
    amount,
    currencyCode,
    checkoutReference = null,
    idempotencyKey = null,
    expiresAt = undefined,
    lockMinutes = DEFAULT_SALES_CREDIT_LOCK_MINUTES,
    metadataJson = null,
  },
  { prismaClient = prisma, now = new Date() } = {},
) {
  const normalizedSellerId = normalizeText(sellerId);
  const normalizedAmount = toPositiveInteger(amount);
  const normalizedCurrency =
    normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;
  const normalizedIdempotencyKey = normalizeText(idempotencyKey);

  if (!normalizedSellerId) {
    return { ok: false, reason: "seller_required" };
  }

  if (normalizedAmount == null) {
    return { ok: false, reason: "invalid_amount" };
  }

  if (normalizedCurrency !== SALES_CREDIT_SUPPORTED_CURRENCY) {
    return {
      ok: false,
      reason: "unsupported_sales_credit_currency",
      currencyCode: normalizedCurrency,
      supportedCurrencyCode: SALES_CREDIT_SUPPORTED_CURRENCY,
    };
  }

  return runInTransaction(prismaClient, async (tx) => {
    if (normalizedIdempotencyKey) {
      const existing = await tx.salesCreditOffset.findUnique({
        where: { idempotencyKey: normalizedIdempotencyKey },
      });

      if (existing) {
        if (existing.status !== "authorized") {
          return {
            ok: false,
            reason: "sales_credit_idempotency_key_used",
            offset: existing,
          };
        }

        const expectation = validateSalesCreditOffsetExpectation(existing, {
          expectedSellerId: normalizedSellerId,
          expectedAmount: normalizedAmount,
          expectedCurrencyCode: normalizedCurrency,
        });

        if (!expectation.ok) {
          return {
            ok: false,
            reason: "sales_credit_idempotency_mismatch",
            mismatchReason: expectation.reason,
            offset: existing,
          };
        }

        return {
          ok: true,
          duplicate: true,
          offset: existing,
        };
      }
    }

    const summary = await getSellerSalesCreditSummary(
      {
        sellerId: normalizedSellerId,
        currencyCode: normalizedCurrency,
      },
      { prismaClient: tx, now },
    );

    if (!summary.canUseSalesCredit) {
      return {
        ok: false,
        reason: summary.unavailableReason || "sales_credit_unavailable",
        summary,
      };
    }

    if (summary.availableAmount < normalizedAmount) {
      return {
        ok: false,
        reason: "insufficient_sales_credit",
        availableAmount: summary.availableAmount,
        requestedAmount: normalizedAmount,
        summary,
      };
    }

    const offset = await tx.salesCreditOffset.create({
      data: {
        sellerId: normalizedSellerId,
        amount: normalizedAmount,
        currencyCode: normalizedCurrency,
        status: "authorized",
        checkoutReference: normalizeText(checkoutReference),
        idempotencyKey: normalizedIdempotencyKey,
        expiresAt:
          expiresAt === null
            ? null
            : expiresAt
              ? new Date(expiresAt)
              : addMinutes(now, clampInteger(lockMinutes)),
        metadataJson,
      },
    });

    return {
      ok: true,
      duplicate: false,
      offset,
      summary,
    };
  });
}

export async function captureSalesCreditOffset(
  {
    offsetId,
    orderId = null,
    metadataJson = null,
    expectedSellerId = null,
    expectedAmount = null,
    expectedCurrencyCode = null,
    expectedTargetSellerId = null,
  },
  { prismaClient = prisma, now = new Date() } = {},
) {
  const normalizedOffsetId = normalizeText(offsetId);

  if (!normalizedOffsetId) {
    return { ok: false, reason: "offset_required" };
  }

  return runInTransaction(prismaClient, async (tx) => {
    const offset = await tx.salesCreditOffset.findUnique({
      where: { id: normalizedOffsetId },
    });

    if (!offset) {
      return { ok: false, reason: "offset_not_found" };
    }

    const expectation = validateSalesCreditOffsetExpectation(offset, {
      expectedSellerId,
      expectedAmount,
      expectedCurrencyCode,
      expectedTargetSellerId,
    });

    if (!expectation.ok) {
      return {
        ok: false,
        reason: expectation.reason,
        offset,
      };
    }

    if (offset.status === "captured") {
      return { ok: true, duplicate: true, offset };
    }

    if (offset.status !== "authorized") {
      return { ok: false, reason: "offset_not_capturable", offset };
    }

    if (offset.expiresAt && new Date(offset.expiresAt) <= now) {
      const expired = await tx.salesCreditOffset.update({
        where: { id: offset.id },
        data: {
          status: "expired",
          releasedAt: now,
          releaseReason: "expired",
        },
      });

      return { ok: false, reason: "offset_expired", offset: expired };
    }

    const updated = await tx.salesCreditOffset.update({
      where: { id: offset.id },
      data: {
        status: "captured",
        capturedAt: now,
      },
    });

    const existingLedgerEntry = await tx.ledgerEntry.findFirst({
      where: {
        entryType: "sales_credit_offset_captured",
        stripeObjectId: offset.id,
      },
    });

    const ledgerEntry =
      existingLedgerEntry ||
      (await createLedgerEntry(
        {
          sellerId: offset.sellerId,
          orderId: normalizeText(orderId),
          entryType: "sales_credit_offset_captured",
          stripeObjectId: offset.id,
          amount: offset.amount,
          currencyCode: offset.currencyCode,
          direction: "debit",
          description: "Sales credit applied to purchase",
          metadataJson: {
            salesCreditOffsetId: offset.id,
            checkoutReference: offset.checkoutReference,
            ...getSalesCreditOffsetMetadata(offset),
            ...(isPlainObject(metadataJson) ? metadataJson : {}),
          },
          occurredAt: now,
        },
        { prismaClient: tx },
      ));

    return {
      ok: true,
      duplicate: Boolean(existingLedgerEntry),
      offset: updated,
      ledgerEntry,
    };
  });
}

export async function markSalesCreditOffsetCheckoutCreated(
  {
    offsetId,
    draftOrderId = null,
    invoiceUrl = null,
    metadataJson = null,
  },
  { prismaClient = prisma, now = new Date() } = {},
) {
  const normalizedOffsetId = normalizeText(offsetId);

  if (!normalizedOffsetId) {
    return { ok: false, reason: "offset_required" };
  }

  const offset = await prismaClient.salesCreditOffset.findUnique({
    where: { id: normalizedOffsetId },
  });

  if (!offset) {
    return { ok: false, reason: "offset_not_found" };
  }

  if (offset.status !== "authorized") {
    return {
      ok: true,
      duplicate: true,
      offset,
    };
  }

  const existingMetadata = getSalesCreditOffsetMetadata(offset);
  const updated = await prismaClient.salesCreditOffset.update({
    where: { id: offset.id },
    data: {
      metadataJson: {
        ...existingMetadata,
        ...(isPlainObject(metadataJson) ? metadataJson : {}),
        draftOrderId:
          normalizeText(draftOrderId) || existingMetadata.draftOrderId || null,
        invoiceUrl:
          normalizeText(invoiceUrl) || existingMetadata.invoiceUrl || null,
        checkoutCreatedAt: now.toISOString(),
      },
    },
  });

  return {
    ok: true,
    duplicate: false,
    offset: updated,
  };
}

export async function releaseSalesCreditOffset(
  { offsetId, reason = "released" },
  { prismaClient = prisma, now = new Date() } = {},
) {
  const normalizedOffsetId = normalizeText(offsetId);

  if (!normalizedOffsetId) {
    return { ok: false, reason: "offset_required" };
  }

  const offset = await prismaClient.salesCreditOffset.findUnique({
    where: { id: normalizedOffsetId },
  });

  if (!offset) {
    return { ok: false, reason: "offset_not_found" };
  }

  if (offset.status !== "authorized") {
    return {
      ok: true,
      duplicate: true,
      offset,
    };
  }

  const updated = await prismaClient.salesCreditOffset.update({
    where: { id: offset.id },
    data: {
      status: "released",
      releasedAt: now,
      releaseReason: normalizeText(reason) || "released",
    },
  });

  return {
    ok: true,
    duplicate: false,
    offset: updated,
  };
}

export async function reverseSalesCreditOffsetForRefund(
  { offsetId, orderId = null, metadataJson = null },
  { prismaClient = prisma, now = new Date() } = {},
) {
  const normalizedOffsetId = normalizeText(offsetId);

  if (!normalizedOffsetId) {
    return { ok: false, reason: "offset_required" };
  }

  return runInTransaction(prismaClient, async (tx) => {
    const offset = await tx.salesCreditOffset.findUnique({
      where: { id: normalizedOffsetId },
    });

    if (!offset) {
      return { ok: false, reason: "offset_not_found" };
    }

    if (offset.status === "refunded") {
      const existingLedgerEntry = await tx.ledgerEntry.findFirst({
        where: {
          entryType: "sales_credit_offset_refund_reversal",
          stripeObjectId: offset.id,
        },
      });

      return {
        ok: true,
        duplicate: true,
        offset,
        ledgerEntry: existingLedgerEntry || null,
      };
    }

    if (offset.status !== "captured") {
      return { ok: false, reason: "offset_not_refundable", offset };
    }

    const updated = await tx.salesCreditOffset.update({
      where: { id: offset.id },
      data: {
        status: "refunded",
        releasedAt: now,
        releaseReason: "refund_reversal",
      },
    });

    const existingLedgerEntry = await tx.ledgerEntry.findFirst({
      where: {
        entryType: "sales_credit_offset_refund_reversal",
        stripeObjectId: offset.id,
      },
    });

    const ledgerEntry =
      existingLedgerEntry ||
      (await createLedgerEntry(
        {
          sellerId: offset.sellerId,
          orderId: normalizeText(orderId),
          entryType: "sales_credit_offset_refund_reversal",
          stripeObjectId: offset.id,
          amount: offset.amount,
          currencyCode: offset.currencyCode,
          direction: "credit",
          description: "Sales credit returned after refund",
          metadataJson: {
            salesCreditOffsetId: offset.id,
            checkoutReference: offset.checkoutReference,
            ...getSalesCreditOffsetMetadata(offset),
            ...(isPlainObject(metadataJson) ? metadataJson : {}),
          },
          occurredAt: now,
        },
        { prismaClient: tx },
      ));

    return {
      ok: true,
      duplicate: Boolean(existingLedgerEntry),
      offset: updated,
      ledgerEntry,
    };
  });
}

export async function getSellerPayoutableLedgerBalance(
  { sellerId, currencyCode },
  { prismaClient = prisma } = {},
) {
  const normalizedSellerId = normalizeText(sellerId);
  const normalizedCurrency =
    normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;

  if (!normalizedSellerId) {
    return 0;
  }

  const entries = await prismaClient.ledgerEntry.findMany({
    where: {
      sellerId: normalizedSellerId,
      currencyCode: normalizedCurrency,
      entryType: {
        in: Object.keys(SELLER_PAYOUT_LEDGER_ENTRY_SIGNS),
      },
    },
    select: {
      entryType: true,
      amount: true,
    },
  });

  return calculateSellerPayoutableLedgerBalance(entries);
}

async function assertPayoutEligibleSeller(
  sellerId,
  { prismaClient = prisma } = {},
) {
  const seller = await prismaClient.seller.findUnique({
    where: { id: sellerId },
    include: {
      vendor: true,
      stripeAccount: true,
      payoutRecipient: true,
    },
  });

  if (!seller?.vendor) {
    return {
      ok: false,
      reason: "seller_not_found",
    };
  }

  if (["restricted", "banned"].includes(seller.status)) {
    return {
      ok: false,
      reason: "seller_payout_restricted",
    };
  }

  if (seller.status !== "active") {
    return {
      ok: false,
      reason: "seller_not_active",
    };
  }

  const payoutVerification = getSellerPayoutVerificationState(seller);

  if (!payoutVerification.complete) {
    return {
      ok: false,
      reason: "seller_verification_required",
      verification: payoutVerification,
    };
  }

  return {
    ok: true,
    seller,
    verification: payoutVerification,
  };
}

export async function createPayoutRun(
  { sellerId, amount, currencyCode },
  { prismaClient = prisma } = {},
) {
  const eligibility = await assertPayoutEligibleSeller(sellerId, {
    prismaClient,
  });

  if (!eligibility.ok) {
    return eligibility;
  }

  const normalizedAmount = toPositiveInteger(amount);
  const normalizedCurrency =
    normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;
  const payoutProvider = getConfiguredSellerPayoutProvider();

  if (normalizedAmount == null) {
    return {
      ok: false,
      reason: "invalid_amount",
    };
  }

  const availableLedgerBalance = await getSellerPayoutableLedgerBalance(
    {
      sellerId: eligibility.seller.id,
      currencyCode: normalizedCurrency,
    },
    { prismaClient },
  );

  if (availableLedgerBalance < normalizedAmount) {
    return {
      ok: false,
      reason: "insufficient_ledger_balance",
      availableLedgerBalance,
      requestedAmount: normalizedAmount,
      currencyCode: normalizedCurrency,
    };
  }

  const payoutRecipient =
    payoutProvider === "wise" ? eligibility.seller.payoutRecipient : null;

  if (
    payoutProvider === "wise" &&
    (!payoutRecipient ||
      payoutRecipient.provider !== "wise" ||
      payoutRecipient.status !== "active" ||
      !payoutRecipient.wiseRecipientId)
  ) {
    return {
      ok: false,
      reason: "wise_recipient_missing",
    };
  }

  const payoutRun = await prismaClient.payoutRun.create({
    data: {
      sellerId: eligibility.seller.id,
      sellerStripeAccountId: eligibility.seller.stripeAccount?.id || null,
      sellerPayoutRecipientId: payoutRecipient?.id || null,
      stripeAccountId:
        eligibility.seller.stripeAccount?.stripeAccountId || null,
      amount: normalizedAmount,
      currencyCode: normalizedCurrency,
      status: "draft",
      transferMethod:
        payoutProvider === "wise" ? "wise_api" : "manual_bank_transfer",
    },
  });

  return {
    ok: true,
    payoutRun,
    availableLedgerBalance,
  };
}

export async function approvePayoutRun(
  { payoutRunId, approvedBy = "admin" },
  { prismaClient = prisma } = {},
) {
  const payoutRun = await prismaClient.payoutRun.findUnique({
    where: { id: payoutRunId },
    include: {
      seller: {
        include: {
          payoutRecipient: true,
        },
      },
      sellerPayoutRecipient: true,
    },
  });

  if (!payoutRun?.seller) {
    return {
      ok: false,
      reason: "payout_run_not_found",
    };
  }

  if (payoutRun.status !== "draft") {
    return {
      ok: false,
      reason: "payout_run_not_approvable",
    };
  }

  if (["restricted", "banned"].includes(payoutRun.seller.status)) {
    return {
      ok: false,
      reason: "seller_payout_restricted",
    };
  }

  const payoutVerification = getSellerPayoutVerificationState({
    ...payoutRun.seller,
    payoutRecipient:
      payoutRun.sellerPayoutRecipient || payoutRun.seller.payoutRecipient,
  });

  if (!payoutVerification.complete) {
    return {
      ok: false,
      reason: "seller_verification_required",
      verification: payoutVerification,
    };
  }

  const updated = await prismaClient.payoutRun.update({
    where: { id: payoutRunId },
    data: {
      status: "approved",
      approvedAt: new Date(),
      approvedBy,
    },
  });

  return {
    ok: true,
    payoutRun: updated,
  };
}

export async function markPayoutRunManuallyPaid(
  {
    payoutRunId,
    executedBy = "admin",
    externalTransferId = null,
    transferMemo = null,
  },
  { prismaClient = prisma } = {},
) {
  const payoutRun = await prismaClient.payoutRun.findUnique({
    where: { id: payoutRunId },
    include: {
      seller: {
        include: {
          stripeAccount: true,
          payoutRecipient: true,
        },
      },
      sellerPayoutRecipient: true,
    },
  });

  if (!payoutRun?.seller) {
    return {
      ok: false,
      reason: "payout_run_not_found",
    };
  }

  if (payoutRun.status !== "approved") {
    return {
      ok: false,
      reason: "payout_run_not_executable",
    };
  }

  if (["restricted", "banned"].includes(payoutRun.seller.status)) {
    return {
      ok: false,
      reason: "seller_payout_restricted",
    };
  }

  const payoutVerification = getSellerPayoutVerificationState({
    ...payoutRun.seller,
    payoutRecipient:
      payoutRun.sellerPayoutRecipient || payoutRun.seller.payoutRecipient,
  });

  if (!payoutVerification.complete) {
    return {
      ok: false,
      reason: "seller_verification_required",
      verification: payoutVerification,
    };
  }

  const now = new Date();
  const normalizedExternalTransferId = normalizeText(externalTransferId);
  const normalizedTransferMemo = normalizeText(transferMemo);

  return prismaClient.$transaction(async (tx) => {
    const updated = await tx.payoutRun.update({
      where: { id: payoutRun.id },
      data: {
        status: "executed",
        executedAt: now,
        executedBy,
        transferMethod: "manual_bank_transfer",
        externalTransferId: normalizedExternalTransferId,
        transferMemo: normalizedTransferMemo,
        failureCode: null,
        failureMessage: null,
      },
    });

    await createLedgerEntry(
      {
        sellerId: payoutRun.sellerId,
        sellerStripeAccountId: payoutRun.sellerStripeAccountId,
        payoutRunId: payoutRun.id,
        stripeAccountId: payoutRun.stripeAccountId,
        entryType: "payout_paid",
        stripeObjectId: normalizedExternalTransferId || payoutRun.id,
        amount: payoutRun.amount,
        currencyCode: payoutRun.currencyCode,
        direction: "debit",
        description: "Manual seller payout paid",
        metadataJson: {
          transferMethod: "manual_bank_transfer",
          externalTransferId: normalizedExternalTransferId,
          transferMemo: normalizedTransferMemo,
          executedBy,
        },
        occurredAt: now,
      },
      { prismaClient: tx },
    );

    return {
      ok: true,
      payoutRun: updated,
      externalTransferId: normalizedExternalTransferId,
    };
  });
}

const WISE_TRANSFER_COMPLETED_STATUSES = new Set(["outgoing_payment_sent"]);
const WISE_TRANSFER_FAILED_STATUSES = new Set([
  "bounced_back",
  "cancelled",
  "charged_back",
  "funds_refunded",
]);

function toNullableNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getWiseQuoteFeeAmount(quote) {
  const directFee =
    toNullableNumber(quote?.fee) ||
    toNullableNumber(quote?.feeAmount) ||
    toNullableNumber(quote?.totalFee);

  if (directFee != null) {
    return directFee;
  }

  const paymentOptions = Array.isArray(quote?.paymentOptions)
    ? quote.paymentOptions
    : [];
  const balanceOption = paymentOptions.find(
    (option) => normalizeLowercase(option?.payIn) === "balance",
  );
  return (
    toNullableNumber(balanceOption?.fee?.total) ||
    toNullableNumber(paymentOptions[0]?.fee?.total)
  );
}

function getWiseTransferStatus(...payloads) {
  for (const payload of payloads) {
    const status =
      normalizeLowercase(payload?.status) ||
      normalizeLowercase(payload?.current_state) ||
      normalizeLowercase(payload?.data?.current_state);

    if (status) {
      return status;
    }
  }

  return null;
}

function mergeWisePayload(existingPayload, patch) {
  return {
    ...(isPlainObject(existingPayload) ? existingPayload : {}),
    ...patch,
  };
}

async function markWisePayoutRunCompleted(
  { payoutRun, transferStatus, transferPayload = null, executedBy = "admin" },
  { prismaClient = prisma } = {},
) {
  const now = new Date();

  return prismaClient.$transaction(async (tx) => {
    const updated = await tx.payoutRun.update({
      where: { id: payoutRun.id },
      data: {
        status: "executed",
        executedAt: payoutRun.executedAt || now,
        executedBy: payoutRun.executedBy || executedBy,
        wiseTransferStatus: transferStatus,
        wisePayloadJson: mergeWisePayload(payoutRun.wisePayloadJson, {
          finalTransfer: transferPayload,
        }),
        failureCode: null,
        failureMessage: null,
        wiseFailureCode: null,
        wiseFailureMessage: null,
      },
    });

    const existingPaidEntry = await tx.ledgerEntry.findFirst({
      where: {
        payoutRunId: payoutRun.id,
        entryType: "payout_paid",
      },
    });

    if (!existingPaidEntry) {
      await createLedgerEntry(
        {
          sellerId: payoutRun.sellerId,
          sellerStripeAccountId: payoutRun.sellerStripeAccountId,
          payoutRunId: payoutRun.id,
          stripeAccountId: payoutRun.stripeAccountId,
          entryType: "payout_paid",
          stripeObjectId:
            normalizeWiseTransferId(payoutRun.wiseTransferId) || payoutRun.id,
          amount: payoutRun.amount,
          currencyCode: payoutRun.currencyCode,
          direction: "debit",
          description: "Wise seller settlement paid",
          metadataJson: {
            transferMethod: "wise_api",
            wiseTransferId: normalizeWiseTransferId(payoutRun.wiseTransferId),
            wiseTransferStatus: transferStatus,
            executedBy,
          },
          occurredAt: now,
        },
        { prismaClient: tx },
      );
    }

    return {
      ok: true,
      payoutRun: updated,
      ledgerEntryCreated: !existingPaidEntry,
    };
  });
}

async function markWisePayoutRunFailed(
  { payoutRun, transferStatus, failureCode = null, failureMessage = null },
  { prismaClient = prisma } = {},
) {
  const updated = await prismaClient.payoutRun.update({
    where: { id: payoutRun.id },
    data: {
      status: "failed",
      wiseTransferStatus: transferStatus,
      wiseFailureCode: normalizeText(failureCode) || transferStatus,
      wiseFailureMessage: normalizeText(failureMessage),
      failureCode: normalizeText(failureCode) || transferStatus,
      failureMessage: normalizeText(failureMessage),
    },
  });

  await setSellerReviewStatus(
    {
      sellerId: payoutRun.sellerId,
      reason: SELLER_REVIEW_REASON_PAYOUT_FAILED,
      changedBy: "wise.transfer.failed",
    },
    { prismaClient },
  );

  return {
    ok: false,
    reason: "wise_transfer_failed",
    payoutRun: updated,
  };
}

async function applyWiseTransferStatus(
  { payoutRun, transferStatus, transferPayload = null, executedBy = "admin" },
  { prismaClient = prisma } = {},
) {
  if (WISE_TRANSFER_COMPLETED_STATUSES.has(transferStatus)) {
    return markWisePayoutRunCompleted(
      {
        payoutRun,
        transferStatus,
        transferPayload,
        executedBy,
      },
      { prismaClient },
    );
  }

  if (WISE_TRANSFER_FAILED_STATUSES.has(transferStatus)) {
    return markWisePayoutRunFailed(
      {
        payoutRun,
        transferStatus,
        failureCode: transferStatus,
        failureMessage: `Wise transfer ended with status ${transferStatus}.`,
      },
      { prismaClient },
    );
  }

  const updated = await prismaClient.payoutRun.update({
    where: { id: payoutRun.id },
    data: {
      status: "processing",
      wiseTransferStatus: transferStatus,
      wisePayloadJson: mergeWisePayload(payoutRun.wisePayloadJson, {
        latestTransfer: transferPayload,
      }),
    },
  });

  return {
    ok: true,
    pending: true,
    payoutRun: updated,
  };
}

export async function executeWisePayoutRun(
  { payoutRunId, executedBy = "admin" },
  { prismaClient = prisma, fetchImpl = fetch, env = process.env } = {},
) {
  if (getConfiguredSellerPayoutProvider(env) !== "wise") {
    return {
      ok: false,
      reason: "wise_payout_not_enabled",
    };
  }

  const config = getWisePayoutConfig(env);

  if (config.missing.length > 0) {
    return {
      ok: false,
      reason: "wise_env_missing",
      missing: config.missing,
    };
  }

  if (!config.isSandbox && !config.liveTransfersEnabled) {
    return {
      ok: false,
      reason: "wise_live_transfers_disabled",
    };
  }

  const payoutRun = await prismaClient.payoutRun.findUnique({
    where: { id: payoutRunId },
    include: {
      seller: {
        include: {
          payoutRecipient: true,
        },
      },
      sellerPayoutRecipient: true,
    },
  });

  if (!payoutRun?.seller) {
    return {
      ok: false,
      reason: "payout_run_not_found",
    };
  }

  if (payoutRun.status !== "approved") {
    return {
      ok: false,
      reason: "payout_run_not_executable",
    };
  }

  if (["restricted", "banned"].includes(payoutRun.seller.status)) {
    return {
      ok: false,
      reason: "seller_payout_restricted",
    };
  }

  const payoutVerification = getSellerPayoutVerificationState({
    ...payoutRun.seller,
    payoutRecipient:
      payoutRun.sellerPayoutRecipient || payoutRun.seller.payoutRecipient,
  });

  if (!payoutVerification.complete) {
    return {
      ok: false,
      reason: "seller_verification_required",
      verification: payoutVerification,
    };
  }

  const payoutRecipient =
    payoutRun.sellerPayoutRecipient || payoutRun.seller.payoutRecipient;

  if (
    !payoutRecipient ||
    payoutRecipient.provider !== "wise" ||
    payoutRecipient.status !== "active" ||
    !payoutRecipient.wiseRecipientId
  ) {
    return {
      ok: false,
      reason: "wise_recipient_missing",
    };
  }

  const availableLedgerBalance = await getSellerPayoutableLedgerBalance(
    {
      sellerId: payoutRun.sellerId,
      currencyCode: payoutRun.currencyCode,
    },
    { prismaClient },
  );

  if (availableLedgerBalance < payoutRun.amount) {
    return {
      ok: false,
      reason: "insufficient_ledger_balance",
      availableLedgerBalance,
      requestedAmount: payoutRun.amount,
      currencyCode: payoutRun.currencyCode,
    };
  }

  const customerTransactionId =
    payoutRun.wiseCustomerTransactionId || randomUUID();
  const sourceCurrency =
    normalizeUppercase(config.sourceCurrency) ||
    DEFAULT_ORDER_CURRENCY.toUpperCase();
  const targetCurrency =
    normalizeUppercase(payoutRecipient.currencyCode) ||
    normalizeUppercase(payoutRun.currencyCode) ||
    sourceCurrency;
  const sourceAmount = decimalAmountFromMinorUnits(
    payoutRun.amount,
    sourceCurrency,
  );

  const preparedPayoutRun = await prismaClient.payoutRun.update({
    where: { id: payoutRun.id },
    data: {
      transferMethod: "wise_api",
      sellerPayoutRecipientId: payoutRecipient.id,
      wiseCustomerTransactionId: customerTransactionId,
      wiseSourceCurrency: sourceCurrency,
      wiseTargetCurrency: targetCurrency,
      wiseSourceAmount: sourceAmount,
      failureCode: null,
      failureMessage: null,
      wiseFailureCode: null,
      wiseFailureMessage: null,
    },
  });

  try {
    const quote = await createWiseQuote(
      {
        payoutRun: preparedPayoutRun,
        recipient: payoutRecipient,
        config,
      },
      { fetchImpl },
    );
    const quoteId = normalizeText(quote?.id);

    if (!quoteId) {
      throw new Error("Wise quote response did not include an id.");
    }

    await prismaClient.payoutRun.update({
      where: { id: payoutRun.id },
      data: {
        wiseQuoteId: quoteId,
        wiseSourceAmount: toNullableNumber(quote.sourceAmount) || sourceAmount,
        wiseTargetAmount: toNullableNumber(quote.targetAmount),
        wiseFeeAmount: getWiseQuoteFeeAmount(quote),
        wiseRate: toNullableNumber(quote.rate),
        wisePayloadJson: mergeWisePayload(preparedPayoutRun.wisePayloadJson, {
          quote,
        }),
      },
    });

    const transfer = await createWiseTransfer(
      {
        payoutRun: preparedPayoutRun,
        recipient: payoutRecipient,
        quote,
        customerTransactionId,
        config,
      },
      { fetchImpl },
    );
    const transferId = normalizeWiseTransferId(transfer?.id);

    if (!transferId) {
      throw new Error("Wise transfer response did not include an id.");
    }

    const funding = await fundWiseTransfer(
      { transferId, config },
      { fetchImpl },
    );
    const transferStatus =
      getWiseTransferStatus(funding, transfer) || "processing";

    const processingPayoutRun = await prismaClient.payoutRun.update({
      where: { id: payoutRun.id },
      data: {
        status: "processing",
        executedAt: new Date(),
        executedBy,
        transferMethod: "wise_api",
        wiseTransferId: transferId,
        wiseTransferStatus: transferStatus,
        externalTransferId: transferId,
        wisePayloadJson: mergeWisePayload(preparedPayoutRun.wisePayloadJson, {
          quote,
          transfer,
          funding,
        }),
      },
    });

    return applyWiseTransferStatus(
      {
        payoutRun: processingPayoutRun,
        transferStatus,
        transferPayload: transfer,
        executedBy,
      },
      { prismaClient },
    );
  } catch (error) {
    const code = normalizeText(error?.code) || "wise_api_error";
    const message = error instanceof Error ? error.message : String(error);
    const updated = await prismaClient.payoutRun.update({
      where: { id: payoutRun.id },
      data: {
        status: "failed",
        failureCode: code,
        failureMessage: normalizeText(message),
        wiseFailureCode: code,
        wiseFailureMessage: normalizeText(message),
      },
    });

    return {
      ok: false,
      reason: "wise_payout_execution_failed",
      payoutRun: updated,
    };
  }
}

export async function syncWisePayoutRunStatus(
  { payoutRunId, executedBy = "admin" },
  { prismaClient = prisma, fetchImpl = fetch, env = process.env } = {},
) {
  const config = getWisePayoutConfig(env);

  if (config.missing.length > 0) {
    return {
      ok: false,
      reason: "wise_env_missing",
      missing: config.missing,
    };
  }

  const payoutRun = await prismaClient.payoutRun.findUnique({
    where: { id: payoutRunId },
  });

  if (!payoutRun?.wiseTransferId) {
    return {
      ok: false,
      reason: "wise_transfer_missing",
    };
  }

  const transfer = await retrieveWiseTransfer(
    {
      transferId: payoutRun.wiseTransferId,
      config,
    },
    { fetchImpl },
  );
  const transferStatus = getWiseTransferStatus(transfer) || "processing";

  return applyWiseTransferStatus(
    {
      payoutRun,
      transferStatus,
      transferPayload: transfer,
      executedBy,
    },
    { prismaClient },
  );
}

async function getConnectedAccountAvailableBalanceAmount({
  stripeClient,
  stripeAccountId,
  currencyCode,
}) {
  if (!stripeClient?.balance?.retrieve || !stripeAccountId) {
    return null;
  }

  const balance = await stripeClient.balance.retrieve(
    {},
    {
      stripeAccount: stripeAccountId,
    },
  );
  const normalizedCurrency =
    normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;
  const availableRows = Array.isArray(balance?.available)
    ? balance.available
    : [];

  return availableRows
    .filter((row) => normalizeLowercase(row?.currency) === normalizedCurrency)
    .reduce((total, row) => total + clampInteger(row?.amount), 0);
}

export async function executePayoutRun(
  { payoutRunId, executedBy = "admin" },
  {
    prismaClient = prisma,
    stripeClient,
    createPayout = createConnectedAccountPayout,
  } = {},
) {
  const payoutRun = await prismaClient.payoutRun.findUnique({
    where: { id: payoutRunId },
    include: {
      seller: {
        include: {
          stripeAccount: true,
        },
      },
    },
  });

  if (!payoutRun?.seller?.stripeAccount) {
    return {
      ok: false,
      reason: "payout_run_not_found",
    };
  }

  if (payoutRun.status !== "approved") {
    return {
      ok: false,
      reason: "payout_run_not_executable",
    };
  }

  if (["restricted", "banned"].includes(payoutRun.seller.status)) {
    return {
      ok: false,
      reason: "seller_payout_restricted",
    };
  }

  if (!payoutRun.seller.stripeAccount.payoutsEnabled) {
    return {
      ok: false,
      reason: "payouts_not_enabled",
    };
  }

  try {
    const balanceStripeClient =
      stripeClient ||
      (createPayout === createConnectedAccountPayout
        ? getStripeClient()
        : null);
    const availableBalance = await getConnectedAccountAvailableBalanceAmount({
      stripeClient: balanceStripeClient,
      stripeAccountId: payoutRun.stripeAccountId,
      currencyCode: payoutRun.currencyCode,
    });

    if (availableBalance != null && availableBalance < payoutRun.amount) {
      return {
        ok: false,
        reason: "insufficient_stripe_available_balance",
        availableBalance,
        payoutRun,
      };
    }

    const payout = await createPayout({
      stripeAccountId: payoutRun.stripeAccountId,
      amount: payoutRun.amount,
      currencyCode: payoutRun.currencyCode,
      payoutRunId: payoutRun.id,
      sellerId: payoutRun.sellerId,
    });

    const updated = await prismaClient.payoutRun.update({
      where: { id: payoutRun.id },
      data: {
        status: "executed",
        executedAt: new Date(),
        executedBy,
        stripePayoutId: payout.id,
      },
    });

    return {
      ok: true,
      payoutRun: updated,
      stripePayoutId: payout.id,
    };
  } catch (error) {
    const code = normalizeText(error?.code);
    const message = error instanceof Error ? error.message : String(error);

    const updated = await prismaClient.payoutRun.update({
      where: { id: payoutRun.id },
      data: {
        status: "failed",
        failureCode: code,
        failureMessage: normalizeText(message),
      },
    });

    return {
      ok: false,
      reason: "payout_execution_failed",
      payoutRun: updated,
    };
  }
}

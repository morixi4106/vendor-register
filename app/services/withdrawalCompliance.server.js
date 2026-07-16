import crypto from "node:crypto";

import { isEuCountry, normalizeCountryCode } from "../utils/deliveryEligibility.js";
import {
  DEFAULT_WITHDRAWAL_LOCALE,
  normalizeWithdrawalLocale,
} from "../utils/withdrawalLocale.js";

export const WITHDRAWAL_PAYLOAD_SCHEMA_VERSION = 2;
export const WITHDRAWAL_CONSUMER_LAW_RULE_VERSION = "consumer-law-country-v1";
export const WITHDRAWAL_DEADLINE_RULE_VERSION = "eu-withdrawal-deadline-v1";
export const WITHDRAWAL_ACK_TEMPLATE_VERSION = "withdrawal-ack-v2";

export function hashWithdrawalValue(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function buildWithdrawalSubmissionIdempotencyKey({
  shopDomain,
  submissionNonce,
  fallbackPayload,
} = {}) {
  const nonce = String(submissionNonce || "").trim();
  return hashWithdrawalValue(
    nonce
      ? { shopDomain: String(shopDomain || "").toLowerCase(), submissionNonce: nonce }
      : { shopDomain: String(shopDomain || "").toLowerCase(), fallbackPayload },
  );
}

export function resolveWithdrawalConsumerLawContext({
  orderSnapshot,
  submittedCountryCode,
  shopifyMarketCountry,
} = {}) {
  const shippingCountryAtOrder = normalizeCountryCode(
    orderSnapshot?.shippingCountryCode ||
      orderSnapshot?.shippingAddress?.countryCodeV2 ||
      orderSnapshot?.shippingAddress?.countryCode ||
      orderSnapshot?.shippingAddress?.country_code,
  );
  const habitualResidence = normalizeCountryCode(submittedCountryCode);
  const marketCountry = normalizeCountryCode(shopifyMarketCountry);
  const candidate = shippingCountryAtOrder || habitualResidence || marketCountry || null;
  const source = shippingCountryAtOrder
    ? "SHIPPING_COUNTRY_AT_ORDER"
    : habitualResidence
      ? "BUYER_PROVIDED_FALLBACK"
      : marketCountry
        ? "SHOPIFY_MARKET_FALLBACK"
        : "UNKNOWN";

  return {
    shippingCountryAtOrder,
    shopifyMarketCountry: marketCountry,
    consumerHabitualResidenceCountry: habitualResidence,
    consumerLawCountry: candidate && isEuCountry(candidate) ? candidate : null,
    consumerLawCountrySource: candidate && !isEuCountry(candidate) ? "NON_EU_REVIEW" : source,
    consumerLawRuleVersion: WITHDRAWAL_CONSUMER_LAW_RULE_VERSION,
    consumerLawDeterminedAt: new Date(),
  };
}

export async function resolveWithdrawalLegalBundle({
  prismaClient,
  consumerLawCountry,
  locale,
} = {}) {
  const normalizedLocale = normalizeWithdrawalLocale(locale) || DEFAULT_WITHDRAWAL_LOCALE;
  const country = normalizeCountryCode(consumerLawCountry);

  if (country && prismaClient?.withdrawalLegalBundle?.findFirst) {
    const published = await prismaClient.withdrawalLegalBundle.findFirst({
      where: {
        consumerLawCountry: country,
        locale: normalizedLocale,
        status: "PUBLISHED",
        publishedAt: { not: null },
      },
      orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    });
    if (published) {
      return {
        version: published.version,
        hash: published.contentHash,
        content: published.contentJson,
        requiresLegalReview: false,
      };
    }
  }

  const content = {
    kind: "NEUTRAL_WITHDRAWAL_RECEIPT",
    country: country || null,
    locale: normalizedLocale,
    statements: [
      "WITHDRAWAL_NOTICE_RECEIVED",
      "NO_AUTOMATIC_REFUND_OR_CANCELLATION",
      "MANUAL_LEGAL_REVIEW_REQUIRED",
    ],
  };
  return {
    version: "neutral-receipt-2026-07-v1",
    hash: hashWithdrawalValue(content),
    content,
    requiresLegalReview: true,
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export const THIRD_PARTY_COMMERCE_FLAGS = Object.freeze([
  "PUBLIC_DRAFT_ORDER_CHECKOUT_ENABLED",
  "MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED",
  "MULTI_SELLER_SHOPIFY_ORDER_SETTLEMENT_ENABLED",
  "MULTI_SELLER_SHOPIFY_REFUND_SETTLEMENT_ENABLED",
  "MULTI_SELLER_SHOPIFY_CANCELLED_SETTLEMENT_ENABLED",
  "MULTI_SELLER_SHOPIFY_DISPUTE_SETTLEMENT_ENABLED",
  "MARKETPLACE_SETTLEMENT_ACTIONS_ENABLED",
  "DOMESTIC_SELLER_SETTLEMENT_ENABLED",
  "CROSS_BORDER_SELLER_SETTLEMENT_ENABLED",
]);

export const SINGLE_OPERATOR_PAYOUT_SCOPE =
  "DOMESTIC_PLATFORM_DIRECT_ONLY";

export function isSingleOperatorPayoutReadinessAllowed(
  env = process.env,
) {
  return Boolean(
    isEnabled(env.SINGLE_OPERATOR_PAYOUT_ATTESTATION_ENABLED) &&
      isThirdPartyCommerceDisabled(env),
  );
}

export function isThirdPartyCommerceDisabled(env = process.env) {
  return THIRD_PARTY_COMMERCE_FLAGS.every((key) => !isEnabled(env[key]));
}

function isEnabled(value) {
  return ENABLED_VALUES.has(String(value || "").trim().toLowerCase());
}

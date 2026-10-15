import {
  isThirdPartyCommerceDisabled,
  THIRD_PARTY_COMMERCE_FLAGS,
} from "../utils/singleOperatorReadiness.js";

export const PLATFORM_DIRECT_CHECKOUT_MODE = Object.freeze({
  MARKETPLACE_VALIDATED: "MARKETPLACE_VALIDATED",
  SHOPIFY_STANDARD_DIRECT: "SHOPIFY_STANDARD_DIRECT",
});

function normalizeMode(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  return Object.values(PLATFORM_DIRECT_CHECKOUT_MODE).includes(normalized)
    ? normalized
    : PLATFORM_DIRECT_CHECKOUT_MODE.MARKETPLACE_VALIDATED;
}

export function inspectPlatformDirectCheckoutMode(
  env = process.env,
  observedScope,
) {
  const requestedMode = normalizeMode(env.PLATFORM_DIRECT_CHECKOUT_MODE);
  const thirdPartyCommerceDisabled = isThirdPartyCommerceDisabled(env);
  const enabledThirdPartyFlags = THIRD_PARTY_COMMERCE_FLAGS.filter((key) => {
    const value = String(env[key] || "")
      .trim()
      .toLowerCase();
    return ["1", "true", "yes", "on"].includes(value);
  });
  const standardDirectRequested =
    requestedMode === PLATFORM_DIRECT_CHECKOUT_MODE.SHOPIFY_STANDARD_DIRECT;
  const standardDirectReady =
    standardDirectRequested &&
    thirdPartyCommerceDisabled &&
    (observedScope === undefined ||
      (observedScope.available === true &&
        observedScope.internationalConfigured !== true));

  return {
    requestedMode,
    effectiveMode: standardDirectReady
      ? PLATFORM_DIRECT_CHECKOUT_MODE.SHOPIFY_STANDARD_DIRECT
      : PLATFORM_DIRECT_CHECKOUT_MODE.MARKETPLACE_VALIDATED,
    standardDirectRequested,
    standardDirectReady,
    thirdPartyCommerceDisabled,
    enabledThirdPartyFlags,
    ...(observedScope === undefined
      ? {}
      : {
          scopeAvailable: observedScope.available === true,
          internationalConfigured:
            observedScope.internationalConfigured === true,
        }),
    reason:
      standardDirectRequested && !thirdPartyCommerceDisabled
        ? "third_party_commerce_must_be_disabled"
        : observedScope !== undefined && observedScope.available !== true
          ? "checkout_scope_unverified"
          : standardDirectRequested &&
              observedScope?.internationalConfigured === true
            ? "international_sales_require_validation"
            : null,
  };
}

export function isShopifyStandardDirectCheckoutMode(
  env = process.env,
  observedScope,
) {
  return inspectPlatformDirectCheckoutMode(env, observedScope)
    .standardDirectReady;
}

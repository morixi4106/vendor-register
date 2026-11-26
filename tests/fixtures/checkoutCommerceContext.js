import { buildCheckoutCommerceContext } from "../../app/services/checkoutCommerceContext.server.js";

export const domesticShippingProfiles = Object.freeze({
  available: true,
  airPacketCount: 0,
  serviceAvailability: {
    available: true,
    activeCount: 0,
    requiredCountryCount: 0,
  },
});

export const domesticNativeScope = Object.freeze({
  available: true,
  internationalConfigured: false,
  scopeStatus: "DOMESTIC_ONLY",
  configHash: "a".repeat(64),
  observedAt: "2026-10-16T10:00:00.000Z",
  reason: null,
});

export function inspectDomesticNativeScope({ shopDomain, now } = {}) {
  return { ...domesticNativeScope, shopDomain, observedAt: now?.toISOString() || domesticNativeScope.observedAt };
}

export function domesticCheckoutContext({ env = {} } = {}) {
  return buildCheckoutCommerceContext(domesticShippingProfiles, env, domesticNativeScope);
}

export const domesticProbeOptions = {
  env: { PLATFORM_DIRECT_CHECKOUT_MODE: "SHOPIFY_STANDARD_DIRECT" },
  inspectCheckoutCommerceContextImpl: domesticCheckoutContext,
};

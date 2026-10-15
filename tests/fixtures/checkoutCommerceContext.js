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

export function domesticCheckoutContext({ env = {} } = {}) {
  return buildCheckoutCommerceContext(domesticShippingProfiles, env);
}

export const domesticProbeOptions = {
  env: { PLATFORM_DIRECT_CHECKOUT_MODE: "SHOPIFY_STANDARD_DIRECT" },
  inspectCheckoutCommerceContextImpl: domesticCheckoutContext,
};

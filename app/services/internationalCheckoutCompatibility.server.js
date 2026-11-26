import { internationalGraphQL } from "./internationalGateTransport.server.js";
import { SHOPIFY_API_VERSION } from "../utils/shopifyApiVersion.js";

export const CHECKOUT_COMPATIBILITY_QUERY = `query InternationalCheckoutCompatibility {
  shop { myshopifyDomain plan { shopifyPlus partnerDevelopment } }
}`;
export const CHECKOUT_COMPATIBILITY_VERSION =
  "international-checkout-compatibility-v1";
const TTL_MS = 300000;

// This reports only the documented plan prerequisite, never verifier qualification.
export async function inspectInternationalCheckoutCompatibility({
  shopDomain,
  graphQL = internationalGraphQL,
  signal,
  clock = () => Date.now(),
}) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain || ""))
    throw new Error("international_shop_invalid");
  let plan = "UNVERIFIED",
    developmentStore = null;
  const controller = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), 5000);
  let rejectAbort;
  try {
    combined.throwIfAborted();
    const result = await Promise.race([
      Promise.resolve().then(() => {
        combined.throwIfAborted();
        return graphQL({
          shopDomain,
          query: CHECKOUT_COMPATIBILITY_QUERY,
          variables: {},
          timeoutMs: 5000,
          signal: combined,
        });
      }),
      new Promise((_, reject) => {
        rejectAbort = () =>
          reject(new Error("international_checkout_compatibility_unavailable"));
        combined.addEventListener("abort", rejectAbort, { once: true });
      }),
    ]);
    combined.throwIfAborted();
    const shop = result?.data?.shop;
    if (
      Buffer.byteLength(JSON.stringify(result)) > 4096 ||
      (result.errors !== undefined &&
        (!Array.isArray(result.errors) || result.errors.length)) ||
      shop?.myshopifyDomain !== shopDomain ||
      typeof shop.plan?.shopifyPlus !== "boolean" ||
      typeof shop.plan?.partnerDevelopment !== "boolean"
    )
      throw new Error("international_checkout_compatibility_unavailable");
    plan = shop.plan.shopifyPlus ? "PLUS" : "NON_PLUS";
    developmentStore = shop.plan.partnerDevelopment;
  } catch {
    // Transport messages and partial responses may contain sensitive data.
  } finally {
    clearTimeout(timer);
    if (rejectAbort) combined.removeEventListener("abort", rejectAbort);
    controller.abort();
  }
  const observedAt = new Date(clock());
  return {
    version: CHECKOUT_COMPATIBILITY_VERSION,
    apiVersion: SHOPIFY_API_VERSION,
    shopDomain,
    status: plan === "UNVERIFIED" ? "UNAVAILABLE" : "OBSERVED",
    plan,
    developmentStore,
    observedAt: observedAt.toISOString(),
    expiresAt: new Date(+observedAt + TTL_MS).toISOString(),
    paths: [
      {
        id: "STOREFRONT_CART",
        status: "INSUFFICIENT",
        reason: "ESTIMATES_AND_ROUTE_BINDING_UNVERIFIED",
      },
      {
        id: "CHECKOUT_UI_EXTENSION",
        status:
          plan === "PLUS"
            ? "UNVERIFIED"
            : plan === "NON_PLUS"
              ? "UNAVAILABLE"
              : "UNKNOWN",
        reason:
          plan === "PLUS"
            ? "PLAN_ONLY_OBSERVED"
            : plan === "NON_PLUS"
              ? "PLUS_REQUIRED"
              : "PLAN_UNVERIFIED",
      },
      {
        id: "WEB_PIXEL",
        status: "INSUFFICIENT",
        reason: "ANALYTICS_NOT_INDEPENDENT_CHECKOUT_PROOF",
      },
    ],
    readOnly: true,
    verificationReady: false,
    saleReady: false,
  };
}

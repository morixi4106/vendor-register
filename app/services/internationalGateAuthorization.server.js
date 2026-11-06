import { inspectMarketplaceCheckoutValidation } from "./shopifyCheckoutValidation.server.js";
import { inspectInternationalAuthorizationProof } from "./internationalAuthorizationContext.server.js";
export { INTERNATIONAL_RELEASE_EVIDENCE_KEY, INTERNATIONAL_DEPLOYMENT_EVIDENCE_KEY } from "./internationalAuthorizationPolicy.server.js";
export { createInternationalAuthorizationCommands } from "./internationalAuthorizationRequests.server.js";

export async function inspectInternationalStopProtection(args) {
  const validation = await inspectMarketplaceCheckoutValidation(args.shopDomain, { graphQL: args.graphQL });
  const proof = await inspectInternationalAuthorizationProof({ ...args, purpose: "DEPLOYMENT", native: validation });
  return { ready: validation.ok && validation.active && !validation.runtimeErrorDetected && proof.ready };
}

export async function inspectInternationalGateRelease(args) {
  return inspectInternationalAuthorizationProof({ ...args, purpose: args.purpose || "SALE" });
}

// The legacy actor-string command cannot bypass the single-use protocol.
export async function authorizeInternationalGateScope() {
  return { ok: false, reason: "international_single_use_authorization_required" };
}

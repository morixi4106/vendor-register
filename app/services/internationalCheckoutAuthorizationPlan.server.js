import { buildInternationalCheckoutPlan } from "./internationalCheckoutPlan.server.js";
import {
  effectiveAuthorizationPurpose,
  authorizationError,
} from "./internationalAuthorizationPolicy.server.js";
import {
  checkoutPlanSummary,
  checkoutCaseExpected,
} from "../utils/internationalCheckoutResults.js";
import { HASH, proofHash, shape } from "../utils/internationalProofContract.js";
import { checkoutBrowserPlanCapacity } from "../utils/internationalCheckoutCapacity.js";

// This metadata belongs to the server-owned operator snapshot, not to HTTP input.
export function prepareCheckoutAuthorizationPlan({
  shopDomain,
  input,
  context,
  sourceHash,
  generation,
}) {
  if (effectiveAuthorizationPurpose(input) !== "VERIFY") return null;
  if (input.verificationKind !== "NON_FINANCIAL")
    throw authorizationError("international_verification_not_implemented", 422);
  const descriptor = context.checkoutDescriptor;
  shape(descriptor, ["runnerDigest", "environment"]);
  if (
    !HASH.test(descriptor.runnerDigest || "") ||
    !["ISOLATED_STORE", "LIVE_STORE"].includes(descriptor.environment)
  )
    throw authorizationError("international_checkout_executor_untrusted", 422);
  const plan = buildInternationalCheckoutPlan({
    shopDomain,
    scope: input.scope,
    currencies: input.currencies,
    native: context.native,
    releaseBinding: context.releaseBinding,
    sourceHash,
    verificationKind: input.verificationKind,
  });
  checkoutBrowserPlanCapacity(plan.cases);
  const summary = checkoutPlanSummary(
    plan,
    {
      shopDomain,
      kind: input.verificationKind,
      scopeHash: input.scopeHash,
      releaseBinding: context.releaseBinding,
      nativeConfigHash: context.nativeConfigHash,
      requiredCasesHash: plan.requiredCasesHash,
      startGeneration: generation,
    },
    descriptor,
  );
  return { plan, summary };
}

export function assertCheckoutAuthorizationPlan(prepared, pinned) {
  if (!prepared || proofHash(prepared.summary) !== proofHash(pinned))
    throw authorizationError("international_checkout_plan_changed");
}

export async function persistAuthorizedCheckoutCases(tx, run, prepared) {
  await tx.internationalCheckoutVerificationCase.createMany({
    data: prepared.plan.cases.map((row, ordinal) => ({
      shopDomain: run.shopDomain,
      runId: run.id,
      ordinal,
      caseKey: row.caseKey,
      phase: row.phase,
      expectedJson: checkoutCaseExpected(row),
      expectedHash: row.caseKey,
    })),
  });
}

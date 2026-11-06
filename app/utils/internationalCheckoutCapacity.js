import { checkoutCaseExpected } from "./internationalCheckoutResults.js";
import { MAX_INTERNATIONAL_CASES } from "./internationalCheckoutVerification.js";
import { proofError, proofHash } from "./internationalProofContract.js";

export const CHECKOUT_BROWSER_MAX_SESSIONS = 256;

// Old CLOSED checkouts reuse OPEN contexts; every other case creates a session.
// This is an execution bound, not a reduction of the persisted history limit.
export function checkoutBrowserPlanCapacity(cases) {
  if (
    !Array.isArray(cases) ||
    !cases.length ||
    cases.length > MAX_INTERNATIONAL_CASES
  )
    throw proofError("international_case_plan_invalid");
  const groups = new Map(),
    keys = new Set();
  let sessions = 0;
  for (const row of cases) {
    checkoutCaseExpected(row);
    if (keys.has(row.caseKey))
      throw proofError("international_case_plan_invalid");
    keys.add(row.caseKey);
    if (row.target.country === "GB")
      throw proofError("international_region_unverified");
    if (
      [
        "allowed-before-payment",
        "old-checkout-blocked",
        "new-checkout-blocked",
      ].includes(row.scenario)
    ) {
      const key = proofHash(row.target);
      const group = groups.get(key) || new Set();
      group.add(row.scenario);
      groups.set(key, group);
    }
    if (row.scenario !== "old-checkout-blocked") sessions++;
  }
  if (!groups.size || [...groups.values()].some((group) => group.size !== 3))
    throw proofError("international_case_plan_invalid");
  if (sessions > CHECKOUT_BROWSER_MAX_SESSIONS)
    throw proofError("international_checkout_session_limit");
  return {
    caseCount: cases.length,
    sessionCount: sessions,
    retainedSessionCount: groups.size,
  };
}

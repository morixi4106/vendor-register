import {
  HASH,
  proofError,
  proofHash,
  shape,
  verifyProofSignature,
} from "./internationalProofContract.js";
import {
  inspectCheckoutCaseSet,
  validateCheckoutCaseResult,
  validateCheckoutSummary,
} from "./internationalCheckoutResults.js";
import {
  INTERNATIONAL_ARTIFACT_CASES,
  internationalCoverageKey,
} from "./internationalCheckoutVerification.js";

export const CHECKOUT_CLOSURE_VERSION = "international-checkout-closure-v1";
export const NORMAL_CHECKOUT_CLOSE_REASON =
  "international_verification_complete";
export function closureError() {
  throw proofError("international_checkout_closure_unverified", 409);
}
export function inspectVerifiedCheckoutCases(run, rows, now, trust) {
  const ordered = inspectCheckoutCaseSet(run, rows);
  for (const row of ordered.filter((row) => row.status === "RECORDED")) {
    verifyProofSignature(row.resultJson, "checkoutVerifier", now, trust);
    const checked = validateCheckoutCaseResult(row.resultJson, {
      run,
      row,
      now: row.recordedAt,
      trust,
    });
    if (
      checked.resultHash !== row.resultHash ||
      checked.resultCode !== row.resultCode
    )
      closureError();
  }
  return ordered;
}
export function checkoutOpenResultsHash(rows) {
  const open = rows.filter((row) => row.phase === "OPEN");
  if (
    !open.length ||
    open.some(
      (row) => row.status !== "RECORDED" || row.resultCode !== "MATCHED",
    )
  )
    closureError();
  return proofHash(
    open.map((row) => ({ caseKey: row.caseKey, resultHash: row.resultHash })),
  );
}
export function validateCheckoutCloseContext(context, run, now, phase) {
  shape(
    context,
    [
      "v",
      "runId",
      "shopDomain",
      "planHash",
      "releaseBinding",
      "nativeConfigHash",
      "sourceHash",
      "runnerDigest",
      "environment",
      "proofReferencesHash",
      "artifactHash",
      "artifactReference",
      "artifactExpiresAt",
      "artifactCasesHash",
      "observedAt",
      "phase",
      "generation",
      "gateHash",
    ],
    4096,
  );
  const summary = validateCheckoutSummary(run.planSummaryJson, run);
  const observed = new Date(context.observedAt),
    expiry = new Date(context.artifactExpiresAt);
  if (
    context.v !== "international-checkout-runtime-v1" ||
    context.runId !== run.id ||
    context.shopDomain !== run.shopDomain ||
    context.phase !== phase ||
    context.generation !==
      (phase === "OPEN" ? run.startGeneration : run.closureGeneration) ||
    [
      "planHash",
      "releaseBinding",
      "nativeConfigHash",
      "sourceHash",
      "runnerDigest",
      "environment",
    ].some((k) => context[k] !== summary[k]) ||
    context.proofReferencesHash !== proofHash(run.proofReferencesJson) ||
    !HASH.test(context.artifactHash || "") ||
    !/^github:morixi4106\/vendor-register:[1-9]\d*$/.test(
      context.artifactReference || "",
    ) ||
    context.artifactCasesHash !== proofHash(INTERNATIONAL_ARTIFACT_CASES) ||
    typeof context.observedAt !== "string" ||
    !Number.isFinite(+observed) ||
    observed.toISOString() !== context.observedAt ||
    observed > now ||
    now - observed >= 60000 ||
    !run.startedAt ||
    observed < run.startedAt ||
    typeof context.artifactExpiresAt !== "string" ||
    !Number.isFinite(+expiry) ||
    expiry.toISOString() !== context.artifactExpiresAt ||
    expiry < run.expiresAt ||
    (phase === "CLOSED"
      ? !HASH.test(context.gateHash || "")
      : context.gateHash !== null)
  )
    closureError();
  return context;
}
export function createCheckoutClosureCandidate(run, rows, context, now) {
  validateCheckoutCloseContext(context, run, now, "OPEN");
  const summary = validateCheckoutSummary(run.planSummaryJson, run);
  const candidate = {
    v: CHECKOUT_CLOSURE_VERSION,
    runId: run.id,
    shopDomain: run.shopDomain,
    summaryHash: proofHash(summary),
    openResultsHash: checkoutOpenResultsHash(rows),
    proofReferencesHash: proofHash(run.proofReferencesJson),
    openContext: context,
  };
  return {
    candidate,
    candidateHash: proofHash(candidate),
    closedContext: null,
    final: null,
  };
}
export function validateCheckoutClosureCandidate(run, rows) {
  rows = inspectCheckoutCaseSet(run, rows);
  const result = run.resultsJson;
  shape(
    result,
    ["candidate", "candidateHash", "closedContext", "final"],
    32000,
  );
  const c = result.candidate;
  shape(
    c,
    [
      "v",
      "runId",
      "shopDomain",
      "summaryHash",
      "openResultsHash",
      "proofReferencesHash",
      "openContext",
    ],
    8192,
  );
  if (
    c.v !== CHECKOUT_CLOSURE_VERSION ||
    c.runId !== run.id ||
    c.shopDomain !== run.shopDomain ||
    c.summaryHash !==
      proofHash(validateCheckoutSummary(run.planSummaryJson, run)) ||
    c.proofReferencesHash !== proofHash(run.proofReferencesJson) ||
    c.openResultsHash !== checkoutOpenResultsHash(rows) ||
    result.candidateHash !== proofHash(c)
  )
    closureError();
  // Validate the immutable historical context at its original time, not by renewing it.
  validateCheckoutCloseContext(
    c.openContext,
    run,
    new Date(c.openContext.observedAt),
    "OPEN",
  );
  return result;
}
export function assertClosedCheckoutSession(run, rows, row, payload) {
  const key = internationalCoverageKey(row.expectedJson.target);
  const original = rows.find(
    (r) =>
      r.expectedJson.scenario === "allowed-before-payment" &&
      internationalCoverageKey(r.expectedJson.target) === key,
  );
  if (!original || original.resultCode !== "MATCHED") closureError();
  const session = payload.sessionHash;
  if (row.expectedJson.scenario === "old-checkout-blocked") {
    if (session !== original.resultJson.payload.sessionHash) closureError();
  } else if (row.expectedJson.scenario === "new-checkout-blocked") {
    if (
      rows.some(
        (r) =>
          r.phase === "OPEN" && r.resultJson?.payload.sessionHash === session,
      ) ||
      rows.some(
        (r) =>
          r.caseKey !== row.caseKey &&
          r.expectedJson.scenario === "new-checkout-blocked" &&
          r.resultJson?.payload.sessionHash === session,
      )
    )
      closureError();
  } else closureError();
  if (payload.generation !== run.closureGeneration) closureError();
}

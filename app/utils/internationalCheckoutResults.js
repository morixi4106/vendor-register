import {
  HASH,
  ID,
  INTERNATIONAL_PROOF_TRUST,
  proofError,
  proofHash,
  shape,
  verifyProofSignature,
} from "./internationalProofContract.js";
import {
  INTERNATIONAL_CHECKOUT_SCENARIOS,
  INTERNATIONAL_CHECKOUT_VERIFIER,
  INTERNATIONAL_ARTIFACT_CASES,
  MAX_INTERNATIONAL_CASES,
  internationalCoverageKey,
} from "./internationalCheckoutVerification.js";

export const CHECKOUT_RESULT_VERSION = "international-checkout-result-v1";
export const CHECKOUT_CHALLENGE_MS = 60000;
const SCENARIOS = Object.freeze({
  "allowed-before-payment": ["OPEN", "ALLOWED"],
  "country-rejected": ["OPEN", "REJECTED"],
  "domestic-regression": ["OPEN", "ALLOWED"],
  "old-checkout-blocked": ["CLOSED", "REJECTED"],
  "new-checkout-blocked": ["CLOSED", "REJECTED"],
});
const SUMMARY_FIELDS = [
  "v",
  "planHash",
  "caseCount",
  "caseSetHash",
  "coverageHash",
  "sourceHash",
  "scopeHash",
  "releaseBinding",
  "nativeConfigHash",
  "startGeneration",
  "runnerDigest",
  "environment",
];
const ENVIRONMENTS = ["ISOLATED_STORE", "LIVE_STORE"];
function invalid() {
  throw proofError("international_checkout_result_invalid");
}
export function checkoutCaseExpected(row) {
  const { caseKey, ...expected } = row;
  shape(
    expected,
    ["scenario", "phase", "expectedStage", "expectedOutcome", "target"],
    2048,
  );
  const scenario = SCENARIOS[expected.scenario];
  if (
    !Object.hasOwn(SCENARIOS, expected.scenario) ||
    !scenario ||
    expected.phase !== scenario[0] ||
    expected.expectedOutcome !== scenario[1] ||
    expected.expectedStage !== "CHECKOUT_INTERACTION" ||
    proofHash(expected) !== caseKey
  )
    invalid();
  if (["country-rejected", "domestic-regression"].includes(expected.scenario)) {
    shape(expected.target, ["shopifyProductId", "variantId", "country"]);
    if (
      !/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(
        expected.target.shopifyProductId,
      ) ||
      !/^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/.test(
        expected.target.variantId,
      ) ||
      !/^[A-Z]{2}$/.test(expected.target.country) ||
      (expected.scenario === "domestic-regression"
        ? expected.target.country !== "JP"
        : expected.target.country === "JP")
    )
      invalid();
  } else internationalCoverageKey(expected.target);
  return expected;
}

// The plan hash must already be pinned by the server-owned authorization/run.
export function checkoutPlanSummary(plan, run, { runnerDigest, environment }) {
  shape(
    plan,
    [
      "version",
      "verifierVersion",
      "shopDomain",
      "scopeHash",
      "currencies",
      "releaseBinding",
      "sourceHash",
      "nativeConfigHash",
      "verificationKind",
      "artifactCases",
      "coverage",
      "cases",
      "requiredCasesHash",
      "caseCount",
    ],
    4 * 1024 * 1024,
  );
  const { requiredCasesHash, caseCount, ...body } = plan;
  if (
    plan.version !== INTERNATIONAL_CHECKOUT_SCENARIOS ||
    plan.verifierVersion !== INTERNATIONAL_CHECKOUT_VERIFIER ||
    run.kind !== "NON_FINANCIAL" ||
    plan.verificationKind !== run.kind ||
    plan.shopDomain !== run.shopDomain ||
    plan.scopeHash !== run.scopeHash ||
    plan.releaseBinding !== run.releaseBinding ||
    plan.nativeConfigHash !== run.nativeConfigHash ||
    requiredCasesHash !== run.requiredCasesHash ||
    proofHash(body) !== requiredCasesHash ||
    proofHash(plan.currencies) !== proofHash(["JPY"]) ||
    proofHash(plan.artifactCases) !== proofHash(INTERNATIONAL_ARTIFACT_CASES) ||
    ![
      plan.scopeHash,
      plan.releaseBinding,
      plan.sourceHash,
      plan.nativeConfigHash,
      runnerDigest,
    ].every((v) => HASH.test(v || "")) ||
    !ENVIRONMENTS.includes(environment) ||
    !Number.isSafeInteger(run.startGeneration) ||
    run.startGeneration < 1 ||
    !Array.isArray(plan.cases) ||
    !plan.cases.length ||
    plan.cases.length > MAX_INTERNATIONAL_CASES ||
    caseCount !== plan.cases.length ||
    !Array.isArray(plan.coverage) ||
    !plan.coverage.length ||
    plan.coverage.length > MAX_INTERNATIONAL_CASES
  )
    invalid();
  const keys = plan.cases.map((row) => {
    checkoutCaseExpected(row);
    return row.caseKey;
  });
  const coverageKeys = plan.coverage.map(internationalCoverageKey).sort();
  if (
    new Set(keys).size !== keys.length ||
    proofHash(keys) !== proofHash([...keys].sort()) ||
    new Set(coverageKeys).size !== coverageKeys.length
  )
    invalid();
  const allowed = plan.cases
    .filter((row) => row.scenario === "allowed-before-payment")
    .map((row) => internationalCoverageKey(row.target))
    .sort();
  if (proofHash(allowed) !== proofHash(coverageKeys)) invalid();
  return {
    v: "international-checkout-plan-summary-v1",
    planHash: requiredCasesHash,
    caseCount,
    caseSetHash: proofHash(keys),
    coverageHash: proofHash(coverageKeys),
    sourceHash: plan.sourceHash,
    scopeHash: plan.scopeHash,
    releaseBinding: plan.releaseBinding,
    nativeConfigHash: plan.nativeConfigHash,
    startGeneration: run.startGeneration,
    runnerDigest,
    environment,
  };
}

export function validateCheckoutSummary(summary, run) {
  shape(summary, SUMMARY_FIELDS, 4096);
  if (
    summary.v !== "international-checkout-plan-summary-v1" ||
    run.kind !== "NON_FINANCIAL" ||
    summary.planHash !== run.requiredCasesHash ||
    summary.scopeHash !== run.scopeHash ||
    summary.releaseBinding !== run.releaseBinding ||
    summary.nativeConfigHash !== run.nativeConfigHash ||
    summary.startGeneration !== run.startGeneration ||
    !Number.isInteger(summary.caseCount) ||
    summary.caseCount < 1 ||
    summary.caseCount > MAX_INTERNATIONAL_CASES ||
    !ENVIRONMENTS.includes(summary.environment) ||
    ![
      summary.planHash,
      summary.caseSetHash,
      summary.coverageHash,
      summary.sourceHash,
      summary.runnerDigest,
    ].every((v) => HASH.test(v || ""))
  )
    invalid();
  return summary;
}

export function validateCheckoutCaseResult(
  envelope,
  { run, row, now, trust = INTERNATIONAL_PROOF_TRUST },
) {
  shape(envelope, ["keyId", "payload", "signature"], 4096);
  const summary = validateCheckoutSummary(run.planSummaryJson, run);
  const p = verifyProofSignature(envelope, "checkoutVerifier", now, trust);
  shape(p, [
    "v",
    "shopDomain",
    "runId",
    "caseKey",
    "planHash",
    "scopeHash",
    "releaseBinding",
    "nativeConfigHash",
    "sourceHash",
    "startGeneration",
    "executorId",
    "runnerDigest",
    "environment",
    "generation",
    "challengeHash",
    "sequence",
    "observedAt",
    "stage",
    "outcome",
    "evidenceHash",
    "sessionHash",
  ]);
  const key = trust.checkoutVerifier.find((key) => key.id === envelope.keyId);
  const observedAt = new Date(p.observedAt);
  const expected = checkoutCaseExpected({
    ...row.expectedJson,
    caseKey: row.caseKey,
  });
  if (
    p.v !== CHECKOUT_RESULT_VERSION ||
    p.shopDomain !== run.shopDomain ||
    p.runId !== run.id ||
    !ID.test(p.runId) ||
    p.caseKey !== row.caseKey ||
    row.expectedHash !== row.caseKey ||
    row.phase !== expected.phase ||
    [
      "planHash",
      "scopeHash",
      "releaseBinding",
      "nativeConfigHash",
      "sourceHash",
      "startGeneration",
      "runnerDigest",
      "environment",
    ].some((field) => p[field] !== summary[field]) ||
    p.executorId !== run.executorId ||
    p.executorId !== key.executorId ||
    p.runnerDigest !== key.runnerDigest ||
    p.environment !== key.environment ||
    p.generation !==
      (row.phase === "OPEN" ? run.startGeneration : run.closureGeneration) ||
    p.challengeHash !== row.challengeHash ||
    !HASH.test(p.challengeHash || "") ||
    p.sequence !== row.challengeSequence ||
    !row.challengeIssuedAt ||
    !row.challengeExpiresAt ||
    !Number.isInteger(p.sequence) ||
    p.sequence < 1 ||
    typeof p.observedAt !== "string" ||
    !Number.isFinite(+observedAt) ||
    observedAt.toISOString() !== p.observedAt ||
    observedAt < row.challengeIssuedAt ||
    observedAt >= row.challengeExpiresAt ||
    observedAt > now ||
    now >= row.challengeExpiresAt ||
    ![p.evidenceHash, p.sessionHash].every((v) => HASH.test(v || "")) ||
    !["CHECKOUT_INTERACTION", "CHECKOUT_COMPLETION", "NOT_OBSERVED"].includes(
      p.stage,
    ) ||
    !["ALLOWED", "REJECTED", "NOT_OBSERVED"].includes(p.outcome) ||
    (p.stage === "NOT_OBSERVED") !== (p.outcome === "NOT_OBSERVED")
  )
    invalid();
  const resultCode =
    p.stage === "NOT_OBSERVED"
      ? "NOT_OBSERVED"
      : p.stage !== expected.expectedStage
        ? "UNEXPECTED_STAGE"
        : p.outcome !== expected.expectedOutcome
          ? "UNEXPECTED_OUTCOME"
          : "MATCHED";
  return { payload: p, resultCode, resultHash: proofHash(envelope) };
}

export function inspectCheckoutCaseSet(run, rows) {
  const summary = validateCheckoutSummary(run.planSummaryJson, run);
  if (!Array.isArray(rows) || rows.length !== summary.caseCount) invalid();
  const ordered = [...rows].sort((a, b) => a.ordinal - b.ordinal);
  const keys = ordered.map((row, index) => {
    if (
      row.shopDomain !== run.shopDomain ||
      row.runId !== run.id ||
      row.ordinal !== index ||
      row.expectedHash !== row.caseKey
    )
      invalid();
    const expected = checkoutCaseExpected({
      ...row.expectedJson,
      caseKey: row.caseKey,
    });
    if (row.phase !== expected.phase) invalid();
    return row.caseKey;
  });
  if (
    new Set(keys).size !== keys.length ||
    proofHash(keys) !== summary.caseSetHash
  )
    invalid();
  return ordered;
}

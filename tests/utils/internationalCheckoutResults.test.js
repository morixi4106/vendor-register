import assert from "node:assert/strict";
import test from "node:test";
import { internationalCheckoutResultFixture } from "../helpers/internationalCheckoutResultFixture.js";
import {
  checkoutPlanSummary,
  validateCheckoutCaseResult,
  inspectCheckoutCaseSet,
} from "../../app/utils/internationalCheckoutResults.js";
import { proofHash } from "../../app/utils/internationalProofContract.js";

const NOW = new Date("2026-11-07T00:00:00.000Z");
function fixture() {
  const f = internationalCheckoutResultFixture(undefined, NOW);
  const row = f.rows.find(
    (row) => row.expectedJson.scenario === "allowed-before-payment",
  );
  return {
    ...f,
    row,
    validate: (envelope, changes = {}) =>
      validateCheckoutCaseResult(envelope, {
        run: f.run,
        row,
        now: new Date(+NOW + 2),
        trust: f.trust,
        ...changes,
      }),
  };
}
test("nonfinancial plan is pinned, bounded, exact and independent of result order", () => {
  const f = fixture();
  assert.equal(checkoutPlanSummary(f.plan, f.run, f.descriptor).caseCount, 5);
  assert.deepEqual(
    inspectCheckoutCaseSet(f.run, [...f.rows].reverse()),
    f.rows,
  );
  for (const mutate of [
    (p) => p.cases.pop(),
    (p) => p.cases.reverse(),
    (p) => p.coverage.push(p.coverage[0]),
    (p) => p.artifactCases.pop(),
    (p) => p.currencies.push("USD"),
    (p) => (p.cases[0].target.variantId = "other"),
  ]) {
    const p = structuredClone(f.plan);
    mutate(p);
    assert.throws(() => checkoutPlanSummary(p, f.run, f.descriptor));
  }
  for (const mutate of [
    (rows) => rows.pop(),
    (rows) => rows.push(rows[0]),
    (rows) => (rows[0].ordinal = 1),
    (rows) => (rows[0].runId = "other"),
    (rows) => (rows[0].shopDomain = "other.myshopify.com"),
    (rows) => (rows[0].expectedJson.expectedOutcome = "REJECTED"),
    (rows) => (rows[0].expectedHash = "0".repeat(64)),
  ]) {
    const rows = structuredClone(f.rows);
    mutate(rows);
    assert.throws(() => inspectCheckoutCaseSet(f.run, rows));
  }
});
test("signed exact observation is accepted but does not claim completion or sale approval", () => {
  const f = fixture();
  const envelope = f.result(f.row);
  const result = f.validate(envelope);
  assert.equal(result.resultCode, "MATCHED");
  assert.equal(result.resultHash, proofHash(envelope));
  assert.equal(Object.hasOwn(result, "saleReady"), false);
});
for (const [field, value] of Object.entries({
  v: "other",
  shopDomain: "other.myshopify.com",
  runId: "other",
  caseKey: "0".repeat(64),
  planHash: "0".repeat(64),
  scopeHash: "0".repeat(64),
  releaseBinding: "0".repeat(64),
  nativeConfigHash: "0".repeat(64),
  sourceHash: "0".repeat(64),
  startGeneration: 3,
  runnerDigest: "0".repeat(64),
  environment: "LIVE_STORE",
  executorId: "system:other",
  generation: 3,
  challengeHash: "0".repeat(64),
  sequence: 2,
  observedAt: "2026-11-06T23:59:59.999Z",
  evidenceHash: "https://example.test/checkout",
  sessionHash: "checkout-token",
  email: "private@example.invalid",
})) {
  test(`signed result refuses substitution or private field: ${field}`, () => {
    const f = fixture();
    assert.throws(() => f.validate(f.result(f.row, { [field]: value })));
  });
}
test("stage and outcome mismatches are recorded as failure, never coerced into success", () => {
  const f = fixture();
  assert.equal(
    f.validate(f.result(f.row, { stage: "CHECKOUT_COMPLETION" })).resultCode,
    "UNEXPECTED_STAGE",
  );
  assert.equal(
    f.validate(f.result(f.row, { outcome: "REJECTED" })).resultCode,
    "UNEXPECTED_OUTCOME",
  );
  assert.equal(
    f.validate(
      f.result(f.row, { stage: "NOT_OBSERVED", outcome: "NOT_OBSERVED" }),
    ).resultCode,
    "NOT_OBSERVED",
  );
  assert.throws(() => f.validate(f.result(f.row, { stage: "NOT_OBSERVED" })));
});
test("keys are domain-separated, scoped to code/environment/executor, current and fail closed", () => {
  const f = fixture(),
    envelope = f.result(f.row);
  assert.throws(() =>
    f.validate(envelope, { trust: { checkoutVerifier: [] } }),
  );
  assert.throws(() => f.validate(f.result(f.row, {}, "observer")));
  for (const change of [
    { revokedAt: NOW.toISOString() },
    { runnerDigest: "0".repeat(64) },
    { environment: "LIVE_STORE" },
    { executorId: "system:other" },
    { notAfter: NOW.toISOString() },
    { notBefore: new Date(+NOW + 100).toISOString() },
  ]) {
    assert.throws(() =>
      f.validate(envelope, {
        trust: {
          checkoutVerifier: [{ ...f.trust.checkoutVerifier[0], ...change }],
        },
      }),
    );
  }
  const tampered = structuredClone(envelope);
  tampered.payload.outcome = "REJECTED";
  assert.throws(() => f.validate(tampered));
});
test("challenge and observation times have strict boundaries and canonical UTC representation", () => {
  const f = fixture();
  for (const observedAt of [
    "2026-11-07T00:00:00Z",
    "2026-11-07T00:00:00.002+00:00",
    "2026-11-07T00:00:00.003Z",
    "2026-11-07T00:01:00.000Z",
    "not-a-date",
  ]) {
    assert.throws(() => f.validate(f.result(f.row, { observedAt })));
  }
  assert.throws(() =>
    f.validate(f.result(f.row), { now: new Date(+NOW + 60000) }),
  );
  assert.equal(
    f.validate(f.result(f.row, { observedAt: NOW.toISOString() })).resultCode,
    "MATCHED",
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { internationalCheckoutResultFixture } from "../helpers/internationalCheckoutResultFixture.js";
import { proofHash } from "../../app/utils/internationalProofContract.js";
import { INTERNATIONAL_ARTIFACT_CASES } from "../../app/utils/internationalCheckoutVerification.js";
import {
  createCheckoutClosureCandidate,
  validateCheckoutClosureCandidate,
  validateCheckoutCloseContext,
  inspectVerifiedCheckoutCases,
  assertClosedCheckoutSession,
} from "../../app/utils/internationalCheckoutClosure.js";
import { inspectInternationalCheckoutCloseContext } from "../../app/services/internationalCheckoutCloseContext.server.js";
const NOW = new Date("2026-11-07T00:00:00.000Z");
function fixture() {
  const f = internationalCheckoutResultFixture(undefined, NOW);
  for (const row of f.rows.filter((row) => row.phase === "OPEN")) {
    row.resultJson = f.result(row);
    row.resultHash = proofHash(row.resultJson);
    row.status = "RECORDED";
    row.recordedAt = new Date(+NOW + 2);
    row.resultCode = "MATCHED";
  }
  const context = {
    v: "international-checkout-runtime-v1",
    runId: f.run.id,
    shopDomain: f.run.shopDomain,
    planHash: f.run.requiredCasesHash,
    releaseBinding: f.run.releaseBinding,
    nativeConfigHash: f.run.nativeConfigHash,
    sourceHash: f.plan.sourceHash,
    runnerDigest: f.descriptor.runnerDigest,
    environment: f.descriptor.environment,
    proofReferencesHash: proofHash(f.run.proofReferencesJson),
    artifactHash: "f".repeat(64),
    artifactReference: "github:morixi4106/vendor-register:1",
    artifactExpiresAt: f.run.expiresAt.toISOString(),
    artifactCasesHash: proofHash(INTERNATIONAL_ARTIFACT_CASES),
    observedAt: new Date(+NOW + 3).toISOString(),
    phase: "OPEN",
    generation: 2,
    gateHash: null,
  };
  const now = new Date(+NOW + 4);
  f.run.resultsJson = createCheckoutClosureCandidate(
    f.run,
    f.rows,
    context,
    now,
  );
  return { ...f, context, clock: now };
}
test("closure candidate commits only verified OPEN results and fixed context without renewing its timestamp", () => {
  const f = fixture();
  assert.equal(
    inspectVerifiedCheckoutCases(f.run, f.rows, f.clock, f.trust).length,
    5,
  );
  const before = structuredClone(f.run.resultsJson);
  validateCheckoutClosureCandidate(f.run, f.rows);
  assert.deepEqual(f.run.resultsJson, before);
  assert.equal(before.final, null);
  assert.equal(before.closedContext, null);
  assert.equal(before.candidate.openContext.observedAt, f.context.observedAt);
  const missing = structuredClone(f.rows);
  missing.find((row) => row.phase === "OPEN").status = "PENDING";
  assert.throws(() =>
    createCheckoutClosureCandidate(f.run, missing, f.context, f.clock),
  );
});
for (const [field, value] of Object.entries({
  v: "other",
  runId: "other",
  shopDomain: "other.myshopify.com",
  planHash: "0".repeat(64),
  releaseBinding: "0".repeat(64),
  nativeConfigHash: "0".repeat(64),
  sourceHash: "0".repeat(64),
  runnerDigest: "0".repeat(64),
  environment: "LIVE_STORE",
  proofReferencesHash: "0".repeat(64),
  artifactCasesHash: "0".repeat(64),
  artifactHash: "not-a-hash",
  artifactReference: "https://example.test/checkout",
  phase: "CLOSED",
  generation: 3,
  gateHash: "0".repeat(64),
  email: "private@example.invalid",
  observedAt: NOW.toISOString(),
  artifactExpiresAt: NOW.toISOString(),
})) {
  test(`closure context rejects substituted/private/stale binding: ${field}`, () => {
    const f = fixture(),
      context = { ...f.context, [field]: value };
    // NOW itself is fresh, but predates this run's original observed context only by 3ms;
    // use the exact 60-second boundary for the stale case.
    if (field === "observedAt")
      context.observedAt = new Date(+f.clock - 60000).toISOString();
    assert.throws(() =>
      validateCheckoutCloseContext(context, f.run, f.clock, "OPEN"),
    );
  });
}
test("candidate cannot survive result, case-set, summary or dependency tampering", () => {
  for (const change of [
    "hash",
    "context",
    "result",
    "case",
    "summary",
    "proof",
  ]) {
    const f = fixture();
    if (change === "hash") f.run.resultsJson.candidateHash = "0".repeat(64);
    if (change === "context")
      f.run.resultsJson.candidate.openContext.releaseBinding = "0".repeat(64);
    if (change === "result")
      f.rows.find((row) => row.phase === "OPEN").resultHash = "0".repeat(64);
    if (change === "case") f.rows.pop();
    if (change === "summary") f.run.planSummaryJson.sourceHash = "0".repeat(64);
    if (change === "proof") f.run.proofReferencesJson[0].revision++;
    assert.throws(() => validateCheckoutClosureCandidate(f.run, f.rows));
  }
});
test("old and new checkout observations cannot be swapped or replayed across a closure generation", () => {
  const f = fixture();
  f.run.closureGeneration = 3;
  const old = f.rows.find(
    (row) => row.expectedJson.scenario === "old-checkout-blocked",
  );
  const fresh = f.rows.find(
    (row) => row.expectedJson.scenario === "new-checkout-blocked",
  );
  const payload = { sessionHash: "2".repeat(64), generation: 3 };
  assert.doesNotThrow(() =>
    assertClosedCheckoutSession(f.run, f.rows, old, payload),
  );
  assert.throws(() =>
    assertClosedCheckoutSession(f.run, f.rows, fresh, payload),
  );
  assert.throws(() =>
    assertClosedCheckoutSession(f.run, f.rows, old, {
      ...payload,
      sessionHash: "3".repeat(64),
    }),
  );
  assert.doesNotThrow(() =>
    assertClosedCheckoutSession(f.run, f.rows, fresh, {
      ...payload,
      sessionHash: "3".repeat(64),
    }),
  );
  assert.throws(() =>
    assertClosedCheckoutSession(f.run, f.rows, old, {
      ...payload,
      generation: 2,
    }),
  );
});
test("CONTRACT_ONLY artifact cannot certify a managed checkout verifier or trigger external reads", async () => {
  const f = fixture();
  let network = 0;
  const prismaClient = {
    operationalReadinessAttestation: {
      findUnique: async () => ({ metadataJson: { runId: "deployment" } }),
    },
    internationalCheckoutVerificationRun: {
      findFirst: async () => ({
        resultsJson: {
          manifest: { checkoutVerifier: { level: "CONTRACT_ONLY" } },
        },
      }),
    },
  };
  await assert.rejects(
    inspectInternationalCheckoutCloseContext(
      { prismaClient, run: f.run, phase: "OPEN" },
      {
        graphQL: async () => {
          network++;
        },
        inspectContext: async () => {
          network++;
        },
      },
    ),
  );
  assert.equal(network, 0);
});

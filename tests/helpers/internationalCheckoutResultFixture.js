import { generateKeyPairSync } from "node:crypto";
import { checkoutInventoryFixture } from "./internationalCheckoutFixture.js";
import { collectInternationalCheckoutInventory } from "../../app/services/internationalCheckoutInventory.server.js";
import { buildInternationalCheckoutPlan } from "../../app/services/internationalCheckoutPlan.server.js";
import {
  checkoutPlanSummary,
  CHECKOUT_RESULT_VERSION,
} from "../../app/utils/internationalCheckoutResults.js";
import {
  proofHash,
  signProofPayload,
} from "../../app/utils/internationalProofContract.js";
import { hashInternationalSecret } from "../../app/services/internationalAuthorizationPolicy.server.js";

export function internationalCheckoutResultFixture(
  shopDomain = "results.myshopify.com",
  now = new Date(),
) {
  const source = checkoutInventoryFixture();
  const plan = buildInternationalCheckoutPlan({
    shopDomain,
    scope: source.scope,
    currencies: ["JPY"],
    releaseBinding: "a".repeat(64),
    sourceHash: "b".repeat(64),
    verificationKind: "NON_FINANCIAL",
    native: {
      available: true,
      validationReady: true,
      configHash: "c".repeat(64),
      verificationInventory: collectInternationalCheckoutInventory(source),
    },
  });
  const descriptor = {
    runnerDigest: "d".repeat(64),
    environment: "ISOLATED_STORE",
  };
  const keys = generateKeyPairSync("ed25519");
  const executorId = "system:international-checkout-verifier";
  const trust = {
    checkoutVerifier: [
      {
        id: "checkout-test",
        ...descriptor,
        executorId,
        publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
        notBefore: new Date(+now - 86400000).toISOString(),
        notAfter: new Date(+now + 86400000).toISOString(),
      },
    ],
  };
  const leaseToken = "e".repeat(64);
  const tag = proofHash(shopDomain).slice(0, 16);
  const run = {
    id: `checkout-run-${tag}`,
    shopDomain,
    kind: "NON_FINANCIAL",
    authorizationRequestId: `checkout-auth-${tag}`,
    initiatedBy: "shopify_user:1",
    executorId,
    scenarioVersion: plan.version,
    verifierVersion: plan.verifierVersion,
    scopeHash: plan.scopeHash,
    releaseBinding: plan.releaseBinding,
    nativeConfigHash: plan.nativeConfigHash,
    requiredCasesHash: plan.requiredCasesHash,
    proofReferencesJson: [
      {
        id: `checkout-proof-${tag}`,
        revision: 1,
        evidenceHash: "f".repeat(64),
      },
    ],
    startGeneration: 2,
    activeKey: `${shopDomain}:VERIFY`,
    status: "RUNNING",
    closureStatus: "PENDING",
    expiresAt: new Date(+now + 3600000),
    startedAt: new Date(+now - 1000),
    heartbeatAt: now,
    leaseTokenHash: hashInternationalSecret(leaseToken),
    leaseUntil: new Date(+now + 300000),
  };
  run.planSummaryJson = checkoutPlanSummary(plan, run, descriptor);
  const rows = plan.cases.map(({ caseKey, ...expectedJson }, ordinal) => ({
    id: `case-${tag}-${ordinal}`,
    shopDomain,
    runId: run.id,
    caseKey,
    ordinal,
    phase: expectedJson.phase,
    expectedJson,
    expectedHash: caseKey,
    status: "PENDING",
    challengeSequence: 1,
    challengeHash: proofHash({ ordinal }),
    challengeIssuedAt: now,
    challengeExpiresAt: new Date(+now + 60000),
    resultHash: null,
    resultJson: null,
    resultCode: null,
    recordedAt: null,
  }));
  const args = { shopDomain, runId: run.id, executorId, leaseToken };
  const result = (row, changes = {}, purpose = "checkoutVerifier") => {
    const summary = run.planSummaryJson;
    const payload = {
      v: CHECKOUT_RESULT_VERSION,
      shopDomain,
      runId: run.id,
      caseKey: row.caseKey,
      ...Object.fromEntries(
        [
          "planHash",
          "scopeHash",
          "releaseBinding",
          "nativeConfigHash",
          "sourceHash",
          "startGeneration",
          "runnerDigest",
          "environment",
        ].map((field) => [field, summary[field]]),
      ),
      executorId,
      generation:
        row.phase === "OPEN" ? run.startGeneration : run.closureGeneration,
      challengeHash: row.challengeHash,
      sequence: row.challengeSequence,
      observedAt: new Date(+row.challengeIssuedAt + 1).toISOString(),
      stage: row.expectedJson.expectedStage,
      outcome: row.expectedJson.expectedOutcome,
      evidenceHash: "1".repeat(64),
      sessionHash: "2".repeat(64),
      ...changes,
    };
    return signProofPayload(purpose, payload, "checkout-test", keys.privateKey);
  };
  return { plan, descriptor, trust, run, rows, args, result, keys, now };
}

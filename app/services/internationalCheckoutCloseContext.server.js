import {
  inspectInternationalAuthorizationContext,
  collectInternationalAuthorizationSource,
} from "./internationalAuthorizationContext.server.js";
import { inspectInternationalProofRuntime } from "./internationalProofRuntime.server.js";
import {
  proofHash,
  validateReceipt,
  INTERNATIONAL_PROOF_TRUST,
} from "../utils/internationalProofContract.js";
import { INTERNATIONAL_ARTIFACT_CASES } from "../utils/internationalCheckoutVerification.js";
import { closureError } from "../utils/internationalCheckoutClosure.js";
import { internationalGraphQL } from "./internationalGateTransport.server.js";

// The existing CONTRACT_ONLY package cannot certify the not-yet-shipped managed verifier.
export async function inspectInternationalCheckoutCloseContext(
  { prismaClient, run, phase },
  {
    env = process.env,
    graphQL = internationalGraphQL,
    trust = INTERNATIONAL_PROOF_TRUST,
    inspectContext = inspectInternationalAuthorizationContext,
    inspectRuntime = inspectInternationalProofRuntime,
    readSource = collectInternationalAuthorizationSource,
  } = {},
) {
  const started = Date.now(),
    deadline = started + 45000;
  const call = (args) => {
    const remaining = deadline - Date.now();
    if (remaining < 500) closureError();
    return graphQL({ ...args, timeoutMs: Math.min(10000, remaining) });
  };
  const proof = await prismaClient.operationalReadinessAttestation.findUnique({
    where: { id: run.proofReferencesJson?.[0]?.id || "" },
  });
  const deployment =
    proof &&
    (await prismaClient.internationalCheckoutVerificationRun.findFirst({
      where: {
        id: proof.metadataJson?.runId || "",
        shopDomain: run.shopDomain,
      },
    }));
  const verifier = deployment?.resultsJson?.manifest?.checkoutVerifier;
  if (
    verifier?.level !== "NON_FINANCIAL" ||
    verifier.digest !== run.planSummaryJson?.runnerDigest ||
    verifier.artifactCasesHash !== proofHash(INTERNATIONAL_ARTIFACT_CASES)
  )
    closureError();
  const auth =
    await prismaClient.internationalGateAuthorizationRequest.findFirst({
      where: { id: run.authorizationRequestId, shopDomain: run.shopDomain },
    });
  if (!auth || auth.revokedAt) closureError();
  const input = {
    purpose: "VERIFY",
    verificationKind: "NON_FINANCIAL",
    scope: auth.scopeJson,
    currencies: auth.currenciesJson,
  };
  const context = await inspectContext(
    { prismaClient, shopDomain: run.shopDomain, input, now: new Date(), env },
    { graphQL: call, proofOptions: { trust } },
  );
  const source = await readSource({
    prismaClient,
    shopDomain: run.shopDomain,
    input,
    context,
    expiresAt: run.expiresAt,
    now: new Date(),
  });
  if (
    !context.ready ||
    context.releaseBinding !== run.releaseBinding ||
    context.nativeConfigHash !== run.nativeConfigHash ||
    proofHash(context.proofReferences) !== proofHash(run.proofReferencesJson) ||
    !source.ready ||
    source.sourceHash !== auth.sourceHash
  )
    closureError();
  const { manifest, receipt: signedReceipt } = deployment.resultsJson;
  const receipt = validateReceipt(signedReceipt, {
    manifest,
    archiveHash: deployment.artifactHash,
    shopDomain: run.shopDomain,
    now: new Date(),
    trust,
  });
  const runtime = await inspectRuntime({
    shopDomain: run.shopDomain,
    manifest,
    receipt,
    generation:
      phase === "CLOSED" ? run.closureGeneration : run.startGeneration,
    closed: phase === "CLOSED",
    env,
    graphQL: call,
  });
  if (
    Date.now() >= deadline ||
    proofHash(runtime.dto) !== proofHash(deployment.resultsJson.runtime)
  )
    closureError();
  return {
    v: "international-checkout-runtime-v1",
    runId: run.id,
    shopDomain: run.shopDomain,
    planHash: run.requiredCasesHash,
    releaseBinding: run.releaseBinding,
    nativeConfigHash: run.nativeConfigHash,
    sourceHash: source.sourceHash,
    runnerDigest: verifier.digest,
    environment: run.planSummaryJson.environment,
    proofReferencesHash: proofHash(run.proofReferencesJson),
    artifactHash: deployment.artifactHash,
    artifactReference: deployment.artifactReference,
    artifactExpiresAt: deployment.artifactExpiresAt.toISOString(),
    artifactCasesHash: verifier.artifactCasesHash,
    observedAt: new Date(started).toISOString(),
    phase,
    generation:
      phase === "CLOSED" ? run.closureGeneration : run.startGeneration,
    gateHash: phase === "CLOSED" ? runtime.closedShopHash : null,
  };
}

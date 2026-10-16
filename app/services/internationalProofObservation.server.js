import {
  internationalAuthorizationTransaction,
  assertInternationalShop,
  newInternationalSecret,
  hashInternationalSecret,
} from "./internationalAuthorizationPolicy.server.js";
import {
  proofError,
  validateReceipt,
  validateObservation,
  INTERNATIONAL_PROOF_TRUST,
} from "../utils/internationalProofContract.js";

// Internal commands only. 4B-3 must authenticate the dedicated observer before use.
export async function requestInternationalProofObservation({
  prismaClient,
  shopDomain,
  runId,
}) {
  assertInternationalShop(shopDomain);
  const nonce = newInternationalSecret();
  await internationalAuthorizationTransaction(prismaClient, async (tx, now) => {
    const run = await tx.internationalCheckoutVerificationRun.findFirst({
      where: { id: runId, shopDomain },
    });
    if (
      !run ||
      run.kind !== "DEPLOYMENT" ||
      run.status !== "PASSED" ||
      run.revokedAt
    )
      throw proofError("international_run_unavailable", 409);
    await tx.internationalCheckoutVerificationRun.update({
      where: { id: runId },
      data: {
        observationNonceHash: hashInternationalSecret(nonce),
        observationRequestedAt: now,
      },
    });
  });
  return { runId, nonce };
}
export async function recordInternationalProofObservation(
  { prismaClient, shopDomain, runId, observation },
  { trust = INTERNATIONAL_PROOF_TRUST } = {},
) {
  assertInternationalShop(shopDomain);
  return internationalAuthorizationTransaction(
    prismaClient,
    async (tx, now) => {
      const run = await tx.internationalCheckoutVerificationRun.findFirst({
        where: { id: runId, shopDomain },
      });
      if (
        !run ||
        run.kind !== "DEPLOYMENT" ||
        run.status !== "PASSED" ||
        run.revokedAt ||
        !run.observationNonceHash ||
        !run.observationRequestedAt ||
        now - run.observationRequestedAt > 60000
      )
        throw proofError("international_observation_unavailable", 409);
      const receipt = validateReceipt(run.resultsJson.receipt, {
        manifest: run.resultsJson.manifest,
        archiveHash: run.artifactHash,
        shopDomain,
        now,
        trust,
      });
      const p = validateObservation(observation, {
        receipt,
        runId,
        nonceHash: run.observationNonceHash,
        now,
        trust,
      });
      if (
        p.sequence <= (run.observationJson?.payload?.sequence || 0) ||
        new Date(p.observedAt) < run.observationRequestedAt
      )
        throw proofError("international_observation_replayed", 409);
      await tx.internationalCheckoutVerificationRun.update({
        where: { id: runId },
        data: {
          observationJson: observation,
          observedAt: new Date(p.observedAt),
          observationExpiresAt: new Date(p.expiresAt),
          observationNonceHash: null,
          observationRequestedAt: null,
        },
      });
      return { ok: true };
    },
  );
}

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
  proofHash,
  shape,
  INTERNATIONAL_PROOF_TRUST,
} from "../utils/internationalProofContract.js";
import { assertInternationalRunDelivery } from "./internationalProofDeliveryState.server.js";

// Internal commands only. 4B-3 must authenticate the dedicated observer before use.
export async function requestInternationalProofObservation({
  prismaClient,
  shopDomain,
  runId,
}) {
  assertInternationalShop(shopDomain);
  const nonce = newInternationalSecret();
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
        run.revokedAt
      )
        throw proofError("international_run_unavailable", 409);
      await assertInternationalRunDelivery(tx, run, now);
      if (
        run.observationRequestedAt &&
        now - run.observationRequestedAt < 60000
      )
        throw Object.assign(
          proofError("international_observation_pending", 409),
          { retryAfter: 5 },
        );
      if (!(await internationalObservationDue(tx, run, now)))
        throw proofError("international_observation_not_requested", 409);
      const sequence = (run.observationJson?.payload?.sequence || 0) + 1;
      if (!Number.isSafeInteger(sequence))
        throw proofError("international_observation_sequence_exhausted");
      await tx.internationalCheckoutVerificationRun.update({
        where: { id: runId },
        data: {
          observationNonceHash: hashInternationalSecret(nonce),
          observationRequestedAt: now,
        },
      });
      return { runId, nonce, sequence, receipt: run.resultsJson.receipt };
    },
  );
}
export async function recordInternationalProofObservation(
  { prismaClient, shopDomain, runId, observation },
  { trust = INTERNATIONAL_PROOF_TRUST } = {},
) {
  assertInternationalShop(shopDomain);
  shape(observation, ["keyId", "payload", "signature"], 32768);
  return internationalAuthorizationTransaction(
    prismaClient,
    async (tx, now) => {
      const run = await tx.internationalCheckoutVerificationRun.findFirst({
        where: { id: runId, shopDomain },
      });
      if (
        run?.status === "PASSED" &&
        !run.revokedAt &&
        proofHash(observation) === proofHash(run.observationJson)
      )
        return { ok: true, replayed: true, historical: true };
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
      await assertInternationalRunDelivery(tx, run, now);
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
        p.sequence !== (run.observationJson?.payload?.sequence || 0) + 1 ||
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
          observationRefreshRequestedAt: null,
          observationRetryAt: null,
          observationFailureCode: null,
        },
      });
      return { ok: true };
    },
  );
}

export async function internationalObservationDue(tx, run, now) {
  if (run.observationFailureCode === "international_deployment_changed")
    return false;
  if (run.observationRetryAt && run.observationRetryAt > now) return false;
  if (run.observationRefreshRequestedAt) return true;
  if (run.observedAt && now - run.observedAt < 300000) return false;
  const state = await tx.internationalGateSyncState.findUnique({
    where: { shopDomain: run.shopDomain },
  });
  if (state?.mode !== "ENFORCE") return false;
  const proof = await tx.operationalReadinessAttestation.findUnique({
    where: {
      checkKey_scopeType_scopeId: {
        checkKey: "INTERNATIONAL_CHECKOUT_DEPLOYMENT_VERIFIED",
        scopeType: "SHOP",
        scopeId: run.shopDomain,
      },
    },
  });
  return (
    proof?.status === "CONFIRMED" &&
    proof.expiresAt > now &&
    proof.metadataJson?.runId === run.id
  );
}

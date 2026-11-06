import prisma from "../db.server.js";
import { assertInternationalRunDelivery } from "./internationalProofDeliveryState.server.js";
import {
  INTERNATIONAL_DEPLOYMENT_EVIDENCE_KEY,
  INTERNATIONAL_RELEASE_EVIDENCE_KEY,
} from "./internationalAuthorizationPolicy.server.js";
import {
  createInternationalProofGitHub,
  inspectProofArtifactMetadata,
} from "./internationalProofGitHub.server.js";
import {
  inspectInternationalProofRuntime,
  internationalReleaseBinding,
} from "./internationalProofRuntime.server.js";
import {
  proofHash,
  validateReceipt,
  validateObservation,
  PROOF_VERSION,
  PROOF_VALIDITY,
  INTERNATIONAL_PROOF_TRUST,
} from "../utils/internationalProofContract.js";

export async function inspectInternationalAuthorizationProof(
  {
    shopDomain,
    input,
    purpose,
    prismaClient = prisma,
    now = new Date(),
    graphQL,
    env = process.env,
    state,
  },
  {
    trust = INTERNATIONAL_PROOF_TRUST,
    github = createInternationalProofGitHub({
      token: env.INTERNATIONAL_PROOF_GITHUB_READ_TOKEN,
    }),
    inspectRuntime = inspectInternationalProofRuntime,
  } = {},
) {
  const effective =
    input?.purpose === "RESUME"
      ? input.resumePurpose
      : input?.purpose || purpose;
  if (!["DEPLOYMENT", "VERIFY", "SALE"].includes(effective))
    return { ready: false, reason: "international_proof_level_invalid" };
  // 4C has no accepted result schema/coverage verifier yet.
  if (effective === "SALE")
    return {
      ready: false,
      reason: "international_verification_not_implemented",
    };
  try {
    const row = await prismaClient.operationalReadinessAttestation.findUnique({
      where: {
        checkKey_scopeType_scopeId: {
          checkKey: INTERNATIONAL_DEPLOYMENT_EVIDENCE_KEY,
          scopeType: "SHOP",
          scopeId: shopDomain,
        },
      },
    });
    if (
      !row ||
      row.status !== "CONFIRMED" ||
      row.confirmedBy !== "system:international-checkout-verifier" ||
      !row.confirmedAt ||
      row.confirmedAt > now ||
      !row.expiresAt ||
      row.expiresAt <= now ||
      row.metadataJson?.v !== PROOF_VERSION ||
      row.metadataJson.validity !== PROOF_VALIDITY
    )
      return { ready: false, reason: "international_proof_expired" };
    const run =
      await prismaClient.internationalCheckoutVerificationRun.findFirst({
        where: { id: row.metadataJson.runId, shopDomain },
      });
    const result = run?.resultsJson;
    if (
      !run ||
      run.kind !== "DEPLOYMENT" ||
      run.status !== "PASSED" ||
      run.revokedAt ||
      run.closureStatus !== "CONFIRMED" ||
      run.completedAt > run.expiresAt ||
      !result ||
      proofHash(result) !== row.evidenceHash ||
      row.evidenceReference !== `international-run:${run.id}` ||
      result.expiresAt !== row.expiresAt.toISOString()
    )
      return { ready: false, reason: "international_proof_revoked" };
    const { manifest, receipt: signedReceipt, runtime } = result;
    await assertInternationalRunDelivery(prismaClient, run, now);
    if (run.observationFailureCode === "international_deployment_changed")
      return { ready: false, reason: "international_deployment_changed" };
    const receipt = validateReceipt(signedReceipt, {
      manifest,
      archiveHash: run.artifactHash,
      shopDomain,
      now,
      trust,
    });
    const metadata = await inspectProofArtifactMetadata({
      artifactId: receipt.artifactId,
      manifest,
      now,
      github,
    });
    if (
      metadata.archiveHash !== run.artifactHash ||
      metadata.reference !== run.artifactReference ||
      metadata.expiresAt < row.expiresAt
    )
      return { ready: false, reason: "international_artifact_untrusted" };
    validateObservation(run.observationJson, {
      receipt,
      runId: run.id,
      now,
      maxAgeMs: state ? 900000 : 60000,
      trust,
    });
    const surfaces =
      await prismaClient.operationalReadinessAttestation.findUnique({
        where: { id: result.surface.id },
      });
    if (
      !surfaces ||
      surfaces.checkKey !== "UNSUPPORTED_SALES_SURFACES_DISABLED" ||
      surfaces.scopeType !== "SHOP" ||
      surfaces.scopeId !== shopDomain ||
      surfaces.status !== "CONFIRMED" ||
      surfaces.revision !== result.surface.revision ||
      surfaces.evidenceHash !== result.surface.evidenceHash ||
      !surfaces.expiresAt ||
      surfaces.expiresAt < row.expiresAt ||
      !surfaces.confirmedAt ||
      surfaces.confirmedAt > now
    )
      return { ready: false, reason: "international_proof_revoked" };
    const current = await inspectRuntime({
      shopDomain,
      manifest,
      receipt,
      graphQL,
      env,
    });
    if (
      proofHash(current.dto) !== proofHash(runtime) ||
      internationalReleaseBinding(manifest, receipt, current.dto) !==
        run.releaseBinding
    )
      return { ready: false, reason: "international_deployment_changed" };
    return {
      ready: true,
      binding: run.releaseBinding,
      releaseBinding: run.releaseBinding,
      scenarioVersion: run.scenarioVersion,
      verifierVersion: run.verifierVersion,
      requiredCasesHash: run.requiredCasesHash,
      proofReferences: [
        { id: row.id, revision: row.revision, evidenceHash: row.evidenceHash },
      ],
      expiresAt: row.expiresAt,
      observedAt: new Date(run.observedAt),
      key: INTERNATIONAL_DEPLOYMENT_EVIDENCE_KEY,
    };
  } catch {
    return { ready: false, reason: "international_system_proof_unavailable" };
  }
}

export { INTERNATIONAL_RELEASE_EVIDENCE_KEY };

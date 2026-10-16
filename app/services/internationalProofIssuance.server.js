import prisma from "../db.server.js";
import { requirePostRequest } from "../utils/internalRouteSecurity.server.js";
import {
  proofHash,
  proofError,
  shape,
  PROOF_VERSION,
  PROOF_VALIDITY,
  DEPLOYMENT_CASES,
  INTERNATIONAL_PROOF_TRUST,
  validateReceipt,
  verifyProofSignature,
  validateObservation,
} from "../utils/internationalProofContract.js";
import {
  internationalAuthorizationTransaction,
  assertInternationalShop,
  newInternationalSecret,
  hashInternationalSecret,
  matchesInternationalSecret,
  INTERNATIONAL_DEPLOYMENT_EVIDENCE_KEY,
  INTERNATIONAL_SYSTEM_EVIDENCE_KEYS,
} from "./internationalAuthorizationPolicy.server.js";
import { stopInternationalGateInTransaction } from "./internationalGateQueue.server.js";
import {
  createInternationalProofGitHub,
  verifyInternationalProofArtifact,
  inspectProofArtifactMetadata,
} from "./internationalProofGitHub.server.js";
import {
  inspectInternationalProofRuntime,
  internationalReleaseBinding,
} from "./internationalProofRuntime.server.js";
import {
  readInternationalMetafield,
  writeInternationalMetafield,
  internationalGraphQL,
} from "./internationalGateTransport.server.js";
import { closedInternationalGate } from "./internationalGateProjection.server.js";

export async function readDeploymentSurfaceEvidence(
  tx,
  shopDomain,
  now,
  expected,
) {
  const row = await tx.operationalReadinessAttestation.findUnique({
    where: {
      checkKey_scopeType_scopeId: {
        checkKey: "UNSUPPORTED_SALES_SURFACES_DISABLED",
        scopeType: "SHOP",
        scopeId: shopDomain,
      },
    },
  });
  if (
    !row ||
    row.status !== "CONFIRMED" ||
    !row.confirmedAt ||
    row.confirmedAt > now ||
    !row.confirmedBy ||
    !row.evidenceHash ||
    !row.evidenceReference ||
    !row.expiresAt ||
    row.expiresAt <= now ||
    (expected &&
      (expected.id !== row.id ||
        expected.revision !== row.revision ||
        expected.evidenceHash !== row.evidenceHash))
  )
    throw proofError("international_surface_evidence_unverified");
  return row;
}
const ref = (row) => ({
  id: row.id,
  revision: row.revision,
  evidenceHash: row.evidenceHash,
});

export function createInternationalProofCommands({
  requireOperator,
  prismaClient = prisma,
  github = createInternationalProofGitHub({
    token: process.env.INTERNATIONAL_PROOF_GITHUB_READ_TOKEN,
  }),
  trust = INTERNATIONAL_PROOF_TRUST,
  graphQL = internationalGraphQL,
  inspectRuntime = inspectInternationalProofRuntime,
  env = process.env,
} = {}) {
  if (typeof requireOperator !== "function")
    throw new TypeError("requireOperator required");
  async function identity(request, role) {
    requirePostRequest(request);
    const actor = await requireOperator(request, { role });
    const shopDomain = actor.session?.shop;
    assertInternationalShop(shopDomain);
    if (!/^shopify_(user|email):.{1,200}$/.test(actor.operator?.actorKey || ""))
      throw proofError("international_operator_required", 403);
    return { shopDomain, actorKey: actor.operator.actorKey };
  }
  return {
    async prepare(request, input) {
      const actor = await identity(request, "RELEASE_MANAGER");
      shape(input, ["artifactId", "receipt"], 32000);
      const time = new Date();
      verifyProofSignature(input.receipt, "publisher", time, trust);
      const artifact = await verifyInternationalProofArtifact({
        artifactId: input.artifactId,
        now: time,
        github,
      });
      const receipt = validateReceipt(input.receipt, {
        manifest: artifact.manifest,
        archiveHash: artifact.archiveHash,
        ...actor,
        now: time,
        trust,
      });
      if (receipt.artifactId !== input.artifactId) throw proofError();
      const runtime = await inspectRuntime({
        ...actor,
        manifest: artifact.manifest,
        receipt,
        graphQL,
        env,
      });
      return internationalAuthorizationTransaction(
        prismaClient,
        async (tx, now) => {
          const surface = await readDeploymentSurfaceEvidence(
            tx,
            actor.shopDomain,
            now,
          );
          if (
            await tx.internationalCheckoutVerificationRun.findFirst({
              where: {
                shopDomain: actor.shopDomain,
                OR: [
                  { activeKey: `${actor.shopDomain}:DEPLOYMENT` },
                  {
                    kind: { in: ["NON_FINANCIAL", "FINANCIAL"] },
                    status: { in: ["QUEUED", "RUNNING"] },
                  },
                ],
              },
            })
          )
            throw proofError("international_run_still_active", 409);
          if (now - time > 60000 || new Date(receipt.allowedUseUntil) <= now)
            throw proofError("international_deployment_unverified");
          const { generation } = await stopInternationalGateInTransaction(tx, {
            ...actor,
            now,
            reason: "international_deployment_preparation",
          });
          const run = await tx.internationalCheckoutVerificationRun.create({
            data: {
              shopDomain: actor.shopDomain,
              kind: "DEPLOYMENT",
              initiatedBy: actor.actorKey,
              scenarioVersion: "international-deployment-v1",
              verifierVersion: PROOF_VERSION,
              scopeHash: proofHash({
                shopDomain: actor.shopDomain,
                deploymentDigest: artifact.manifest.deploymentDigest,
              }),
              releaseBinding: internationalReleaseBinding(
                artifact.manifest,
                receipt,
                runtime.dto,
              ),
              nativeConfigHash: runtime.nativeConfigHash,
              proofReferencesJson: [ref(surface)],
              requiredCasesHash: proofHash(DEPLOYMENT_CASES),
              startGeneration: generation,
              activeKey: `${actor.shopDomain}:DEPLOYMENT`,
              expiresAt: new Date(now.getTime() + 1800000),
              artifactReference: artifact.reference,
              artifactHash: artifact.archiveHash,
              artifactExpiresAt: artifact.expiresAt,
              resultsJson: {
                v: PROOF_VERSION,
                manifest: artifact.manifest,
                receipt: input.receipt,
                runtime: runtime.dto,
                surface: ref(surface),
              },
            },
          });
          return { ok: true, pending: true, runId: run.id, generation };
        },
      );
    },
    async revoke(request, input) {
      const actor = await identity(request, "COMPLIANCE_REVIEWER");
      shape(input, ["runId", "resultDigest", "expectedProof"], 32000);
      return internationalAuthorizationTransaction(
        prismaClient,
        async (tx, now) => {
          const run = await tx.internationalCheckoutVerificationRun.findFirst({
            where: { id: input.runId, shopDomain: actor.shopDomain },
          });
          if (
            !run ||
            !run.resultsJson ||
            proofHash(run.resultsJson) !== input.resultDigest
          )
            throw proofError("international_proof_changed", 409);
          const rows = await tx.operationalReadinessAttestation.findMany({
            where: {
              scopeType: "SHOP",
              scopeId: actor.shopDomain,
              checkKey: { in: INTERNATIONAL_SYSTEM_EVIDENCE_KEYS },
            },
          });
          const direct = rows.find((r) => r.metadataJson?.runId === run.id);
          if (
            proofHash(direct ? ref(direct) : null) !==
            proofHash(input.expectedProof)
          )
            throw proofError("international_proof_changed", 409);
          if (run.revokedAt) return { ok: true, replayed: true };
          await tx.internationalCheckoutVerificationRun.update({
            where: { id: run.id },
            data: {
              revokedAt: now,
              revokedBy: actor.actorKey,
              revocationReason: "international_proof_revoked",
            },
          });
          let affected = false;
          for (const row of rows)
            if (
              row.metadataJson?.runId === run.id ||
              row.metadataJson?.runReferences?.includes(run.id)
            ) {
              await tx.operationalReadinessAttestation.update({
                where: { id: row.id },
                data: { status: "REVOKED", revision: { increment: 1 } },
              });
              affected = true;
            }
          if (affected)
            await stopInternationalGateInTransaction(tx, {
              ...actor,
              now,
              reason: "international_proof_revoked",
            });
          return { ok: true, pending: affected };
        },
      );
    },
  };
}

function assertDeploymentLease(
  run,
  state,
  { shopDomain, executorId, leaseToken },
  now,
) {
  if (
    !run ||
    run.shopDomain !== shopDomain ||
    run.kind !== "DEPLOYMENT" ||
    run.status !== "RUNNING" ||
    run.revokedAt ||
    run.executorId !== executorId ||
    executorId !== "system:international-deployment-verifier" ||
    run.expiresAt <= now ||
    !run.leaseUntil ||
    run.leaseUntil <= now ||
    !matchesInternationalSecret(leaseToken, run.leaseTokenHash) ||
    state?.mode !== "STOPPED" ||
    state.desiredGeneration !== run.startGeneration
  )
    throw proofError("international_run_lease_invalid", 409);
}
export async function claimInternationalDeploymentRun({
  prismaClient,
  shopDomain,
  runId,
}) {
  assertInternationalShop(shopDomain);
  const token = newInternationalSecret();
  const nonce = newInternationalSecret();
  await internationalAuthorizationTransaction(prismaClient, async (tx, now) => {
    const run = await tx.internationalCheckoutVerificationRun.findFirst({
      where: { id: runId, shopDomain },
    });
    const state = await tx.internationalGateSyncState.findUnique({
      where: { shopDomain },
    });
    if (
      !run ||
      run.kind !== "DEPLOYMENT" ||
      run.status !== "QUEUED" ||
      run.revokedAt ||
      run.expiresAt <= now ||
      state?.mode !== "STOPPED" ||
      state.desiredGeneration !== run.startGeneration
    )
      throw proofError("international_run_unavailable", 409);
    await tx.internationalCheckoutVerificationRun.update({
      where: { id: run.id },
      data: {
        status: "RUNNING",
        executorId: "system:international-deployment-verifier",
        startedAt: now,
        heartbeatAt: now,
        leaseTokenHash: hashInternationalSecret(token),
        leaseUntil: new Date(Math.min(+now + 300000, +run.expiresAt)),
        observationNonceHash: hashInternationalSecret(nonce),
        observationRequestedAt: now,
      },
    });
  });
  return { runId, leaseToken: token, observationNonce: nonce };
}

export async function completeInternationalDeploymentRun(
  args,
  {
    trust = INTERNATIONAL_PROOF_TRUST,
    github = createInternationalProofGitHub(),
    graphQL = internationalGraphQL,
    inspectRuntime = inspectInternationalProofRuntime,
    env = process.env,
  } = {},
) {
  const { prismaClient, shopDomain, runId, observation } = args;
  assertInternationalShop(shopDomain);
  const run = await prismaClient.internationalCheckoutVerificationRun.findFirst(
    { where: { id: runId, shopDomain } },
  );
  const state = await prismaClient.internationalGateSyncState.findUnique({
    where: { shopDomain },
  });
  const time = new Date();
  if (
    run?.status === "PASSED" &&
    !run.revokedAt &&
    args.executorId === "system:international-deployment-verifier" &&
    proofHash(observation) === proofHash(run.observationJson)
  )
    return {
      ok: true,
      runId,
      replayed: true,
      historical: true,
      saleReady: false,
    };
  assertDeploymentLease(run, state, args, time);
  const { manifest, receipt: signedReceipt } = run.resultsJson;
  const receipt = validateReceipt(signedReceipt, {
    manifest,
    archiveHash: run.artifactHash,
    shopDomain,
    now: time,
    trust,
  });
  const observed = validateObservation(observation, {
    receipt,
    runId,
    nonceHash: run.observationNonceHash,
    now: time,
    trust,
  });
  if (new Date(observed.observedAt) < run.observationRequestedAt)
    throw proofError("international_deployment_unverified");
  const metadata = await inspectProofArtifactMetadata({
    artifactId: receipt.artifactId,
    manifest,
    now: time,
    github,
  });
  if (
    metadata.archiveHash !== run.artifactHash ||
    metadata.reference !== run.artifactReference
  )
    throw proofError();
  const assertCurrent = async () =>
    assertDeploymentLease(
      await prismaClient.internationalCheckoutVerificationRun.findUnique({
        where: { id: runId },
      }),
      await prismaClient.internationalGateSyncState.findUnique({
        where: { shopDomain },
      }),
      args,
      new Date(),
    );
  const shop = await readInternationalMetafield({
    shopDomain,
    targetType: "SHOP",
    graphQL,
  });
  await writeInternationalMetafield({
    shopDomain,
    targetType: "SHOP",
    graphQL,
    assertCurrent,
    projection: closedInternationalGate(
      run.startGeneration,
      new Date(),
      shop.timezone,
    ),
  });
  const runtime = await inspectRuntime({
    shopDomain,
    manifest,
    receipt,
    generation: run.startGeneration,
    closed: true,
    graphQL,
    env,
  });
  if (
    proofHash(runtime.dto) !== proofHash(run.resultsJson.runtime) ||
    internationalReleaseBinding(manifest, receipt, runtime.dto) !==
      run.releaseBinding
  )
    throw proofError("international_deployment_changed");
  return internationalAuthorizationTransaction(
    prismaClient,
    async (tx, now) => {
      const current = await tx.internationalCheckoutVerificationRun.findUnique({
        where: { id: runId },
      });
      const liveState = await tx.internationalGateSyncState.findUnique({
        where: { shopDomain },
      });
      assertDeploymentLease(current, liveState, args, now);
      if (
        now - time > 60000 ||
        proofHash(current.resultsJson) !== proofHash(run.resultsJson)
      )
        throw proofError("international_deployment_unverified");
      validateReceipt(signedReceipt, {
        manifest,
        archiveHash: run.artifactHash,
        shopDomain,
        now,
        trust,
      });
      validateObservation(observation, {
        receipt,
        runId,
        nonceHash: current.observationNonceHash,
        now,
        trust,
      });
      const surface = await readDeploymentSurfaceEvidence(
        tx,
        shopDomain,
        now,
        run.resultsJson.surface,
      );
      const expiresAt = new Date(
        Math.min(
          +now + 30 * 86400000,
          +metadata.expiresAt - 3600000,
          +surface.expiresAt,
          Date.parse(receipt.allowedUseUntil),
        ),
      );
      if (expiresAt <= now) throw proofError("international_proof_expired");
      const result = {
        ...run.resultsJson,
        validity: PROOF_VALIDITY,
        expiresAt: expiresAt.toISOString(),
        cases: DEPLOYMENT_CASES,
      };
      if (Buffer.byteLength(JSON.stringify(result)) > 262144)
        throw proofError("international_proof_result_limit");
      const key = {
        checkKey: INTERNATIONAL_DEPLOYMENT_EVIDENCE_KEY,
        scopeType: "SHOP",
        scopeId: shopDomain,
      };
      await tx.internationalCheckoutVerificationRun.update({
        where: { id: runId },
        data: {
          status: "PASSED",
          outcomeCode: "PASSED",
          closureStatus: "CONFIRMED",
          closureGeneration: run.startGeneration,
          closedAt: now,
          completedAt: now,
          activeKey: null,
          leaseTokenHash: null,
          leaseUntil: null,
          resultsJson: result,
          observationJson: observation,
          observedAt: new Date(observed.observedAt),
          observationExpiresAt: new Date(observed.expiresAt),
          observationNonceHash: null,
          observationRequestedAt: null,
        },
      });
      await tx.operationalReadinessAttestation.upsert({
        where: { checkKey_scopeType_scopeId: key },
        create: {
          ...key,
          status: "CONFIRMED",
          confirmedBy: "system:international-checkout-verifier",
          confirmedAt: now,
          expiresAt,
          evidenceReference: `international-run:${runId}`,
          evidenceHash: proofHash(result),
          metadataJson: { v: PROOF_VERSION, validity: PROOF_VALIDITY, runId },
        },
        update: {
          status: "CONFIRMED",
          confirmedBy: "system:international-checkout-verifier",
          confirmedAt: now,
          expiresAt,
          evidenceReference: `international-run:${runId}`,
          evidenceHash: proofHash(result),
          revision: { increment: 1 },
          metadataJson: { v: PROOF_VERSION, validity: PROOF_VALIDITY, runId },
        },
      });
      return { ok: true, runId, expiresAt, saleReady: false };
    },
  );
}

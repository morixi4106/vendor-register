import {
  assertInternationalShop,
  internationalAuthorizationTransaction,
  matchesInternationalSecret,
  newInternationalSecret,
  hashInternationalSecret,
  INTERNATIONAL_DEPLOYMENT_EVIDENCE_KEY,
} from "./internationalAuthorizationPolicy.server.js";
import {
  HASH,
  ID,
  INTERNATIONAL_PROOF_TRUST,
  proofError,
  proofHash,
  verifyProofSignature,
} from "../utils/internationalProofContract.js";
import {
  CHECKOUT_CHALLENGE_MS,
  checkoutCaseExpected,
  checkoutPlanSummary,
  validateCheckoutSummary,
  validateCheckoutCaseResult,
  inspectCheckoutCaseSet,
} from "../utils/internationalCheckoutResults.js";
import {
  INTERNATIONAL_CHECKOUT_SCENARIOS,
  INTERNATIONAL_CHECKOUT_VERIFIER,
} from "../utils/internationalCheckoutVerification.js";
import { assertInternationalRunDelivery } from "./internationalProofDeliveryState.server.js";

function unavailable() {
  throw proofError("international_checkout_run_unavailable", 409);
}
export function assertCheckoutResultArgs(args) {
  assertInternationalShop(args.shopDomain);
  if (
    !ID.test(args.runId || "") ||
    args.executorId !== "system:international-checkout-verifier"
  )
    unavailable();
}
export async function readCheckoutResultRun(tx, args) {
  const run = await tx.internationalCheckoutVerificationRun.findFirst({
    where: { id: args.runId, shopDomain: args.shopDomain },
  });
  if (
    !run ||
    run.kind !== "NON_FINANCIAL" ||
    run.scenarioVersion !== INTERNATIONAL_CHECKOUT_SCENARIOS ||
    run.verifierVersion !== INTERNATIONAL_CHECKOUT_VERIFIER
  )
    unavailable();
  return run;
}
export async function assertCurrentCheckoutRun(tx, args, run, now) {
  const state = await tx.internationalGateSyncState.findUnique({
    where: { shopDomain: args.shopDomain },
  });
  const auth = await assertCheckoutDependencies(tx, run, now);
  if (
    run.status !== "RUNNING" ||
    run.revokedAt ||
    run.executorId !== args.executorId ||
    run.expiresAt <= now ||
    !run.leaseUntil ||
    run.leaseUntil <= now ||
    !matchesInternationalSecret(args.leaseToken, run.leaseTokenHash) ||
    !auth ||
    auth.shopDomain !== args.shopDomain ||
    !auth.consumedAt ||
    auth.revokedAt ||
    (auth.purpose === "RESUME" ? auth.resumePurpose : auth.purpose) !==
      "VERIFY" ||
    auth.verificationKind !== run.kind ||
    auth.effectiveExpiresAt < run.expiresAt ||
    auth.consumedGeneration !== run.startGeneration ||
    auth.scopeHash !== run.scopeHash ||
    auth.releaseBinding !== run.releaseBinding ||
    auth.nativeConfigHash !== run.nativeConfigHash ||
    state?.mode !== "ENFORCE" ||
    state.phase !== "ACTIVE" ||
    !state.snapshotComplete ||
    state.desiredGeneration !== run.startGeneration ||
    state.appliedGeneration !== run.startGeneration ||
    state.verificationRunId !== run.id ||
    state.authorizationRequestId !== auth.id ||
    state.authorizedScopeHash !== run.scopeHash ||
    state.releaseBinding !== run.releaseBinding ||
    state.nativeConfigHash !== run.nativeConfigHash ||
    state.sourceHash !== auth.sourceHash ||
    !HASH.test(auth.sourceHash || "") ||
    state.authorizationExpiresAt < run.expiresAt ||
    !state.verifiedAt ||
    state.verifiedAt > now
  )
    unavailable();
  return auth;
}
export async function assertCheckoutDependencies(tx, run, now) {
  const auth =
    run.authorizationRequestId &&
    (await tx.internationalGateAuthorizationRequest.findUnique({
      where: { id: run.authorizationRequestId },
    }));
  if (
    !auth ||
    auth.shopDomain !== run.shopDomain ||
    !auth.consumedAt ||
    auth.revokedAt ||
    auth.effectiveExpiresAt <= now ||
    auth.effectiveExpiresAt < run.expiresAt ||
    auth.consumedGeneration !== run.startGeneration ||
    auth.scopeHash !== run.scopeHash ||
    auth.releaseBinding !== run.releaseBinding ||
    auth.nativeConfigHash !== run.nativeConfigHash ||
    auth.verificationKind !== run.kind ||
    (auth.purpose === "RESUME" ? auth.resumePurpose : auth.purpose) !== "VERIFY"
  )
    unavailable();
  const references = run.proofReferencesJson;
  if (
    !Array.isArray(references) ||
    !references.length ||
    references.length > 32 ||
    new Set(references.map((ref) => ref.id)).size !== references.length ||
    proofHash(references) !== proofHash(auth.proofReferencesJson)
  )
    unavailable();
  for (const ref of references) {
    const proof = await tx.operationalReadinessAttestation.findUnique({
      where: { id: ref.id },
    });
    if (
      !proof ||
      proof.scopeType !== "SHOP" ||
      proof.scopeId !== run.shopDomain ||
      proof.checkKey !== INTERNATIONAL_DEPLOYMENT_EVIDENCE_KEY ||
      proof.status !== "CONFIRMED" ||
      proof.confirmedBy !== "system:international-checkout-verifier" ||
      proof.revision !== ref.revision ||
      proof.evidenceHash !== ref.evidenceHash ||
      !proof.confirmedAt ||
      proof.confirmedAt > now ||
      !proof.expiresAt ||
      proof.expiresAt < run.expiresAt
    )
      unavailable();
    const deployment =
      ID.test(proof.metadataJson?.runId || "") &&
      (await tx.internationalCheckoutVerificationRun.findFirst({
        where: { id: proof.metadataJson.runId, shopDomain: run.shopDomain },
      }));
    if (
      !deployment ||
      deployment.kind !== "DEPLOYMENT" ||
      deployment.status !== "PASSED" ||
      deployment.revokedAt ||
      deployment.closureStatus !== "CONFIRMED" ||
      deployment.expiresAt < run.expiresAt ||
      deployment.releaseBinding !== run.releaseBinding
    )
      unavailable();
    await assertInternationalRunDelivery(tx, deployment, now);
  }
  if (
    run.planSummaryJson &&
    validateCheckoutSummary(run.planSummaryJson, run).sourceHash !==
      auth.sourceHash
  )
    unavailable();
  return auth;
}
export function assertCheckoutExecutor(summary, executorId, now, trust) {
  const eligible = trust.checkoutVerifier?.filter(
    (key) =>
      !key.revokedAt &&
      key.executorId === executorId &&
      key.runnerDigest === summary.runnerDigest &&
      key.environment === summary.environment &&
      Number.isFinite(Date.parse(key.notBefore)) &&
      Number.isFinite(Date.parse(key.notAfter)) &&
      new Date(key.notBefore) <= now &&
      new Date(key.notAfter) > now,
  );
  if (!eligible?.length)
    throw proofError("international_checkout_executor_untrusted", 403);
}
const caseWhere = (args) => ({
  shopDomain: args.shopDomain,
  runId: args.runId,
});
export const readCheckoutCases = (tx, args) =>
  tx.internationalCheckoutVerificationCase.findMany({
    where: caseWhere(args),
    orderBy: { ordinal: "asc" },
    take: 2049,
  });

// Internal server operations only. There is deliberately no HTTP route or default trust key yet.
export function createInternationalCheckoutResultCommands({
  prismaClient,
  trust = INTERNATIONAL_PROOF_TRUST,
} = {}) {
  return {
    async initialize(args, plan, descriptor) {
      assertCheckoutResultArgs(args);
      return internationalAuthorizationTransaction(
        prismaClient,
        async (tx, now) => {
          const run = await readCheckoutResultRun(tx, args);
          const auth = await assertCurrentCheckoutRun(tx, args, run, now);
          const summary = checkoutPlanSummary(plan, run, descriptor);
          if (summary.sourceHash !== auth.sourceHash) unavailable();
          assertCheckoutExecutor(summary, args.executorId, now, trust);
          if (run.planSummaryJson) {
            if (proofHash(run.planSummaryJson) !== proofHash(summary))
              unavailable();
            inspectCheckoutCaseSet(run, await readCheckoutCases(tx, args));
            return { ok: true, replayed: true, caseCount: summary.caseCount };
          }
          if (
            await tx.internationalCheckoutVerificationCase.count({
              where: caseWhere(args),
            })
          )
            unavailable();
          await tx.internationalCheckoutVerificationRun.update({
            where: { id: run.id },
            data: { planSummaryJson: summary },
          });
          await tx.internationalCheckoutVerificationCase.createMany({
            data: plan.cases.map((row, ordinal) => ({
              ...caseWhere(args),
              ordinal,
              caseKey: row.caseKey,
              phase: row.phase,
              expectedJson: checkoutCaseExpected(row),
              expectedHash: row.caseKey,
            })),
          });
          return { ok: true, replayed: false, caseCount: summary.caseCount };
        },
      );
    },

    async challenge(args, caseKey) {
      assertCheckoutResultArgs(args);
      if (!HASH.test(caseKey || "")) unavailable();
      return internationalAuthorizationTransaction(
        prismaClient,
        async (tx, now) => {
          const run = await readCheckoutResultRun(tx, args);
          await assertCurrentCheckoutRun(tx, args, run, now);
          const summary = validateCheckoutSummary(run.planSummaryJson, run);
          assertCheckoutExecutor(summary, args.executorId, now, trust);
          const row = inspectCheckoutCaseSet(
            run,
            await readCheckoutCases(tx, args),
          ).find((row) => row.caseKey === caseKey);
          if (!row || row.status !== "PENDING") unavailable();
          // Closed-checkout observations need the separate closure lifecycle, never an OPEN lease.
          if (row.phase !== "OPEN")
            throw proofError(
              "international_checkout_closure_not_implemented",
              409,
            );
          if (row.challengeHash && row.challengeExpiresAt > now)
            return challengeDto(row);
          if (row.challengeSequence >= 2147483647) unavailable();
          const updated = await tx.internationalCheckoutVerificationCase.update(
            {
              where: { id: row.id },
              data: {
                challengeHash: hashInternationalSecret(
                  newInternationalSecret(),
                ),
                challengeSequence: row.challengeSequence + 1,
                challengeIssuedAt: now,
                challengeExpiresAt: new Date(
                  Math.min(
                    +now + CHECKOUT_CHALLENGE_MS,
                    +run.expiresAt,
                    +run.leaseUntil,
                  ),
                ),
              },
            },
          );
          return challengeDto(updated);
        },
      );
    },

    async record(args, envelopes) {
      assertCheckoutResultArgs(args);
      if (
        !Array.isArray(envelopes) ||
        !envelopes.length ||
        envelopes.length > 8 ||
        Buffer.byteLength(JSON.stringify(envelopes)) > 32000 ||
        new Set(envelopes.map((e) => e?.payload?.caseKey)).size !==
          envelopes.length
      )
        unavailable();
      return internationalAuthorizationTransaction(
        prismaClient,
        async (tx, now) => {
          const run = await readCheckoutResultRun(tx, args);
          const rows = inspectCheckoutCaseSet(
            run,
            await readCheckoutCases(tx, args),
          );
          const selected = envelopes.map((envelope) => {
            const row = rows.find(
              (row) => row.caseKey === envelope?.payload?.caseKey,
            );
            if (!row || row.phase !== "OPEN") unavailable();
            if (
              row.status === "RECORDED" &&
              row.resultHash !== proofHash(envelope)
            )
              unavailable();
            return { envelope, row };
          });
          // Exact retry is history only, even after expiry/STOP; it cannot re-arm or renew anything.
          if (selected.every(({ row }) => row.status === "RECORDED"))
            return { ok: true, replayed: true, historical: true };
          await assertCurrentCheckoutRun(tx, args, run, now);
          assertCheckoutExecutor(
            run.planSummaryJson,
            args.executorId,
            now,
            trust,
          );
          for (const { envelope, row } of selected) {
            if (row.status === "RECORDED") continue;
            const result = validateCheckoutCaseResult(envelope, {
              run,
              row,
              now,
              trust,
            });
            await tx.internationalCheckoutVerificationCase.update({
              where: { id: row.id },
              data: {
                status: "RECORDED",
                resultJson: envelope,
                resultHash: result.resultHash,
                resultCode: result.resultCode,
                recordedAt: now,
              },
            });
          }
          const [clock] = await tx.$queryRaw`SELECT clock_timestamp() AS now`;
          if (
            new Date(clock.now) >= run.leaseUntil ||
            new Date(clock.now) >= run.expiresAt ||
            selected.some(
              ({ row }) =>
                row.status !== "RECORDED" &&
                new Date(clock.now) >= row.challengeExpiresAt,
            )
          )
            unavailable();
          return {
            ok: true,
            replayed: false,
            recorded: selected.filter(({ row }) => row.status !== "RECORDED")
              .length,
          };
        },
      );
    },

    async inspect(args) {
      assertCheckoutResultArgs(args);
      return internationalAuthorizationTransaction(
        prismaClient,
        async (tx, now) => {
          const run = await readCheckoutResultRun(tx, args);
          await assertCurrentCheckoutRun(tx, args, run, now);
          assertCheckoutExecutor(
            validateCheckoutSummary(run.planSummaryJson, run),
            args.executorId,
            now,
            trust,
          );
          const rows = inspectCheckoutCaseSet(
            run,
            await readCheckoutCases(tx, args),
          );
          for (const row of rows.filter((row) => row.status === "RECORDED")) {
            verifyProofSignature(
              row.resultJson,
              "checkoutVerifier",
              now,
              trust,
            );
            const result = validateCheckoutCaseResult(row.resultJson, {
              run,
              row,
              now: row.recordedAt,
              trust,
            });
            if (
              result.resultHash !== row.resultHash ||
              result.resultCode !== row.resultCode
            )
              unavailable();
          }
          const open = rows.filter((row) => row.phase === "OPEN");
          return {
            ok: true,
            preCloseComplete: open.every(
              (row) =>
                row.status === "RECORDED" && row.resultCode === "MATCHED",
            ),
            missing: open
              .filter((row) => row.status !== "RECORDED")
              .map((row) => row.caseKey),
            mismatched: open
              .filter(
                (row) =>
                  row.status === "RECORDED" && row.resultCode !== "MATCHED",
              )
              .map((row) => row.caseKey),
            candidateHash: proofHash(
              rows.map((row) => ({
                caseKey: row.caseKey,
                resultHash: row.resultHash,
              })),
            ),
            pendingClosureCases: rows.filter((row) => row.phase === "CLOSED")
              .length,
            environment: run.planSummaryJson.environment,
            artifactVerified: false,
            closureVerified: false,
            completionObserved: false,
            saleReady: false,
          };
        },
      );
    },
  };
}
function challengeDto(row) {
  return {
    caseKey: row.caseKey,
    challengeHash: row.challengeHash,
    sequence: row.challengeSequence,
    issuedAt: row.challengeIssuedAt.toISOString(),
    expiresAt: row.challengeExpiresAt.toISOString(),
  };
}

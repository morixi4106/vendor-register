import {
  internationalAuthorizationTransaction,
  newInternationalSecret,
  hashInternationalSecret,
} from "./internationalAuthorizationPolicy.server.js";
import { invalidateInternationalGates } from "./internationalGateQueue.server.js";
import {
  assertCheckoutResultArgs,
  readCheckoutResultRun,
  assertCurrentCheckoutRun,
  assertCheckoutDependencies,
  assertCheckoutExecutor,
  readCheckoutCases,
} from "./internationalCheckoutResults.server.js";
import {
  HASH,
  INTERNATIONAL_PROOF_TRUST,
  proofHash,
} from "../utils/internationalProofContract.js";
import {
  CHECKOUT_CHALLENGE_MS,
  validateCheckoutCaseResult,
  validateCheckoutSummary,
} from "../utils/internationalCheckoutResults.js";
import {
  NORMAL_CHECKOUT_CLOSE_REASON,
  closureError,
  inspectVerifiedCheckoutCases,
  createCheckoutClosureCandidate,
  validateCheckoutClosureCandidate,
  validateCheckoutCloseContext,
  assertClosedCheckoutSession,
} from "../utils/internationalCheckoutClosure.js";
import { inspectInternationalCheckoutCloseContext } from "./internationalCheckoutCloseContext.server.js";

async function closingState(
  tx,
  args,
  run,
  now,
  { requireReadback = true } = {},
) {
  if (
    args.leaseToken ||
    run.status !== "CLOSING" ||
    run.outcomeCode !== "PRE_CLOSE_VERIFIED" ||
    run.revokedAt ||
    run.expiresAt <= now ||
    run.executorId !== args.executorId ||
    run.leaseUntil ||
    run.leaseTokenHash ||
    run.closureGeneration !== run.startGeneration + 1
  )
    closureError();
  const auth = await assertCheckoutDependencies(tx, run, now);
  const state = await tx.internationalGateSyncState.findUnique({
    where: { shopDomain: run.shopDomain },
  });
  if (
    !state ||
    state.mode !== "STOPPED" ||
    state.stopReasonCode !== NORMAL_CHECKOUT_CLOSE_REASON ||
    state.verificationRunId !== run.id ||
    state.authorizationRequestId !== auth.id ||
    state.desiredGeneration !== run.closureGeneration ||
    state.authorizedScopeHash !== run.scopeHash ||
    state.releaseBinding !== run.releaseBinding ||
    state.nativeConfigHash !== run.nativeConfigHash ||
    state.sourceHash !== auth.sourceHash ||
    state.authorizationExpiresAt < run.expiresAt ||
    run.planSummaryJson?.sourceHash !== auth.sourceHash
  )
    closureError();
  if (
    requireReadback &&
    (state.phase !== "BLOCKED" ||
      state.appliedGeneration !== run.closureGeneration ||
      run.closureStatus !== "CONFIRMED" ||
      !run.closedAt ||
      !state.protectedAt ||
      !state.verifiedAt ||
      +run.closedAt !== +state.protectedAt ||
      run.closedAt > now ||
      state.verifiedAt > now ||
      !HASH.test(state.observedShopHash || ""))
  )
    closureError();
  return state;
}
function executor(run, args, now, trust) {
  assertCheckoutExecutor(
    validateCheckoutSummary(run.planSummaryJson, run),
    args.executorId,
    now,
    trust,
  );
}
async function verifiedRows(tx, args, run, now, trust) {
  return inspectVerifiedCheckoutCases(
    run,
    await readCheckoutCases(tx, args),
    now,
    trust,
  );
}
function closedContext(context, run, state, now) {
  validateCheckoutCloseContext(context, run, now, "CLOSED");
  const original = run.resultsJson.candidate.openContext;
  if (
    context.artifactHash !== original.artifactHash ||
    context.artifactReference !== original.artifactReference ||
    context.gateHash !== state.observedShopHash ||
    new Date(context.observedAt) < run.closedAt
  )
    closureError();
}
async function lateClock(tx, deadline) {
  const [clock] = await tx.$queryRaw`SELECT clock_timestamp() AS now`;
  if (!Number.isFinite(+deadline) || new Date(clock.now) >= deadline)
    closureError();
}
function contextDeadline(run, context) {
  return new Date(
    Math.min(
      +run.expiresAt,
      Date.parse(context.observedAt) + CHECKOUT_CHALLENGE_MS,
    ),
  );
}
function signerDeadline(rows, trust) {
  return Math.min(
    ...rows
      .filter((row) => row.status === "RECORDED")
      .map((row) =>
        Date.parse(
          trust.checkoutVerifier.find((key) => key.id === row.resultJson.keyId)
            ?.notAfter || "",
        ),
      ),
  );
}
function historical(run) {
  return {
    ok: true,
    historical: true,
    replayed: true,
    runId: run.id,
    pending: run.status === "CLOSING",
    saleReady: false,
    completionObserved: false,
    ...(run.status === "PASSED" ? { level: "NON_FINANCIAL" } : {}),
  };
}

// Server-owned dependencies only; no request supplies a context, success flag or callback.
export function createInternationalCheckoutClosureCommands({
  prismaClient,
  trust = INTERNATIONAL_PROOF_TRUST,
  inspectContext = inspectInternationalCheckoutCloseContext,
} = {}) {
  const readOutside = (args) => readCheckoutResultRun(prismaClient, args);
  return {
    async finish(args) {
      assertCheckoutResultArgs(args);
      const before = await readOutside(args);
      if (["CLOSING", "PASSED"].includes(before.status))
        return internationalAuthorizationTransaction(
          prismaClient,
          async (tx) => {
            const run = await readCheckoutResultRun(tx, args);
            validateCheckoutClosureCandidate(
              run,
              await readCheckoutCases(tx, args),
            );
            if (
              run.executorId !== args.executorId ||
              !["CLOSING", "PASSED"].includes(run.status)
            )
              closureError();
            return historical(run);
          },
        );
      const context = await inspectContext({
        prismaClient,
        run: before,
        phase: "OPEN",
      });
      return internationalAuthorizationTransaction(
        prismaClient,
        async (tx, now) => {
          const run = await readCheckoutResultRun(tx, args);
          if (["CLOSING", "PASSED"].includes(run.status)) {
            validateCheckoutClosureCandidate(
              run,
              await readCheckoutCases(tx, args),
            );
            if (run.executorId !== args.executorId) closureError();
            return historical(run);
          }
          if (run.status !== "RUNNING") closureError();
          await assertCurrentCheckoutRun(tx, args, run, now);
          executor(run, args, now, trust);
          const rows = await verifiedRows(tx, args, run, now, trust);
          if (run.resultsJson || run.startGeneration >= 2147483646)
            closureError();
          const result = createCheckoutClosureCandidate(
            run,
            rows,
            context,
            now,
          );
          await tx.internationalGateSyncState.update({
            where: { shopDomain: run.shopDomain },
            data: {
              mode: "STOPPED",
              stoppedAt: now,
              stopReasonCode: NORMAL_CHECKOUT_CLOSE_REASON,
            },
          });
          await invalidateInternationalGates(tx, {
            shopDomain: run.shopDomain,
            now,
          });
          await tx.internationalCheckoutVerificationRun.update({
            where: { id: run.id },
            data: {
              status: "CLOSING",
              outcomeCode: "PRE_CLOSE_VERIFIED",
              failureCode: null,
              resultsJson: result,
              closureGeneration: run.startGeneration + 1,
              closureStatus: "PENDING",
              stopRequestedAt: now,
              leaseTokenHash: null,
              leaseUntil: null,
            },
          });
          await lateClock(
            tx,
            new Date(
              Math.min(
                +run.expiresAt,
                +run.leaseUntil,
                +contextDeadline(run, context),
                signerDeadline(rows, trust),
              ),
            ),
          );
          return {
            ok: true,
            pending: true,
            generation: run.startGeneration + 1,
            candidateHash: result.candidateHash,
            saleReady: false,
          };
        },
      );
    },

    async challenge(args, caseKey) {
      assertCheckoutResultArgs(args);
      if (args.leaseToken || !HASH.test(caseKey || "")) closureError();
      const before = await readOutside(args);
      const context = await inspectContext({
        prismaClient,
        run: before,
        phase: "CLOSED",
      });
      return internationalAuthorizationTransaction(
        prismaClient,
        async (tx, now) => {
          const run = await readCheckoutResultRun(tx, args),
            state = await closingState(tx, args, run, now);
          executor(run, args, now, trust);
          const rows = await verifiedRows(tx, args, run, now, trust);
          const result = validateCheckoutClosureCandidate(run, rows);
          closedContext(context, run, state, now);
          const row = rows.find((row) => row.caseKey === caseKey);
          if (!row || row.phase !== "CLOSED" || row.status !== "PENDING")
            closureError();
          if (row.challengeHash && row.challengeExpiresAt > now)
            return challengeDto(row);
          if (row.challengeSequence >= 2147483647) closureError();
          const updated = await tx.internationalCheckoutVerificationCase.update(
            {
              where: { id: row.id },
              data: {
                challengeSequence: row.challengeSequence + 1,
                challengeHash: hashInternationalSecret(
                  newInternationalSecret(),
                ),
                challengeIssuedAt: now,
                challengeExpiresAt: contextDeadline(run, context),
              },
            },
          );
          await tx.internationalCheckoutVerificationRun.update({
            where: { id: run.id },
            data: {
              resultsJson: { ...result, closedContext: context },
            },
          });
          await lateClock(
            tx,
            new Date(
              Math.min(
                +contextDeadline(run, context),
                signerDeadline(rows, trust),
              ),
            ),
          );
          return challengeDto(updated);
        },
      );
    },

    async record(args, envelopes) {
      assertCheckoutResultArgs(args);
      if (
        args.leaseToken ||
        !Array.isArray(envelopes) ||
        !envelopes.length ||
        envelopes.length > 8 ||
        Buffer.byteLength(JSON.stringify(envelopes)) > 32000 ||
        new Set(envelopes.map((e) => e?.payload?.caseKey)).size !==
          envelopes.length
      )
        closureError();
      return internationalAuthorizationTransaction(
        prismaClient,
        async (tx, now) => {
          const run = await readCheckoutResultRun(tx, args);
          const rows = await readCheckoutCases(tx, args);
          validateCheckoutClosureCandidate(run, rows);
          const selected = envelopes.map((envelope) => {
            const row = rows.find(
              (row) => row.caseKey === envelope?.payload?.caseKey,
            );
            if (
              !row ||
              row.phase !== "CLOSED" ||
              (row.status === "RECORDED" &&
                row.resultHash !== proofHash(envelope))
            )
              closureError();
            return { row, envelope };
          });
          if (selected.every(({ row }) => row.status === "RECORDED"))
            return historical(run);
          const state = await closingState(tx, args, run, now);
          executor(run, args, now, trust);
          inspectVerifiedCheckoutCases(run, rows, now, trust);
          closedContext(run.resultsJson.closedContext, run, state, now);
          let recorded = 0;
          for (const { row, envelope } of selected) {
            if (row.status === "RECORDED") continue;
            const result = validateCheckoutCaseResult(envelope, {
              run,
              row,
              now,
              trust,
            });
            assertClosedCheckoutSession(run, rows, row, result.payload);
            const data = {
              status: "RECORDED",
              resultJson: envelope,
              resultHash: result.resultHash,
              resultCode: result.resultCode,
              recordedAt: now,
            };
            await tx.internationalCheckoutVerificationCase.update({
              where: { id: row.id },
              data,
            });
            Object.assign(row, data);
            recorded++;
          }
          await lateClock(
            tx,
            new Date(
              Math.min(
                +contextDeadline(run, run.resultsJson.closedContext),
                ...selected.map(({ row }) => +row.challengeExpiresAt),
                signerDeadline(rows, trust),
              ),
            ),
          );
          return { ok: true, recorded, saleReady: false };
        },
      );
    },

    async finalize(args) {
      assertCheckoutResultArgs(args);
      if (args.leaseToken) closureError();
      const before = await readOutside(args);
      if (before.status === "PASSED") {
        validateCheckoutClosureCandidate(
          before,
          await readCheckoutCases(prismaClient, args),
        );
        if (before.executorId !== args.executorId) closureError();
        return historical(before);
      }
      const context = await inspectContext({
        prismaClient,
        run: before,
        phase: "CLOSED",
      });
      return internationalAuthorizationTransaction(
        prismaClient,
        async (tx, now) => {
          const run = await readCheckoutResultRun(tx, args);
          if (run.status === "PASSED") return historical(run);
          const state = await closingState(tx, args, run, now);
          executor(run, args, now, trust);
          const rows = await verifiedRows(tx, args, run, now, trust);
          const result = validateCheckoutClosureCandidate(run, rows);
          closedContext(context, run, state, now);
          if (
            rows.some(
              (row) =>
                row.status !== "RECORDED" || row.resultCode !== "MATCHED",
            )
          )
            closureError();
          for (const row of rows.filter((row) => row.phase === "CLOSED"))
            assertClosedCheckoutSession(run, rows, row, row.resultJson.payload);
          const final = {
            level: "NON_FINANCIAL",
            caseResultsHash: proofHash(
              rows.map((row) => ({
                caseKey: row.caseKey,
                resultHash: row.resultHash,
              })),
            ),
            completedAt: now.toISOString(),
            closureGeneration: run.closureGeneration,
            completionObserved: false,
            saleReady: false,
          };
          await tx.internationalCheckoutVerificationRun.update({
            where: { id: run.id },
            data: {
              status: "PASSED",
              outcomeCode: "NON_FINANCIAL_VERIFIED",
              completedAt: now,
              activeKey: null,
              resultsJson: { ...result, closedContext: context, final },
              artifactHash: context.artifactHash,
              artifactReference: context.artifactReference,
              artifactExpiresAt: new Date(context.artifactExpiresAt),
            },
          });
          await lateClock(
            tx,
            new Date(
              Math.min(
                +contextDeadline(run, context),
                signerDeadline(rows, trust),
              ),
            ),
          );
          return {
            ok: true,
            runId: run.id,
            level: "NON_FINANCIAL",
            saleReady: false,
            completionObserved: false,
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

import prisma from "../db.server.js";
import {
  authenticateInternationalRunner,
  readInternationalRunnerJson,
  limitInternationalRequests,
  internationalJson,
  internationalErrorResponse,
} from "./internationalRunnerAuthentication.server.js";
import {
  internationalAuthorizationTransaction,
  inspectInternationalAuthorizationCapability,
  newInternationalSecret,
  hashInternationalSecret,
  VERIFICATION_LEASE_MS,
} from "./internationalAuthorizationPolicy.server.js";
import {
  createInternationalCheckoutResultCommands,
  readCheckoutResultRun,
  assertCurrentCheckoutRun,
  assertCheckoutDependencies,
  assertCheckoutExecutor,
  readCheckoutCases,
} from "./internationalCheckoutResults.server.js";
import { createInternationalCheckoutClosureCommands } from "./internationalCheckoutClosure.server.js";
import { stopInternationalGateInTransaction } from "./internationalGateQueue.server.js";
import { inspectInternationalCheckoutCloseContext } from "./internationalCheckoutCloseContext.server.js";
import {
  inspectCheckoutCaseSet,
  validateCheckoutSummary,
} from "../utils/internationalCheckoutResults.js";
import { validateCheckoutCloseContext } from "../utils/internationalCheckoutClosure.js";
import {
  ID,
  shape,
  proofHash,
  proofError,
  INTERNATIONAL_PROOF_TRUST,
} from "../utils/internationalProofContract.js";

const EXECUTOR = "system:international-checkout-verifier";
const FIELDS = Object.freeze({
  next: [],
  claim: ["runId"],
  heartbeat: ["runId"],
  cases: ["runId", "offset"],
  challenge: ["runId", "caseKey"],
  record: ["runId", "envelopes"],
  finish: ["runId"],
  closedChallenge: ["runId", "caseKey"],
  closedRecord: ["runId", "envelopes"],
  finalize: ["runId"],
  status: ["runId"],
  fail: ["runId", "code"],
});
const FAILURES = [
  "international_checkout_not_observed",
  "international_checkout_runner_failed",
];
const unavailable = () => {
  throw proofError("international_checkout_run_unavailable", 409);
};
async function pinnedPlan(tx, run, now) {
  const auth =
    run.status === "PASSED"
      ? await tx.internationalGateAuthorizationRequest.findUnique({
          where: { id: run.authorizationRequestId },
        })
      : await assertCheckoutDependencies(tx, run, now);
  if (
    auth?.shopDomain !== run.shopDomain ||
    !auth.operatorJson?.checkoutPlan ||
    proofHash(auth.operatorJson.checkoutPlan) !== proofHash(run.planSummaryJson)
  )
    unavailable();
}

// All dependencies are server-owned. No plan, URL, executor, trust root or descriptor comes from HTTP.
export function createInternationalCheckoutRunner({
  prismaClient = prisma,
  env = process.env,
  trust = INTERNATIONAL_PROOF_TRUST,
  inspectCapability = inspectInternationalAuthorizationCapability,
  inspectContext = inspectInternationalCheckoutCloseContext,
} = {}) {
  const db = prismaClient;
  const results = createInternationalCheckoutResultCommands({
    prismaClient: db,
    trust,
  });
  const closure = createInternationalCheckoutClosureCommands({
    prismaClient: db,
    trust,
    inspectContext,
  });
  return async function handle(request) {
    try {
      const principal = authenticateInternationalRunner(
        request,
        "checkout",
        env,
      );
      const input = await readInternationalRunnerJson(request);
      await limitInternationalRequests(db, principal, "checkout", 120);
      if (!input || !Object.hasOwn(FIELDS, input.intent))
        throw proofError("international_intent_invalid", 400);
      shape(input, ["intent", ...FIELDS[input.intent]], 32000);
      if (input.intent !== "next" && !ID.test(input.runId || "")) unavailable();
      const args = {
        shopDomain: principal.shopDomain,
        runId: input.runId,
        executorId: EXECUTOR,
        leaseToken: request.headers.get("x-international-lease") || "",
      };
      // A disabled capability still permits authenticated STOP and historical status reads.
      if (
        !["fail", "status"].includes(input.intent) &&
        !(await inspectCapability()).ready
      )
        throw proofError("international_verification_not_implemented", 422);
      if (!["next", "status", "fail"].includes(input.intent))
        await internationalAuthorizationTransaction(db, async (tx, now) => {
          const run = await readCheckoutResultRun(tx, args);
          await pinnedPlan(tx, run, now);
        });
      let result;
      if (input.intent === "next") {
        const rows = await db.internationalCheckoutVerificationRun.findMany({
          where: {
            shopDomain: principal.shopDomain,
            kind: "NON_FINANCIAL",
            status: "QUEUED",
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 20,
        });
        result = { ok: true, task: null };
        for (const run of rows) {
          try {
            await internationalAuthorizationTransaction(db, async (tx, now) => {
              await pinnedPlan(tx, run, now);
              assertCheckoutExecutor(
                validateCheckoutSummary(run.planSummaryJson, run),
                EXECUTOR,
                now,
                trust,
              );
              inspectCheckoutCaseSet(
                run,
                await readCheckoutCases(tx, { ...args, runId: run.id }),
              );
              const state = await tx.internationalGateSyncState.findUnique({
                where: { shopDomain: args.shopDomain },
              });
              if (
                state?.verificationRunId !== run.id ||
                state.mode !== "ENFORCE" ||
                state.phase !== "ACTIVE" ||
                state.desiredGeneration !== run.startGeneration ||
                state.appliedGeneration !== run.startGeneration
              )
                unavailable();
            });
            result.task = { runId: run.id };
            break;
          } catch {
            /* A stale task is not executable. Claim rechecks every dependency. */
          }
        }
      } else if (input.intent === "claim") {
        if (args.leaseToken) unavailable();
        const snapshot = await readCheckoutResultRun(db, args);
        const context = await inspectContext({
          prismaClient: db,
          run: snapshot,
          phase: "OPEN",
        });
        const token = newInternationalSecret();
        result = await internationalAuthorizationTransaction(
          db,
          async (tx, now) => {
            const run = await readCheckoutResultRun(tx, args);
            if (
              run.status !== "QUEUED" ||
              run.startedAt ||
              run.leaseTokenHash ||
              run.executorId ||
              run.revokedAt ||
              run.expiresAt <= now
            )
              unavailable();
            const summary = validateCheckoutSummary(run.planSummaryJson, run);
            assertCheckoutExecutor(summary, EXECUTOR, now, trust);
            inspectCheckoutCaseSet(run, await readCheckoutCases(tx, args));
            const contextRun = {
              ...run,
              startedAt: new Date(context.observedAt),
            };
            validateCheckoutCloseContext(context, contextRun, now, "OPEN");
            const leaseUntil = new Date(
              Math.min(+now + VERIFICATION_LEASE_MS, +run.expiresAt),
            );
            const candidate = {
              ...run,
              status: "RUNNING",
              executorId: EXECUTOR,
              leaseUntil,
              leaseTokenHash: hashInternationalSecret(token),
            };
            await assertCurrentCheckoutRun(
              tx,
              { ...args, leaseToken: token },
              candidate,
              now,
            );
            const [clock] = await tx.$queryRaw`SELECT clock_timestamp() AS now`;
            validateCheckoutCloseContext(
              context,
              contextRun,
              new Date(clock.now),
              "OPEN",
            );
            if (new Date(clock.now) >= leaseUntil) unavailable();
            await tx.internationalCheckoutVerificationRun.update({
              where: { id: run.id },
              data: {
                status: "RUNNING",
                executorId: EXECUTOR,
                startedAt: now,
                heartbeatAt: now,
                leaseUntil,
                leaseTokenHash: candidate.leaseTokenHash,
              },
            });
            return {
              ok: true,
              runId: run.id,
              shopDomain: run.shopDomain,
              summary,
              leaseToken: token,
              leaseUntil,
              expiresAt: run.expiresAt,
            };
          },
        );
      } else if (
        ["heartbeat", "cases", "status", "fail"].includes(input.intent)
      ) {
        result = await internationalAuthorizationTransaction(
          db,
          async (tx, now) => {
            const run = await readCheckoutResultRun(tx, args);
            if (input.intent === "status")
              return {
                ok: true,
                status: run.status,
                closureStatus: run.closureStatus,
                closureGeneration: run.closureGeneration,
                outcomeCode: run.outcomeCode,
                saleReady: false,
                completionObserved: false,
              };
            if (input.intent === "fail") {
              if (!FAILURES.includes(input.code)) unavailable();
              if (["PASSED", "FAILED", "EXPIRED"].includes(run.status))
                return { ok: true, historical: true };
              if (run.status === "CLOSING") {
                if (args.leaseToken || run.executorId !== EXECUTOR)
                  unavailable();
                await assertCheckoutDependencies(tx, run, now);
                const state = await tx.internationalGateSyncState.findUnique({
                  where: { shopDomain: args.shopDomain },
                });
                if (
                  state?.verificationRunId !== run.id ||
                  state.authorizationRequestId !== run.authorizationRequestId
                )
                  unavailable();
              } else await assertCurrentCheckoutRun(tx, args, run, now);
              await stopInternationalGateInTransaction(tx, {
                shopDomain: args.shopDomain,
                now,
                reason: input.code,
              });
              return { ok: true, pending: true };
            }
            if (input.intent === "cases" && run.status === "CLOSING") {
              if (
                args.leaseToken ||
                run.executorId !== EXECUTOR ||
                run.revokedAt ||
                run.expiresAt <= now
              )
                unavailable();
              await assertCheckoutDependencies(tx, run, now);
            } else await assertCurrentCheckoutRun(tx, args, run, now);
            const summary = validateCheckoutSummary(run.planSummaryJson, run);
            assertCheckoutExecutor(summary, EXECUTOR, now, trust);
            if (input.intent === "heartbeat") {
              const leaseUntil = new Date(
                Math.min(+now + VERIFICATION_LEASE_MS, +run.expiresAt),
              );
              const [clock] =
                await tx.$queryRaw`SELECT clock_timestamp() AS now`;
              if (
                new Date(clock.now) >= run.leaseUntil ||
                new Date(clock.now) >= run.expiresAt
              )
                unavailable();
              await tx.internationalCheckoutVerificationRun.update({
                where: { id: run.id },
                data: { heartbeatAt: now, leaseUntil },
              });
              return { ok: true, leaseUntil };
            }
            if (
              !Number.isInteger(input.offset) ||
              input.offset < 0 ||
              input.offset >= summary.caseCount
            )
              unavailable();
            const rows = inspectCheckoutCaseSet(
              run,
              await readCheckoutCases(tx, args),
            );
            return {
              ok: true,
              cases: rows.slice(input.offset, input.offset + 8).map((row) => ({
                caseKey: row.caseKey,
                ...row.expectedJson,
                status: row.status,
                resultCode: row.resultCode,
              })),
              nextOffset:
                input.offset + 8 < rows.length ? input.offset + 8 : null,
            };
          },
        );
      } else if (input.intent === "challenge")
        result = {
          ok: true,
          ...(await results.challenge(args, input.caseKey)),
        };
      else if (input.intent === "record")
        result = await results.record(args, input.envelopes);
      else if (input.intent === "finish") result = await closure.finish(args);
      else if (input.intent === "closedChallenge")
        result = {
          ok: true,
          ...(await closure.challenge(args, input.caseKey)),
        };
      else if (input.intent === "closedRecord")
        result = await closure.record(args, input.envelopes);
      else result = await closure.finalize(args);
      return internationalJson(result);
    } catch (error) {
      return internationalErrorResponse(error);
    }
  };
}

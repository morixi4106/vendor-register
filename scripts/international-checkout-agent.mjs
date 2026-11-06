import { setTimeout as sleep } from "node:timers/promises";
import { createInternationalAgentTransport } from "./international-proof-agent.mjs";
import {
  CHECKOUT_RESULT_VERSION,
  checkoutCaseExpected,
  validateCheckoutSummary,
} from "../app/utils/internationalCheckoutResults.js";
import {
  proofError,
  proofHash,
  shape,
  signProofPayload,
  HASH,
  ID,
} from "../app/utils/internationalProofContract.js";

const fail = () => {
  throw proofError("international_checkout_not_observed");
};

// No default browser adapter or CLI: this protocol cannot turn an expectation into an observation.
export async function runInternationalCheckoutAgentOnce({
  transport = createInternationalAgentTransport("checkout"),
  observe,
  close,
  key,
  runnerDigest,
  environment,
  clock = () => Date.now(),
  wait = sleep,
  budgetMs = 600000,
} = {}) {
  if (
    typeof observe !== "function" ||
    typeof close !== "function" ||
    !key?.privateKey ||
    !ID.test(key.id || "") ||
    !HASH.test(runnerDigest || "") ||
    !["ISOLATED_STORE", "LIVE_STORE"].includes(environment) ||
    !Number.isInteger(budgetMs) ||
    budgetMs < 1000 ||
    budgetMs > 600000
  )
    fail();
  const deadline = clock() + budgetMs;
  const bounded = async (operation, limit = 45000) => {
    const remaining = Math.min(limit, deadline - clock());
    if (remaining <= 0) fail();
    let timer;
    const controller = new AbortController();
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(proofError("international_checkout_not_observed")),
            remaining,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
  const call = (body, lease) => bounded(() => transport(body, lease));
  const next = await call({ intent: "next" });
  if (!next.task) return { processed: 0 };
  const runId = next.task.runId;
  if (!ID.test(runId || "")) fail();
  let lease,
    claimed = false;
  try {
    const task = await call({ intent: "claim", runId });
    lease = task.leaseToken;
    claimed = true;
    const summary = validateCheckoutSummary(task.summary, {
      kind: "NON_FINANCIAL",
      requiredCasesHash: task.summary?.planHash,
      scopeHash: task.summary?.scopeHash,
      releaseBinding: task.summary?.releaseBinding,
      nativeConfigHash: task.summary?.nativeConfigHash,
      startGeneration: task.summary?.startGeneration,
    });
    if (
      !HASH.test(lease || "") ||
      task.runId !== runId ||
      !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(task.shopDomain || "") ||
      summary.runnerDigest !== runnerDigest ||
      summary.environment !== environment ||
      !Number.isFinite(Date.parse(task.expiresAt)) ||
      Date.parse(task.expiresAt) <= clock()
    )
      fail();
    const cases = [];
    let offset = 0;
    do {
      const page = await call({ intent: "cases", runId, offset }, lease);
      if (
        !Array.isArray(page.cases) ||
        !page.cases.length ||
        page.cases.length > 8 ||
        cases.length + page.cases.length > summary.caseCount ||
        page.nextOffset !==
          (cases.length + page.cases.length === summary.caseCount
            ? null
            : offset + 8)
      )
        fail();
      for (const row of page.cases) {
        const { status, resultCode, ...expected } = row;
        if (status !== "PENDING" || resultCode !== null) fail();
        checkoutCaseExpected(expected);
        cases.push(expected);
      }
      offset = page.nextOffset;
    } while (offset !== null);
    if (
      cases.length !== summary.caseCount ||
      proofHash(cases.map((row) => row.caseKey)) !== summary.caseSetHash
    )
      fail();
    const observePhase = async (phase, generation) => {
      for (const row of cases.filter((row) => row.phase === phase)) {
        if (phase === "OPEN") await call({ intent: "heartbeat", runId }, lease);
        const challenge = await call(
          {
            intent: phase === "OPEN" ? "challenge" : "closedChallenge",
            runId,
            caseKey: row.caseKey,
          },
          lease,
        );
        if (
          challenge.caseKey !== row.caseKey ||
          !HASH.test(challenge.challengeHash || "") ||
          !Number.isInteger(challenge.sequence) ||
          challenge.sequence < 1 ||
          !Number.isFinite(Date.parse(challenge.issuedAt)) ||
          Date.parse(challenge.issuedAt) > clock() ||
          Date.parse(challenge.expiresAt) <= clock() ||
          Date.parse(challenge.expiresAt) - Date.parse(challenge.issuedAt) >
            60000
        )
          fail();
        const observation = await bounded(
          (signal) =>
            observe({
              runId,
              shopDomain: task.shopDomain,
              row,
              phase,
              generation,
              challengeExpiresAt: challenge.expiresAt,
              signal,
            }),
          Math.min(30000, Date.parse(challenge.expiresAt) - clock()),
        );
        shape(
          observation,
          ["stage", "outcome", "evidenceHash", "sessionHash"],
          1024,
        );
        if (
          !["CHECKOUT_INTERACTION", "NOT_OBSERVED"].includes(
            observation.stage,
          ) ||
          !["ALLOWED", "REJECTED", "NOT_OBSERVED"].includes(
            observation.outcome,
          ) ||
          (observation.stage === "NOT_OBSERVED") !==
            (observation.outcome === "NOT_OBSERVED") ||
          ![observation.evidenceHash, observation.sessionHash].every((x) =>
            HASH.test(x || ""),
          ) ||
          clock() >= Date.parse(challenge.expiresAt)
        )
          fail();
        const envelope = signProofPayload(
          "checkoutVerifier",
          {
            v: CHECKOUT_RESULT_VERSION,
            shopDomain: task.shopDomain,
            runId,
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
            executorId: "system:international-checkout-verifier",
            generation,
            challengeHash: challenge.challengeHash,
            sequence: challenge.sequence,
            observedAt: new Date(clock()).toISOString(),
            ...observation,
          },
          key.id,
          key.privateKey,
        );
        const body = {
          intent: phase === "OPEN" ? "record" : "closedRecord",
          runId,
          envelopes: [envelope],
        };
        try {
          await call(body, lease);
        } catch {
          await call(body, lease);
        }
        if (
          observation.stage !== row.expectedStage ||
          observation.outcome !== row.expectedOutcome
        )
          fail();
      }
    };
    await observePhase("OPEN", summary.startGeneration);
    // Retrying this transition is safe; it never renews the OPEN lease or generation.
    try {
      await call({ intent: "finish", runId }, lease);
    } catch {
      await call({ intent: "finish", runId }, lease);
    }
    lease = undefined;
    let state;
    for (let i = 0; i < 30; i++) {
      state = await call({ intent: "status", runId });
      if (state.status !== "CLOSING") fail();
      if (state.closureStatus === "CONFIRMED") break;
      if (i === 29) fail();
      await bounded(() => wait(1000), 2000);
    }
    if (state.closureGeneration !== summary.startGeneration + 1) fail();
    await observePhase("CLOSED", state.closureGeneration);
    let result;
    try {
      result = await call({ intent: "finalize", runId });
    } catch {
      result = await call({ intent: "finalize", runId });
    }
    if (
      result.saleReady !== false ||
      result.completionObserved !== false ||
      result.level !== "NON_FINANCIAL"
    )
      fail();
    return {
      processed: 1,
      level: "NON_FINANCIAL",
      saleReady: false,
      completionObserved: false,
    };
  } catch {
    if (claimed) {
      try {
        await call(
          {
            intent: "fail",
            runId,
            code: "international_checkout_runner_failed",
          },
          lease,
        );
      } catch {
        /* A lost connection cannot be a pass; the server expiry worker still closes the gate. */
      }
    }
    return { processed: 0, failed: 1, saleReady: false };
  } finally {
    // Close sessions even when the work budget is exhausted.
    let timer;
    try {
      await Promise.race([
        close(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("close_timeout")), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

import assert from "node:assert/strict";
import test from "node:test";
import { runInternationalCheckoutAgentOnce } from "../../scripts/international-checkout-agent.mjs";
import { internationalCheckoutResultFixture } from "../helpers/internationalCheckoutResultFixture.js";
import { checkoutBrowserCapacityCases } from "../helpers/internationalCheckoutBrowserFixture.js";
import {
  verifyProofSignature,
  proofHash,
} from "../../app/utils/internationalProofContract.js";

function fixture() {
  const f = internationalCheckoutResultFixture();
  const calls = [],
    observations = [];
  let lost = false,
    closed = 0;
  const task = {
    ok: true,
    runId: f.run.id,
    shopDomain: f.run.shopDomain,
    summary: f.run.planSummaryJson,
    leaseToken: f.args.leaseToken,
    expiresAt: f.run.expiresAt.toISOString(),
  };
  const transport = async (body, lease) => {
    calls.push({ body, lease });
    if (body.intent === "next") return { ok: true, task: { runId: f.run.id } };
    if (body.intent === "claim") return task;
    if (body.intent === "cases")
      return {
        ok: true,
        cases: f.plan.cases.map((row) => ({
          ...row,
          status: "PENDING",
          resultCode: null,
        })),
        nextOffset: null,
      };
    if (["challenge", "closedChallenge"].includes(body.intent))
      return {
        ok: true,
        caseKey: body.caseKey,
        challengeHash: proofHash(body.caseKey),
        sequence: 1,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
    if (body.intent === "record" && !lost) {
      lost = true;
      throw new Error("response lost");
    }
    if (body.intent === "status")
      return {
        ok: true,
        status: "CLOSING",
        closureStatus: "CONFIRMED",
        closureGeneration: 3,
      };
    if (body.intent === "finalize")
      return {
        ok: true,
        level: "NON_FINANCIAL",
        saleReady: false,
        completionObserved: false,
      };
    return { ok: true };
  };
  const observe = async ({ row }) => {
    observations.push(row.caseKey);
    return {
      stage: row.expectedStage,
      outcome: row.expectedOutcome,
      evidenceHash: proofHash(row.caseKey),
      sessionHash: proofHash(row.scenario),
    };
  };
  const options = {
    transport,
    observe,
    close: async () => {
      closed++;
    },
    key: { id: "checkout-test", privateKey: f.keys.privateKey },
    ...f.descriptor,
  };
  return {
    f,
    task,
    calls,
    observations,
    options,
    transport,
    closed: () => closed,
  };
}
test("bounded protocol signs actual adapter output, retries identical bytes, erases OPEN lease before CLOSED", async () => {
  const f = fixture();
  assert.equal(
    (await runInternationalCheckoutAgentOnce(f.options)).processed,
    1,
  );
  assert.equal(f.closed(), 1);
  assert.equal(f.observations.length, 5);
  const records = f.calls.filter((c) => c.body.intent === "record");
  assert.equal(records.length, 4);
  assert.deepEqual(records[0].body, records[1].body);
  for (const call of f.calls.filter((c) =>
    ["record", "closedRecord"].includes(c.body.intent),
  )) {
    const p = verifyProofSignature(
      call.body.envelopes[0],
      "checkoutVerifier",
      new Date(),
      f.f.trust,
    );
    assert.equal(p.runnerDigest, f.f.descriptor.runnerDigest);
    assert.equal(p.environment, "ISOLATED_STORE");
    assert.equal(
      call.lease,
      call.body.intent === "record" ? f.f.args.leaseToken : undefined,
    );
  }
  assert.ok(
    f.calls
      .filter((c) =>
        ["status", "closedChallenge", "finalize"].includes(c.body.intent),
      )
      .every((c) => c.lease === undefined),
  );
});
for (const mutation of [
  (f) => {
    f.task.summary.runnerDigest = "f".repeat(64);
  },
  (f) => {
    f.task.summary.environment = "LIVE_STORE";
  },
  (f) => {
    f.task.runId = "other";
  },
  (f) => {
    f.task.expiresAt = "2000-01-01T00:00:00.000Z";
  },
  (f) => {
    f.task.leaseToken = "bad";
  },
  (f) => {
    f.options.observe = async () => ({
      stage: "NOT_OBSERVED",
      outcome: "NOT_OBSERVED",
      evidenceHash: "a".repeat(64),
      sessionHash: "b".repeat(64),
    });
  },
  (f) => {
    f.options.observe = async () => ({
      stage: "CHECKOUT_COMPLETION",
      outcome: "ALLOWED",
      evidenceHash: "a".repeat(64),
      sessionHash: "b".repeat(64),
    });
  },
  (f) => {
    f.options.observe = async () => {
      throw new Error("adapter failed");
    };
  },
])
  test(`protocol cannot promote failed or changed observations: ${mutation.toString()}`, async () => {
    const f = fixture();
    mutation(f);
    const result = await runInternationalCheckoutAgentOnce(f.options);
    assert.equal(result.failed, 1);
    assert.equal(f.closed(), 1);
    assert.ok(f.calls.some((c) => c.body.intent === "fail"));
    assert.ok(!f.calls.some((c) => c.body.intent === "finalize"));
  });
test("missing adapter is not implemented by an expectation-based success fallback", async () => {
  await assert.rejects(
    runInternationalCheckoutAgentOnce({
      transport: async () => {
        throw new Error("must not call");
      },
    }),
  );
});
test("polling and pagination are bounded and failures still dispose sessions", async () => {
  for (const mode of [
    "pagination",
    "closure",
    "challenge",
    "unexpectedField",
  ]) {
    const f = fixture();
    f.options.wait = async () => {};
    f.options.transport = async (body, lease) => {
      const value = await f.transport(body, lease);
      if (mode === "pagination" && body.intent === "cases")
        value.nextOffset = 0;
      if (mode === "closure" && body.intent === "status")
        value.closureStatus = "PENDING";
      if (mode === "challenge" && body.intent === "challenge")
        value.expiresAt = "2000-01-01T00:00:00.000Z";
      return value;
    };
    if (mode === "unexpectedField")
      f.options.observe = async () => ({ customerEmail: "must-not-record" });
    assert.equal(
      (await runInternationalCheckoutAgentOnce(f.options)).failed,
      1,
    );
    assert.equal(f.closed(), 1);
    assert.ok(f.calls.filter((c) => c.body.intent === "status").length <= 30);
  }
});

test("no work, next failure and malformed task still close the observer exactly once", async () => {
  for (const mode of ["empty", "error", "malformed"]) {
    const f = fixture();
    f.options.transport = async () => {
      if (mode === "error") throw new Error("private canary");
      return { task: mode === "empty" ? null : { runId: "invalid/id" } };
    };
    const result = await runInternationalCheckoutAgentOnce(f.options);
    assert.equal(result.processed, 0);
    assert.equal(f.closed(), 1);
    assert.ok(!JSON.stringify(result).includes("canary"));
  }
});

test("oversized pinned plan is rejected after pagination and before any challenge or provider observation", async () => {
  const f = fixture(),
    cases = checkoutBrowserCapacityCases(128);
  f.task.summary.caseCount = cases.length;
  f.task.summary.caseSetHash = proofHash(cases.map((row) => row.caseKey));
  f.options.transport = async (body, lease) => {
    if (body.intent === "cases") {
      f.calls.push({ body, lease });
      return {
        cases: cases
          .slice(body.offset, body.offset + 8)
          .map((row) => ({ ...row, status: "PENDING", resultCode: null })),
        nextOffset: body.offset + 8 >= cases.length ? null : body.offset + 8,
      };
    }
    return f.transport(body, lease);
  };
  assert.equal((await runInternationalCheckoutAgentOnce(f.options)).failed, 1);
  assert.equal(f.observations.length, 0);
  assert.ok(
    !f.calls.some((call) =>
      ["challenge", "finish", "finalize"].includes(call.body.intent),
    ),
  );
  assert.equal(f.closed(), 1);
});

test("expired work budget still reports STOP with its own abortable deadline", async () => {
  const f = fixture();
  let now = Date.now(),
    stopSignal;
  f.options.clock = () => now;
  f.options.transport = async (body, lease, options) => {
    if (body.intent === "fail") stopSignal = options.signal;
    return f.transport(body, lease);
  };
  f.options.observe = async () => {
    now += 600001;
    throw new Error("private canary");
  };
  assert.equal((await runInternationalCheckoutAgentOnce(f.options)).failed, 1);
  assert.ok(f.calls.some((call) => call.body.intent === "fail"));
  assert.equal(stopSignal.aborted, true);
  assert.equal(f.closed(), 1);
});

test("cleanup failure never finalizes or leaks a private provider exception", async () => {
  const f = fixture();
  let closed = 0;
  f.options.close = async () => {
    closed++;
    throw new Error("private canary");
  };
  const result = await runInternationalCheckoutAgentOnce(f.options);
  assert.equal(result.failed, 1);
  assert.equal(closed, 1);
  assert.ok(!f.calls.some((call) => call.body.intent === "finalize"));
  assert.ok(f.calls.some((call) => call.body.intent === "fail"));
  assert.ok(!JSON.stringify(result).includes("canary"));
});

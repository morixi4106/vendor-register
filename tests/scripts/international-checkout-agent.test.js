import assert from "node:assert/strict";
import test from "node:test";
import { runInternationalCheckoutAgentOnce } from "../../scripts/international-checkout-agent.mjs";
import { internationalCheckoutResultFixture } from "../helpers/internationalCheckoutResultFixture.js";
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

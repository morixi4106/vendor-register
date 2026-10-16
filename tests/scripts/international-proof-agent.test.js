import assert from "node:assert/strict";
import test from "node:test";
import {
  createInternationalAgentTransport,
  runInternationalProofAgentOnce,
  signInternationalAgentObservation,
} from "../../scripts/international-proof-agent.mjs";
import { canonicalProof } from "../../app/utils/internationalProofContract.js";
test("agent transport pins path, refuses redirects, bounds responses and never sends a signing key", async () => {
  const env = {
    INTERNATIONAL_PROOF_APP_ORIGIN: "https://app.example.test",
    INTERNATIONAL_PROOF_OBSERVER_TOKEN: "a".repeat(64),
    INTERNATIONAL_PROOF_OBSERVER_PRIVATE_KEY: "secret",
  };
  const transport = createInternationalAgentTransport("observer", {
    env,
    fetchImpl: async (url, options) => {
      assert.equal(url.pathname, "/internal/international-proof-observer");
      assert.equal(options.redirect, "error");
      assert.equal(options.body, canonicalProof({ intent: "next" }));
      assert.ok(!JSON.stringify(options).includes("secret"));
      return Response.json({ ok: true, task: null });
    },
  });
  assert.equal((await transport({ intent: "next" })).ok, true);
  for (const base of [
    "http://app.example.test",
    "https://u:p@app.example.test",
    "https://app.example.test/path",
  ])
    assert.throws(() =>
      createInternationalAgentTransport("observer", {
        env: { ...env, INTERNATIONAL_PROOF_APP_ORIGIN: base },
      }),
    );
});
test("agent retries only the same signed result; failed observations close, never report success", async () => {
  for (const purpose of ["deployment", "observer"]) {
    const calls = [];
    let attempts = 0;
    const transport = async (input) => {
      calls.push(input);
      if (input.intent === "next") return { task: { runId: "run1" } };
      if (["claim", "challenge"].includes(input.intent))
        return {
          nonce: "a".repeat(64),
          observationNonce: "a".repeat(64),
          receipt: {},
          sequence: 2,
          leaseToken: "b".repeat(64),
        };
      if (attempts++ === 0) throw new Error("lost response");
      return { ok: true };
    };
    const signed = { fixed: "same observation" };
    assert.equal(
      (
        await runInternationalProofAgentOnce(purpose, {
          transport,
          observe: async () => signed,
        })
      ).processed,
      1,
    );
    assert.deepEqual(calls[2], calls[3]);
    assert.equal(
      calls.filter((c) => ["claim", "challenge"].includes(c.intent)).length,
      1,
    );
    const failures = [];
    const failed = await runInternationalProofAgentOnce(purpose, {
      observe: async () => {
        throw new Error();
      },
      transport: async (input) => {
        failures.push(input);
        if (input.intent === "next") return { task: { runId: "run1" } };
        return {
          nonce: "a".repeat(64),
          observationNonce: "a".repeat(64),
          sequence: 1,
          ok: true,
        };
      },
    });
    assert.equal(failed.failed, 1);
    assert.ok(["fail", "reportFailure"].includes(failures.at(-1).intent));
  }
});
test("signing subprocess receives only read/sign credentials and bounded input, no shell/build/deploy", () => {
  signInternationalAgentObservation(
    {},
    {
      env: {
        PATH: "path",
        INTERNATIONAL_PROOF_OBSERVER_PRIVATE_KEY: "key",
        INTERNATIONAL_PROOF_DEPLOYMENT_RUNNER_TOKEN: "transport-secret",
        SHOPIFY_API_SECRET: "write-secret",
      },
      spawn: (_cmd, args, options) => {
        assert.ok(args[0].endsWith("international-proof-observer.mjs"));
        assert.equal(args[1], "--stdin");
        assert.equal(options.shell, false);
        assert.equal(options.windowsHide, true);
        assert.ok(!JSON.stringify(options).includes("transport-secret"));
        assert.ok(!JSON.stringify(options).includes("write-secret"));
        return { status: 0, stdout: "{}" };
      },
    },
  );
});

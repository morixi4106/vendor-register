import assert from "node:assert/strict";
import test from "node:test";
import { createInternationalCheckoutRunner } from "../../app/services/internationalCheckoutRunner.server.js";
import { canonicalProof } from "../../app/utils/internationalProofContract.js";
import { createInternationalAgentTransport } from "../../scripts/international-proof-agent.mjs";

const env = {
  SHOPIFY_PRIMARY_SHOP_DOMAIN: "runner.myshopify.com",
  SHOPIFY_API_KEY: "synthetic",
  INTERNATIONAL_CHECKOUT_RUNNER_TOKEN: "7".repeat(64),
  INTERNATIONAL_PROOF_OBSERVER_TOKEN: "8".repeat(64),
};
const request = (body, options = {}) =>
  new Request("https://example.test/internal/international-checkout-runner", {
    method: options.method || "POST",
    headers: {
      "Content-Type": options.type || "application/json",
      Authorization: `Bearer ${options.token || env.INTERNATIONAL_CHECKOUT_RUNNER_TOKEN}`,
    },
    ...(options.method === "GET"
      ? {}
      : { body: options.raw ?? canonicalProof(body) }),
  });
test("checkout API rejects wrong method, reused token, noncanonical JSON and excessive bodies before any database access", async () => {
  let reads = 0;
  const db = new Proxy(
    {},
    {
      get() {
        reads++;
        throw new Error("must not access DB");
      },
    },
  );
  const api = createInternationalCheckoutRunner({ prismaClient: db, env });
  for (const [options, expected] of [
    [{ method: "GET" }, 405],
    [{ token: env.INTERNATIONAL_PROOF_OBSERVER_TOKEN }, 401],
    [{ raw: '{"intent":"next","intent":"next"}' }, 400],
    [{ raw: '{ "intent": "next" }' }, 400],
    [{ type: "text/plain" }, 415],
    [{ raw: "x".repeat(32001) }, 413],
  ]) {
    const response = await api(request({ intent: "next" }, options));
    assert.equal(response.status, expected);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  const reused = createInternationalCheckoutRunner({
    prismaClient: db,
    env: {
      ...env,
      INTERNATIONAL_CHECKOUT_RUNNER_TOKEN:
        env.INTERNATIONAL_PROOF_OBSERVER_TOKEN,
    },
  });
  assert.equal(
    (
      await reused(
        request(
          { intent: "next" },
          { token: env.INTERNATIONAL_PROOF_OBSERVER_TOKEN },
        ),
      )
    ).status,
    503,
  );
  assert.equal(reads, 0);
});
test("source capability stays disabled and caller-controlled plans are never accepted", async () => {
  const db = {
    publicEndpointRateLimit: {
      deleteMany: async () => {},
      upsert: async () => ({ count: 1 }),
    },
  };
  const api = createInternationalCheckoutRunner({ prismaClient: db, env });
  assert.equal((await api(request({ intent: "next" }))).status, 422);
  for (const extra of [
    { plan: {} },
    { url: "https://example.test" },
    { executorId: "system:forged" },
    { trust: {} },
  ])
    assert.equal(
      (await api(request({ intent: "claim", runId: "run", ...extra }))).status,
      422,
    );
});
test("checkout transport uses its own fixed endpoint and token, forbids redirects and does not reuse observer auth", async () => {
  const call = createInternationalAgentTransport("checkout", {
    env: { ...env, INTERNATIONAL_PROOF_APP_ORIGIN: "https://example.test" },
    fetchImpl: async (url, options) => {
      assert.equal(
        url.href,
        "https://example.test/internal/international-checkout-runner",
      );
      assert.equal(
        options.headers.Authorization,
        `Bearer ${env.INTERNATIONAL_CHECKOUT_RUNNER_TOKEN}`,
      );
      assert.equal(options.redirect, "error");
      return Response.json({ ok: true });
    },
  });
  assert.deepEqual(await call({ intent: "next" }), { ok: true });
});

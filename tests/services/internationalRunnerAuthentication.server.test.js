import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticateInternationalRunner,
  readInternationalRunnerJson,
  requireInternationalAdminMutation,
  internationalErrorResponse,
  limitInternationalRequests,
} from "../../app/services/internationalRunnerAuthentication.server.js";
import { canonicalProof } from "../../app/utils/internationalProofContract.js";

const env = {
  SHOPIFY_PRIMARY_SHOP_DOMAIN: "example.myshopify.com",
  SHOPIFY_API_KEY: "app1",
  APP_URL: "https://app.example.test",
  INTERNATIONAL_PROOF_PUBLISHER_INGEST_TOKEN: "a".repeat(64),
  INTERNATIONAL_PROOF_DEPLOYMENT_RUNNER_TOKEN: "b".repeat(64),
  INTERNATIONAL_PROOF_OBSERVER_TOKEN: "c".repeat(64),
};
const req = (token, body = "{}", extra = {}) =>
  new Request("https://app.example.test/internal/test", {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      ...extra,
    },
    body,
  });
test("runner transport principals are separate, fixed-shop, strict bearer and fail unconfigured", () => {
  assert.equal(
    authenticateInternationalRunner(
      req(`Bearer ${env.INTERNATIONAL_PROOF_OBSERVER_TOKEN}`),
      "observer",
      env,
    ).shopDomain,
    env.SHOPIFY_PRIMARY_SHOP_DOMAIN,
  );
  for (const [token, purpose, options] of [
    [env.INTERNATIONAL_PROOF_OBSERVER_TOKEN, "observer", env],
    [`Bearer ${env.INTERNATIONAL_PROOF_OBSERVER_TOKEN}`, "deployment", env],
    [`Bearer ${env.INTERNATIONAL_PROOF_OBSERVER_TOKEN}`, "publisher", env],
    ["Bearer none", "observer", env],
    [
      `Bearer ${env.INTERNATIONAL_PROOF_OBSERVER_TOKEN}`,
      "observer",
      { ...env, LAUNCH_MONITOR_TOKEN: env.INTERNATIONAL_PROOF_OBSERVER_TOKEN },
    ],
    ["Bearer none", "observer", {}],
  ])
    assert.throws(() =>
      authenticateInternationalRunner(req(token), purpose, options),
    );
  assert.throws(() =>
    authenticateInternationalRunner(
      new Request("https://app.example.test"),
      "observer",
      env,
    ),
  );
});
test("internal wire format rejects duplicate keys, invalid UTF8, oversized, unknown content type", async () => {
  assert.deepEqual(
    await readInternationalRunnerJson(
      req("", canonicalProof({ intent: "next" })),
    ),
    { intent: "next" },
  );
  for (const request of [
    req("", '{"intent":"next","intent":"claim"}'),
    req("", '{ "intent": "next" }'),
    req("", '"' + "x".repeat(32000) + '"'),
    req("", new Uint8Array([0xff])),
    req("", "{}", { "Content-Type": "text/plain" }),
  ])
    await assert.rejects(readInternationalRunnerJson(request));
});
test("admin writes require header session token plus canonical origin, never cookie or URL token", () => {
  const token = "Bearer abc.def.ghi";
  requireInternationalAdminMutation(
    req(token, "{}", { Origin: env.APP_URL }),
    env,
  );
  requireInternationalAdminMutation(req(token), env);
  for (const request of [
    req(token, "{}", { Origin: "https://other.test" }),
    req(token, "{}", { Origin: "null" }),
    req(token, "{}", { "Sec-Fetch-Site": "cross-site" }),
    req(""),
    new Request("https://app.example.test/?id_token=abc.def.ghi", {
      method: "POST",
    }),
  ])
    assert.throws(() => requireInternationalAdminMutation(request, env));
});
test("polling quota cleanup is scoped and excess requests are rejected with retry timing", async () => {
  const deletes = [];
  const db = {
    publicEndpointRateLimit: {
      deleteMany: async (query) => {
        deletes.push(query);
        return { count: 1 };
      },
      upsert: async () => ({ count: 61 }),
    },
  };
  await assert.rejects(
    limitInternationalRequests(
      db,
      {
        shopDomain: env.SHOPIFY_PRIMARY_SHOP_DOMAIN,
        principalId: "system:international-observer",
      },
      "observer",
    ),
    (error) => error.status === 429 && error.retryAfter > 0,
  );
  assert.equal(deletes[0].where.endpoint, "international:observer");
  assert.ok(deletes[0].where.expiresAt.lt instanceof Date);
});
test("API failures never disclose external exception text or credentials", async () => {
  const response = internationalErrorResponse(
    new Error("secret API/DB raw details"),
  );
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("secret"));
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

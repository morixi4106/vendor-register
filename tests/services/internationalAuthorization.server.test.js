import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeInternationalAuthorization,
  inspectInternationalAuthorizationCapability,
  hashInternationalSecret,
  matchesInternationalSecret,
  newInternationalSecret,
  authorizationExpiry,
  internationalAuthorizationTransaction,
} from "../../app/services/internationalAuthorizationPolicy.server.js";
import {
  createInternationalAuthorizationCommands,
  authorizeInternationalGateScope,
  inspectInternationalGateRelease,
} from "../../app/services/internationalGateAuthorization.server.js";
import { recordOperationalReadinessAttestation } from "../../app/services/operationalReadiness.server.js";
import { runInternationalGateSync } from "../../app/services/internationalGateSync.server.js";
import { inspectInternationalCheckoutGate } from "../../app/services/internationalCheckoutInspection.server.js";
import { syncFixture } from "../helpers/internationalGateMemory.js";

const input = () => ({
  purpose: "VERIFY",
  verificationKind: "NON_FINANCIAL",
  currencies: ["JPY"],
  expiresAt: "2026-10-19T00:00:00Z",
  scope: [
    {
      productId: "p1",
      shopifyProductId: "gid://shopify/Product/1",
      countries: ["US"],
    },
  ],
});

test("authorization input is bounded, purpose specific, and JPY only", () => {
  assert.equal(normalizeInternationalAuthorization(input()).scope.length, 1);
  for (const extra of [
    { purpose: "UNKNOWN" },
    { purpose: "RESUME" },
    { resumePurpose: "SALE" },
    { purpose: "SALE" },
    { currencies: ["USD"] },
    { currencies: ["JPY", "JPY"] },
    { actorKey: "forged" },
    { scope: [] },
    { expiresAt: null },
  ])
    assert.throws(() =>
      normalizeInternationalAuthorization({ ...input(), ...extra }),
    );
  assert.throws(() =>
    normalizeInternationalAuthorization({
      ...input(),
      scope: [{ ...input().scope[0], productId: "x".repeat(32000) }],
    }),
  );
});

test("secrets are random, hashed and compared without accepting another nonce", () => {
  const secret = newInternationalSecret();
  assert.notEqual(secret, newInternationalSecret());
  assert.equal(
    matchesInternationalSecret(secret, hashInternationalSecret(secret)),
    true,
  );
  assert.equal(
    matchesInternationalSecret(
      newInternationalSecret(),
      hashInternationalSecret(secret),
    ),
    false,
  );
  assert.equal(matchesInternationalSecret(null, null), false);
});

test("verification has a 48-hour cap and unusable shop-date windows are rejected", () => {
  const normalized = normalizeInternationalAuthorization(input());
  const now = new Date("2026-10-16T00:00:00Z");
  const context = {
    expiresAt: "2026-10-20T00:00:00Z",
    shopTimezone: "Asia/Tokyo",
  };
  assert.equal(
    authorizationExpiry(normalized, context, now).toISOString(),
    "2026-10-18T00:00:00.000Z",
  );
  assert.throws(() =>
    authorizationExpiry(
      normalized,
      { ...context, expiresAt: "2026-10-16T01:00:00Z" },
      now,
    ),
  );
});

test("real transactions are mandatory and serialization retries are bounded", async () => {
  await assert.rejects(
    internationalAuthorizationTransaction({}, () => {}),
    (e) => e.code === "international_transaction_required",
  );
  let calls = 0;
  const client = {
    $transaction: async (callback, options) => {
      assert.equal(options.isolationLevel, "Serializable");
      calls++;
      if (calls < 3) throw Object.assign(new Error("retry"), { code: "P2034" });
      return callback({ $queryRaw: async () => [{ now: new Date() }] });
    },
  };
  assert.equal(
    await internationalAuthorizationTransaction(client, () => "done"),
    "done",
  );
  assert.equal(calls, 3);
});

test("production capability, legacy arming and self-declared evidence remain locked", async () => {
  assert.equal(
    inspectInternationalAuthorizationCapability({ ready: true }).ready,
    false,
  );
  assert.equal(
    (await authorizeInternationalGateScope({ actorKey: "admin" })).ok,
    false,
  );
  assert.equal(
    (await inspectInternationalGateRelease({ passed: true })).ready,
    false,
  );
  for (const checkKey of [
    "INTERNATIONAL_CHECKOUT_DEPLOYMENT_VERIFIED",
    "INTERNATIONAL_CHECKOUT_RELEASE_VERIFIED",
  ])
    assert.equal(
      (
        await recordOperationalReadinessAttestation({
          checkKey,
          confirmedBy: "system:international-checkout-verifier",
          status: "CONFIRMED",
        })
      ).reason,
      "international_dedicated_verifier_required",
    );
});

test("command boundary reauthenticates the shop/role and cannot consume without 4C", async () => {
  const roles = [];
  const commands = createInternationalAuthorizationCommands({
    requireOperator: async (_request, { role }) => {
      roles.push(role);
      return {
        session: { shop: "example.myshopify.com" },
        operator: { actorKey: "shopify_user:1" },
      };
    },
  });
  await assert.rejects(
    commands.preview(
      new Request("https://example.test", { method: "POST" }),
      input(),
    ),
    (e) => e.code === "international_verification_not_implemented",
  );
  assert.deepEqual(roles, ["RELEASE_MANAGER"]);
  await assert.rejects(
    commands.preview(new Request("https://example.test"), input()),
    (e) => e.status === 405,
  );
});

test("worker default rejects legacy or unsupported approvals and only writes a closure", async () => {
  const f = syncFixture();
  const { inspectAuthorization: _injected, ...dependencies } = f.dependencies;
  await runInternationalGateSync({ prismaClient: f.db }, dependencies);
  assert.equal(f.storage.states[0].mode, "STOPPED");
  assert.ok(f.graph.writes.length > 0);
  assert.ok(
    f.graph.writes.every((row) => JSON.parse(row.value).c.length === 0),
  );
});

test("a queued runner cannot publish products or an ACTIVE shop", async () => {
  const f = syncFixture();
  await runInternationalGateSync(
    { prismaClient: f.db },
    {
      ...f.dependencies,
      inspectAuthorization: async () => ({ ready: false, waiting: true }),
    },
  );
  assert.equal(f.graph.writes.length, 1);
  assert.equal(JSON.parse(f.graph.writes[0].value).s, "PREPARING");
  assert.equal(f.storage.jobs[0].status, "RETRY");
});

test("VERIFY readiness is never general SALE readiness", async () => {
  const f = syncFixture();
  const dependencies = {
    ...f.dependencies,
    inspectAuthorization: async () => ({ ready: true, purpose: "VERIFY" }),
  };
  await runInternationalGateSync({ prismaClient: f.db }, dependencies);
  const inspected = await inspectInternationalCheckoutGate(
    { prismaClient: f.db, shopDomain: f.state.shopDomain },
    dependencies,
  );
  assert.equal(inspected.ready, false);
  assert.equal(inspected.verificationReady, true);
});

test("unverified closure remains a durable retry instead of completing a stop", async () => {
  const f = syncFixture();
  f.storage.states[0].mode = "STOPPED";
  await runInternationalGateSync(
    { prismaClient: f.db },
    {
      ...f.dependencies,
      inspectStopProtection: async () => ({ ready: false }),
    },
  );
  assert.equal(f.storage.jobs[0].status, "RETRY");
  assert.equal(f.storage.states[0].protectedAt, null);
});

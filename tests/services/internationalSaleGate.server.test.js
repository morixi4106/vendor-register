import assert from "node:assert/strict";
import test from "node:test";
import { syncInternationalSaleGate } from "../../app/services/internationalSaleGate.server.js";
import {
  invalidateInternationalGates,
  requestInternationalGateSync,
  internationalGateTransaction,
  assertInternationalEvidenceVersion,
} from "../../app/services/internationalGateQueue.server.js";
import { runInternationalGateSync } from "../../app/services/internationalGateSync.server.js";
import {
  writeInternationalMetafield,
  verifyInternationalProductReadbacks,
} from "../../app/services/internationalGateTransport.server.js";
import { closedInternationalGate } from "../../app/services/internationalGateProjection.server.js";
import { inspectInternationalCheckoutGate } from "../../app/services/internationalCheckoutInspection.server.js";
import {
  internationalMemory,
  syncFixture,
} from "../helpers/internationalGateMemory.js";

test("default sync is disabled and does not contact Shopify", async () => {
  const memory = internationalMemory();
  let calls = 0;
  const result = await syncInternationalSaleGate(
    { shopDomain: "example.myshopify.com", prismaClient: memory.db },
    {
      graphQL: async () => {
        calls++;
      },
    },
  );
  assert.equal(result.reason, "international_sync_not_armed");
  assert.equal(calls, 0);
  assert.equal(memory.storage.states[0].mode, "DISABLED");
  assert.equal(memory.storage.jobs.length, 0);
});

test("source change and generation queue roll back together", async () => {
  const f = syncFixture();
  await assert.rejects(
    internationalGateTransaction(f.db, async (tx) => {
      await invalidateInternationalGates(tx);
      throw new Error("source failed");
    }),
  );
  assert.equal(f.storage.states[0].desiredGeneration, 1);
  assert.equal(f.storage.jobs.length, 1);
});

test("new generations supersede leased work without changing the approved scope", async () => {
  const f = syncFixture();
  await requestInternationalGateSync({
    shopDomain: f.state.shopDomain,
    prismaClient: f.db,
  });
  assert.equal(f.storage.states[0].desiredGeneration, 2);
  assert.deepEqual(
    f.storage.states[0].authorizedScopeJson,
    f.state.authorizedScopeJson,
  );
  assert.equal(f.storage.jobs[0].status, "SUPERSEDED");
  assert.equal(f.storage.jobs[1].generation, 2);
});

test("worker closes the shop, reads products back, then activates one matching generation", async () => {
  const f = syncFixture();
  const result = await runInternationalGateSync(
    { prismaClient: f.db },
    f.dependencies,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    f.graph.writes.map((w) => [w.key, JSON.parse(w.value).s || "PRODUCT"]),
    [
      ["international_sale_gate", "PREPARING"],
      ["international_sale_eligibility", "PRODUCT"],
      ["international_sale_gate", "ACTIVE"],
    ],
  );
  assert.equal(f.graph.writes[0].compareDigest, null);
  assert.deepEqual(JSON.parse(f.graph.writes[0].value).c, []);
  assert.equal(f.storage.states[0].appliedGeneration, 1);
  assert.equal(f.storage.states[0].verifiedProductCount, 1);
});

test("bounded immediate work reports protection separately from activation", async () => {
  const f = syncFixture();
  const result = await syncInternationalSaleGate(
    { shopDomain: f.state.shopDomain, prismaClient: f.db },
    f.dependencies,
  );
  assert.equal(result.protected, true);
  assert.equal(result.pending, true);
  assert.equal(f.graph.writes.length, 1);
  assert.equal(JSON.parse(f.graph.writes[0].value).s, "PREPARING");
  assert.equal(f.storage.states[0].appliedGeneration, 0);
});

test("partial product failure leaves the shop closed and a durable retry", async () => {
  const f = syncFixture();
  f.graph.beforeCall(async ({ variables }) => {
    if (variables?.metafields?.[0]?.key === "international_sale_eligibility")
      throw new Error("private upstream payload");
  });
  const result = await runInternationalGateSync(
    { prismaClient: f.db },
    f.dependencies,
  );
  assert.equal(result.ok, false);
  assert.equal(
    JSON.parse(f.graph.values.get("gid://shopify/Shop/1").value).s,
    "PREPARING",
  );
  assert.equal(f.storage.states[0].appliedGeneration, 0);
  assert.equal(
    f.storage.jobs.find((j) => j.targetType === "PRODUCT").lastErrorCode,
    "international_sync_failed",
  );
  assert.ok(!JSON.stringify(f.storage).includes("private upstream"));
});

test("revocation after digest acquisition fences out an old allow", async () => {
  const f = syncFixture();
  await assert.rejects(
    writeInternationalMetafield({
      shopDomain: f.state.shopDomain,
      targetType: "SHOP",
      projection: closedInternationalGate(1, new Date(), "Asia/Tokyo"),
      graphQL: f.graph.graphQL,
      assertCurrent: async () => {
        throw new Error("superseded");
      },
    }),
  );
  assert.equal(f.graph.writes.length, 0);
});

test("worker cannot finalize a job whose lease was stolen", async () => {
  const f = syncFixture();
  f.graph.beforeCall(async ({ query }) => {
    if (query.includes("mutation InternationalGateSet"))
      f.storage.jobs[0].leaseToken = "other-worker";
  });
  await runInternationalGateSync({ prismaClient: f.db }, f.dependencies);
  assert.equal(f.storage.states[0].appliedGeneration, 0);
  assert.equal(f.storage.states[0].protectedAt, undefined);
  assert.equal(f.storage.jobs[0].status, "RUNNING");
});

test("native drift stops automatic recovery and never publishes ACTIVE", async () => {
  const f = syncFixture();
  f.dependencies.inspectNative = async () => ({ available: false });
  await runInternationalGateSync({ prismaClient: f.db }, f.dependencies);
  assert.equal(f.storage.states[0].mode, "STOPPED");
  assert.ok(f.graph.writes.every((w) => JSON.parse(w.value).s !== "ACTIVE"));
  assert.equal(f.storage.states[0].appliedGeneration, 0);
});

test("read-only inspection cannot turn a closed shop into ready", async () => {
  const f = syncFixture();
  await runInternationalGateSync(
    { prismaClient: f.db, stopOnly: true },
    f.dependencies,
  );
  const before = JSON.stringify(f.storage);
  const result = await inspectInternationalCheckoutGate(
    { shopDomain: f.state.shopDomain, prismaClient: f.db },
    f.dependencies,
  );
  assert.equal(result.protected, true);
  assert.equal(result.ready, false);
  assert.equal(JSON.stringify(f.storage), before);
  assert.equal(f.graph.writes.length, 1);
});

test("readback comparison catches tampered product values", async () => {
  const f = syncFixture();
  await runInternationalGateSync({ prismaClient: f.db }, f.dependencies);
  const targets = f.storage.jobs.filter((j) => j.targetType === "PRODUCT");
  f.graph.values.get(targets[0].targetId).value = "{}";
  await assert.rejects(
    verifyInternationalProductReadbacks({
      shopDomain: f.state.shopDomain,
      targets,
      graphQL: f.graph.graphQL,
    }),
  );
});

test("stale forms cannot overwrite a newer revocation", () => {
  assert.throws(
    () =>
      assertInternationalEvidenceVersion(
        { updatedAt: new Date("2026-10-15T01:00:00Z") },
        "absent",
      ),
    (error) => error.code === "INTERNATIONAL_EVIDENCE_CONFLICT",
  );
  assertInternationalEvidenceVersion(null, "absent");
  assert.throws(() =>
    assertInternationalEvidenceVersion(
      { updatedAt: new Date("2026-10-15T01:00:00Z"), revision: 2 },
      "1:2026-10-15T01:00:00.000Z",
    ),
  );
});

test("a stored closed value alone is not evidence that checkout is stopped", async () => {
  const f = syncFixture();
  f.dependencies.inspectStopProtection = async () => ({ ready: false });
  const result = await runInternationalGateSync(
    { prismaClient: f.db, stopOnly: true },
    f.dependencies,
  );
  assert.equal(result.ok, true);
  assert.equal(result.protected, false);
  assert.equal(f.storage.states[0].protectedAt, null);
  assert.equal(JSON.parse(f.graph.writes[0].value).s, "PREPARING");
});

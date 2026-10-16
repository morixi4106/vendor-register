import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { internationalProofFixture } from "../helpers/internationalProofFixture.js";
import {
  createInternationalProofCommands,
  claimInternationalDeploymentRun,
  completeInternationalDeploymentRun,
} from "../../app/services/internationalProofIssuance.server.js";
import {
  requestInternationalProofObservation,
  recordInternationalProofObservation,
} from "../../app/services/internationalProofObservation.server.js";
import { inspectInternationalAuthorizationProof } from "../../app/services/internationalProofReader.server.js";
import { proofHash } from "../../app/utils/internationalProofContract.js";
import {
  hashInternationalSecret,
  internationalAuthorizationTransaction,
} from "../../app/services/internationalAuthorizationPolicy.server.js";
import { stopInternationalGateInTransaction } from "../../app/services/internationalGateQueue.server.js";

const databaseUrl = process.env.INTERNATIONAL_AUTHORIZATION_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/vendor_register_auth_test(?:_[a-z0-9]+)?$/);
  assert.match(url.searchParams.get("schema"), /^intl_auth_test_[a-f0-9]{16}$/);
}
test(
  "PostgreSQL deployment proof issuance, revocation and observation fencing",
  { skip: !databaseUrl },
  async (t) => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    t.after(() => db.$disconnect());
    const post = () =>
      new Request("https://example.test/app/international-shipping", {
        method: "POST",
      });
    async function fixture() {
      const f = internationalProofFixture(
        `proof-${randomBytes(6).toString("hex")}.myshopify.com`,
      );
      const shopDomain = f.payload.shopDomain;
      const surface = await db.operationalReadinessAttestation.create({
        data: {
          checkKey: "UNSUPPORTED_SALES_SURFACES_DISABLED",
          scopeType: "SHOP",
          scopeId: shopDomain,
          status: "CONFIRMED",
          confirmedBy: "shopify_user:1",
          confirmedAt: new Date(),
          expiresAt: new Date(Date.now() + 86400000),
          evidenceReference: "fixture:surface",
          evidenceHash: "f".repeat(64),
        },
      });
      const deps = {
        ...f,
        prismaClient: db,
        requireOperator: async () => ({
          session: { shop: shopDomain },
          operator: { actorKey: "shopify_user:1" },
        }),
      };
      const commands = createInternationalProofCommands(deps);
      const prepared = await commands.prepare(post(), {
        artifactId: 200,
        receipt: f.receipt,
      });
      const claim = await claimInternationalDeploymentRun({
        prismaClient: db,
        shopDomain,
        runId: prepared.runId,
      });
      const args = {
        prismaClient: db,
        shopDomain,
        runId: prepared.runId,
        executorId: "system:international-deployment-verifier",
        leaseToken: claim.leaseToken,
        observation: f.observation(
          prepared.runId,
          hashInternationalSecret(claim.observationNonce),
        ),
      };
      const read = () =>
        inspectInternationalAuthorizationProof(
          {
            prismaClient: db,
            shopDomain,
            purpose: "DEPLOYMENT",
            env: f.env,
            graphQL: f.graphQL,
          },
          f,
        );
      const getRun = () =>
        db.internationalCheckoutVerificationRun.findUnique({
          where: { id: prepared.runId },
        });
      const proof = () =>
        db.operationalReadinessAttestation.findFirst({
          where: {
            scopeId: shopDomain,
            checkKey: "INTERNATIONAL_CHECKOUT_DEPLOYMENT_VERIFIED",
          },
        });
      return {
        ...f,
        shopDomain,
        deps,
        commands,
        surface,
        prepared,
        claim,
        args,
        read,
        getRun,
        proof,
      };
    }
    await t.test(
      "initial closure issues deployment proof atomically without a VERIFY or sale",
      async () => {
        const f = await fixture();
        assert.equal((await f.read()).ready, false);
        const result = await completeInternationalDeploymentRun(f.args, f.deps);
        assert.equal(result.saleReady, false);
        const run = await f.getRun();
        const row = await f.proof();
        assert.equal(run.status, "PASSED");
        assert.equal(run.closureStatus, "CONFIRMED");
        assert.equal(run.activeKey, null);
        assert.equal(row.evidenceHash, proofHash(run.resultsJson));
        assert.equal((await f.read()).ready, true);
        const state = await db.internationalGateSyncState.findUnique({
          where: { shopDomain: f.shopDomain },
        });
        assert.equal(state.mode, "STOPPED");
        assert.ok(
          f.graph.writes.every((w) => JSON.parse(w.value).c.length === 0),
        );
        const replay = await completeInternationalDeploymentRun(f.args, f.deps);
        assert.equal(replay.replayed, true);
        assert.equal((await f.proof()).revision, row.revision);
        assert.equal(
          (
            await inspectInternationalAuthorizationProof(
              { purpose: "SALE", shopDomain: f.shopDomain, prismaClient: db },
              f,
            )
          ).ready,
          false,
        );
      },
    );
    await t.test(
      "expired execution lease and wrong signature cannot complete",
      async (subtest) => {
        const f = await fixture();
        await assert.rejects(
          completeInternationalDeploymentRun(
            {
              ...f.args,
              observation: {
                ...f.args.observation,
                signature: "a".repeat(86) + "==",
              },
            },
            f.deps,
          ),
        );
        await subtest.test(
          "attestation failure rolls back successful run persistence",
          async () => {
            const f = await fixture();
            const failureClient = new Proxy(db, {
              get(target, key) {
                if (key === "$transaction")
                  return (callback, options) =>
                    target.$transaction(
                      (tx) =>
                        callback(
                          new Proxy(tx, {
                            get(inner, field) {
                              if (field === "operationalReadinessAttestation")
                                return new Proxy(inner[field], {
                                  get(delegate, method) {
                                    if (method === "upsert")
                                      return async () => {
                                        throw new Error(
                                          "injected_attestation_failure",
                                        );
                                      };
                                    return delegate[method];
                                  },
                                });
                              return inner[field];
                            },
                          }),
                        ),
                      options,
                    );
                const value = target[key];
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
            await assert.rejects(
              completeInternationalDeploymentRun(
                { ...f.args, prismaClient: failureClient },
                f.deps,
              ),
              /injected_attestation_failure/,
            );
            assert.equal((await f.getRun()).status, "RUNNING");
            assert.equal(await f.proof(), null);
          },
        );
        await subtest.test(
          "expired artifact, stale observation and revoked signing key are not valid existing proof",
          async () => {
            const f = await fixture();
            await completeInternationalDeploymentRun(f.args, f.deps);
            f.responses["/actions/artifacts/200"].expired = true;
            assert.equal((await f.read()).ready, false);
            f.responses["/actions/artifacts/200"].expired = false;
            f.trust.publisher[0].revokedAt = new Date();
            assert.equal((await f.read()).ready, false);
            f.trust.publisher[0].revokedAt = null;
            assert.equal(
              (
                await inspectInternationalAuthorizationProof(
                  {
                    prismaClient: db,
                    shopDomain: f.shopDomain,
                    purpose: "DEPLOYMENT",
                    now: new Date(Date.now() + 120000),
                    env: f.env,
                    graphQL: f.graphQL,
                  },
                  f,
                )
              ).ready,
              false,
            );
          },
        );
        await db.internationalCheckoutVerificationRun.update({
          where: { id: f.prepared.runId },
          data: { leaseUntil: new Date(Date.now() - 1000) },
        });
        await assert.rejects(
          completeInternationalDeploymentRun(f.args, f.deps),
        );
        assert.equal(await f.proof(), null);
      },
    );
    await t.test(
      "simultaneous completion converges to a single immutable proof",
      async () => {
        const f = await fixture();
        const outcomes = await Promise.allSettled([
          completeInternationalDeploymentRun(f.args, f.deps),
          completeInternationalDeploymentRun(f.args, f.deps),
        ]);
        assert.ok(outcomes.some((r) => r.status === "fulfilled"));
        assert.equal((await f.proof()).revision, 0);
        assert.equal((await f.getRun()).status, "PASSED");
      },
    );
    await t.test(
      "STOP competing with completion prevents a new valid proof",
      async () => {
        const f = await fixture();
        await internationalAuthorizationTransaction(db, (tx, now) =>
          stopInternationalGateInTransaction(tx, {
            shopDomain: f.shopDomain,
            now,
            reason: "international_operator_stop",
          }),
        );
        await assert.rejects(
          completeInternationalDeploymentRun(f.args, f.deps),
        );
        assert.equal(await f.proof(), null);
        assert.equal((await f.getRun()).status, "CLOSING");
      },
    );
    await t.test(
      "source evidence revision is rechecked inside the issuing transaction",
      async () => {
        const f = await fixture();
        await db.operationalReadinessAttestation.update({
          where: { id: f.surface.id },
          data: { revision: { increment: 1 } },
        });
        await assert.rejects(
          completeInternationalDeploymentRun(f.args, f.deps),
        );
        assert.equal(await f.proof(), null);
        assert.equal((await f.getRun()).status, "RUNNING");
      },
    );
    await t.test(
      "proof revocation persists a stop and rejects stale-revision revocation",
      async () => {
        const f = await fixture();
        await completeInternationalDeploymentRun(f.args, f.deps);
        const run = await f.getRun();
        const row = await f.proof();
        const input = {
          runId: run.id,
          resultDigest: proofHash(run.resultsJson),
          expectedProof: {
            id: row.id,
            revision: row.revision,
            evidenceHash: row.evidenceHash,
          },
        };
        await f.commands.revoke(post(), input);
        assert.equal(
          (await f.getRun()).revocationReason,
          "international_proof_revoked",
        );
        assert.equal((await f.read()).ready, false);
        assert.equal((await f.proof()).status, "REVOKED");
        const state = await db.internationalGateSyncState.findUnique({
          where: { shopDomain: f.shopDomain },
        });
        assert.equal(state.mode, "STOPPED");
        assert.equal(state.stopReasonCode, "international_proof_revoked");
        await assert.rejects(f.commands.revoke(post(), input));
      },
    );
    await t.test(
      "observation refresh is nonce-bound, increasing and cannot extend proof validity",
      async () => {
        const f = await fixture();
        await completeInternationalDeploymentRun(f.args, f.deps);
        const before = await f.proof();
        const request = await requestInternationalProofObservation({
          prismaClient: db,
          shopDomain: f.shopDomain,
          runId: f.prepared.runId,
        });
        const observation = f.observation(
          request.runId,
          hashInternationalSecret(request.nonce),
          2,
        );
        await recordInternationalProofObservation(
          {
            prismaClient: db,
            shopDomain: f.shopDomain,
            runId: request.runId,
            observation,
          },
          f,
        );
        assert.equal((await f.proof()).revision, before.revision);
        assert.equal(
          (await f.proof()).expiresAt.toISOString(),
          before.expiresAt.toISOString(),
        );
        assert.equal((await f.read()).ready, true);
        await assert.rejects(
          recordInternationalProofObservation(
            {
              prismaClient: db,
              shopDomain: f.shopDomain,
              runId: request.runId,
              observation,
            },
            f,
          ),
        );
      },
    );
    await t.test(
      "different shop and raw passed fields cannot issue evidence",
      async () => {
        const f = await fixture();
        await assert.rejects(
          completeInternationalDeploymentRun(
            { ...f.args, shopDomain: "other.myshopify.com" },
            f.deps,
          ),
        );
        await assert.rejects(
          f.commands.prepare(post(), {
            artifactId: 200,
            receipt: f.receipt,
            passed: true,
          }),
        );
        assert.equal(await f.proof(), null);
      },
    );
  },
);

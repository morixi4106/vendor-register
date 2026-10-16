import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { internationalProofFixture } from "../helpers/internationalProofFixture.js";
import {
  canonicalProof,
  proofHash,
  signProofPayload,
} from "../../app/utils/internationalProofContract.js";
import {
  receiveInternationalProofDelivery,
  revokeInternationalProofDelivery,
} from "../../app/services/internationalProofDelivery.server.js";
import {
  createInternationalProofCommands,
  claimInternationalDeploymentRun,
  completeInternationalDeploymentRun,
} from "../../app/services/internationalProofIssuance.server.js";
import { createInternationalRunnerInterface } from "../../app/services/internationalRunnerInterface.server.js";
import { dispatchInternationalRunnerAdmin } from "../../app/services/internationalRunnerAdmin.server.js";
import { loadInternationalRunnerAdmin } from "../../app/services/internationalRunnerAdminRead.server.js";
import { saveInternationalSurfaceEvidence } from "../../app/services/internationalSurfaceEvidence.server.js";
import { internationalEvidenceVersion } from "../../app/utils/internationalEvidenceVersion.js";
import {
  internationalAuthorizationTransaction,
  hashInternationalSecret,
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
  "PostgreSQL authenticated runner interface and admin commands",
  { skip: !databaseUrl },
  async (t) => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    t.after(() => db.$disconnect());
    async function fixture() {
      const f = internationalProofFixture(
        `runner-${randomBytes(5).toString("hex")}.myshopify.com`,
      );
      const shopDomain = f.payload.shopDomain;
      const actor = { shopDomain, actorKey: "shopify_user:1" };
      const env = {
        ...f.env,
        APP_URL: "https://app.example.test",
        SHOPIFY_PRIMARY_SHOP_DOMAIN: shopDomain,
        INTERNATIONAL_PROOF_PUBLISHER_INGEST_TOKEN: "1".repeat(64),
        INTERNATIONAL_PROOF_DEPLOYMENT_RUNNER_TOKEN: "2".repeat(64),
        INTERNATIONAL_PROOF_OBSERVER_TOKEN: "3".repeat(64),
      };
      const requireOperator = async (_r, options) => {
        if (
          ![
            "RELEASE_MANAGER",
            "COMPLIANCE_REVIEWER",
            "RECOVERY_APPROVER",
          ].includes(options.role)
        )
          throw new Response("Forbidden", { status: 403 });
        return {
          session: { shop: shopDomain },
          operator: { actorKey: actor.actorKey },
        };
      };
      const deps = { ...f, prismaClient: db, env, requireOperator };
      const principal = {
        shopDomain,
        appId: f.payload.appId,
        principalId: "system:international-publisher",
      };
      await saveInternationalSurfaceEvidence(db, actor, {
        evidenceReference: "fixture:P03",
        evidenceHash: "f".repeat(64),
        notes: "Fixture only: all unsupported channels disabled",
        expectedVersion: "absent",
        status: "CONFIRMED",
      });
      const received = await receiveInternationalProofDelivery(
        db,
        principal,
        f.receipt,
        f,
      );
      const input = {
        deliveryId: received.deliveryId,
        expectedDigest: proofHash(f.receipt),
        requestKey: randomUUID(),
      };
      const post = () =>
        new Request("https://app.example.test/app/international-shipping", {
          method: "POST",
        });
      const commands = createInternationalProofCommands(deps);
      const handle = createInternationalRunnerInterface(deps);
      const call = (
        purpose,
        body,
        token = env[
          purpose === "publisher"
            ? "INTERNATIONAL_PROOF_PUBLISHER_INGEST_TOKEN"
            : purpose === "observer"
              ? "INTERNATIONAL_PROOF_OBSERVER_TOKEN"
              : "INTERNATIONAL_PROOF_DEPLOYMENT_RUNNER_TOKEN"
        ],
        lease,
      ) =>
        handle(
          new Request("https://app.example.test/internal/test", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              ...(lease ? { "X-International-Lease": lease } : {}),
            },
            body: canonicalProof(body),
          }),
          purpose,
        );
      const admin = (intent, values) =>
        dispatchInternationalRunnerAdmin({
          request: post(),
          formData: new FormData(),
          requireOperator,
          prismaClient: db,
          env,
          ...{
            formData: (() => {
              const form = new FormData();
              for (const [key, value] of Object.entries({ intent, ...values }))
                form.set(key, value);
              return form;
            })(),
          },
        });
      async function start() {
        const result = await commands.prepare(post(), input);
        return result.runId;
      }
      async function finish(runId = null) {
        runId ||= await start();
        const claim = await claimInternationalDeploymentRun({
          prismaClient: db,
          shopDomain,
          runId,
        });
        const observation = f.observation(
          runId,
          hashInternationalSecret(claim.observationNonce),
        );
        await completeInternationalDeploymentRun(
          {
            prismaClient: db,
            shopDomain,
            runId,
            executorId: "system:international-deployment-verifier",
            leaseToken: claim.leaseToken,
            observation,
          },
          deps,
        );
        return db.internationalCheckoutVerificationRun.findUnique({
          where: { id: runId },
        });
      }
      return {
        ...f,
        shopDomain,
        actor,
        env,
        deps,
        principal,
        input,
        commands,
        post,
        start,
        finish,
        call,
        admin,
      };
    }
    await t.test(
      "same receipt deliveries and parallel prepare converge to one row/run/generation",
      async () => {
        const f = await fixture();
        const deliveries = await Promise.all(
          [1, 2].map(() =>
            receiveInternationalProofDelivery(db, f.principal, f.receipt, f),
          ),
        );
        assert.equal(deliveries[0].deliveryId, deliveries[1].deliveryId);
        const results = await Promise.all(
          [1, 2].map(() => f.commands.prepare(f.post(), f.input)),
        );
        assert.equal(results[0].runId, results[1].runId);
        assert.equal(
          await db.internationalCheckoutVerificationRun.count({
            where: { shopDomain: f.shopDomain },
          }),
          1,
        );
        const state = await db.internationalGateSyncState.findUnique({
          where: { shopDomain: f.shopDomain },
        });
        assert.equal(state.desiredGeneration, 1);
        assert.equal(state.mode, "STOPPED");
        assert.equal(f.graph.writes.length, 0);
      },
    );
    await t.test(
      "start key cannot switch actor/delivery; schema forbids cross-shop linkage",
      async () => {
        const f = await fixture();
        const runId = await f.start();
        await assert.rejects(
          f.commands.prepare(f.post(), { ...f.input, deliveryId: "different" }),
        );
        const another = createInternationalProofCommands({
          ...f.deps,
          requireOperator: async () => ({
            session: { shop: f.shopDomain },
            operator: { actorKey: "shopify_user:other" },
          }),
        });
        await assert.rejects(another.prepare(f.post(), f.input));
        await assert.rejects(
          db.internationalCheckoutVerificationRun.update({
            where: { id: runId },
            data: { shopDomain: "other.myshopify.com" },
          }),
        );
      },
    );
    await t.test(
      "wrong-purpose/monitor/missing token cannot claim or alter any run",
      async () => {
        const f = await fixture();
        const runId = await f.start();
        for (const token of [
          "",
          f.env.INTERNATIONAL_PROOF_OBSERVER_TOKEN,
          "x".repeat(64),
        ])
          assert.equal(
            (await f.call("deployment", { intent: "claim", runId }, token))
              .status,
            401,
          );
        assert.equal(
          (
            await db.internationalCheckoutVerificationRun.findUnique({
              where: { id: runId },
            })
          ).status,
          "QUEUED",
        );
        assert.equal(
          (
            await f.call("deployment", {
              intent: "claim",
              runId,
              executorId: "forged",
            })
          ).status,
          422,
        );
      },
    );
    await t.test(
      "authenticated closed deployment completes without granting VERIFY or SALE",
      async () => {
        const f = await fixture();
        const runId = await f.start();
        assert.equal(
          (await (await f.call("deployment", { intent: "next" })).json()).task
            .runId,
          runId,
        );
        const claim = await (
          await f.call("deployment", { intent: "claim", runId })
        ).json();
        const signed = f.observation(
          runId,
          hashInternationalSecret(claim.observationNonce),
        );
        assert.equal(
          (
            await f.call(
              "deployment",
              { intent: "heartbeat", runId },
              undefined,
              claim.leaseToken,
            )
          ).status,
          200,
        );
        const result = await (
          await f.call(
            "deployment",
            { intent: "complete", runId, observation: signed },
            undefined,
            claim.leaseToken,
          )
        ).json();
        assert.equal(result.saleReady, false);
        assert.equal(
          (
            await (
              await f.call(
                "deployment",
                { intent: "complete", runId, observation: signed },
                undefined,
                claim.leaseToken,
              )
            ).json()
          ).historical,
          true,
        );
        assert.equal(
          (
            await db.internationalGateSyncState.findUnique({
              where: { shopDomain: f.shopDomain },
            })
          ).mode,
          "STOPPED",
        );
      },
    );
    await t.test(
      "cancel/STOP fences heartbeat and late completion",
      async () => {
        const f = await fixture();
        const runId = await f.start();
        const claim = await (
          await f.call("deployment", { intent: "claim", runId })
        ).json();
        await internationalAuthorizationTransaction(db, (tx, now) =>
          stopInternationalGateInTransaction(tx, {
            shopDomain: f.shopDomain,
            now,
            reason: "international_operator_stop",
          }),
        );
        assert.equal(
          (
            await f.call(
              "deployment",
              { intent: "heartbeat", runId },
              undefined,
              claim.leaseToken,
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await f.call(
              "deployment",
              {
                intent: "complete",
                runId,
                observation: f.observation(
                  runId,
                  hashInternationalSecret(claim.observationNonce),
                ),
              },
              undefined,
              claim.leaseToken,
            )
          ).status,
          409,
        );
      },
    );
    await t.test(
      "refresh coalesces, competing challenge does not overwrite nonce, sequence cannot jump",
      async () => {
        const f = await fixture();
        const run = await f.finish();
        for (let i = 0; i < 2; i++)
          assert.equal(
            (
              await f.admin("refreshInternationalProofObservation", {
                runId: run.id,
                resultDigest: proofHash(run.resultsJson),
              })
            ).status,
            202,
          );
        const task = await (
          await f.call("observer", { intent: "challenge", runId: run.id })
        ).json();
        assert.equal(task.sequence, 2);
        assert.equal(
          (await f.call("observer", { intent: "challenge", runId: run.id }))
            .status,
          409,
        );
        const nonceHash = hashInternationalSecret(task.nonce);
        assert.equal(
          (
            await db.internationalCheckoutVerificationRun.findUnique({
              where: { id: run.id },
            })
          ).observationNonceHash,
          nonceHash,
        );
        assert.equal(
          (
            await f.call("observer", {
              intent: "record",
              runId: run.id,
              observation: f.observation(run.id, nonceHash, 3),
            })
          ).status,
          409,
        );
        const observation = f.observation(run.id, nonceHash, 2);
        assert.equal(
          (
            await f.call("observer", {
              intent: "record",
              runId: run.id,
              observation,
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await (
              await f.call("observer", {
                intent: "record",
                runId: run.id,
                observation,
              })
            ).json()
          ).historical,
          true,
        );
        const updated =
          await db.internationalCheckoutVerificationRun.findUnique({
            where: { id: run.id },
          });
        assert.equal(updated.observationRefreshRequestedAt, null);
        assert.deepEqual(updated.resultsJson, run.resultsJson);
      },
    );
    await t.test(
      "old/missing nonce, stale challenge and future observation cannot be accepted",
      async () => {
        const f = await fixture();
        const run = await f.finish();
        await f.admin("refreshInternationalProofObservation", {
          runId: run.id,
          resultDigest: proofHash(run.resultsJson),
        });
        const task = await (
          await f.call("observer", { intent: "challenge", runId: run.id })
        ).json();
        await db.internationalCheckoutVerificationRun.update({
          where: { id: run.id },
          data: { observationRequestedAt: new Date(Date.now() - 61000) },
        });
        assert.equal(
          (
            await f.call("observer", {
              intent: "record",
              runId: run.id,
              observation: f.observation(
                run.id,
                hashInternationalSecret(task.nonce),
                2,
              ),
            })
          ).status,
          409,
        );
      },
    );
    await t.test(
      "delivery revocation atomically revokes proof/run and is irreversible on re-delivery",
      async () => {
        const f = await fixture();
        const run = await f.finish();
        await revokeInternationalProofDelivery(db, f.actor, f.input);
        const proof = await db.operationalReadinessAttestation.findFirst({
          where: {
            scopeId: f.shopDomain,
            checkKey: "INTERNATIONAL_CHECKOUT_DEPLOYMENT_VERIFIED",
          },
        });
        assert.equal(proof.status, "REVOKED");
        assert.ok(
          (
            await db.internationalCheckoutVerificationRun.findUnique({
              where: { id: run.id },
            })
          ).revokedAt,
        );
        assert.equal(
          (
            await receiveInternationalProofDelivery(
              db,
              f.principal,
              f.receipt,
              f,
            )
          ).revoked,
          true,
        );
        await assert.rejects(
          f.commands.prepare(f.post(), {
            ...f.input,
            requestKey: randomUUID(),
          }),
        );
      },
    );
    await t.test(
      "P03 revision changes and rollback cannot leave usable proof or partial stop",
      async () => {
        const f = await fixture();
        await f.finish();
        const key = {
          checkKey: "UNSUPPORTED_SALES_SURFACES_DISABLED",
          scopeType: "SHOP",
          scopeId: f.shopDomain,
        };
        const row = await db.operationalReadinessAttestation.findUnique({
          where: { checkKey_scopeType_scopeId: key },
        });
        const input = {
          evidenceReference: "fixture:changed",
          evidenceHash: "f".repeat(64),
          notes: "Changed fixture evidence",
          expectedVersion: internationalEvidenceVersion(row),
          status: "CONFIRMED",
        };
        await saveInternationalSurfaceEvidence(db, f.actor, input);
        assert.equal(
          (
            await db.operationalReadinessAttestation.findUnique({
              where: { id: row.id },
            })
          ).revision,
          row.revision + 1,
        );
        await assert.rejects(
          saveInternationalSurfaceEvidence(db, f.actor, input),
        );
        assert.equal(
          (
            await db.internationalGateSyncState.findUnique({
              where: { shopDomain: f.shopDomain },
            })
          ).stopReasonCode,
          "international_surface_evidence_changed",
        );
      },
    );
    await t.test(
      "admin DTO is shop-bound and omits raw receipts/observations/nonce/lease/customer data",
      async () => {
        const f = await fixture();
        await f.finish();
        const dto = await loadInternationalRunnerAdmin(
          db,
          {
            session: { shop: f.shopDomain },
            operator: { authorizedRoles: ["COMPLIANCE_REVIEWER"] },
          },
          f.post(),
        );
        const json = JSON.stringify(dto);
        for (const secret of [
          "receiptJson",
          "resultsJson",
          "nonceHash",
          "leaseToken",
          "signature",
          "system:international-publisher",
          "shopify_user:",
        ])
          assert.ok(!json.includes(secret), secret);
        assert.equal(dto.runs.length, 1);
        assert.equal(dto.deliveries.length, 1);
        assert.equal(dto.permissions.release, false);
        assert.equal(dto.permissions.review, true);
        assert.equal(dto.saleReady, false);
      },
    );
    await t.test(
      "receipt ingestion rejects unknown signed fields and a changed receipt ID body",
      async () => {
        const f = await fixture();
        const signed = (extra) =>
          signProofPayload(
            "publisher",
            { ...f.payload, ...extra },
            "pub1",
            f.publisher.privateKey,
          );
        for (const extra of [
          { customerEmail: "fixture-only@example.invalid" },
          { versionTag: "changed" },
        ])
          await assert.rejects(
            receiveInternationalProofDelivery(
              db,
              f.principal,
              signed(extra),
              f,
            ),
          );
        assert.equal(
          await db.internationalProofDelivery.count({
            where: { shopDomain: f.shopDomain },
          }),
          1,
        );
      },
    );
    await t.test(
      "surface mutation rolls back revision, generation and job on a queue write failure",
      async () => {
        const f = await fixture();
        await f.finish();
        const row = await db.operationalReadinessAttestation.findFirst({
          where: {
            scopeId: f.shopDomain,
            checkKey: "UNSUPPORTED_SALES_SURFACES_DISABLED",
          },
        });
        const before = await db.internationalGateSyncState.findUnique({
          where: { shopDomain: f.shopDomain },
        });
        const failing = {
          $transaction: (callback, options) =>
            db.$transaction(
              (tx) =>
                callback(
                  new Proxy(tx, {
                    get(target, key) {
                      if (key === "internationalGateSyncJob")
                        return new Proxy(target[key], {
                          get(delegate, method) {
                            if (method === "create")
                              return async () => {
                                throw new Error("injected_queue_failure");
                              };
                            return delegate[method];
                          },
                        });
                      return target[key];
                    },
                  }),
                ),
              options,
            ),
        };
        await assert.rejects(
          saveInternationalSurfaceEvidence(failing, f.actor, {
            evidenceReference: "fixture:rollback",
            evidenceHash: "e".repeat(64),
            notes: "Fixture rollback",
            expectedVersion: internationalEvidenceVersion(row),
            status: "CONFIRMED",
          }),
          /injected_queue_failure/,
        );
        assert.deepEqual(
          await db.operationalReadinessAttestation.findUnique({
            where: { id: row.id },
          }),
          row,
        );
        assert.deepEqual(
          await db.internationalGateSyncState.findUnique({
            where: { shopDomain: f.shopDomain },
          }),
          before,
        );
      },
    );
    await t.test(
      "initial deployment challenge older than 60 seconds and wrong first sequence cannot complete",
      async () => {
        const f = await fixture();
        const runId = await f.start();
        const claim = await (
          await f.call("deployment", { intent: "claim", runId })
        ).json();
        assert.equal(
          (
            await f.call(
              "deployment",
              {
                intent: "complete",
                runId,
                observation: f.observation(
                  runId,
                  hashInternationalSecret(claim.observationNonce),
                  2,
                ),
              },
              undefined,
              claim.leaseToken,
            )
          ).status,
          422,
        );
        await db.internationalCheckoutVerificationRun.update({
          where: { id: runId },
          data: { observationRequestedAt: new Date(Date.now() - 61000) },
        });
        assert.equal(
          (
            await f.call(
              "deployment",
              {
                intent: "complete",
                runId,
                observation: f.observation(
                  runId,
                  hashInternationalSecret(claim.observationNonce),
                ),
              },
              undefined,
              claim.leaseToken,
            )
          ).status,
          422,
        );
      },
    );
    await t.test(
      "future observation is rejected, and a real deployment change persists stop without self healing",
      async () => {
        const f = await fixture();
        const run = await f.finish();
        await f.admin("refreshInternationalProofObservation", {
          runId: run.id,
          resultDigest: proofHash(run.resultsJson),
        });
        const challenge = await (
          await f.call("observer", { intent: "challenge", runId: run.id })
        ).json();
        const nonceHash = hashInternationalSecret(challenge.nonce);
        assert.equal(
          (
            await f.call("observer", {
              intent: "record",
              runId: run.id,
              observation: f.observation(run.id, nonceHash, 2, {
                observedAt: new Date(Date.now() + 60000).toISOString(),
              }),
            })
          ).status,
          422,
        );
        assert.equal(
          (
            await f.call("observer", {
              intent: "reportFailure",
              runId: run.id,
              nonceHash,
              sequence: 2,
              code: "international_deployment_changed",
            })
          ).status,
          200,
        );
        const state = await db.internationalGateSyncState.findUnique({
          where: { shopDomain: f.shopDomain },
        });
        assert.equal(state.mode, "STOPPED");
        assert.equal(state.stopReasonCode, "international_deployment_changed");
        await assert.rejects(
          f.admin("refreshInternationalProofObservation", {
            runId: run.id,
            resultDigest: proofHash(run.resultsJson),
          }),
        );
        assert.equal(
          (await (await f.call("observer", { intent: "next" })).json()).task,
          null,
        );
      },
    );
    await t.test(
      "revocation racing observation cannot leave an unrevoked usable proof",
      async () => {
        const f = await fixture();
        const run = await f.finish();
        await f.admin("refreshInternationalProofObservation", {
          runId: run.id,
          resultDigest: proofHash(run.resultsJson),
        });
        const task = await (
          await f.call("observer", { intent: "challenge", runId: run.id })
        ).json();
        await Promise.allSettled([
          revokeInternationalProofDelivery(db, f.actor, f.input),
          f.call("observer", {
            intent: "record",
            runId: run.id,
            observation: f.observation(
              run.id,
              hashInternationalSecret(task.nonce),
              2,
            ),
          }),
        ]);
        assert.ok(
          (
            await db.internationalCheckoutVerificationRun.findUnique({
              where: { id: run.id },
            })
          ).revokedAt,
        );
        assert.equal(
          (
            await db.operationalReadinessAttestation.findFirst({
              where: {
                scopeId: f.shopDomain,
                checkKey: "INTERNATIONAL_CHECKOUT_DEPLOYMENT_VERIFIED",
              },
            })
          ).status,
          "REVOKED",
        );
      },
    );
    await t.test(
      "4C unsupported blocks preview without creating authorization or run",
      async () => {
        const f = await fixture();
        await assert.rejects(
          f.admin("previewInternationalAuthorization", {
            purpose: "VERIFY",
            resumePurpose: "",
            verificationKind: "NON_FINANCIAL",
            scope: JSON.stringify([
              {
                productId: "p1",
                shopifyProductId: "gid://shopify/Product/1",
                countries: ["US"],
              },
            ]),
            currencies: '["JPY"]',
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          }),
          /not_implemented/,
        );
        assert.equal(
          await db.internationalGateAuthorizationRequest.count({
            where: { shopDomain: f.shopDomain },
          }),
          0,
        );
        assert.equal(
          await db.internationalCheckoutVerificationRun.count({
            where: { shopDomain: f.shopDomain },
          }),
          0,
        );
      },
    );
  },
);

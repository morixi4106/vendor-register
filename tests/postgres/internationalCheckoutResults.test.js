import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { internationalCheckoutResultFixture } from "../helpers/internationalCheckoutResultFixture.js";
import { createInternationalCheckoutResultCommands } from "../../app/services/internationalCheckoutResults.server.js";
import { proofHash } from "../../app/utils/internationalProofContract.js";
import { stopInternationalGateInTransaction } from "../../app/services/internationalGateQueue.server.js";
import {
  internationalAuthorizationTransaction,
  inspectInternationalAuthorizationCapability,
} from "../../app/services/internationalAuthorizationPolicy.server.js";

const databaseUrl = process.env.INTERNATIONAL_AUTHORIZATION_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/vendor_register_auth_test(?:_[a-z0-9]+)?$/);
  assert.match(url.searchParams.get("schema"), /^intl_auth_test_[a-f0-9]{16}$/);
}
test(
  "PostgreSQL pinned nonfinancial cases and signed observations",
  { skip: !databaseUrl },
  async (t) => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const cleanups = [];
    t.after(async () => {
      try {
        for (const cleanup of cleanups) await cleanup();
      } finally {
        await db.$disconnect();
      }
    });
    async function fixture({ initialize = true } = {}) {
      const f = internationalCheckoutResultFixture(
        `case-${randomBytes(6).toString("hex")}.myshopify.com`,
      );
      const { planSummaryJson: _summary, ...run } = f.run;
      const shopDomain = run.shopDomain;
      const deliveryId = `delivery-${run.id}`,
        deploymentId = `deployment-${run.id}`;
      cleanups.push(async () => {
        await db.internationalCheckoutVerificationCase.deleteMany({
          where: { shopDomain },
        });
        await db.internationalGateSyncJob.deleteMany({ where: { shopDomain } });
        await db.internationalGateSyncState.deleteMany({
          where: { shopDomain },
        });
        await db.internationalCheckoutVerificationRun.deleteMany({
          where: { shopDomain },
        });
        await db.internationalGateAuthorizationRequest.deleteMany({
          where: { shopDomain },
        });
        await db.operationalReadinessAttestation.deleteMany({
          where: { scopeId: shopDomain },
        });
        await db.internationalProofDelivery.deleteMany({
          where: { shopDomain },
        });
      });
      const receipt = { synthetic: true };
      await db.internationalProofDelivery.create({
        data: {
          id: deliveryId,
          shopDomain,
          appId: "synthetic",
          receiptId: run.id,
          receiptJson: receipt,
          receiptDigest: proofHash(receipt),
          artifactId: 1,
          headSha: "a".repeat(40),
          versionTag: "synthetic",
          allowedUseUntil: new Date(+run.expiresAt + 10000),
          receivedBy: "system:synthetic",
        },
      });
      await db.internationalCheckoutVerificationRun.create({
        data: {
          id: deploymentId,
          shopDomain,
          kind: "DEPLOYMENT",
          initiatedBy: "system:synthetic",
          scenarioVersion: "synthetic",
          verifierVersion: "synthetic",
          scopeHash: run.scopeHash,
          releaseBinding: run.releaseBinding,
          nativeConfigHash: run.nativeConfigHash,
          proofReferencesJson: [],
          requiredCasesHash: "a".repeat(64),
          startGeneration: 1,
          status: "PASSED",
          closureStatus: "CONFIRMED",
          expiresAt: run.expiresAt,
          artifactHash: "f".repeat(64),
          completedAt: f.now,
          resultsJson: { receipt },
          proofDeliveryId: deliveryId,
          preparationRequestKey: "00000000-0000-0000-0000-000000000000",
        },
      });
      await db.operationalReadinessAttestation.create({
        data: {
          id: run.proofReferencesJson[0].id,
          checkKey: "INTERNATIONAL_CHECKOUT_DEPLOYMENT_VERIFIED",
          scopeType: "SHOP",
          scopeId: shopDomain,
          status: "CONFIRMED",
          revision: 1,
          evidenceHash: "f".repeat(64),
          confirmedBy: f.args.executorId,
          confirmedAt: f.now,
          expiresAt: run.expiresAt,
          metadataJson: { runId: deploymentId },
        },
      });
      await db.internationalGateAuthorizationRequest.create({
        data: {
          id: run.authorizationRequestId,
          shopDomain,
          actorKey: "shopify_user:1",
          purpose: "VERIFY",
          verificationKind: "NON_FINANCIAL",
          operatorJson: { synthetic: true },
          scopeJson: [],
          scopeHash: run.scopeHash,
          currenciesJson: ["JPY"],
          requestedExpiresAt: run.expiresAt,
          effectiveExpiresAt: run.expiresAt,
          expectedGeneration: 1,
          sourceHash: f.plan.sourceHash,
          proofReferencesJson: run.proofReferencesJson,
          nativeConfigHash: run.nativeConfigHash,
          releaseBinding: run.releaseBinding,
          shopTimezone: "Asia/Tokyo",
          nonceHash: proofHash(shopDomain),
          previewExpiresAt: run.expiresAt,
          consumedAt: f.now,
          consumedGeneration: 2,
          resultCode: "ACCEPTED",
        },
      });
      await db.internationalCheckoutVerificationRun.create({ data: run });
      await db.internationalGateSyncState.create({
        data: {
          shopDomain,
          mode: "ENFORCE",
          desiredGeneration: 2,
          appliedGeneration: 2,
          phase: "ACTIVE",
          snapshotComplete: true,
          verifiedAt: f.now,
          verificationRunId: run.id,
          authorizationRequestId: run.authorizationRequestId,
          authorizationPurpose: "VERIFY",
          authorizedScopeHash: run.scopeHash,
          releaseBinding: run.releaseBinding,
          nativeConfigHash: run.nativeConfigHash,
          sourceHash: f.plan.sourceHash,
          authorizationExpiresAt: run.expiresAt,
        },
      });
      const commands = createInternationalCheckoutResultCommands({
        prismaClient: db,
        trust: f.trust,
      });
      if (initialize) await commands.initialize(f.args, f.plan, f.descriptor);
      const rows = () =>
        db.internationalCheckoutVerificationCase.findMany({
          where: { shopDomain },
          orderBy: { ordinal: "asc" },
        });
      const challenge = async (index = 0) => {
        const row = (await rows()).filter((row) => row.phase === "OPEN")[index];
        await commands.challenge(f.args, row.caseKey);
        return db.internationalCheckoutVerificationCase.findUnique({
          where: { id: row.id },
        });
      };
      return { ...f, commands, rows, challenge, deliveryId, deploymentId };
    }

    await t.test(
      "parallel initialization creates the exact case set once, never changes the run status",
      async () => {
        const f = await fixture({ initialize: false });
        const results = await Promise.all(
          [1, 2].map(() => f.commands.initialize(f.args, f.plan, f.descriptor)),
        );
        assert.equal(results.filter((r) => r.replayed).length, 1);
        assert.equal((await f.rows()).length, f.plan.caseCount);
        assert.equal(
          (
            await db.internationalCheckoutVerificationRun.findUnique({
              where: { id: f.run.id },
            })
          ).status,
          "RUNNING",
        );
        await assert.rejects(
          f.commands.initialize(f.args, f.plan, {
            ...f.descriptor,
            environment: "LIVE_STORE",
          }),
        );
      },
    );
    await t.test(
      "parallel challenges reuse one sequence and deadline",
      async () => {
        const f = await fixture();
        const key = (await f.rows()).find(
          (row) => row.phase === "OPEN",
        ).caseKey;
        const results = await Promise.all(
          [1, 2].map(() => f.commands.challenge(f.args, key)),
        );
        assert.deepEqual(results[0], results[1]);
        assert.equal(results[0].sequence, 1);
        assert.ok(
          Date.parse(results[0].expiresAt) - Date.parse(results[0].issuedAt) <=
            60000,
        );
        await assert.rejects(
          f.commands.challenge({ ...f.args, leaseToken: "0".repeat(64) }, key),
        );
        await assert.rejects(
          f.commands.challenge({ ...f.args, executorId: "system:other" }, key),
        );
      },
    );
    await t.test(
      "parallel identical recording converges and historical replay cannot renew a stopped run",
      async () => {
        const f = await fixture(),
          row = await f.challenge(),
          envelope = f.result(row);
        const results = await Promise.all(
          [1, 2].map(() => f.commands.record(f.args, [envelope])),
        );
        assert.equal(results.filter((r) => r.replayed).length, 1);
        const before =
          await db.internationalCheckoutVerificationCase.findUnique({
            where: { id: row.id },
          });
        await internationalAuthorizationTransaction(db, (tx, now) =>
          stopInternationalGateInTransaction(tx, {
            shopDomain: f.run.shopDomain,
            now,
            reason: "synthetic_stop",
          }),
        );
        assert.equal(
          (await f.commands.record(f.args, [envelope])).historical,
          true,
        );
        assert.deepEqual(
          await db.internationalCheckoutVerificationCase.findUnique({
            where: { id: row.id },
          }),
          before,
        );
        await assert.rejects(
          f.commands.record(f.args, [
            f.result(row, { evidenceHash: "0".repeat(64) }),
          ]),
        );
        assert.equal(
          (
            await db.internationalCheckoutVerificationRun.findUnique({
              where: { id: f.run.id },
            })
          ).status,
          "CLOSING",
        );
      },
    );
    await t.test(
      "mixed-validity result batch rolls back every case and never overwrites an accepted result",
      async () => {
        const f = await fixture(),
          first = await f.challenge(0),
          second = await f.challenge(1);
        await assert.rejects(
          f.commands.record(f.args, [
            f.result(first),
            f.result(second, { sourceHash: "0".repeat(64) }),
          ]),
        );
        assert.ok((await f.rows()).every((row) => row.status === "PENDING"));
        await f.commands.record(f.args, [f.result(first)]);
        await assert.rejects(
          f.commands.record(f.args, [
            f.result(first, { outcome: "NOT_OBSERVED", stage: "NOT_OBSERVED" }),
          ]),
        );
        await assert.rejects(
          f.commands.record(f.args, [f.result(second), f.result(second)]),
        );
        await assert.rejects(
          f.commands.record(f.args, Array(9).fill(f.result(second))),
        );
      },
    );
    await t.test(
      "all pre-close observations still leave artifact, closure, completion and sale unverified",
      async () => {
        const f = await fixture();
        assert.equal(
          (await f.commands.inspect(f.args)).preCloseComplete,
          false,
        );
        for (let i = 0; i < 3; i++) {
          const row = await f.challenge(i);
          await f.commands.record(f.args, [f.result(row)]);
        }
        const result = await f.commands.inspect(f.args);
        assert.equal(result.preCloseComplete, true);
        assert.equal(result.pendingClosureCases, 2);
        for (const field of [
          "artifactVerified",
          "closureVerified",
          "completionObserved",
          "saleReady",
        ])
          assert.equal(result[field], false);
        assert.equal(result.environment, "ISOLATED_STORE");
        const run = await db.internationalCheckoutVerificationRun.findUnique({
          where: { id: f.run.id },
        });
        assert.equal(run.status, "RUNNING");
        assert.equal(run.resultsJson, null);
        assert.ok(run.activeKey);
        await assert.rejects(
          f.commands.challenge(
            f.args,
            (await f.rows()).find((row) => row.phase === "CLOSED").caseKey,
          ),
          { code: "international_checkout_closure_not_implemented" },
        );
        assert.equal(
          inspectInternationalAuthorizationCapability().ready,
          false,
        );
      },
    );
    await t.test(
      "wrong outcome and unobserved completion cannot satisfy the required set",
      async () => {
        const f = await fixture(),
          first = await f.challenge(0),
          second = await f.challenge(1);
        await f.commands.record(f.args, [
          f.result(first, { stage: "CHECKOUT_COMPLETION" }),
          f.result(second, { stage: "NOT_OBSERVED", outcome: "NOT_OBSERVED" }),
        ]);
        const result = await f.commands.inspect(f.args);
        assert.equal(result.preCloseComplete, false);
        assert.equal(result.mismatched.length, 2);
        assert.equal(result.missing.length, 1);
      },
    );
    await t.test(
      "expired challenge is replaced monotonically and old signed observation is fenced",
      async () => {
        const f = await fixture(),
          row = await f.challenge(),
          old = f.result(row);
        const now = Date.now();
        await db.internationalCheckoutVerificationCase.update({
          where: { id: row.id },
          data: {
            challengeIssuedAt: new Date(now - 61000),
            challengeExpiresAt: new Date(now - 1000),
          },
        });
        await assert.rejects(f.commands.record(f.args, [old]));
        const fresh = await f.commands.challenge(f.args, row.caseKey);
        assert.equal(fresh.sequence, 2);
        assert.notEqual(fresh.challengeHash, row.challengeHash);
        await assert.rejects(f.commands.record(f.args, [old]));
        const current =
          await db.internationalCheckoutVerificationCase.findUnique({
            where: { id: row.id },
          });
        await f.commands.record(f.args, [f.result(current)]);
      },
    );
    for (const change of [
      "authorization-revoked",
      "proof-revision",
      "delivery-revoked",
      "deployment-revoked",
      "source",
      "generation",
      "not-active",
      "lease-expired",
      "executor-key-revoked",
    ]) {
      await t.test(
        `current dependency change rejects new observation: ${change}`,
        async () => {
          const f = await fixture(),
            row = await f.challenge();
          if (change === "authorization-revoked")
            await db.internationalGateAuthorizationRequest.update({
              where: { id: f.run.authorizationRequestId },
              data: { revokedAt: new Date() },
            });
          if (change === "proof-revision")
            await db.operationalReadinessAttestation.update({
              where: { id: f.run.proofReferencesJson[0].id },
              data: { revision: 2 },
            });
          if (change === "delivery-revoked")
            await db.internationalProofDelivery.update({
              where: { id: f.deliveryId },
              data: { revokedAt: new Date() },
            });
          if (change === "deployment-revoked")
            await db.internationalCheckoutVerificationRun.update({
              where: { id: f.deploymentId },
              data: {
                revokedAt: new Date(),
                revokedBy: "system:synthetic",
                revocationReason: "synthetic",
              },
            });
          if (change === "source")
            await db.internationalGateSyncState.update({
              where: { shopDomain: f.run.shopDomain },
              data: { sourceHash: "0".repeat(64) },
            });
          if (change === "generation")
            await db.internationalGateSyncState.update({
              where: { shopDomain: f.run.shopDomain },
              data: { desiredGeneration: 3 },
            });
          if (change === "not-active")
            await db.internationalGateSyncState.update({
              where: { shopDomain: f.run.shopDomain },
              data: { phase: "PREPARING" },
            });
          if (change === "lease-expired")
            await db.internationalCheckoutVerificationRun.update({
              where: { id: f.run.id },
              data: { leaseUntil: new Date(Date.now() - 1) },
            });
          if (change === "executor-key-revoked")
            f.trust.checkoutVerifier[0].revokedAt = new Date().toISOString();
          await assert.rejects(f.commands.record(f.args, [f.result(row)]));
          assert.ok((await f.rows()).every((row) => row.status === "PENDING"));
        },
      );
    }
    await t.test(
      "STOP racing with result recording never completes or reopens the run",
      async () => {
        const f = await fixture(),
          row = await f.challenge();
        const results = await Promise.allSettled([
          f.commands.record(f.args, [f.result(row)]),
          internationalAuthorizationTransaction(db, (tx, now) =>
            stopInternationalGateInTransaction(tx, {
              shopDomain: f.run.shopDomain,
              now,
              reason: "synthetic_stop",
            }),
          ),
        ]);
        assert.equal(results[1].status, "fulfilled");
        assert.equal(
          (
            await db.internationalGateSyncState.findUnique({
              where: { shopDomain: f.run.shopDomain },
            })
          ).mode,
          "STOPPED",
        );
        assert.equal(
          (
            await db.internationalCheckoutVerificationRun.findUnique({
              where: { id: f.run.id },
            })
          ).status,
          "CLOSING",
        );
        await assert.rejects(f.commands.inspect(f.args));
      },
    );
    await t.test(
      "legacy and untrusted executors remain unusable without a pinned plan",
      async () => {
        const f = await fixture({ initialize: false });
        await assert.rejects(f.commands.inspect(f.args));
        const closed = createInternationalCheckoutResultCommands({
          prismaClient: db,
        });
        await assert.rejects(closed.initialize(f.args, f.plan, f.descriptor), {
          code: "international_checkout_executor_untrusted",
        });
        await assert.rejects(
          f.commands.initialize(
            { ...f.args, shopDomain: "other.myshopify.com" },
            f.plan,
            f.descriptor,
          ),
        );
        assert.equal((await f.rows()).length, 0);
      },
    );
    await t.test(
      "DB enforces tenant FK, unique ordinal/key, bounded shape, challenge and recorded result",
      async () => {
        const f = await fixture(),
          row = (await f.rows())[0];
        const { id: _id, createdAt: _created, ...copy } = row;
        delete copy.resultJson;
        await assert.rejects(
          db.internationalCheckoutVerificationCase.create({ data: copy }),
          { code: "P2002" },
        );
        await assert.rejects(
          db.internationalCheckoutVerificationCase.create({
            data: { ...copy, shopDomain: "other.myshopify.com" },
          }),
          { code: "P2003" },
        );
        for (const data of [
          { ordinal: 2048 },
          { phase: "FINANCIAL" },
          { status: "RECORDED" },
          { expectedJson: { huge: "x".repeat(2100) } },
          { expectedHash: "0".repeat(64) },
          { challengeSequence: -1 },
        ]) {
          await assert.rejects(
            db.internationalCheckoutVerificationCase.update({
              where: { id: row.id },
              data,
            }),
          );
        }
        await assert.rejects(
          db.internationalCheckoutVerificationRun.update({
            where: { id: f.run.id },
            data: { planSummaryJson: { huge: "x".repeat(4200) } },
          }),
        );
        await db.internationalGateSyncState.delete({
          where: { shopDomain: f.run.shopDomain },
        });
        await assert.rejects(
          db.$executeRaw`DELETE FROM "InternationalCheckoutVerificationRun" WHERE id=${f.run.id}`,
          (error) =>
            error.code === "P2010" &&
            ["23503", "23001"].includes(error.meta?.code) &&
            error.meta?.message.includes("intl_case_run_fkey"),
        );
      },
    );
    await t.test(
      "stored expected/result tampering is detected when collecting coverage",
      async () => {
        const f = await fixture(),
          row = await f.challenge();
        await f.commands.record(f.args, [f.result(row)]);
        await db.internationalCheckoutVerificationCase.update({
          where: { id: row.id },
          data: { resultCode: "NOT_OBSERVED" },
        });
        await assert.rejects(f.commands.inspect(f.args));
      },
    );
  },
);

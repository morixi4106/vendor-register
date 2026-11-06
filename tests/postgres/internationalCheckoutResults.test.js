import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { internationalCheckoutResultFixture } from "../helpers/internationalCheckoutResultFixture.js";
import { createInternationalCheckoutResultCommands } from "../../app/services/internationalCheckoutResults.server.js";
import { createInternationalCheckoutClosureCommands } from "../../app/services/internationalCheckoutClosure.server.js";
import {
  recordInternationalRunClosure,
  expireInternationalVerificationRuns,
} from "../../app/services/internationalVerificationRuns.server.js";
import { invalidateInternationalGates } from "../../app/services/internationalGateQueue.server.js";
import { INTERNATIONAL_ARTIFACT_CASES } from "../../app/utils/internationalCheckoutVerification.js";
import { closedInternationalGate } from "../../app/services/internationalGateProjection.server.js";
import { runInternationalGateSync } from "../../app/services/internationalGateSync.server.js";
import { internationalGraphMemory } from "../helpers/internationalGateMemory.js";
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
      const getRun = () =>
        db.internationalCheckoutVerificationRun.findUnique({
          where: { id: run.id },
        });
      const closeArgs = {
        shopDomain,
        runId: run.id,
        executorId: f.args.executorId,
      };
      const inspectContext = async ({ run: current, phase }) => ({
        v: "international-checkout-runtime-v1",
        runId: current.id,
        shopDomain,
        planHash: current.requiredCasesHash,
        releaseBinding: current.releaseBinding,
        nativeConfigHash: current.nativeConfigHash,
        sourceHash: f.plan.sourceHash,
        runnerDigest: f.descriptor.runnerDigest,
        environment: f.descriptor.environment,
        proofReferencesHash: proofHash(current.proofReferencesJson),
        artifactHash: "f".repeat(64),
        artifactReference: "github:morixi4106/vendor-register:1",
        artifactExpiresAt: new Date(+f.run.expiresAt + 10000).toISOString(),
        artifactCasesHash: proofHash(INTERNATIONAL_ARTIFACT_CASES),
        observedAt: new Date().toISOString(),
        phase,
        generation:
          phase === "OPEN"
            ? current.startGeneration
            : current.closureGeneration,
        gateHash:
          phase === "OPEN"
            ? null
            : (
                await db.internationalGateSyncState.findUnique({
                  where: { shopDomain },
                })
              ).observedShopHash,
      });
      const closer = createInternationalCheckoutClosureCommands({
        prismaClient: db,
        trust: f.trust,
        inspectContext,
      });
      const openComplete = async () => {
        for (let i = 0; i < 3; i++) {
          const row = await challenge(i);
          await commands.record(f.args, [f.result(row)]);
        }
      };
      const confirmClose = async ({ protectedState = true, mutate } = {}) => {
        const state = await db.internationalGateSyncState.findUnique({
          where: { shopDomain },
        });
        const job = await db.internationalGateSyncJob.findFirst({
          where: { shopDomain, generation: state.desiredGeneration },
        });
        await db.internationalGateSyncJob.update({
          where: { id: job.id },
          data: {
            status: "RUNNING",
            leaseToken: "synthetic-closure-lease",
            leaseUntil: new Date(Date.now() + 60000),
          },
        });
        if (mutate) await mutate(job, state);
        await internationalAuthorizationTransaction(db, (tx, now) =>
          recordInternationalRunClosure(tx, {
            state,
            generation: state.desiredGeneration,
            protected: protectedState,
            now,
            job,
            leaseToken: "synthetic-closure-lease",
            observedShopHash: closedInternationalGate(
              state.desiredGeneration,
              now,
              "Asia/Tokyo",
            ).h,
          }),
        );
        Object.assign(f.run, await getRun());
      };
      const closedResult = async (scenario, changes = {}) => {
        const row = (await rows()).find(
          (row) => row.expectedJson.scenario === scenario,
        );
        await closer.challenge(closeArgs, row.caseKey);
        const current =
          await db.internationalCheckoutVerificationCase.findUnique({
            where: { id: row.id },
          });
        Object.assign(f.run, await getRun());
        return f.result(current, {
          ...(scenario === "new-checkout-blocked"
            ? { sessionHash: "3".repeat(64) }
            : {}),
          ...changes,
        });
      };
      return {
        ...f,
        commands,
        rows,
        challenge,
        deliveryId,
        deploymentId,
        getRun,
        closeArgs,
        inspectContext,
        closer,
        openComplete,
        confirmClose,
        closedResult,
      };
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
      "normal finish atomically fixes one candidate, consumes no new approval and keeps the active key",
      async () => {
        const f = await fixture();
        await f.openComplete();
        const results = await Promise.all(
          [1, 2].map(() => f.closer.finish(f.args)),
        );
        assert.equal(results.filter((r) => r.replayed).length, 1);
        const before = await f.getRun();
        assert.equal(before.status, "CLOSING");
        assert.equal(before.outcomeCode, "PRE_CLOSE_VERIFIED");
        assert.equal(before.closureGeneration, 3);
        assert.ok(before.activeKey);
        assert.equal(before.leaseTokenHash, null);
        assert.equal(before.leaseUntil, null);
        assert.equal(
          (
            await db.internationalGateAuthorizationRequest.findUnique({
              where: { id: before.authorizationRequestId },
            })
          ).revokedAt,
          null,
        );
        assert.equal(
          await db.internationalGateSyncJob.count({
            where: { shopDomain: f.run.shopDomain, generation: 3 },
          }),
          1,
        );
        assert.equal((await f.closer.finish(f.closeArgs)).historical, true);
        assert.deepEqual(await f.getRun(), before);
      },
    );
    await t.test(
      "missing OPEN observations or default CONTRACT_ONLY evidence cannot begin normal closure",
      async () => {
        const f = await fixture();
        await assert.rejects(f.closer.finish(f.args));
        await f.openComplete();
        await assert.rejects(
          createInternationalCheckoutClosureCommands({
            prismaClient: db,
            trust: f.trust,
          }).finish(f.args),
        );
        assert.equal((await f.getRun()).status, "RUNNING");
      },
    );
    await t.test(
      "closure challenges cannot use OPEN leases, pending readback or an OPEN case",
      async () => {
        const f = await fixture();
        await f.openComplete();
        await f.closer.finish(f.args);
        const closed = (await f.rows()).find((row) => row.phase === "CLOSED");
        await assert.rejects(f.closer.challenge(f.args, closed.caseKey));
        await assert.rejects(f.closer.challenge(f.closeArgs, closed.caseKey));
        await f.confirmClose();
        await assert.rejects(
          f.closer.challenge(
            f.closeArgs,
            (await f.rows()).find((row) => row.phase === "OPEN").caseKey,
          ),
        );
        assert.equal((await f.getRun()).status, "CLOSING");
      },
    );
    await t.test(
      "full worker closure records BLOCKED/applied generation and pending normal run in one transaction",
      async () => {
        const f = await fixture();
        await f.openComplete();
        await f.closer.finish(f.args);
        const graph = internationalGraphMemory();
        await runInternationalGateSync(
          { shopDomain: f.run.shopDomain, prismaClient: db },
          {
            graphQL: graph.graphQL,
            inspectStopProtection: async () => ({ ready: true }),
          },
        );
        const run = await f.getRun(),
          state = await db.internationalGateSyncState.findUnique({
            where: { shopDomain: f.run.shopDomain },
          });
        assert.equal(state.mode, "STOPPED");
        assert.equal(state.phase, "BLOCKED");
        assert.equal(state.appliedGeneration, run.closureGeneration);
        assert.equal(run.status, "CLOSING");
        assert.equal(run.closureStatus, "CONFIRMED");
        assert.equal(+run.closedAt, +state.protectedAt);
        assert.ok(run.activeKey);
        assert.deepEqual(
          JSON.parse(graph.values.get("gid://shopify/Shop/1").value).c,
          [],
        );
      },
    );
    await t.test(
      "unprotected closure does not advance applied generation or release the active key",
      async () => {
        const f = await fixture();
        await f.openComplete();
        await f.closer.finish(f.args);
        await f.confirmClose({ protectedState: false });
        const state = await db.internationalGateSyncState.findUnique({
          where: { shopDomain: f.run.shopDomain },
        });
        assert.equal(state.phase, "PREPARING");
        assert.equal(state.appliedGeneration, 2);
        assert.equal((await f.getRun()).closureStatus, "UNVERIFIED");
        assert.ok((await f.getRun()).activeKey);
        await assert.rejects(f.closedResult("old-checkout-blocked"));
      },
    );
    await t.test(
      "stale worker lease rolls back job, state and run together",
      async () => {
        const f = await fixture();
        await f.openComplete();
        await f.closer.finish(f.args);
        await assert.rejects(
          f.confirmClose({
            mutate: async (job) =>
              db.internationalGateSyncJob.update({
                where: { id: job.id },
                data: { leaseUntil: new Date(0) },
              }),
          }),
        );
        const state = await db.internationalGateSyncState.findUnique({
          where: { shopDomain: f.run.shopDomain },
        });
        assert.equal(state.appliedGeneration, 2);
        assert.equal((await f.getRun()).closureStatus, "PENDING");
      },
    );
    await t.test(
      "closed-checkout sessions bind the original checkout and reject reusing it as new",
      async () => {
        const f = await fixture();
        await f.openComplete();
        await f.closer.finish(f.args);
        await f.confirmClose();
        const old = await f.closedResult("old-checkout-blocked", {
          sessionHash: "4".repeat(64),
        });
        await assert.rejects(f.closer.record(f.closeArgs, [old]));
        const fresh = await f.closedResult("new-checkout-blocked", {
          sessionHash: "2".repeat(64),
        });
        await assert.rejects(f.closer.record(f.closeArgs, [fresh]));
        assert.ok(
          (await f.rows())
            .filter((row) => row.phase === "CLOSED")
            .every((row) => row.status === "PENDING"),
        );
      },
    );
    await t.test(
      "complete signed closure finalizes only NON_FINANCIAL, remains STOPPED and writes no sale attestation",
      async () => {
        const f = await fixture();
        await f.openComplete();
        await f.closer.finish(f.args);
        await f.confirmClose();
        const old = await f.closedResult("old-checkout-blocked"),
          fresh = await f.closedResult("new-checkout-blocked");
        await f.closer.record(f.closeArgs, [old, fresh]);
        const result = await f.closer.finalize(f.closeArgs);
        assert.equal(result.level, "NON_FINANCIAL");
        assert.equal(result.saleReady, false);
        const passed = await f.getRun();
        assert.equal(passed.status, "PASSED");
        assert.equal(passed.activeKey, null);
        assert.equal(passed.outcomeCode, "NON_FINANCIAL_VERIFIED");
        assert.equal(passed.resultsJson.final.completionObserved, false);
        assert.equal(
          (
            await db.internationalGateSyncState.findUnique({
              where: { shopDomain: f.run.shopDomain },
            })
          ).mode,
          "STOPPED",
        );
        assert.equal(
          await db.operationalReadinessAttestation.count({
            where: {
              scopeId: f.run.shopDomain,
              checkKey: "INTERNATIONAL_CHECKOUT_RELEASE_VERIFIED",
            },
          }),
          0,
        );
        assert.equal((await f.closer.finalize(f.closeArgs)).historical, true);
        assert.equal(
          (await f.closer.record(f.closeArgs, [old, fresh])).historical,
          true,
        );
        assert.deepEqual(await f.getRun(), passed);
        assert.equal(
          inspectInternationalAuthorizationCapability().ready,
          false,
        );
      },
    );
    for (const change of [
      "stop",
      "source-invalidation",
      "proof-revision",
      "delivery-revocation",
      "candidate-tamper",
      "case-tamper",
      "context-stale",
      "context-release",
      "context-gate",
      "expired",
    ]) {
      await t.test(`normal closure never passes after ${change}`, async () => {
        const f = await fixture();
        await f.openComplete();
        await f.closer.finish(f.args);
        await f.confirmClose();
        await f.closer.record(f.closeArgs, [
          await f.closedResult("old-checkout-blocked"),
          await f.closedResult("new-checkout-blocked"),
        ]);
        let closer = f.closer;
        if (change === "stop")
          await internationalAuthorizationTransaction(db, (tx, now) =>
            stopInternationalGateInTransaction(tx, {
              shopDomain: f.run.shopDomain,
              now,
              reason: "synthetic_stop",
            }),
          );
        if (change === "source-invalidation")
          await internationalAuthorizationTransaction(db, (tx, now) =>
            invalidateInternationalGates(tx, {
              shopDomain: f.run.shopDomain,
              now,
            }),
          );
        if (change === "proof-revision")
          await db.operationalReadinessAttestation.update({
            where: { id: f.run.proofReferencesJson[0].id },
            data: { revision: 2 },
          });
        if (change === "delivery-revocation")
          await db.internationalProofDelivery.update({
            where: { id: f.deliveryId },
            data: { revokedAt: new Date() },
          });
        if (change === "candidate-tamper") {
          const run = await f.getRun();
          run.resultsJson.candidateHash = "0".repeat(64);
          await db.internationalCheckoutVerificationRun.update({
            where: { id: run.id },
            data: { resultsJson: run.resultsJson },
          });
        }
        if (change === "case-tamper")
          await db.internationalCheckoutVerificationCase.update({
            where: { id: (await f.rows())[0].id },
            data: { resultCode: "NOT_OBSERVED" },
          });
        if (change.startsWith("context-"))
          closer = createInternationalCheckoutClosureCommands({
            prismaClient: db,
            trust: f.trust,
            inspectContext: async (input) => ({
              ...(await f.inspectContext(input)),
              ...(change === "context-stale"
                ? {
                    observedAt: new Date(Date.now() - 60000).toISOString(),
                  }
                : {}),
              ...(change === "context-release"
                ? { releaseBinding: "0".repeat(64) }
                : {}),
              ...(change === "context-gate"
                ? { gateHash: "0".repeat(64) }
                : {}),
            }),
          });
        if (change === "expired") {
          await db.internationalCheckoutVerificationRun.update({
            where: { id: f.run.id },
            data: { expiresAt: new Date(0) },
          });
          await expireInternationalVerificationRuns({
            prismaClient: db,
            shopDomain: f.run.shopDomain,
          });
        }
        await assert.rejects(closer.finalize(f.closeArgs));
        assert.notEqual((await f.getRun()).status, "PASSED");
        assert.ok((await f.getRun()).activeKey);
      });
    }
    await t.test(
      "STOP during external close observation invalidates the candidate before finalization",
      async () => {
        const f = await fixture();
        await f.openComplete();
        await f.closer.finish(f.args);
        await f.confirmClose();
        await f.closer.record(f.closeArgs, [
          await f.closedResult("old-checkout-blocked"),
          await f.closedResult("new-checkout-blocked"),
        ]);
        const closer = createInternationalCheckoutClosureCommands({
          prismaClient: db,
          trust: f.trust,
          inspectContext: async (input) => {
            const context = await f.inspectContext(input);
            await internationalAuthorizationTransaction(db, (tx, now) =>
              stopInternationalGateInTransaction(tx, {
                shopDomain: f.run.shopDomain,
                now,
                reason: "synthetic_racing_stop",
              }),
            );
            return context;
          },
        });
        await assert.rejects(closer.finalize(f.closeArgs));
        assert.equal((await f.getRun()).outcomeCode, "FAILED");
      },
    );

    await t.test(
      "superseded closure job cannot finalize a new STOP generation",
      async () => {
        const f = await fixture();
        await f.openComplete();
        await f.closer.finish(f.args);
        await assert.rejects(
          f.confirmClose({
            mutate: async () =>
              internationalAuthorizationTransaction(db, (tx, now) =>
                stopInternationalGateInTransaction(tx, {
                  shopDomain: f.run.shopDomain,
                  now,
                  reason: "synthetic_superseded",
                }),
              ),
          }),
        );
        const state = await db.internationalGateSyncState.findUnique({
          where: { shopDomain: f.run.shopDomain },
        });
        assert.equal(state.desiredGeneration, 4);
        assert.equal(state.appliedGeneration, 2);
        assert.equal((await f.getRun()).outcomeCode, "FAILED");
        assert.ok((await f.getRun()).activeKey);
      },
    );
    await t.test(
      "stop-only readback is not normal completion; full worker records the applied closure",
      async () => {
        const f = await fixture();
        await f.openComplete();
        await f.closer.finish(f.args);
        const graph = internationalGraphMemory(),
          deps = {
            graphQL: graph.graphQL,
            inspectStopProtection: async () => ({ ready: true }),
          };
        await runInternationalGateSync(
          { shopDomain: f.run.shopDomain, prismaClient: db, stopOnly: true },
          deps,
        );
        let state = await db.internationalGateSyncState.findUnique({
          where: { shopDomain: f.run.shopDomain },
        });
        assert.equal(state.appliedGeneration, 2);
        assert.equal((await f.getRun()).closureStatus, "PENDING");
        await assert.rejects(f.closedResult("old-checkout-blocked"));
        await runInternationalGateSync(
          { shopDomain: f.run.shopDomain, prismaClient: db },
          deps,
        );
        state = await db.internationalGateSyncState.findUnique({
          where: { shopDomain: f.run.shopDomain },
        });
        assert.equal(state.appliedGeneration, 3);
        assert.equal((await f.getRun()).status, "CLOSING");
        assert.equal((await f.getRun()).closureStatus, "CONFIRMED");
      },
    );
    await t.test(
      "missing or NOT_OBSERVED closed case cannot finalize even with valid protection",
      async () => {
        const f = await fixture();
        await f.openComplete();
        await f.closer.finish(f.args);
        await f.confirmClose();
        await f.closer.record(f.closeArgs, [
          await f.closedResult("old-checkout-blocked"),
        ]);
        await assert.rejects(f.closer.finalize(f.closeArgs));
        await f.closer.record(f.closeArgs, [
          await f.closedResult("new-checkout-blocked", {
            stage: "NOT_OBSERVED",
            outcome: "NOT_OBSERVED",
          }),
        ]);
        await assert.rejects(f.closer.finalize(f.closeArgs));
        assert.equal((await f.getRun()).status, "CLOSING");
        assert.ok((await f.getRun()).activeKey);
      },
    );
    await t.test(
      "parallel normal finalization converges without renewing completion time",
      async () => {
        const f = await fixture();
        await f.openComplete();
        await f.closer.finish(f.args);
        await f.confirmClose();
        await f.closer.record(f.closeArgs, [
          await f.closedResult("old-checkout-blocked"),
          await f.closedResult("new-checkout-blocked"),
        ]);
        const results = await Promise.all(
          [1, 2].map(() => f.closer.finalize(f.closeArgs)),
        );
        assert.equal(results.filter((r) => r.historical).length, 1);
        const before = await f.getRun();
        await f.closer.finalize(f.closeArgs);
        assert.deepEqual(await f.getRun(), before);
      },
    );
    await t.test(
      "revoked checkout signer prevents normal finalization of already-recorded observations",
      async () => {
        const f = await fixture();
        await f.openComplete();
        await f.closer.finish(f.args);
        await f.confirmClose();
        await f.closer.record(f.closeArgs, [
          await f.closedResult("old-checkout-blocked"),
          await f.closedResult("new-checkout-blocked"),
        ]);
        f.trust.checkoutVerifier[0].revokedAt = new Date().toISOString();
        await assert.rejects(f.closer.finalize(f.closeArgs));
        assert.equal((await f.getRun()).status, "CLOSING");
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

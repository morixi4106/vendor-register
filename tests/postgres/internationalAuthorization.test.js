import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createInternationalAuthorizationCommands } from "../../app/services/internationalAuthorizationRequests.server.js";
import { internationalHash } from "../../app/services/internationalGateProjection.server.js";
import { internationalAuthorizationTransaction } from "../../app/services/internationalAuthorizationPolicy.server.js";
import { stopInternationalGateInTransaction } from "../../app/services/internationalGateQueue.server.js";
import { inspectInternationalAuthorizationState } from "../../app/services/internationalAuthorizationState.server.js";
import {
  claimInternationalVerificationRun,
  heartbeatInternationalVerificationRun,
  expireInternationalVerificationRuns,
  recordInternationalRunClosure,
  requestInternationalVerificationClosure,
} from "../../app/services/internationalVerificationRuns.server.js";

const databaseUrl = process.env.INTERNATIONAL_AUTHORIZATION_TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
if (enabled) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/vendor_register_auth_test(?:_[a-z0-9]+)?$/);
  assert.match(url.searchParams.get("schema"), /^intl_auth_test_[a-f0-9]{16}$/);
}

test(
  "PostgreSQL international single-use authorization and durable closure",
  { skip: !enabled },
  async (t) => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    t.after(() => db.$disconnect());
    const post = () =>
      new Request("https://example.test/app/international-shipping", {
        method: "POST",
      });
    const capable = { inspectCapability: async () => ({ ready: true }) };
    async function fixture(purpose = "VERIFY") {
      const shopDomain = `test-${randomBytes(6).toString("hex")}.myshopify.com`;
      const expiry = new Date(Date.now() + 3 * 86400000);
      const proof = await db.operationalReadinessAttestation.create({
        data: {
          checkKey:
            purpose === "SALE"
              ? "INTERNATIONAL_CHECKOUT_RELEASE_VERIFIED"
              : "INTERNATIONAL_CHECKOUT_DEPLOYMENT_VERIFIED",
          scopeType: "SHOP",
          scopeId: shopDomain,
          status: "CONFIRMED",
          confirmedBy: "system:international-checkout-verifier",
          confirmedAt: new Date(),
          expiresAt: expiry,
          evidenceReference: "fixture:deployment",
          evidenceHash: "a".repeat(64),
          metadataJson: {},
        },
      });
      const context = () => ({
        ready: true,
        observedAt: new Date(),
        nativeConfigHash: "b".repeat(64),
        releaseBinding: "c".repeat(64),
        expiresAt: expiry,
        shopTimezone: "Asia/Tokyo",
        requiredCasesHash: "d".repeat(64),
        scenarioVersion: "fixture-v1",
        verifierVersion: "fixture-v1",
        proofReferences: [
          { id: proof.id, revision: 0, evidenceHash: proof.evidenceHash },
        ],
      });
      const calls = [];
      const identity = {
        session: { shop: shopDomain },
        operator: { actorKey: "shopify_user:1" },
      };
      const dependencies = {
        prismaClient: db,
        ...capable,
        requireOperator: async (_request, options) => {
          calls.push(options.role);
          return identity;
        },
        inspectContext: async () => context(),
        readSource: async ({ prismaClient }) => {
          const row =
            await prismaClient.operationalReadinessAttestation.findUnique({
              where: { id: proof.id },
            });
          return {
            ready: row?.status === "CONFIRMED",
            sourceHash: internationalHash(row?.metadataJson),
          };
        },
      };
      const input = {
        purpose,
        verificationKind: purpose === "VERIFY" ? "NON_FINANCIAL" : null,
        scope: [
          {
            productId: "p1",
            shopifyProductId: "gid://shopify/Product/1",
            countries: ["US"],
          },
        ],
        currencies: ["JPY"],
        expiresAt: expiry.toISOString(),
      };
      const commands = createInternationalAuthorizationCommands(dependencies);
      return {
        shopDomain,
        proof,
        dependencies,
        commands,
        input,
        calls,
        identity,
      };
    }
    const consume = (f, preview) =>
      f.commands.confirm(post(), {
        requestId: preview.requestId,
        nonce: preview.nonce,
      });
    const stateOf = (f) =>
      db.internationalGateSyncState.findUnique({
        where: { shopDomain: f.shopDomain },
      });
    const close = (f) =>
      internationalAuthorizationTransaction(db, (tx, now) =>
        stopInternationalGateInTransaction(tx, {
          shopDomain: f.shopDomain,
          now,
          reason: "international_operator_stop",
        }),
      );

    await t.test(
      "nonce is hashed, parallel double confirm creates one generation/job/run",
      async () => {
        const f = await fixture();
        const preview = await f.commands.preview(post(), f.input);
        const row = await db.internationalGateAuthorizationRequest.findUnique({
          where: { id: preview.requestId },
        });
        assert.notEqual(row.nonceHash, preview.nonce);
        assert.ok(
          row.effectiveExpiresAt <= new Date(Date.now() + 48 * 3600000),
        );
        const results = await Promise.all([
          consume(f, preview),
          consume(f, preview),
        ]);
        assert.equal(results.filter((r) => r.replayed).length, 1);
        const state = await stateOf(f);
        assert.equal(state.desiredGeneration, 1);
        assert.equal(
          await db.internationalGateSyncJob.count({
            where: { shopDomain: f.shopDomain },
          }),
          1,
        );
        assert.equal(
          await db.internationalCheckoutVerificationRun.count({
            where: { shopDomain: f.shopDomain },
          }),
          1,
        );
        assert.equal(
          (
            await inspectInternationalAuthorizationState(
              { prismaClient: db, state },
              capable,
            )
          ).waiting,
          true,
        );
        await close(f);
        assert.equal((await consume(f, preview)).historical, true);
        assert.equal((await stateOf(f)).mode, "STOPPED");
      },
    );
    await t.test(
      "a source mutation while DISABLED invalidates an otherwise identical preview",
      async () => {
        const f = await fixture();
        const preview = await f.commands.preview(post(), f.input);
        await db.operationalReadinessAttestation.update({
          where: { id: f.proof.id },
          data: { metadataJson: { changed: true } },
        });
        await assert.rejects(
          consume(f, preview),
          (e) => e.code === "international_source_changed",
        );
        assert.equal(await stateOf(f), null);
      },
    );
    await t.test(
      "other actor/shop, wrong nonce, stale native and expired preview fail without consuming",
      async () => {
        const f = await fixture();
        const preview = await f.commands.preview(post(), f.input);
        await assert.rejects(
          consume(f, { ...preview, nonce: "0".repeat(64) }),
          (e) => e.status === 403,
        );
        f.identity.operator.actorKey = "shopify_user:2";
        await assert.rejects(consume(f, preview), (e) => e.status === 403);
        f.identity.operator.actorKey = "shopify_user:1";
        f.identity.session.shop = "other.myshopify.com";
        await assert.rejects(consume(f, preview), (e) => e.status === 403);
        f.identity.session.shop = f.shopDomain;
        const changed = createInternationalAuthorizationCommands({
          ...f.dependencies,
          inspectContext: async (...args) => ({
            ...(await f.dependencies.inspectContext(...args)),
            nativeConfigHash: "e".repeat(64),
          }),
        });
        await assert.rejects(
          changed.confirm(post(), {
            requestId: preview.requestId,
            nonce: preview.nonce,
          }),
          (e) => e.code === "international_authorization_changed",
        );
        await db.internationalGateAuthorizationRequest.update({
          where: { id: preview.requestId },
          data: { previewExpiresAt: new Date(0) },
        });
        await assert.rejects(
          consume(f, preview),
          (e) => e.code === "international_authorization_expired",
        );
      },
    );
    await t.test(
      "nonce consumption and run/job creation roll back together on failure",
      async () => {
        const f = await fixture();
        const preview = await f.commands.preview(post(), f.input);
        const failing = new Proxy(db, {
          get(target, key) {
            if (key === "$transaction")
              return (callback, options) =>
                target.$transaction(
                  (tx) =>
                    callback(
                      new Proxy(tx, {
                        get(inner, delegate) {
                          if (delegate === "internationalGateSyncJob")
                            return {
                              ...inner[delegate],
                              create: async () => {
                                throw new Error("injected job failure");
                              },
                            };
                          return inner[delegate];
                        },
                      }),
                    ),
                  options,
                );
            return target[key];
          },
        });
        const commands = createInternationalAuthorizationCommands({
          ...f.dependencies,
          prismaClient: failing,
        });
        await assert.rejects(
          commands.confirm(post(), {
            requestId: preview.requestId,
            nonce: preview.nonce,
          }),
          /injected job failure/,
        );
        assert.equal(
          (
            await db.internationalGateAuthorizationRequest.findUnique({
              where: { id: preview.requestId },
            })
          ).consumedAt,
          null,
        );
        assert.equal(await stateOf(f), null);
        assert.equal(
          await db.internationalCheckoutVerificationRun.count({
            where: { shopDomain: f.shopDomain },
          }),
          0,
        );
      },
    );
    await t.test(
      "confirm racing STOP converges to stopped or rejected, never a reopened gate",
      async () => {
        const f = await fixture();
        const preview = await f.commands.preview(post(), f.input);
        const results = await Promise.allSettled([
          consume(f, preview),
          close(f),
        ]);
        assert.equal(results[1].status, "fulfilled");
        assert.equal((await stateOf(f)).mode, "STOPPED");
        const jobs = await db.internationalGateSyncJob.findMany({
          where: { shopDomain: f.shopDomain },
        });
        assert.ok(
          jobs.some(
            (job) => job.targetType === "RECONCILE" && job.status === "PENDING",
          ),
        );
      },
    );
    await t.test(
      "STOPPED requires verified closure and both recovery/release roles",
      async () => {
        const f = await fixture("SALE");
        await close(f);
        await assert.rejects(
          f.commands.preview(post(), f.input),
          (e) => e.code === "international_recovery_required",
        );
        const resume = { ...f.input, purpose: "RESUME", resumePurpose: "SALE" };
        await assert.rejects(
          f.commands.preview(post(), resume),
          (e) => e.code === "international_stop_unverified",
        );
        const state = await stateOf(f);
        await db.internationalGateSyncState.update({
          where: { shopDomain: f.shopDomain },
          data: {
            phase: "BLOCKED",
            protectedAt: new Date(),
            appliedGeneration: state.desiredGeneration,
          },
        });
        const preview = await f.commands.preview(post(), resume);
        await consume(f, preview);
        assert.ok(f.calls.includes("RECOVERY_APPROVER"));
        const denied = createInternationalAuthorizationCommands({
          ...f.dependencies,
          requireOperator: async (_request, { role }) => {
            if (role === "RECOVERY_APPROVER")
              throw new Response("Forbidden", { status: 403 });
            return f.identity;
          },
        });
        await assert.rejects(
          denied.confirm(post(), {
            requestId: preview.requestId,
            nonce: preview.nonce,
          }),
          (e) => e.status === 403,
        );
      },
    );
    await t.test(
      "lease expiry persists closure and invalidates late heartbeats; closure failure keeps active key",
      async () => {
        const f = await fixture();
        const preview = await f.commands.preview(post(), f.input);
        await consume(f, preview);
        const state = await stateOf(f);
        const claim = await claimInternationalVerificationRun(
          {
            prismaClient: db,
            shopDomain: f.shopDomain,
            runId: state.verificationRunId,
            executorId: "system:fixture",
          },
          capable,
        );
        await heartbeatInternationalVerificationRun({
          prismaClient: db,
          shopDomain: f.shopDomain,
          runId: claim.runId,
          executorId: "system:fixture",
          leaseToken: claim.leaseToken,
        });
        await db.internationalCheckoutVerificationRun.update({
          where: { id: claim.runId },
          data: { leaseUntil: new Date(0) },
        });
        assert.equal(
          (
            await expireInternationalVerificationRuns({
              prismaClient: db,
              shopDomain: f.shopDomain,
            })
          ).expired,
          1,
        );
        await assert.rejects(
          heartbeatInternationalVerificationRun({
            prismaClient: db,
            shopDomain: f.shopDomain,
            runId: claim.runId,
            executorId: "system:fixture",
            leaseToken: claim.leaseToken,
          }),
          (e) => e.code === "international_run_lease_invalid",
        );
        const stopped = await stateOf(f);
        await internationalAuthorizationTransaction(db, (tx, now) =>
          recordInternationalRunClosure(tx, {
            state: stopped,
            generation: stopped.desiredGeneration,
            protected: false,
            now,
          }),
        );
        let run = await db.internationalCheckoutVerificationRun.findUnique({
          where: { id: claim.runId },
        });
        assert.equal(run.closureStatus, "UNVERIFIED");
        assert.ok(run.activeKey);
        await internationalAuthorizationTransaction(db, (tx, now) =>
          recordInternationalRunClosure(tx, {
            state: stopped,
            generation: stopped.desiredGeneration,
            protected: true,
            now,
          }),
        );
        run = await db.internationalCheckoutVerificationRun.findUnique({
          where: { id: claim.runId },
        });
        assert.equal(run.status, "EXPIRED");
        assert.equal(run.activeKey, null);
      },
    );
    await t.test(
      "database rejects cross-shop authorization references and invalid request shapes",
      async () => {
        const f = await fixture();
        const preview = await f.commands.preview(post(), f.input);
        await assert.rejects(
          db.internationalGateSyncState.create({
            data: {
              shopDomain: "unrelated.myshopify.com",
              authorizationRequestId: preview.requestId,
            },
          }),
          (e) => e.code === "P2003",
        );
        await assert.rejects(
          db.internationalGateAuthorizationRequest.update({
            where: { id: preview.requestId },
            data: { purpose: "UNKNOWN" },
          }),
        );
        await assert.rejects(
          db.internationalGateAuthorizationRequest.update({
            where: { id: preview.requestId },
            data: { purpose: "RESUME", resumePurpose: null },
          }),
        );
      },
    );
    await t.test(
      "a runner exit requests closure but never self-certifies success",
      async () => {
        const f = await fixture();
        await consume(f, await f.commands.preview(post(), f.input));
        const state = await stateOf(f);
        const claim = await claimInternationalVerificationRun(
          {
            prismaClient: db,
            shopDomain: f.shopDomain,
            runId: state.verificationRunId,
            executorId: "system:fixture",
          },
          capable,
        );
        const command = {
          prismaClient: db,
          shopDomain: f.shopDomain,
          runId: claim.runId,
          executorId: "system:fixture",
          leaseToken: claim.leaseToken,
        };
        assert.equal(
          (await requestInternationalVerificationClosure(command)).pending,
          true,
        );
        const run = await db.internationalCheckoutVerificationRun.findUnique({
          where: { id: claim.runId },
        });
        assert.equal(run.status, "CLOSING");
        assert.ok(run.activeKey);
        assert.equal((await stateOf(f)).mode, "STOPPED");
        await assert.rejects(
          requestInternationalVerificationClosure(command),
          (e) => e.code === "international_run_lease_invalid",
        );
      },
    );
    await t.test(
      "proof revocation and deployment-only SALE proof cannot consume a preview",
      async () => {
        const f = await fixture();
        const preview = await f.commands.preview(post(), f.input);
        await db.operationalReadinessAttestation.update({
          where: { id: f.proof.id },
          data: { status: "FAILED", revision: { increment: 1 } },
        });
        await assert.rejects(
          consume(f, preview),
          (e) => e.code === "international_proof_changed",
        );
        const sale = await fixture();
        await assert.rejects(
          sale.commands.preview(post(), {
            ...sale.input,
            purpose: "SALE",
            verificationKind: null,
          }),
          (e) => e.code === "international_proof_level_invalid",
        );
      },
    );
  },
);

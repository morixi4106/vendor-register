import { randomUUID } from "node:crypto";
import prisma from "../db.server.js";
import {
  buildInternationalGateSnapshot,
  closedInternationalGate,
  internationalLocalDate,
} from "./internationalGateProjection.server.js";
import {
  internationalGateTransaction,
  invalidateInternationalGates,
  stopInternationalGateInTransaction,
} from "./internationalGateQueue.server.js";
import {
  internationalGraphQL,
  internationalGateError,
  readInternationalMetafield,
  writeInternationalMetafield,
  verifyInternationalProductReadbacks,
} from "./internationalGateTransport.server.js";
import { inspectInternationalNativeConfiguration } from "./internationalNativeConfiguration.server.js";
import {
  inspectInternationalGateRelease,
  inspectInternationalStopProtection,
} from "./internationalGateAuthorization.server.js";
import { inspectInternationalCheckoutGate } from "./internationalCheckoutInspection.server.js";
import { inspectInternationalAuthorizationState } from "./internationalAuthorizationState.server.js";
import { expireInternationalVerificationRuns, recordInternationalRunClosure } from "./internationalVerificationRuns.server.js";

const REVIEW_ERRORS = new Set([
  "international_access_denied",
  "international_query_unverified",
  "international_target_missing",
  "international_native_configuration_unverified",
  "international_authorization_unverified",
  "international_timezone_changed",
]);

export async function runInternationalGateSync(
  {
    shopDomain,
    prismaClient = prisma,
    env = process.env,
    now = new Date(),
    maxJobs = 12,
    timeBudgetMs = 20000,
    stopOnly = false,
  } = {},
  {
    graphQL = internationalGraphQL,
    buildSnapshot = buildInternationalGateSnapshot,
    inspectNative = inspectInternationalNativeConfiguration,
    inspectRelease = inspectInternationalGateRelease,
    inspectStopProtection = inspectInternationalStopProtection,
    inspectAuthorization = inspectInternationalAuthorizationState,
  } = {},
) {
  const started = Date.now();
  const deadline = started + Math.min(60000, Math.max(1000, timeBudgetMs));
  const call = (args) => {
    const remaining = deadline - Date.now();
    if (remaining < 500)
      throw internationalGateError("international_budget_exhausted");
    return graphQL({ ...args, timeoutMs: Math.min(10000, remaining) });
  };
  if (prismaClient.internationalCheckoutVerificationRun)
    await expireInternationalVerificationRuns({ prismaClient, shopDomain });
  const states = await prismaClient.internationalGateSyncState.findMany({
    where: {
      mode: { in: ["ENFORCE", "STOPPED"] },
      ...(shopDomain ? { shopDomain } : {}),
    },
    take: 20,
    orderBy: { shopDomain: "asc" },
  });
  if (!states.length) return { ok: true, skipped: true, processed: 0 };
  let processed = 0;
  let failed = 0;
  let protectedState = false;
  for (const initial of states) {
    const authorization = initial.mode === "ENFORCE"
      ? await inspectAuthorization({ prismaClient, state: initial, now: new Date() }) : null;
    if (initial.mode === "ENFORCE" && !authorization.ready && !authorization.waiting)
      await internationalGateTransaction(prismaClient, (tx) => stopInternationalGateInTransaction(tx, {
        shopDomain: initial.shopDomain, expectedGeneration: initial.desiredGeneration,
        now: new Date(), reason: "international_authorization_unverified",
      }));
    if (!stopOnly && authorization?.ready && initial.phase === "ACTIVE") {
      const inspection = await inspectInternationalCheckoutGate(
        { shopDomain: initial.shopDomain, prismaClient, env, now },
        { graphQL: call, buildSnapshot, inspectNative, inspectRelease, inspectAuthorization },
      );
      if (!inspection.ready && !inspection.verificationReady)
        await internationalGateTransaction(prismaClient, (tx) =>
          invalidateInternationalGates(tx, {
            shopDomain: initial.shopDomain,
            now,
          }),
        );
    }
    // Expiry renewal and periodic dependency checks still use the closed-first path.
    if (
      !stopOnly &&
      authorization?.ready &&
      initial.phase === "ACTIVE" &&
      initial.nextExpiryAt &&
      new Date(initial.nextExpiryAt).getTime() <= now.getTime() + 3 * 3600000
    ) {
      await internationalGateTransaction(prismaClient, (tx) =>
        invalidateInternationalGates(tx, {
          shopDomain: initial.shopDomain,
          now,
        }),
      );
    }
    for (
      let index = 0;
      processed < Math.min(50, maxJobs) && Date.now() < deadline;
      index++
    ) {
      const state = await prismaClient.internationalGateSyncState.findUnique({
        where: { shopDomain: initial.shopDomain },
      });
      if (!state || state.mode === "DISABLED") break;
      const query = {
        shopDomain: state.shopDomain,
        generation: state.desiredGeneration,
        status: { in: ["PENDING", "RETRY", "RUNNING"] },
        nextAttemptAt: { lte: new Date() },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
        ...(stopOnly ? { targetType: "RECONCILE" } : {}),
      };
      const jobs = await prismaClient.internationalGateSyncJob.findMany({
        where: query,
        orderBy: [{ createdAt: "asc" }, { targetId: "asc" }],
        take: 202,
      });
      const job =
        jobs.find((j) => j.targetType === "RECONCILE") ||
        jobs.find((j) => j.targetType === "PRODUCT") ||
        jobs[0];
      if (!job) break;
      if (
        job.targetType === "SHOP" &&
        (await prismaClient.internationalGateSyncJob.count({
          where: {
            shopDomain: state.shopDomain,
            generation: job.generation,
            targetType: "PRODUCT",
            status: { not: "VERIFIED" },
          },
        }))
      )
        break;
      const leaseToken = randomUUID();
      const claim = await prismaClient.internationalGateSyncJob.updateMany({
        where: { id: job.id, ...query },
        data: {
          status: "RUNNING",
          leaseToken,
          leaseUntil: new Date(Date.now() + 120000),
          attempts: { increment: 1 },
        },
      });
      if (claim.count !== 1) continue;
      processed++;
      const assertCurrent = async () => {
        const current =
          await prismaClient.internationalGateSyncState.findUnique({
            where: { shopDomain: state.shopDomain },
          });
        const lease = await prismaClient.internationalGateSyncJob.findUnique({
          where: { id: job.id },
        });
        if (
          !current ||
          current.desiredGeneration !== job.generation ||
          (current.authorizationRequestId || null) !== (job.authorizationRequestId || null) ||
          current.mode === "DISABLED" ||
          (job.payloadJson?.s === "ACTIVE" && current.mode !== "ENFORCE") ||
          lease?.leaseToken !== leaseToken ||
          lease.status !== "RUNNING" ||
          new Date(lease.leaseUntil).getTime() <= Date.now()
        ) {
          throw internationalGateError("international_job_superseded");
        }
        if (job.payloadJson?.s === "ACTIVE" || (job.targetType === "PRODUCT" && job.payloadJson?.c?.length)) {
          if (!(await inspectAuthorization({ prismaClient, state: current, now: new Date() })).ready)
            throw internationalGateError("international_authorization_unverified");
        }
      };
      const finish = async (data) => {
        await assertCurrent();
        const result = await prismaClient.internationalGateSyncJob.updateMany({
          where: {
            id: job.id,
            leaseToken,
            status: "RUNNING",
            leaseUntil: { gt: new Date() },
          },
          data: { ...data, leaseToken: null, leaseUntil: null },
        });
        if (result.count !== 1)
          throw internationalGateError("international_job_superseded");
      };
      try {
        if (job.targetType === "RECONCILE") {
          const observed = await readInternationalMetafield({
            shopDomain: state.shopDomain,
            targetType: "SHOP",
            graphQL: call,
          });
          const closed = closedInternationalGate(
            job.generation,
            now,
            observed.timezone,
          );
          await writeInternationalMetafield({
            shopDomain: state.shopDomain,
            targetType: "SHOP",
            projection: closed,
            assertCurrent,
            graphQL: call,
          });
          const runtime = await inspectStopProtection({
            shopDomain: state.shopDomain,
            prismaClient,
            env,
            graphQL: call,
            now,
          });
          protectedState = runtime.ready === true;
          await assertCurrent();
          await prismaClient.internationalGateSyncState.updateMany({
            where: {
              shopDomain: state.shopDomain,
              desiredGeneration: job.generation,
            },
            data: {
              phase: "PREPARING",
              protectedAt: protectedState ? new Date() : null,
              observedShopHash: closed.h,
            },
          });
          if (stopOnly) {
            if (state.mode === "STOPPED")
              await internationalGateTransaction(prismaClient, (tx) => recordInternationalRunClosure(tx, {
                state, generation: job.generation, protected: protectedState, now: new Date(),
              }));
            await finish({
              status: "RETRY",
              nextAttemptAt: new Date(),
              lastErrorCode: null,
            });
            break;
          }
          if (state.mode === "STOPPED") {
            await internationalGateTransaction(prismaClient, (tx) => recordInternationalRunClosure(tx, {
              state, generation: job.generation, protected: protectedState, now: new Date(),
            }));
            await prismaClient.internationalGateSyncState.updateMany({
              where: {
                shopDomain: state.shopDomain,
                desiredGeneration: job.generation,
              },
              data: { phase: "BLOCKED", appliedGeneration: job.generation },
            });
            await finish(protectedState ? { status: "VERIFIED", verifiedAt: new Date() } : {
              status: "RETRY", nextAttemptAt: new Date(Date.now() + 30000), lastErrorCode: "international_stop_unverified",
            });
            break;
          }
          const currentAuthorization = await inspectAuthorization({ prismaClient, state, now: new Date() });
          if (currentAuthorization.waiting) {
            await finish({ status: "RETRY", nextAttemptAt: new Date(Date.now() + 30000), lastErrorCode: "international_runner_not_started" });
            break;
          }
          if (!currentAuthorization.ready) throw internationalGateError("international_authorization_unverified");
          if (observed.timezone !== state.shopTimezone)
            throw internationalGateError("international_timezone_changed");
          if (state.snapshotComplete) {
            await finish({ status: "VERIFIED", verifiedAt: new Date() });
            continue;
          }
          const snapshot = await internationalGateTransaction(
            prismaClient,
            async (tx) => {
              const current = await tx.internationalGateSyncState.findUnique({
                where: { shopDomain: state.shopDomain },
              });
              if (current.desiredGeneration !== job.generation)
                throw internationalGateError("international_job_superseded");
              const built = await buildSnapshot({
                state: current,
                prismaClient: tx,
                env,
                now,
                persist: true,
              });
              for (const target of built.targets)
                await tx.internationalGateSyncJob.create({
                  data: {
                    shopDomain: state.shopDomain,
                    generation: job.generation,
                    authorizationRequestId: current.authorizationRequestId || null,
                    targetType: "PRODUCT",
                    targetId: target.targetId,
                    payloadJson: target.projection,
                    expectedHash: target.projection.h,
                    nextAttemptAt: new Date(),
                  },
                });
              await tx.internationalGateSyncJob.create({
                data: {
                  shopDomain: state.shopDomain,
                  generation: job.generation,
                  authorizationRequestId: current.authorizationRequestId || null,
                  targetType: "SHOP",
                  targetId: state.shopDomain,
                  payloadJson: built.shop,
                  expectedHash: built.shop.h,
                  nextAttemptAt: new Date(),
                },
              });
              await tx.internationalGateSyncState.update({
                where: { shopDomain: state.shopDomain },
                data: {
                  snapshotComplete: true,
                  sourceHash: built.sourceHash,
                  expectedShopJson: built.shop,
                  expectedShopHash: built.shop.h,
                  expectedProductCount: built.targets.length,
                  verifiedProductCount: 0,
                  nextExpiryAt: built.nextExpiryAt,
                },
              });
              return built;
            },
          );
          if (!snapshot)
            throw internationalGateError("international_snapshot_failed");
          await finish({ status: "VERIFIED", verifiedAt: new Date() });
        } else {
          if (
            !state.snapshotComplete ||
            job.payloadJson?.g !== job.generation ||
            job.payloadJson?.h !== job.expectedHash
          )
            throw internationalGateError("international_snapshot_failed");
          if (job.targetType === "SHOP" && job.payloadJson.s === "ACTIVE") {
            if (
              internationalLocalDate(new Date(), state.shopTimezone) >=
              job.payloadJson.e
            )
              throw internationalGateError("international_source_changed");
            const targets =
              await prismaClient.internationalGateSyncJob.findMany({
                where: {
                  shopDomain: state.shopDomain,
                  generation: job.generation,
                  targetType: "PRODUCT",
                  status: "VERIFIED",
                },
                orderBy: { targetId: "asc" },
              });
            if (targets.length !== state.expectedProductCount)
              throw internationalGateError(
                "international_inventory_incomplete",
              );
            await verifyInternationalProductReadbacks({
              shopDomain: state.shopDomain,
              targets,
              graphQL: call,
            });
            const fresh = await buildSnapshot({
              state,
              prismaClient,
              env,
              now: new Date(),
              persist: false,
            });
            if (
              fresh.sourceHash !== state.sourceHash ||
              JSON.stringify(fresh.shop.c) !== JSON.stringify(job.payloadJson.c)
            )
              throw internationalGateError("international_source_changed");
            const routes =
              await prismaClient.operationalReadinessAttestation.findMany({
                where: {
                  scopeType: "MARKET_COUNTRY",
                  checkKey: "INTERNATIONAL_SHOPIFY_DELIVERY_ROUTE_AUDIT",
                  scopeId: { in: job.payloadJson.c },
                },
              });
            const native = await inspectNative({
              shopDomain: state.shopDomain,
              scope: state.authorizedScopeJson,
              expectedRoutes: Object.fromEntries(
                routes.map((r) => [
                  r.scopeId,
                  r.metadataJson?.deliveryProfileId,
                ]),
              ),
              graphQL: call,
            });
            const release = await inspectRelease({
              shopDomain: state.shopDomain,
              prismaClient,
              native,
              env,
              now: new Date(),
              purpose: state.authorizationPurpose || "SALE",
            });
            const shop = await readInternationalMetafield({
              shopDomain: state.shopDomain,
              targetType: "SHOP",
              graphQL: call,
            });
            if (
              !native.available ||
              native.configHash !== state.nativeConfigHash ||
              !release.ready ||
              release.binding !== state.releaseBinding ||
              shop.timezone !== state.shopTimezone
            )
              throw internationalGateError(
                "international_authorization_unverified",
              );
          }
          await writeInternationalMetafield({
            shopDomain: state.shopDomain,
            targetType: job.targetType,
            targetId: job.targetId,
            projection: job.payloadJson,
            graphQL: call,
            assertCurrent: async (owner) => {
              await assertCurrent();
              if (
                job.targetType === "SHOP" &&
                job.payloadJson.s === "ACTIVE" &&
                owner.timezone !== state.shopTimezone
              )
                throw internationalGateError("international_timezone_changed");
            },
          });
          await internationalGateTransaction(prismaClient, async (tx) => {
            await assertCurrent();
            const result = await tx.internationalGateSyncState.updateMany({
              where: {
                shopDomain: state.shopDomain,
                desiredGeneration: job.generation,
                authorizationRequestId: state.authorizationRequestId || null,
                mode: state.mode,
              },
              data:
                job.targetType === "SHOP"
                  ? {
                      appliedGeneration: job.generation,
                      phase: job.payloadJson.s,
                      observedShopHash: job.expectedHash,
                      verifiedAt: new Date(),
                      lastErrorCode: null,
                    }
                  : { verifiedProductCount: { increment: 1 } },
            });
            if (result.count !== 1)
              throw internationalGateError("international_job_superseded");
            const completed = await tx.internationalGateSyncJob.updateMany({
              where: {
                id: job.id,
                leaseToken,
                status: "RUNNING",
                leaseUntil: { gt: new Date() },
              },
              data: {
                status: "VERIFIED",
                verifiedAt: new Date(),
                leaseToken: null,
                leaseUntil: null,
              },
            });
            if (completed.count !== 1)
              throw internationalGateError("international_job_superseded");
          });
        }
      } catch (error) {
        failed++;
        const code = String(error?.code || "international_sync_failed");
        const safeCode = /^international_[a-z_]+$/.test(code)
          ? code
          : "international_sync_failed";
        const review = REVIEW_ERRORS.has(safeCode);
        const delay = Math.max(
          Math.min(3600000, 30000 * 2 ** Math.min(7, job.attempts)),
          Math.min(86400000, Number(error?.retryAfterMs) || 0),
        );
        await prismaClient.internationalGateSyncJob.updateMany({
          where: { id: job.id, leaseToken, status: "RUNNING" },
          data: {
            status:
              safeCode === "international_job_superseded"
                ? "SUPERSEDED"
                : review
                  ? "NEEDS_REVIEW"
                  : "RETRY",
            nextAttemptAt: new Date(Date.now() + delay),
            leaseToken: null,
            leaseUntil: null,
            lastErrorCode: safeCode,
          },
        });
        await prismaClient.internationalGateSyncState.updateMany({
          where: {
            shopDomain: state.shopDomain,
            desiredGeneration: job.generation,
          },
          data: {
            lastErrorCode: safeCode,
          },
        });
        if (review)
          await internationalGateTransaction(prismaClient, async (tx) => {
            const current = await tx.internationalGateSyncState.findUnique({ where: { shopDomain: state.shopDomain } });
            if (current?.desiredGeneration === job.generation)
              await stopInternationalGateInTransaction(tx, { shopDomain: state.shopDomain, now: new Date(), reason: safeCode });
          });
        if (safeCode === "international_source_changed")
          await internationalGateTransaction(prismaClient, (tx) =>
            invalidateInternationalGates(tx, {
              shopDomain: state.shopDomain,
              now: new Date(),
            }),
          );
        break;
      }
    }
  }
  return { ok: failed === 0, processed, failed, protected: protectedState };
}

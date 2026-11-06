import {
  authorizationError,
  assertInternationalShop,
  internationalAuthorizationTransaction,
  inspectInternationalAuthorizationCapability,
  hashInternationalSecret,
  newInternationalSecret,
  matchesInternationalSecret,
  VERIFICATION_LEASE_MS,
} from "./internationalAuthorizationPolicy.server.js";
import { stopInternationalGateInTransaction } from "./internationalGateQueue.server.js";

// Internal lifecycle operations. Runner HTTP authentication is added in 4B-3.
export async function claimInternationalVerificationRun(
  { prismaClient, shopDomain, runId, executorId },
  { inspectCapability = inspectInternationalAuthorizationCapability } = {},
) {
  assertInternationalShop(shopDomain);
  if (!(await inspectCapability()).ready)
    throw authorizationError("international_verification_not_implemented", 422);
  if (!/^system:[a-z0-9_-]{1,80}$/.test(executorId || ""))
    throw authorizationError("international_executor_invalid", 403);
  const token = newInternationalSecret();
  await internationalAuthorizationTransaction(prismaClient, async (tx, now) => {
    const run = await tx.internationalCheckoutVerificationRun.findFirst({
      where: { id: runId, shopDomain },
    });
    const state = await tx.internationalGateSyncState.findUnique({
      where: { shopDomain },
    });
    const request =
      run?.authorizationRequestId &&
      (await tx.internationalGateAuthorizationRequest.findUnique({
        where: { id: run.authorizationRequestId },
      }));
    if (
      !run ||
      run.status !== "QUEUED" ||
      run.expiresAt <= now ||
      !request?.consumedAt ||
      request.revokedAt ||
      state?.mode !== "ENFORCE" ||
      state.verificationRunId !== run.id ||
      state.authorizationRequestId !== request.id
    )
      throw authorizationError("international_run_unavailable");
    const result = await tx.internationalCheckoutVerificationRun.updateMany({
      where: {
        id: run.id,
        shopDomain,
        status: "QUEUED",
        expiresAt: { gt: now },
      },
      data: {
        status: "RUNNING",
        executorId,
        startedAt: now,
        heartbeatAt: now,
        leaseTokenHash: hashInternationalSecret(token),
        leaseUntil: new Date(
          Math.min(
            now.getTime() + VERIFICATION_LEASE_MS,
            run.expiresAt.getTime(),
          ),
        ),
      },
    });
    if (result.count !== 1)
      throw authorizationError("international_run_unavailable");
  });
  return { runId, leaseToken: token };
}

export async function heartbeatInternationalVerificationRun({
  prismaClient,
  shopDomain,
  runId,
  executorId,
  leaseToken,
}) {
  assertInternationalShop(shopDomain);
  return internationalAuthorizationTransaction(
    prismaClient,
    async (tx, now) => {
      const run = await tx.internationalCheckoutVerificationRun.findFirst({
        where: { id: runId, shopDomain },
      });
      if (
        !run ||
        run.executorId !== executorId ||
        run.status !== "RUNNING" ||
        run.expiresAt <= now ||
        !run.leaseUntil ||
        run.leaseUntil <= now ||
        !matchesInternationalSecret(leaseToken, run.leaseTokenHash)
      )
        throw authorizationError("international_run_lease_invalid", 403);
      const leaseUntil = new Date(
        Math.min(
          now.getTime() + VERIFICATION_LEASE_MS,
          run.expiresAt.getTime(),
        ),
      );
      await tx.internationalCheckoutVerificationRun.update({
        where: { id: run.id },
        data: { heartbeatAt: now, leaseUntil },
      });
      return { ok: true, leaseUntil };
    },
  );
}

export async function expireInternationalVerificationRuns({
  prismaClient,
  shopDomain,
}) {
  return internationalAuthorizationTransaction(
    prismaClient,
    async (tx, now) => {
      const runs = await tx.internationalCheckoutVerificationRun.findMany({
        where: {
          ...(shopDomain ? { shopDomain } : {}),
          status: { in: ["QUEUED", "RUNNING"] },
          OR: [
            { expiresAt: { lte: now } },
            { status: "RUNNING", leaseUntil: { lte: now } },
          ],
        },
        take: 20,
        orderBy: { expiresAt: "asc" },
      });
      for (const run of runs) {
        await stopInternationalGateInTransaction(tx, {
          shopDomain: run.shopDomain,
          now,
          reason: "international_run_expired",
        });
        await tx.internationalCheckoutVerificationRun.update({
          where: { id: run.id },
          data: {
            outcomeCode: "EXPIRED",
            failureCode: "international_run_expired",
          },
        });
      }
      return { expired: runs.length };
    },
  );
}

export async function requestInternationalVerificationClosure({
  prismaClient,
  shopDomain,
  runId,
  executorId,
  leaseToken,
}) {
  assertInternationalShop(shopDomain);
  return internationalAuthorizationTransaction(
    prismaClient,
    async (tx, now) => {
      const run = await tx.internationalCheckoutVerificationRun.findFirst({
        where: { id: runId, shopDomain },
      });
      if (
        !run ||
        run.status !== "RUNNING" ||
        run.executorId !== executorId ||
        run.expiresAt <= now ||
        !run.leaseUntil ||
        run.leaseUntil <= now ||
        !matchesInternationalSecret(leaseToken, run.leaseTokenHash)
      )
        throw authorizationError("international_run_lease_invalid", 403);
      const state = await tx.internationalGateSyncState.findUnique({
        where: { shopDomain },
      });
      if (
        state?.verificationRunId !== run.id ||
        state.authorizationRequestId !== run.authorizationRequestId
      )
        throw authorizationError("international_run_unavailable");
      await stopInternationalGateInTransaction(tx, {
        shopDomain,
        now,
        reason: "international_verification_results_unavailable",
      });
      return { ok: true, pending: true };
    },
  );
}

export async function recordInternationalRunClosure(
  tx,
  { state, generation, protected: protectedState, now },
) {
  if (!tx.internationalCheckoutVerificationRun) return;
  const current = await tx.internationalGateSyncState.findUnique({
    where: { shopDomain: state.shopDomain },
  });
  if (
    !current ||
    current.mode !== "STOPPED" ||
    current.desiredGeneration !== generation ||
    (current.authorizationRequestId || null) !==
      (state.authorizationRequestId || null)
  )
    throw authorizationError("international_authorization_changed");
  await tx.internationalCheckoutVerificationRun.updateMany({
    where: {
      shopDomain: state.shopDomain,
      status: "CLOSING",
      closureGeneration: generation,
    },
    data: protectedState
      ? {
          status: "FAILED",
          closureStatus: "CONFIRMED",
          closedAt: now,
          completedAt: now,
          activeKey: null,
          leaseTokenHash: null,
          leaseUntil: null,
        }
      : { closureStatus: "UNVERIFIED" },
  });
  // Expiry remains distinct from failure; neither is a successful verifier result.
  if (protectedState)
    await tx.internationalCheckoutVerificationRun.updateMany({
      where: {
        shopDomain: state.shopDomain,
        status: "FAILED",
        outcomeCode: "EXPIRED",
        closureGeneration: generation,
      },
      data: { status: "EXPIRED" },
    });
}

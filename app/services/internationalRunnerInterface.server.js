import prisma from "../db.server.js";
import {
  authenticateInternationalRunner,
  readInternationalRunnerJson,
  limitInternationalRequests,
  internationalJson,
  internationalErrorResponse,
} from "./internationalRunnerAuthentication.server.js";
import { receiveInternationalProofDelivery } from "./internationalProofDelivery.server.js";
import {
  claimInternationalDeploymentRun,
  completeInternationalDeploymentRun,
  assertDeploymentLease,
} from "./internationalProofIssuance.server.js";
import {
  requestInternationalProofObservation,
  recordInternationalProofObservation,
  internationalObservationDue,
} from "./internationalProofObservation.server.js";
import { assertInternationalRunDelivery } from "./internationalProofDeliveryState.server.js";
import { internationalAuthorizationTransaction } from "./internationalAuthorizationPolicy.server.js";
import { stopInternationalGateInTransaction } from "./internationalGateQueue.server.js";
import {
  shape,
  proofError,
  ID,
  HASH,
} from "../utils/internationalProofContract.js";

const EXECUTOR = "system:international-deployment-verifier";
const FIELDS = {
  deployment: {
    next: [],
    claim: ["runId"],
    heartbeat: ["runId"],
    complete: ["runId", "observation"],
    fail: ["runId", "code"],
  },
  observer: {
    next: [],
    challenge: ["runId"],
    record: ["runId", "observation"],
    reportFailure: ["runId", "nonceHash", "sequence", "code"],
  },
};
const FAILURE_CODES = [
  "international_observation_unavailable",
  "international_deployment_changed",
];

export function createInternationalRunnerInterface({
  prismaClient = prisma,
  env = process.env,
  ...proofDeps
} = {}) {
  const db = prismaClient;
  return async function handle(request, purpose) {
    try {
      const principal = authenticateInternationalRunner(request, purpose, env);
      const input = await readInternationalRunnerJson(request);
      await limitInternationalRequests(
        db,
        principal,
        purpose,
        purpose === "publisher" ? 10 : 60,
      );
      if (purpose === "publisher")
        return internationalJson(
          await receiveInternationalProofDelivery(
            db,
            principal,
            input,
            proofDeps,
          ),
        );
      const fields =
        input &&
        typeof input.intent === "string" &&
        Object.hasOwn(FIELDS[purpose] || {}, input.intent)
          ? FIELDS[purpose][input.intent]
          : null;
      if (!fields) throw proofError("international_intent_invalid", 400);
      shape(input, ["intent", ...fields], 32000);
      if (fields.includes("runId") && !ID.test(input.runId || ""))
        throw proofError("international_input_invalid", 422);
      if (input.intent === "next") {
        const now = new Date();
        const rows = await db.internationalCheckoutVerificationRun.findMany({
          where: {
            shopDomain: principal.shopDomain,
            kind: "DEPLOYMENT",
            revokedAt: null,
            ...(purpose === "deployment"
              ? { status: "QUEUED", expiresAt: { gt: now } }
              : {
                  status: "PASSED",
                  OR: [
                    { observationFailureCode: null },
                    {
                      observationFailureCode: {
                        not: "international_deployment_changed",
                      },
                    },
                  ],
                }),
          },
          select: {
            id: true,
            shopDomain: true,
            observedAt: true,
            observationRefreshRequestedAt: true,
            observationRetryAt: true,
            proofDeliveryId: true,
            resultsJson: true,
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 20,
        });
        for (const row of rows) {
          if (
            purpose === "observer" &&
            !(await internationalObservationDue(db, row, now))
          )
            continue;
          try {
            await assertInternationalRunDelivery(db, row, now);
          } catch {
            continue;
          }
          return internationalJson({ ok: true, task: { runId: row.id } });
        }
        return internationalJson({ ok: true, task: null });
      }
      const args = {
        prismaClient: db,
        shopDomain: principal.shopDomain,
        runId: input.runId,
        executorId: EXECUTOR,
        leaseToken: request.headers.get("x-international-lease") || "",
      };
      let result;
      if (purpose === "deployment") {
        if (input.intent === "claim") {
          result = await claimInternationalDeploymentRun(args);
          const row = await db.internationalCheckoutVerificationRun.findFirst({
            where: { id: input.runId, shopDomain: principal.shopDomain },
          });
          result = {
            ok: true,
            ...result,
            receipt: row.resultsJson.receipt,
            sequence: 1,
          };
        } else if (input.intent === "complete") {
          result = await completeInternationalDeploymentRun(
            { ...args, observation: input.observation },
            { ...proofDeps, env },
          );
        } else
          result = await internationalAuthorizationTransaction(
            db,
            async (tx, now) => {
              const row =
                await tx.internationalCheckoutVerificationRun.findFirst({
                  where: { id: input.runId, shopDomain: principal.shopDomain },
                });
              const state = await tx.internationalGateSyncState.findUnique({
                where: { shopDomain: principal.shopDomain },
              });
              assertDeploymentLease(row, state, args, now);
              await assertInternationalRunDelivery(tx, row, now);
              if (input.intent === "heartbeat") {
                const leaseUntil = new Date(
                  Math.min(+now + 300000, +row.expiresAt),
                );
                await tx.internationalCheckoutVerificationRun.update({
                  where: { id: row.id },
                  data: { heartbeatAt: now, leaseUntil },
                });
                return { ok: true, leaseUntil };
              }
              if (!FAILURE_CODES.includes(input.code))
                throw proofError("international_input_invalid", 422);
              await stopInternationalGateInTransaction(tx, {
                shopDomain: principal.shopDomain,
                now,
                reason: input.code,
              });
              return { ok: true, pending: true };
            },
          );
      } else if (input.intent === "challenge")
        result = {
          ok: true,
          ...(await requestInternationalProofObservation(args)),
        };
      else if (input.intent === "record")
        result = await recordInternationalProofObservation(
          { ...args, observation: input.observation },
          proofDeps,
        );
      else
        result = await internationalAuthorizationTransaction(
          db,
          async (tx, now) => {
            const row = await tx.internationalCheckoutVerificationRun.findFirst(
              { where: { id: input.runId, shopDomain: principal.shopDomain } },
            );
            if (
              !row ||
              row.status !== "PASSED" ||
              row.revokedAt ||
              !row.observationRequestedAt ||
              now - row.observationRequestedAt > 60000 ||
              !HASH.test(input.nonceHash || "") ||
              row.observationNonceHash !== input.nonceHash ||
              input.sequence !==
                (row.observationJson?.payload?.sequence || 0) + 1 ||
              !FAILURE_CODES.includes(input.code)
            )
              throw proofError("international_observation_unavailable", 409);
            await assertInternationalRunDelivery(tx, row, now);
            await tx.internationalCheckoutVerificationRun.update({
              where: { id: row.id },
              data: {
                observationFailureCode: input.code,
                observationRetryAt: new Date(+now + 60000),
                observationNonceHash: null,
                observationRequestedAt: null,
              },
            });
            const proof = await tx.operationalReadinessAttestation.findFirst({
              where: {
                scopeType: "SHOP",
                scopeId: principal.shopDomain,
                checkKey: "INTERNATIONAL_CHECKOUT_DEPLOYMENT_VERIFIED",
              },
            });
            if (
              input.code === "international_deployment_changed" &&
              proof?.metadataJson?.runId === row.id
            )
              await stopInternationalGateInTransaction(tx, {
                shopDomain: principal.shopDomain,
                now,
                reason: input.code,
              });
            return { ok: true, pending: true };
          },
        );
      return internationalJson(result);
    } catch (error) {
      return internationalErrorResponse(error);
    }
  };
}

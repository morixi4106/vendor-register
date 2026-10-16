import prisma from "../db.server.js";
import { normalizeShopDomain } from "../utils/shopifyAdmin.server.js";
import { internationalEvidenceVersion } from "../utils/internationalEvidenceVersion.js";
export { internationalEvidenceVersion } from "../utils/internationalEvidenceVersion.js";

export async function internationalGateTransaction(client, callback) {
  if (!client.$transaction) return callback(client);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await client.$transaction(callback, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      if (error?.code !== "P2034" || attempt === 2) throw error;
    }
  }
}

export function staleInternationalEvidence() {
  const error = new Error(
    "International evidence changed; reload before saving.",
  );
  error.code = "INTERNATIONAL_EVIDENCE_CONFLICT";
  return error;
}

export function assertInternationalEvidenceVersion(row, expectedVersion) {
  if (
    expectedVersion !== undefined &&
    expectedVersion !== internationalEvidenceVersion(row)
  ) {
    throw staleInternationalEvidence();
  }
}

// Called inside the source write transaction. Disabled shops never write Shopify.
export async function invalidateInternationalGates(
  client,
  { shopDomain, now = new Date() } = {},
) {
  if (!client.internationalGateSyncState) return { queued: 0 };
  const states = await client.internationalGateSyncState.findMany({
    where: {
      mode: { in: ["ENFORCE", "STOPPED"] },
      ...(shopDomain ? { shopDomain } : {}),
    },
  });
  for (const state of states) {
    if (state.desiredGeneration >= 2147483646)
      throw new Error("international_generation_exhausted");
    const generation = state.desiredGeneration + 1;
    const updated = await client.internationalGateSyncState.updateMany({
      where: {
        shopDomain: state.shopDomain,
        desiredGeneration: state.desiredGeneration,
      },
      data: {
        desiredGeneration: generation,
        phase: "PENDING",
        snapshotComplete: false,
        protectedAt: null,
        verifiedAt: null,
        lastErrorCode: null,
      },
    });
    if (updated.count !== 1) throw staleInternationalEvidence();
    await client.internationalGateSyncJob.updateMany({
      where: {
        shopDomain: state.shopDomain,
        generation: { lt: generation },
        status: { not: "SUPERSEDED" },
      },
      data: { status: "SUPERSEDED", leaseToken: null, leaseUntil: null },
    });
    await client.internationalGateSyncJob.create({
      data: {
        shopDomain: state.shopDomain,
        generation,
        authorizationRequestId: state.authorizationRequestId || null,
        targetType: "RECONCILE",
        targetId: state.shopDomain,
        nextAttemptAt: now,
      },
    });
  }
  return { queued: states.length };
}

export async function withInternationalGateInvalidation(
  client,
  write,
  options = {},
) {
  let queued = false;
  const result = await internationalGateTransaction(client, async (tx) => {
    const result = await write(tx);
    if (result?.ok !== false)
      queued = (await invalidateInternationalGates(tx, options)).queued > 0;
    return result;
  });
  if (queued && client.$transaction)
    await flushInternationalGateStops(client, options);
  return result;
}

export async function flushInternationalGateStops(
  prismaClient = prisma,
  { shopDomain } = {},
) {
  if (!prismaClient.$transaction || !prismaClient.internationalGateSyncState)
    return;
  try {
    const { runInternationalGateSync } =
      await import("./internationalGateSync.server.js");
    return await runInternationalGateSync({
      shopDomain,
      prismaClient,
      maxJobs: 1,
      timeBudgetMs: 8000,
      stopOnly: true,
    });
  } catch {
    return { ok: false, reason: "international_stop_pending" };
  }
}

export function writeInternationalProduct(client, operation, args) {
  if (!["update", "updateMany", "delete", "deleteMany"].includes(operation))
    throw new Error("international_product_operation_invalid");
  const policyFields = new Set([
    "name",
    "category",
    "approvalStatus",
    "shopifyProductId",
    "shopifyVariantId",
    "shopDomain",
    "vendorStoreId",
    "shippingWeightGrams",
    "shippingLengthMm",
    "shippingWidthMm",
    "shippingHeightMm",
    "internationalShippingMethod",
    "shippingWeightConfirmedAt",
    "shippingWeightSource",
    "shopifyVariantCount",
    "shopifyWeightSyncStatus",
    "productEuStatus",
    "euSaleRequested",
    "regulatorySelfCertificationJson",
  ]);
  if (
    operation.startsWith("update") &&
    !Object.keys(args.data || {}).some((key) => policyFields.has(key))
  )
    return client.product[operation](args);
  return withInternationalGateInvalidation(client, (tx) =>
    tx.product[operation](args),
  );
}

export async function requestInternationalGateSync({
  shopDomain: rawDomain,
  prismaClient = prisma,
  now = new Date(),
}) {
  const shopDomain = normalizeShopDomain(rawDomain);
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain || ""))
    return { ok: false, reason: "invalid_shop_domain" };
  return internationalGateTransaction(prismaClient, async (tx) => {
    const state = await tx.internationalGateSyncState.upsert({
      where: { shopDomain },
      create: { shopDomain },
      update: {},
    });
    if (state.mode === "DISABLED")
      return { ok: false, reason: "international_sync_not_armed" };
    await invalidateInternationalGates(tx, { shopDomain, now });
    return { ok: true, pending: true, generation: state.desiredGeneration + 1 };
  });
}

export async function stopInternationalGateSync({
  shopDomain,
  prismaClient = prisma,
  now = new Date(),
}) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain || ""))
    return { ok: false, reason: "invalid_shop_domain" };
  await internationalGateTransaction(prismaClient, (tx) =>
    stopInternationalGateInTransaction(tx, { shopDomain, now, reason: "international_operator_stop" }),
  );
  const result = await flushInternationalGateStops(prismaClient, {
    shopDomain,
  });
  return { ok: true, pending: true, protected: result?.protected === true };
}

export async function stopInternationalGateInTransaction(tx, {
  shopDomain, now = new Date(), reason, expectedGeneration,
}) {
  const state = await tx.internationalGateSyncState.upsert({
    where: { shopDomain }, create: { shopDomain }, update: {},
  });
  if (expectedGeneration !== undefined && state.desiredGeneration !== expectedGeneration)
    throw staleInternationalEvidence();
  if (state.authorizationRequestId)
    await tx.internationalGateAuthorizationRequest.updateMany({
      where: { id: state.authorizationRequestId, shopDomain, revokedAt: null },
      data: { revokedAt: now, revocationReasonCode: reason },
    });
  await tx.internationalGateSyncState.update({ where: { shopDomain }, data: {
    mode: "STOPPED", stoppedAt: now, stopReasonCode: reason,
  } });
  await invalidateInternationalGates(tx, { shopDomain, now });
  if (tx.internationalCheckoutVerificationRun) {
    await tx.internationalCheckoutVerificationRun.updateMany({
      where: { shopDomain, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "CLOSING", outcomeCode: "FAILED", failureCode: reason,
        stopRequestedAt: now, closureGeneration: state.desiredGeneration + 1, closureStatus: "PENDING",
        leaseTokenHash: null, leaseUntil: null },
    });
    await tx.internationalCheckoutVerificationRun.updateMany({
      where: { shopDomain, status: "CLOSING" },
      data: { closureGeneration: state.desiredGeneration + 1 },
    });
  }
  return { generation: state.desiredGeneration + 1 };
}

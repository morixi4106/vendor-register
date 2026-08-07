import crypto from "node:crypto";

import prisma from "../db.server.js";
import { syncShopKomojuLimitedLaunchControl } from "./marketplaceCheckoutGate.server.js";
import { inspectKomojuLimitedLaunchScope } from "./komojuLimitedLaunchScope.server.js";

export const KOMOJU_LIMITED_LAUNCH_STATUS = Object.freeze({
  PREPARING: "PREPARING",
  ACTIVE: "ACTIVE",
  BLOCKED: "BLOCKED",
  COMPLETED: "COMPLETED",
});

export const KOMOJU_LIMITED_LAUNCH_PROJECTION_VERSION = 2;

function clean(value) {
  return String(value ?? "").trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function amount(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeState(value) {
  const state = clean(value).toUpperCase();
  if (state === KOMOJU_LIMITED_LAUNCH_STATUS.COMPLETED) return "INACTIVE";
  return ["INACTIVE", "PREPARING", "ACTIVE", "BLOCKED"].includes(state)
    ? state
    : "BLOCKED";
}

function toDateString(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

function toIsoString(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function sortedStrings(value) {
  return asArray(value).map(clean).filter(Boolean).sort();
}

function sameStrings(left, right) {
  return JSON.stringify(sortedStrings(left)) === JSON.stringify(sortedStrings(right));
}

function projectionHash(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function currentReleaseId(env) {
  const renderCommit = clean(env?.RENDER_GIT_COMMIT || env?.GIT_COMMIT);
  const shopifyAppVersion = clean(env?.SHOPIFY_APP_VERSION);
  return renderCommit && shopifyAppVersion
    ? `${renderCommit.slice(0, 12)}:${shopifyAppVersion}`
    : null;
}

export function isCompleteKomojuLimitedLaunchMetadata(metadata) {
  const value = asObject(metadata);
  const saleVerifiedAt = new Date(value.saleVerifiedAt);
  const expectedBankDepositAt = new Date(value.expectedBankDepositAt);
  const completionDeadline = new Date(value.completionDeadline);
  const actualPaidAmount = amount(value.actualPaidAmount);
  const maximumPlannedChargeAmount = amount(
    value.maximumPlannedChargeAmount,
  );
  const companyRefundReserveAmount = amount(
    value.companyRefundReserveAmount,
  );
  const maxGrossAmount = amount(value.maxGrossAmount);
  const maxOutstandingLiability = amount(value.maxOutstandingLiability);
  const minimumPayoutAmount = amount(value.minimumPayoutAmount);
  const estimatedProcessingFeeAmount = amount(
    value.estimatedProcessingFeeAmount,
  );

  return Boolean(
    value.verificationSource === "komoju_zero_balance_limited_launch" &&
      clean(value.probeId) &&
      clean(value.shopDomain) &&
      clean(value.shopifyOrderId) &&
      clean(value.marketplaceOrderId) &&
      clean(value.releaseId) &&
      /^[a-f0-9]{64}$/.test(clean(value.releaseFingerprint).toLowerCase()) &&
      Number.isFinite(saleVerifiedAt.getTime()) &&
      Number.isFinite(expectedBankDepositAt.getTime()) &&
      Number.isFinite(completionDeadline.getTime()) &&
      saleVerifiedAt.getTime() <= expectedBankDepositAt.getTime() &&
      expectedBankDepositAt.getTime() <= completionDeadline.getTime() &&
      actualPaidAmount > 0 &&
      clean(value.currencyCode).toUpperCase() === "JPY" &&
      maximumPlannedChargeAmount >= actualPaidAmount &&
      companyRefundReserveAmount >= maximumPlannedChargeAmount &&
      Number(value.maxOrderCount) === 2 &&
      maxGrossAmount >= actualPaidAmount &&
      maxOutstandingLiability >= actualPaidAmount &&
      maxGrossAmount <= companyRefundReserveAmount &&
      maxOutstandingLiability <= companyRefundReserveAmount &&
      sortedStrings(value.allowedProductIds).length === 1 &&
      sortedStrings(value.allowedShopifyProductIds).length === 1 &&
      clean(value.allowedShopifyVariantId) &&
      Number(value.canaryQuantity) === 1 &&
      Number(value.canaryInventoryQuantity) === 1 &&
      value.canaryInventoryTracked === true &&
      clean(value.canaryInventoryPolicy).toUpperCase() === "DENY" &&
      sortedStrings(value.allowedProductNames).length === 1 &&
      ["WEEKLY", "MONTHLY"].includes(
        clean(value.komojuPayoutCycle).toUpperCase(),
      ) &&
      minimumPayoutAmount > 0 &&
      actualPaidAmount - estimatedProcessingFeeAmount >= minimumPayoutAmount &&
      value.payoutNotOnHoldConfirmed === true &&
      Number(value.confirmedKomojuUnsettledBalanceAmount) === 0 &&
      value.zeroUnsettledBalanceConfirmed === true &&
      value.companyRefundReserveConfirmed === true &&
      value.directRefundFallbackConfirmed === true &&
      value.domesticPlatformDirectOnlyConfirmed === true &&
      value.thirdPartyCommerceDisabled === true &&
      Number(value.euEnabledSellerCount) === 0 &&
      Number(value.euEnabledProductCount) === 0 &&
      Number(value.internationalEnabledProductCount) === 0 &&
      clean(value.evidencePackageReference) &&
      value.strictE2eStillRequired === true
  );
}

function buildProjectionPayload({
  state,
  revision,
  expiresAt,
  productIds = [],
  variantId = "",
  maxSingleOrderAmount = 0,
  remainingOrders = 0,
  remainingGross = 0,
  remainingLiability = 0,
  currencyCode = "JPY",
}) {
  return {
    v: KOMOJU_LIMITED_LAUNCH_PROJECTION_VERSION,
    s: normalizeState(state),
    r: amount(revision) || 1,
    e: toDateString(expiresAt),
    x: toIsoString(expiresAt),
    p: sortedStrings(productIds),
    q: clean(variantId),
    m: amount(maxSingleOrderAmount),
    o: amount(remainingOrders),
    g: amount(remainingGross),
    l: amount(remainingLiability),
    c: clean(currencyCode || "JPY").toUpperCase(),
  };
}

export function buildKomojuLimitedLaunchProjection(
  control,
  { state = control?.status, revision = control?.projectionVersion } = {},
) {
  const normalizedState = normalizeState(state);
  const active = normalizedState === "ACTIVE";
  const metadata = asObject(control?.metadataJson);
  const payload = buildProjectionPayload({
    state: normalizedState,
    revision,
    expiresAt: control?.expiresAt,
    productIds: control?.allowedShopifyProductIdsJson,
    variantId: metadata.allowedShopifyVariantId,
    maxSingleOrderAmount: control?.maxSingleOrderAmount,
    remainingOrders: active
      ? Math.max(0, amount(control?.maxOrderCount) - amount(control?.orderCount))
      : 0,
    remainingGross: active
      ? Math.max(0, amount(control?.maxGrossAmount) - amount(control?.grossAmount))
      : 0,
    remainingLiability: active
      ? Math.max(
          0,
          amount(control?.maxOutstandingLiability) -
            amount(control?.outstandingLiabilityAmount),
        )
      : 0,
  });
  return { ...payload, h: projectionHash(payload) };
}

export function buildKomojuLimitedLaunchBaselineProjection({ revision = 1 } = {}) {
  const payload = buildProjectionPayload({
    state: "INACTIVE",
    revision,
    expiresAt: "9999-12-31T00:00:00.000Z",
  });
  return { ...payload, h: projectionHash(payload) };
}

export async function prepareKomojuLimitedLaunchBaseline(
  { shopDomain },
  { syncProjection = syncShopKomojuLimitedLaunchControl } = {},
) {
  const projection = buildKomojuLimitedLaunchBaselineProjection();
  const sync = await syncProjection({ shopDomain, projection });
  return sync?.ok === true
    ? { ok: true, projection, sync }
    : { ok: false, reason: sync?.reason || "limited_launch_baseline_sync_failed" };
}

function isPaidOrder(order) {
  return ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(
    clean(order?.financialStatus).toUpperCase(),
  );
}

function paidRefundAmount(order) {
  const providerRefund = asArray(order?.paymentRefundOperations)
    .filter(
      (refund) =>
        refund?.ledgerAppliedAt ||
        refund?.providerConfirmedAt ||
        ["LEDGER_APPLIED", "PROVIDER_CONFIRMED"].includes(
          clean(refund?.status).toUpperCase(),
        ),
    )
    .reduce((total, refund) => total + amount(refund?.amount), 0);
  const directRefund =
    clean(order?.directCustomerRefund?.status).toUpperCase() === "COMPLETED"
      ? amount(order.directCustomerRefund.amount)
      : 0;
  return Math.min(amount(order?.totalAmount), providerRefund + directRefund);
}

export async function calculateKomojuLimitedLaunchExposure(
  control,
  { prismaClient = prisma } = {},
) {
  const seedOrderId = clean(control?.metadataJson?.seedMarketplaceOrderId);
  const orders = await prismaClient.marketplaceOrder.findMany({
    where: {
      shopDomain: control.shopDomain,
      OR: [
        ...(seedOrderId ? [{ id: seedOrderId }] : []),
        { processedAt: { gte: control.startsAt } },
        { createdAt: { gte: control.startsAt } },
      ],
    },
    select: {
      id: true,
      totalAmount: true,
      financialStatus: true,
      sellerOrders: {
        select: {
          lines: {
            select: {
              productId: true,
              shopifyProductId: true,
              shopifyVariantId: true,
              quantity: true,
            },
          },
        },
      },
      paymentRefundOperations: {
        select: {
          amount: true,
          status: true,
          providerConfirmedAt: true,
          ledgerAppliedAt: true,
        },
      },
      refundGuard: { select: { channel: true, status: true } },
      directCustomerRefund: { select: { amount: true, status: true } },
    },
  });
  const allowedProductIds = new Set(sortedStrings(control.allowedProductIdsJson));
  const allowedVariantId = clean(control?.metadataJson?.allowedShopifyVariantId);
  const paidOrders = orders.filter(isPaidOrder);
  const disallowedProductOrderIds = [];
  const invalidCanaryOrderIds = [];
  const directRefundGuardOrderIds = [];

  for (const order of paidOrders) {
    const lines = order.sellerOrders.flatMap((sellerOrder) => sellerOrder.lines);
    if (
      lines.length === 0 ||
      lines.some((line) => !allowedProductIds.has(clean(line.productId)))
    ) {
      disallowedProductOrderIds.push(order.id);
    }
    if (
      lines.length !== 1 ||
      amount(lines[0]?.quantity) !== 1 ||
      clean(lines[0]?.shopifyVariantId) !== allowedVariantId
    ) {
      invalidCanaryOrderIds.push(order.id);
    }
    const refundGuardChannel = clean(order.refundGuard?.channel).toUpperCase();
    const refundGuardStatus = clean(order.refundGuard?.status).toUpperCase();
    if (
      (refundGuardChannel === "DIRECT" &&
        ["RESERVED", "COMPLETED", "CONFLICT"].includes(refundGuardStatus)) ||
      refundGuardStatus === "CONFLICT"
    ) {
      directRefundGuardOrderIds.push(order.id);
    }
  }

  return paidOrders.reduce(
    (summary, order) => {
      const total = amount(order.totalAmount);
      const refunded = paidRefundAmount(order);
      summary.orderCount += 1;
      summary.grossAmount += total;
      summary.outstandingLiabilityAmount += Math.max(0, total - refunded);
      summary.marketplaceOrderIds.push(order.id);
      return summary;
    },
    {
      orderCount: 0,
      grossAmount: 0,
      outstandingLiabilityAmount: 0,
      marketplaceOrderIds: [],
      disallowedProductOrderIds,
      invalidCanaryOrderIds,
      directRefundGuardOrderIds,
    },
  );
}

function projectionMetadataMatches(control) {
  const metadata = asObject(control?.metadataJson);
  const projection = buildKomojuLimitedLaunchProjection(control);
  return Boolean(
    control?.projectionSyncedAt &&
      clean(metadata.projectionState) === projection.s &&
      Number(metadata.projectionRevision) === projection.r &&
      clean(metadata.projectionHash) === projection.h &&
      clean(metadata.projectionReadbackHash) === projection.h &&
      Number(metadata.projectionReadbackRevision) === projection.r &&
      clean(metadata.projectionCompareDigest),
  );
}

function attestationMatches(control, attestation, probe, now) {
  const metadata = asObject(attestation?.metadataJson);
  const expiresAt = new Date(attestation?.expiresAt);
  const controlExpiresAt = new Date(control?.expiresAt);
  return Boolean(
    isCompleteKomojuLimitedLaunchMetadata(metadata) &&
      !clean(control?.blockReason) &&
    attestation?.id === control?.attestationId &&
      attestation?.status === "CONFIRMED" &&
      Number.isFinite(expiresAt.getTime()) &&
      expiresAt.getTime() > now.getTime() &&
      expiresAt.getTime() === controlExpiresAt.getTime() &&
      clean(metadata.probeId) === clean(control?.probeId) &&
      clean(metadata.releaseId) === clean(probe?.releaseId) &&
      clean(metadata.releaseFingerprint) === clean(probe?.releaseFingerprint) &&
      probe?.paidVerifiedAt &&
      probe?.paidEvidenceJson?.passed === true &&
      clean(probe?.orderEvidenceJson?.externalReadiness?.strategy) ===
        "ZERO_BALANCE_LIMITED_LAUNCH" &&
      clean(metadata.completionDeadline) === controlExpiresAt.toISOString() &&
      Number(metadata.maxOrderCount) === Number(control?.maxOrderCount) &&
      Number(metadata.maxGrossAmount) === Number(control?.maxGrossAmount) &&
      Number(metadata.maxOutstandingLiability) ===
        Number(control?.maxOutstandingLiability) &&
      Number(metadata.maximumPlannedChargeAmount) ===
        Number(control?.maxSingleOrderAmount) &&
      Number(metadata.companyRefundReserveAmount) ===
        Number(control?.companyRefundReserveAmount) &&
      sameStrings(metadata.allowedProductIds, control?.allowedProductIdsJson) &&
      sameStrings(
        metadata.allowedShopifyProductIds,
        control?.allowedShopifyProductIdsJson,
      ) &&
      clean(metadata.allowedShopifyVariantId) ===
        clean(control?.metadataJson?.allowedShopifyVariantId) &&
      Number(metadata.canaryQuantity) ===
        Number(control?.metadataJson?.canaryQuantity) &&
      Number(metadata.canaryInventoryQuantity) ===
        Number(control?.metadataJson?.canaryInventoryQuantity) &&
      metadata.canaryInventoryTracked ===
        control?.metadataJson?.canaryInventoryTracked &&
      clean(metadata.canaryInventoryPolicy).toUpperCase() ===
        clean(control?.metadataJson?.canaryInventoryPolicy).toUpperCase() &&
      clean(metadata.evidencePackageReference) ===
        clean(control?.metadataJson?.evidencePackageReference),
  );
}

export async function evaluateKomojuLimitedLaunchControl(
  control,
  {
    prismaClient = prisma,
    now = new Date(),
    scope = null,
    exposure = null,
    attestation = null,
    probe = null,
    env = process.env,
  } = {},
) {
  if (!control) {
    return { ready: false, blockingReason: null, reason: "limited_launch_inactive" };
  }
  const [resolvedAttestation, resolvedProbe, resolvedScope, resolvedExposure] =
    await Promise.all([
      attestation ||
        (control.attestationId &&
        prismaClient.operationalReadinessAttestation?.findUnique
          ? prismaClient.operationalReadinessAttestation.findUnique({
              where: { id: control.attestationId },
            })
          : null),
      probe ||
        (control.probeId && prismaClient.productionTransactionProbe?.findUnique
          ? prismaClient.productionTransactionProbe.findUnique({
              where: { id: control.probeId },
            })
          : null),
      scope ||
        (prismaClient.seller?.count && prismaClient.product?.count
          ? inspectKomojuLimitedLaunchScope({ prismaClient, env })
          : { ready: true }),
      exposure || calculateKomojuLimitedLaunchExposure(control, { prismaClient }),
    ]);
  const status = clean(control.status).toUpperCase();
  const strictE2ePassed = resolvedProbe?.status === "PASSED";
  const directRefundDetected =
    resolvedExposure.directRefundGuardOrderIds.length > 0;
  if (strictE2ePassed && !directRefundDetected) {
    return {
      ready: true,
      completed: true,
      blockingReason: null,
      reason: null,
      exposure: resolvedExposure,
      probe: resolvedProbe,
      attestation: resolvedAttestation,
      scope: resolvedScope,
    };
  }

  let blockingReason = null;
  if (status === KOMOJU_LIMITED_LAUNCH_STATUS.BLOCKED) {
    blockingReason = clean(control.blockReason) || "komoju_limited_launch_blocked";
  } else if (status === KOMOJU_LIMITED_LAUNCH_STATUS.PREPARING) {
    blockingReason = "komoju_limited_launch_preparing";
  } else if (status !== KOMOJU_LIMITED_LAUNCH_STATUS.ACTIVE) {
    blockingReason = "komoju_limited_launch_inactive";
  } else if (
    control.attestationId &&
    (!currentReleaseId(env) ||
      clean(resolvedProbe?.releaseId) !== currentReleaseId(env))
  ) {
    blockingReason = "komoju_limited_launch_release_changed";
  } else if (
    control.attestationId &&
    !attestationMatches(control, resolvedAttestation, resolvedProbe, now)
  ) {
    blockingReason = "komoju_limited_launch_attestation_mismatch";
  } else if (resolvedScope?.ready !== true) {
    blockingReason = resolvedScope?.reason || "komoju_limited_launch_scope_changed";
  } else if (
    !resolvedProbe ||
    !["AWAITING_PAYOUT_EVIDENCE", "AWAITING_REFUND_RESERVE_CONFIRMATION", "AWAITING_REFUND"].includes(
      resolvedProbe.status,
    )
  ) {
    blockingReason = "komoju_limited_launch_probe_not_continuing";
  } else if (new Date(control.expiresAt).getTime() <= now.getTime()) {
    blockingReason = "komoju_limited_launch_expired";
  } else if (
    Number(control.maxOrderCount) !== 2 ||
    sortedStrings(control.allowedProductIdsJson).length !== 1 ||
    sortedStrings(control.allowedShopifyProductIdsJson).length !== 1 ||
    !clean(control?.metadataJson?.allowedShopifyVariantId)
  ) {
    blockingReason = "komoju_limited_launch_canary_scope_invalid";
  } else if (resolvedExposure.disallowedProductOrderIds.length > 0) {
    blockingReason = "komoju_limited_launch_product_allowlist_violated";
  } else if (resolvedExposure.invalidCanaryOrderIds.length > 0) {
    blockingReason = "komoju_limited_launch_canary_cart_violated";
  } else if (directRefundDetected) {
    blockingReason = "komoju_limited_launch_direct_refund_detected";
  } else if (resolvedExposure.orderCount >= control.maxOrderCount) {
    blockingReason = "komoju_limited_launch_order_limit_reached";
  } else if (resolvedExposure.grossAmount >= control.maxGrossAmount) {
    blockingReason = "komoju_limited_launch_gross_limit_reached";
  } else if (
    resolvedExposure.outstandingLiabilityAmount >=
      control.maxOutstandingLiability ||
    resolvedExposure.outstandingLiabilityAmount >
      control.companyRefundReserveAmount
  ) {
    blockingReason = "komoju_limited_launch_liability_limit_reached";
  }

  const projectionReady = projectionMetadataMatches(control);
  return {
    ready: !blockingReason && projectionReady,
    completed: false,
    blockingReason,
    reason: blockingReason || (projectionReady ? null : "limited_launch_projection_mismatch"),
    syncRequired: !blockingReason && !projectionReady,
    exposure: resolvedExposure,
    probe: resolvedProbe,
    attestation: resolvedAttestation,
    scope: resolvedScope,
  };
}

function projectionChanged(control, state, exposure) {
  const candidate = {
    ...control,
    status: state,
    orderCount: exposure.orderCount,
    grossAmount: exposure.grossAmount,
    outstandingLiabilityAmount: exposure.outstandingLiabilityAmount,
  };
  const currentHash = clean(control?.metadataJson?.projectionHash);
  const sameRevision = buildKomojuLimitedLaunchProjection(candidate, {
    state,
    revision: control.projectionVersion,
  });
  return currentHash !== sameRevision.h;
}

async function applyEmergencyHoldSafely(
  { control, reason, prismaClient, now, emergencyHold },
) {
  const hold =
    emergencyHold ||
    (await import("./operationalReadiness.server.js"))
      .applyPlatformCheckoutEmergencyHold;
  try {
    return await hold(
      {
        reason,
        changedBy: "system:komoju-limited-launch",
        shopDomain: control.shopDomain,
      },
      { prismaClient, now },
    );
  } catch {
    return { ok: false, reason: "limited_launch_emergency_hold_failed" };
  }
}

export async function refreshKomojuLimitedLaunchControl(
  { shopDomain, applyEmergencyHold = true },
  {
    prismaClient = prisma,
    syncProjection = syncShopKomojuLimitedLaunchControl,
    emergencyHold = null,
    now = new Date(),
    env = process.env,
  } = {},
) {
  const control = await prismaClient.komojuLimitedLaunchControl.findUnique({
    where: { shopDomain: clean(shopDomain).toLowerCase() },
  });
  if (!control) {
    return { ok: true, skipped: true, reason: "limited_launch_not_active" };
  }

  const evaluation = await evaluateKomojuLimitedLaunchControl(control, {
    prismaClient,
    now,
    env,
  });
  const exposure = evaluation.exposure;
  const targetState = evaluation.completed
    ? "INACTIVE"
    : evaluation.blockingReason
      ? "BLOCKED"
      : "ACTIVE";
  const status = evaluation.completed
    ? KOMOJU_LIMITED_LAUNCH_STATUS.COMPLETED
    : targetState;
  const revision = projectionChanged(control, targetState, exposure)
    ? control.projectionVersion + 1
    : control.projectionVersion;
  const candidate = {
    ...control,
    status,
    projectionVersion: revision,
    orderCount: exposure.orderCount,
    grossAmount: exposure.grossAmount,
    outstandingLiabilityAmount: exposure.outstandingLiabilityAmount,
  };
  const projection = buildKomojuLimitedLaunchProjection(candidate, {
    state: targetState,
    revision,
  });

  let syncResult;
  try {
    syncResult = await syncProjection({
      shopDomain: control.shopDomain,
      projection,
    });
  } catch {
    syncResult = { ok: false, reason: "limited_launch_projection_sync_failed" };
  }

  if (syncResult?.ok !== true) {
    const blockRevision = Math.max(revision + 1, control.projectionVersion + 1);
    const blockedProjection = buildKomojuLimitedLaunchProjection(candidate, {
      state: "BLOCKED",
      revision: blockRevision,
    });
    try {
      await syncProjection({ shopDomain: control.shopDomain, projection: blockedProjection });
    } catch {
      // The emergency hold below is the independent fail-closed boundary.
    }
    const holdResult = applyEmergencyHold
      ? await applyEmergencyHoldSafely({
          control,
          reason: syncResult?.reason || "limited_launch_projection_sync_failed",
          prismaClient,
          now,
          emergencyHold,
        })
      : null;
    await prismaClient.komojuLimitedLaunchControl.update({
      where: { id: control.id },
      data: {
        status: KOMOJU_LIMITED_LAUNCH_STATUS.BLOCKED,
        projectionVersion: blockRevision,
        blockedAt: control.blockedAt || now,
        blockReason: syncResult?.reason || "limited_launch_projection_sync_failed",
        lastEvaluatedAt: now,
      },
    });
    return {
      ok: false,
      reason: syncResult?.reason || "limited_launch_projection_sync_failed",
      control,
      exposure,
      projection: blockedProjection,
      holdResult,
    };
  }

  const blockReason = evaluation.blockingReason;
  let updated;
  try {
    updated = await prismaClient.komojuLimitedLaunchControl.update({
      where: { id: control.id },
      data: {
        status,
        projectionVersion: revision,
        projectionSyncedAt: now,
        orderCount: exposure.orderCount,
        grossAmount: exposure.grossAmount,
        outstandingLiabilityAmount: exposure.outstandingLiabilityAmount,
        lastEvaluatedAt: now,
        blockedAt: blockReason ? control.blockedAt || now : null,
        blockReason,
        metadataJson: {
          ...asObject(control.metadataJson),
          marketplaceOrderIds: exposure.marketplaceOrderIds,
          disallowedProductOrderIds: exposure.disallowedProductOrderIds,
          invalidCanaryOrderIds: exposure.invalidCanaryOrderIds,
          directRefundGuardOrderIds: exposure.directRefundGuardOrderIds,
          projectionState: projection.s,
          projectionRevision: projection.r,
          projectionHash: projection.h,
          projectionReadbackHash: projection.h,
          projectionReadbackRevision: projection.r,
          projectionCompareDigest: syncResult.compareDigest,
          lastEvaluatedAt: now.toISOString(),
        },
      },
    });
  } catch (error) {
    const blockedProjection = buildKomojuLimitedLaunchProjection(candidate, {
      state: "BLOCKED",
      revision: revision + 1,
    });
    try {
      await syncProjection({ shopDomain: control.shopDomain, projection: blockedProjection });
    } catch {
      // Preserve the original database failure while attempting fail-closed rollback.
    }
    if (applyEmergencyHold) {
      await applyEmergencyHoldSafely({
        control,
        reason: "limited_launch_database_finalize_failed",
        prismaClient,
        now,
        emergencyHold,
      });
    }
    throw error;
  }

  const holdResult =
    blockReason && applyEmergencyHold
      ? await applyEmergencyHoldSafely({
          control: updated,
          reason: blockReason,
          prismaClient,
          now,
          emergencyHold,
        })
      : null;
  return {
    ok:
      holdResult?.ok === false &&
      holdResult.reason !== "purchase_stop_already_active"
        ? false
        : true,
    control: updated,
    exposure,
    projection,
    blockReason,
    holdResult,
  };
}

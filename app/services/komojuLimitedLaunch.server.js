import crypto from "node:crypto";

import prisma from "../db.server.js";
import { shopifyGraphQLWithOfflineSession } from "../utils/shopifyAdmin.server.js";
import { inspectKomojuLimitedLaunchScope } from "./komojuLimitedLaunchScope.server.js";
import {
  applyPlatformCheckoutEmergencyHold,
  KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_CHECK_KEY,
  OPERATIONAL_ATTESTATION_STATUS,
  recordOperationalReadinessAttestation,
} from "./operationalReadiness.server.js";
import { buildProductionReleaseFingerprint } from "./productionRelease.server.js";
import {
  buildKomojuLimitedLaunchProjection,
  KOMOJU_LIMITED_LAUNCH_STATUS,
} from "./komojuLimitedLaunchControl.server.js";
import { syncShopKomojuLimitedLaunchControl } from "./marketplaceCheckoutGate.server.js";

const LIMITED_LAUNCH_VALIDITY_DAYS = 7;
const LIMITED_LAUNCH_PREVIEW_TTL_MS = 15 * 60 * 1000;
const LIMITED_LAUNCH_SOURCE = "komoju_zero_balance_limited_launch";
const LIMITED_LAUNCH_ACTOR = "system:komoju-zero-balance-limited-launch";
const LIMITED_STRATEGY = "ZERO_BALANCE_LIMITED_LAUNCH";
const LIMITED_LAUNCH_MAX_ORDER_COUNT = 2;

const CANARY_VARIANT_QUERY = `#graphql
  query KomojuLimitedLaunchCanaryVariant($id: ID!) {
    productVariant(id: $id) {
      id
      inventoryQuantity
      inventoryPolicy
      inventoryItem { tracked }
      product { id title }
    }
  }
`;

function clean(value) {
  return String(value ?? "").trim();
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function toNonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeSha256(value) {
  const normalized = clean(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function buildReleaseContext(releaseExpectation) {
  const releaseFingerprint = buildProductionReleaseFingerprint(
    releaseExpectation,
  );
  return {
    releaseId: clean(releaseExpectation?.releaseId),
    releaseFingerprint,
    configured:
      releaseExpectation?.configured === true && Boolean(releaseFingerprint),
  };
}

function previewSecret(env) {
  return clean(env?.SHOPIFY_API_SECRET);
}

function previewSnapshot(candidate, evidence, { generatedAt, expiresAt }) {
  return {
    version: 2,
    generatedAt: generatedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    probeId: candidate.probe.id,
    probeUpdatedAt: new Date(candidate.probe.updatedAt).toISOString(),
    releaseId: candidate.probe.releaseId,
    releaseFingerprint: candidate.probe.releaseFingerprint,
    shopDomain: candidate.probe.shopDomain,
    shopifyOrderId: candidate.probe.shopifyOrderId,
    marketplaceOrderId: candidate.probe.marketplaceOrderId,
    actualPaidAmount: candidate.actualPaidAmount,
    currencyCode: candidate.currencyCode,
    maximumPlannedChargeAmount: candidate.maximumPlannedChargeAmount,
    companyRefundReserveAmount: candidate.companyRefundReserveAmount,
    maxOrderCount: candidate.maxOrderCount,
    maxGrossAmount: candidate.maxGrossAmount,
    maxOutstandingLiability: candidate.maxOutstandingLiability,
    expectedBankDepositAt: candidate.expectedBankDepositAt.toISOString(),
    minimumPayoutAmount: candidate.minimumPayoutAmount,
    estimatedProcessingFeeAmount: candidate.estimatedProcessingFeeAmount,
    allowedProductIds: [...candidate.allowedProductIds].sort(),
    allowedShopifyProductIds: [...candidate.allowedShopifyProductIds].sort(),
    allowedShopifyVariantId: candidate.allowedShopifyVariantId,
    canaryQuantity: 1,
    canaryInventoryQuantity: candidate.canaryInventoryQuantity,
    canaryInventoryTracked: candidate.canaryInventoryTracked,
    canaryInventoryPolicy: candidate.canaryInventoryPolicy,
    completionDeadline: candidate.completionDeadline.toISOString(),
    projectionRevision: 1,
    scope: {
      thirdPartyCommerceDisabled: candidate.scope.thirdPartyCommerceDisabled,
      euEnabledSellerCount: candidate.scope.euEnabledSellerCount,
      euEnabledProductCount: candidate.scope.euEnabledProductCount,
      internationalEnabledProductCount:
        candidate.scope.internationalEnabledProductCount,
    },
    evidenceReference: evidence.reference,
    evidenceHash: evidence.hash,
  };
}

function signPreview(snapshot, env) {
  const secret = previewSecret(env);
  if (!secret) return null;
  const payload = Buffer.from(JSON.stringify(snapshot)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return `v2.${payload}.${signature}`;
}

function readPreviewToken(token, { env, now }) {
  const parts = clean(token).split(".");
  const secret = previewSecret(env);
  if (parts.length !== 3 || parts[0] !== "v2" || !secret) return null;
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(parts[1])
    .digest("hex");
  const actualBuffer = Buffer.from(parts[2]);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }
  let snapshot;
  try {
    snapshot = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const generatedAt = new Date(snapshot?.generatedAt);
  const expiresAt = new Date(snapshot?.expiresAt);
  if (
    snapshot?.version !== 2 ||
    !Number.isFinite(generatedAt.getTime()) ||
    !Number.isFinite(expiresAt.getTime()) ||
    generatedAt.getTime() > now.getTime() ||
    expiresAt.getTime() <= now.getTime() ||
    expiresAt.getTime() - generatedAt.getTime() !== LIMITED_LAUNCH_PREVIEW_TTL_MS
  ) {
    return null;
  }
  return snapshot;
}

async function inspectCanaryVariant(
  { shopDomain, shopifyProductId, shopifyVariantId },
  { graphQL },
) {
  if (!clean(shopifyProductId) || !clean(shopifyVariantId)) {
    return { ok: false, reason: "limited_launch_canary_variant_required" };
  }
  const response = await graphQL({
    shopDomain,
    query: CANARY_VARIANT_QUERY,
    variables: { id: clean(shopifyVariantId) },
  });
  const variant = response?.data?.productVariant || null;
  if (
    !variant ||
    clean(variant.product?.id) !== clean(shopifyProductId) ||
    variant.inventoryItem?.tracked !== true ||
    Number(variant.inventoryQuantity) !== 1 ||
    clean(variant.inventoryPolicy).toUpperCase() !== "DENY"
  ) {
    return { ok: false, reason: "limited_launch_canary_inventory_invalid" };
  }
  return {
    ok: true,
    shopifyVariantId: clean(variant.id),
    inventoryQuantity: Number(variant.inventoryQuantity),
    inventoryTracked: true,
    inventoryPolicy: "DENY",
  };
}

async function inspectCandidate(
  {
    probeId,
    releaseExpectation,
    evidenceReference,
    evidenceHash,
    selectedProductId,
    selectedShopifyVariantId,
    completionDeadline: fixedCompletionDeadline = null,
  },
  { prismaClient, env, now, graphQL },
) {
  const reference = clean(evidenceReference);
  const hash = normalizeSha256(evidenceHash);
  const release = buildReleaseContext(releaseExpectation);
  if (!reference || !hash || !release.configured) {
    return { ok: false, reason: "limited_launch_confirmation_invalid" };
  }

  const probe = await prismaClient.productionTransactionProbe.findUnique({
    where: { id: clean(probeId) },
  });
  if (
    !probe ||
    probe.status !== "AWAITING_PAYOUT_EVIDENCE" ||
    probe.releaseFingerprint !== release.releaseFingerprint ||
    probe.releaseId !== release.releaseId
  ) {
    return { ok: false, reason: "limited_launch_probe_not_eligible" };
  }

  const orderEvidence = asObject(probe.orderEvidenceJson);
  const externalReadiness = asObject(orderEvidence.externalReadiness);
  const target = asObject(orderEvidence.probeConfig);
  const paidEvidence = asObject(probe.paidEvidenceJson);
  const maximumPlannedChargeAmount = toNonNegativeInteger(
    externalReadiness.maximumPlannedChargeAmount,
  );
  const companyRefundReserveAmount = toNonNegativeInteger(
    externalReadiness.confirmedRefundReserveAmount,
  );
  const actualPaidAmount = toNonNegativeInteger(paidEvidence.actualPaidAmount);
  const maxOrderCount = toNonNegativeInteger(
    externalReadiness.limitedLaunchMaxOrderCount,
  );
  const maxGrossAmount = toNonNegativeInteger(
    externalReadiness.limitedLaunchMaxGrossAmount,
  );
  const maxOutstandingLiability = toNonNegativeInteger(
    externalReadiness.limitedLaunchMaxOutstandingLiability,
  );
  const minimumPayoutAmount = toNonNegativeInteger(
    externalReadiness.komojuMinimumPayoutAmount,
  );
  const estimatedProcessingFeeAmount = toNonNegativeInteger(
    externalReadiness.estimatedProcessingFeeAmount,
  );
  const expectedBankDepositAt = new Date(
    externalReadiness.expectedBankDepositAt,
  );
  const currencyCode = clean(paidEvidence.currencyCode).toUpperCase();
  if (
    externalReadiness.strategy !== LIMITED_STRATEGY ||
    target.provider !== "KOMOJU" ||
    target.paymentMethod !== "CARD" ||
    paidEvidence.passed !== true ||
    !probe.paidVerifiedAt ||
    actualPaidAmount <= 0 ||
    maximumPlannedChargeAmount < actualPaidAmount ||
    companyRefundReserveAmount < maximumPlannedChargeAmount ||
    externalReadiness.confirmedKomojuUnsettledBalanceAmount !== 0 ||
    externalReadiness.zeroUnsettledBalanceConfirmed !== true ||
    externalReadiness.companyRefundReserveConfirmed !== true ||
    externalReadiness.directRefundFallbackConfirmed !== true ||
    externalReadiness.domesticPlatformDirectOnlyConfirmed !== true ||
    maxOrderCount !== LIMITED_LAUNCH_MAX_ORDER_COUNT ||
    maxGrossAmount < actualPaidAmount ||
    maxOutstandingLiability < actualPaidAmount ||
    maxGrossAmount > companyRefundReserveAmount ||
    maxOutstandingLiability > companyRefundReserveAmount ||
    !["WEEKLY", "MONTHLY"].includes(
      clean(externalReadiness.komojuPayoutCycle).toUpperCase(),
    ) ||
    !Number.isFinite(expectedBankDepositAt.getTime()) ||
    minimumPayoutAmount <= 0 ||
    actualPaidAmount - estimatedProcessingFeeAmount < minimumPayoutAmount ||
    externalReadiness.payoutNotOnHoldConfirmed !== true
  ) {
    return { ok: false, reason: "limited_launch_paid_evidence_incomplete" };
  }

  const scope = await inspectKomojuLimitedLaunchScope({ prismaClient, env });
  if (!scope.ready) {
    return { ok: false, reason: "limited_launch_scope_not_restricted" };
  }

  const existing =
    await prismaClient.operationalReadinessAttestation.findUnique({
      where: {
        checkKey_scopeType_scopeId: {
          checkKey: KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_CHECK_KEY,
          scopeType: "PLATFORM",
          scopeId: "GLOBAL",
        },
      },
    });
  const completionDeadline = fixedCompletionDeadline
    ? new Date(fixedCompletionDeadline)
    : addDays(now, LIMITED_LAUNCH_VALIDITY_DAYS);
  if (
    expectedBankDepositAt.getTime() < now.getTime() ||
    expectedBankDepositAt.getTime() > completionDeadline.getTime()
  ) {
    return { ok: false, reason: "limited_launch_payout_deadline_invalid" };
  }

  const attachedProducts = Array.isArray(orderEvidence.products)
    ? orderEvidence.products
    : [];
  const commercialLines = Array.isArray(
    asObject(orderEvidence.commercialEvidence).lines,
  )
    ? asObject(orderEvidence.commercialEvidence).lines
    : [];
  if (
    attachedProducts.length !== 1 ||
    commercialLines.length !== 1 ||
    Number(attachedProducts[0]?.quantity) !== 1 ||
    Number(commercialLines[0]?.quantity) !== 1
  ) {
    return { ok: false, reason: "limited_launch_canary_order_invalid" };
  }
  const selectedLocalProductId =
    clean(selectedProductId) || clean(attachedProducts[0]?.productId);
  const selectedVariantId =
    clean(selectedShopifyVariantId) || clean(commercialLines[0]?.variantId);
  if (
    !selectedLocalProductId ||
    !selectedVariantId ||
    selectedLocalProductId !== clean(attachedProducts[0]?.productId) ||
    selectedVariantId !== clean(commercialLines[0]?.variantId)
  ) {
    return { ok: false, reason: "limited_launch_canary_selection_mismatch" };
  }

  const allowedProducts = await prismaClient.product.findMany({
    where: {
      id: selectedLocalProductId,
      approvalStatus: "approved",
      shopifyProductId: { not: null },
      shopifyVariantId: selectedVariantId,
      OR: [{ shopDomain: probe.shopDomain }, { shopDomain: null }],
      vendorStore: {
        is: { isPlatformStore: true, isTestStore: false },
      },
    },
    select: {
      id: true,
      name: true,
      shopifyProductId: true,
      shopifyVariantId: true,
      inventoryQuantity: true,
    },
    orderBy: { id: "asc" },
  });
  const allowedProductIds = allowedProducts.map((product) => product.id);
  const allowedShopifyProductIds = allowedProducts
    .map((product) => clean(product.shopifyProductId))
    .filter(Boolean);
  if (
    allowedProductIds.length !== 1 ||
    allowedShopifyProductIds.length !== 1
  ) {
    return { ok: false, reason: "limited_launch_product_allowlist_invalid" };
  }
  const canary = await inspectCanaryVariant(
    {
      shopDomain: probe.shopDomain,
      shopifyProductId: allowedShopifyProductIds[0],
      shopifyVariantId: selectedVariantId,
    },
    { graphQL },
  );
  if (!canary.ok) return canary;

  return {
    ok: true,
    probe,
    existing,
    existingMetadata: asObject(existing?.metadataJson),
    scope,
    allowedProducts,
    allowedProductIds,
    allowedShopifyProductIds,
    allowedShopifyVariantId: canary.shopifyVariantId,
    canaryInventoryQuantity: canary.inventoryQuantity,
    canaryInventoryTracked: canary.inventoryTracked,
    canaryInventoryPolicy: canary.inventoryPolicy,
    actualPaidAmount,
    currencyCode,
    maximumPlannedChargeAmount,
    companyRefundReserveAmount,
    maxOrderCount,
    maxGrossAmount,
    maxOutstandingLiability,
    komojuPayoutCycle: clean(
      externalReadiness.komojuPayoutCycle,
    ).toUpperCase(),
    expectedBankDepositAt,
    minimumPayoutAmount,
    estimatedProcessingFeeAmount,
    completionDeadline,
    evidence: { reference, hash },
  };
}

export { inspectKomojuLimitedLaunchScope } from "./komojuLimitedLaunchScope.server.js";

export async function previewKomojuZeroBalanceLimitedLaunch(
  input,
  {
    prismaClient = prisma,
    env = process.env,
    now = new Date(),
    graphQL = shopifyGraphQLWithOfflineSession,
  } = {},
) {
  const candidate = await inspectCandidate(input, {
    prismaClient,
    env,
    now,
    graphQL,
  });
  if (!candidate.ok) return candidate;
  if (candidate.existing) {
    const existingMetadata = asObject(candidate.existing.metadataJson);
    const sameRecoverableActivation =
      [
        OPERATIONAL_ATTESTATION_STATUS.PENDING,
        OPERATIONAL_ATTESTATION_STATUS.FAILED,
      ].includes(candidate.existing.status) &&
      candidate.existing.evidenceHash === candidate.evidence.hash &&
      existingMetadata.evidencePackageReference === candidate.evidence.reference &&
      existingMetadata.probeId === candidate.probe.id &&
      existingMetadata.releaseId === candidate.probe.releaseId &&
      existingMetadata.releaseFingerprint === candidate.probe.releaseFingerprint;
    if (!sameRecoverableActivation) {
      return { ok: false, reason: "limited_launch_exception_already_used" };
    }
  }
  const generatedAt = new Date(now);
  const expiresAt = new Date(now.getTime() + LIMITED_LAUNCH_PREVIEW_TTL_MS);
  const snapshot = previewSnapshot(candidate, candidate.evidence, {
    generatedAt,
    expiresAt,
  });
  const previewToken = signPreview(snapshot, env);
  if (!previewToken) {
    return { ok: false, reason: "limited_launch_preview_unavailable" };
  }
  return {
    ok: true,
    preview: {
      previewToken,
      generatedAt: generatedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      releaseId: candidate.probe.releaseId,
      shopifyOrderId: candidate.probe.shopifyOrderId,
      actualPaidAmount: candidate.actualPaidAmount,
      currencyCode: candidate.currencyCode,
      completionDeadline: candidate.completionDeadline.toISOString(),
      companyRefundReserveAmount: candidate.companyRefundReserveAmount,
      maxOrderCount: candidate.maxOrderCount,
      maxGrossAmount: candidate.maxGrossAmount,
      maxOutstandingLiability: candidate.maxOutstandingLiability,
      expectedBankDepositAt: candidate.expectedBankDepositAt.toISOString(),
      allowedProducts: candidate.allowedProducts.map((product) => ({
        id: product.id,
        name: product.name,
      })),
      selectedProductId: candidate.allowedProductIds[0],
      selectedShopifyProductId: candidate.allowedShopifyProductIds[0],
      selectedShopifyVariantId: candidate.allowedShopifyVariantId,
      inventoryQuantity: candidate.canaryInventoryQuantity,
      inventoryTracked: candidate.canaryInventoryTracked,
      inventoryPolicy: candidate.canaryInventoryPolicy,
      projectionRevision: 1,
      evidenceReference: candidate.evidence.reference,
      evidenceHash: candidate.evidence.hash,
    },
  };
}

function buildLimitedLaunchMetadata(candidate, actor) {
  return {
    verificationSource: LIMITED_LAUNCH_SOURCE,
    probeId: candidate.probe.id,
    shopDomain: candidate.probe.shopDomain,
    shopifyOrderId: candidate.probe.shopifyOrderId,
    marketplaceOrderId: candidate.probe.marketplaceOrderId,
    releaseId: candidate.probe.releaseId,
    releaseFingerprint: candidate.probe.releaseFingerprint,
    saleVerifiedAt: new Date(candidate.probe.paidVerifiedAt).toISOString(),
    completionDeadline: candidate.completionDeadline.toISOString(),
    actualPaidAmount: candidate.actualPaidAmount,
    currencyCode: candidate.currencyCode,
    maximumPlannedChargeAmount: candidate.maximumPlannedChargeAmount,
    companyRefundReserveAmount: candidate.companyRefundReserveAmount,
    maxOrderCount: candidate.maxOrderCount,
    maxGrossAmount: candidate.maxGrossAmount,
    maxOutstandingLiability: candidate.maxOutstandingLiability,
    allowedProductIds: candidate.allowedProductIds,
    allowedShopifyProductIds: candidate.allowedShopifyProductIds,
    allowedShopifyVariantId: candidate.allowedShopifyVariantId,
    canaryQuantity: 1,
    canaryInventoryQuantity: candidate.canaryInventoryQuantity,
    canaryInventoryTracked: candidate.canaryInventoryTracked,
    canaryInventoryPolicy: candidate.canaryInventoryPolicy,
    allowedProductNames: candidate.allowedProducts.map((product) => product.name),
    komojuPayoutCycle: candidate.komojuPayoutCycle,
    expectedBankDepositAt: candidate.expectedBankDepositAt.toISOString(),
    minimumPayoutAmount: candidate.minimumPayoutAmount,
    estimatedProcessingFeeAmount: candidate.estimatedProcessingFeeAmount,
    payoutNotOnHoldConfirmed: true,
    confirmedKomojuUnsettledBalanceAmount: 0,
    zeroUnsettledBalanceConfirmed: true,
    companyRefundReserveConfirmed: true,
    directRefundFallbackConfirmed: true,
    domesticPlatformDirectOnlyConfirmed: true,
    thirdPartyCommerceDisabled: candidate.scope.thirdPartyCommerceDisabled,
    euEnabledSellerCount: candidate.scope.euEnabledSellerCount,
    euEnabledProductCount: candidate.scope.euEnabledProductCount,
    internationalEnabledProductCount:
      candidate.scope.internationalEnabledProductCount,
    evidencePackageReference: candidate.evidence.reference,
    recordedBy: actor,
    strictE2eStillRequired: true,
  };
}

async function failLimitedLaunchActivation(
  { control, attestation, reason },
  { prismaClient, syncProjection, now },
) {
  const revision = Math.max(3, Number(control?.projectionVersion || 0) + 1);
  const blockedProjection = buildKomojuLimitedLaunchProjection(
    {
      ...control,
      status: KOMOJU_LIMITED_LAUNCH_STATUS.BLOCKED,
      projectionVersion: revision,
      blockReason: reason,
    },
    { state: "BLOCKED", revision },
  );
  try {
    await syncProjection({
      shopDomain: control.shopDomain,
      projection: blockedProjection,
    });
  } catch {
    // The emergency hold below is the independent fail-closed boundary.
  }
  let holdResult;
  try {
    holdResult = await applyPlatformCheckoutEmergencyHold(
      {
        reason,
        changedBy: LIMITED_LAUNCH_ACTOR,
        shopDomain: control.shopDomain,
      },
      { prismaClient, now },
    );
  } catch {
    holdResult = { ok: false, reason: "limited_launch_emergency_hold_failed" };
  }
  await prismaClient.$transaction(
    async (tx) => {
      await tx.komojuLimitedLaunchControl.update({
        where: { id: control.id },
        data: {
          status: KOMOJU_LIMITED_LAUNCH_STATUS.BLOCKED,
          projectionVersion: revision,
          blockedAt: now,
          blockReason: reason,
          lastEvaluatedAt: now,
          metadataJson: {
            ...asObject(control.metadataJson),
            projectionState: "BLOCKED",
            projectionRevision: revision,
            projectionHash: blockedProjection.h,
            activationFailure: reason,
          },
        },
      });
      await tx.operationalReadinessAttestation.update({
        where: { id: attestation.id },
        data: {
          status: OPERATIONAL_ATTESTATION_STATUS.FAILED,
          confirmedAt: null,
          expiresAt: null,
          metadataJson: {
            ...asObject(attestation.metadataJson),
            activationFailure: reason,
          },
        },
      });
    },
    { isolationLevel: "Serializable" },
  );
  return { ok: false, reason, projection: blockedProjection, holdResult };
}

export async function recordKomojuZeroBalanceLimitedLaunch(
  {
    probeId,
    actorKey,
    releaseExpectation,
    evidenceReference,
    evidenceHash,
    previewToken,
    confirm,
  },
  {
    prismaClient = prisma,
    env = process.env,
    now = new Date(),
    graphQL = shopifyGraphQLWithOfflineSession,
    syncProjection = syncShopKomojuLimitedLaunchControl,
  } = {},
) {
  const actor = clean(actorKey);
  if (
    !actor ||
    confirm !== "activate_zero_balance_limited_launch" ||
    !clean(previewToken)
  ) {
    return { ok: false, reason: "limited_launch_confirmation_invalid" };
  }
  const signedSnapshot = readPreviewToken(previewToken, { env, now });
  if (!signedSnapshot) {
    return { ok: false, reason: "limited_launch_preview_expired" };
  }
  const candidate = await inspectCandidate(
    {
      probeId,
      releaseExpectation,
      evidenceReference,
      evidenceHash,
      selectedProductId: signedSnapshot.allowedProductIds?.[0],
      selectedShopifyVariantId: signedSnapshot.allowedShopifyVariantId,
      completionDeadline: signedSnapshot.completionDeadline,
    },
    { prismaClient, env, now, graphQL },
  );
  if (!candidate.ok) return candidate;
  const regeneratedSnapshot = previewSnapshot(candidate, candidate.evidence, {
    generatedAt: new Date(signedSnapshot.generatedAt),
    expiresAt: new Date(signedSnapshot.expiresAt),
  });
  if (JSON.stringify(regeneratedSnapshot) !== JSON.stringify(signedSnapshot)) {
    return { ok: false, reason: "limited_launch_preview_changed" };
  }
  const metadataJson = buildLimitedLaunchMetadata(candidate, actor);
  let prepared = null;
  if (candidate.existing) {
    const existingMetadata = asObject(candidate.existing.metadataJson);
    const sameIdentity =
      candidate.existing.evidenceHash === candidate.evidence.hash &&
      existingMetadata.evidencePackageReference === candidate.evidence.reference &&
      existingMetadata.probeId === candidate.probe.id &&
      existingMetadata.releaseId === candidate.probe.releaseId &&
      existingMetadata.releaseFingerprint === candidate.probe.releaseFingerprint;
    const existingControl = prismaClient.komojuLimitedLaunchControl?.findUnique
      ? await prismaClient.komojuLimitedLaunchControl.findUnique({
          where: { attestationId: candidate.existing.id },
        })
      : null;
    if (
      sameIdentity &&
      candidate.existing.status === OPERATIONAL_ATTESTATION_STATUS.CONFIRMED
    ) {
      return {
        ok: true,
        existing: true,
        attestation: candidate.existing,
        control: existingControl,
        limitedLaunchControl: existingControl,
        probe: candidate.probe,
        scope: candidate.scope,
      };
    }
    const recoverable =
      sameIdentity &&
      existingControl &&
      existingControl.probeId === candidate.probe.id &&
      existingControl.shopDomain === candidate.probe.shopDomain &&
      [
        OPERATIONAL_ATTESTATION_STATUS.PENDING,
        OPERATIONAL_ATTESTATION_STATUS.FAILED,
      ].includes(candidate.existing.status) &&
      [
        KOMOJU_LIMITED_LAUNCH_STATUS.PREPARING,
        KOMOJU_LIMITED_LAUNCH_STATUS.BLOCKED,
      ].includes(existingControl.status);
    if (!recoverable) {
      return { ok: false, reason: "limited_launch_exception_already_used" };
    }

    const recoveryRevision = Math.max(
      3,
      Number(existingControl.projectionVersion || 0) + 2,
    );
    prepared = await prismaClient.$transaction(
      async (tx) => {
        const attestation = await tx.operationalReadinessAttestation.update({
          where: { id: candidate.existing.id },
          data: {
            status: OPERATIONAL_ATTESTATION_STATUS.PENDING,
            confirmedBy: null,
            confirmedAt: null,
            expiresAt: null,
            metadataJson: {
              ...metadataJson,
              activationRetryAt: now.toISOString(),
            },
          },
        });
        const control = await tx.komojuLimitedLaunchControl.update({
          where: { id: existingControl.id },
          data: {
            status: KOMOJU_LIMITED_LAUNCH_STATUS.PREPARING,
            projectionVersion: recoveryRevision,
            projectionSyncedAt: null,
            blockedAt: null,
            blockReason: null,
            lastEvaluatedAt: now,
            metadataJson: {
              ...asObject(existingControl.metadataJson),
              projectionState: "PREPARING",
              projectionRevision: recoveryRevision,
              activationRetryAt: now.toISOString(),
            },
          },
        });
        return { ok: true, attestation, control };
      },
      { isolationLevel: "Serializable" },
    );
  }

  if (!prepared) {
    prepared = await prismaClient.$transaction(
      async (tx) => {
        const recorded = await recordOperationalReadinessAttestation(
          {
          checkKey: KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_CHECK_KEY,
          status: OPERATIONAL_ATTESTATION_STATUS.PENDING,
          evidenceReference: `komoju-limited-launch:${candidate.probe.id}`,
          evidenceHash: candidate.evidence.hash,
          notes: "KOMOJU限定公開のShopify同期を準備しています。",
          confirmedBy: LIMITED_LAUNCH_ACTOR,
          metadataJson,
          },
          { prismaClient: tx, now, env },
        );
        if (!recorded.ok) return recorded;
        const control = await tx.komojuLimitedLaunchControl.create({
          data: {
          shopDomain: candidate.probe.shopDomain,
          attestationId: recorded.attestation.id,
          probeId: candidate.probe.id,
          status: KOMOJU_LIMITED_LAUNCH_STATUS.PREPARING,
          startsAt: now,
          expiresAt: candidate.completionDeadline,
          maxOrderCount: candidate.maxOrderCount,
          maxGrossAmount: candidate.maxGrossAmount,
          maxOutstandingLiability: candidate.maxOutstandingLiability,
          maxSingleOrderAmount: candidate.maximumPlannedChargeAmount,
          companyRefundReserveAmount: candidate.companyRefundReserveAmount,
          orderCount: 1,
          grossAmount: candidate.actualPaidAmount,
          outstandingLiabilityAmount: candidate.actualPaidAmount,
          allowedProductIdsJson: candidate.allowedProductIds,
          allowedShopifyProductIdsJson: candidate.allowedShopifyProductIds,
          projectionVersion: 1,
          metadataJson: {
            seedMarketplaceOrderId: candidate.probe.marketplaceOrderId,
            seedShopifyOrderId: candidate.probe.shopifyOrderId,
            evidencePackageReference: candidate.evidence.reference,
            allowedShopifyVariantId: candidate.allowedShopifyVariantId,
            canaryQuantity: 1,
            canaryInventoryQuantity: candidate.canaryInventoryQuantity,
            canaryInventoryTracked: candidate.canaryInventoryTracked,
            canaryInventoryPolicy: candidate.canaryInventoryPolicy,
          },
          },
        });
        return { ok: true, attestation: recorded.attestation, control };
      },
      { isolationLevel: "Serializable" },
    );
  }
  if (!prepared.ok) return prepared;

  const preparingRevision = Number(prepared.control.projectionVersion || 1);
  const preparingProjection = buildKomojuLimitedLaunchProjection(
    prepared.control,
    { state: "PREPARING", revision: preparingRevision },
  );
  let preparingSync;
  try {
    preparingSync = await syncProjection({
      shopDomain: prepared.control.shopDomain,
      projection: preparingProjection,
    });
  } catch {
    preparingSync = { ok: false, reason: "limited_launch_preparing_sync_failed" };
  }
  if (preparingSync?.ok !== true) {
    return failLimitedLaunchActivation(
      {
        ...prepared,
        reason: preparingSync?.reason || "limited_launch_preparing_sync_failed",
      },
      { prismaClient, syncProjection, now },
    );
  }

  const activeProjection = buildKomojuLimitedLaunchProjection(
    {
      ...prepared.control,
      status: KOMOJU_LIMITED_LAUNCH_STATUS.ACTIVE,
      projectionVersion: preparingRevision + 1,
    },
    { state: "ACTIVE", revision: preparingRevision + 1 },
  );
  let activeSync;
  try {
    activeSync = await syncProjection({
      shopDomain: prepared.control.shopDomain,
      projection: activeProjection,
    });
  } catch {
    activeSync = { ok: false, reason: "limited_launch_active_sync_failed" };
  }
  if (activeSync?.ok !== true) {
    return failLimitedLaunchActivation(
      {
        ...prepared,
        reason: activeSync?.reason || "limited_launch_active_sync_failed",
      },
      { prismaClient, syncProjection, now },
    );
  }

  try {
    const finalized = await prismaClient.$transaction(
      async (tx) => {
        const attestation = await tx.operationalReadinessAttestation.update({
          where: { id: prepared.attestation.id },
          data: {
            status: OPERATIONAL_ATTESTATION_STATUS.CONFIRMED,
            confirmedBy: LIMITED_LAUNCH_ACTOR,
            confirmedAt: now,
            expiresAt: candidate.completionDeadline,
            metadataJson,
          },
        });
        const control = await tx.komojuLimitedLaunchControl.update({
          where: { id: prepared.control.id },
          data: {
            status: KOMOJU_LIMITED_LAUNCH_STATUS.ACTIVE,
            projectionVersion: preparingRevision + 1,
            projectionSyncedAt: now,
            lastEvaluatedAt: now,
            metadataJson: {
              ...asObject(prepared.control.metadataJson),
              projectionState: "ACTIVE",
              projectionRevision: preparingRevision + 1,
              projectionHash: activeProjection.h,
              projectionReadbackHash: activeProjection.h,
              projectionReadbackRevision: preparingRevision + 1,
              projectionCompareDigest: activeSync.compareDigest,
            },
          },
        });
        return { attestation, control };
      },
      { isolationLevel: "Serializable" },
    );
    return {
      ok: true,
      existing: false,
      ...finalized,
      probe: candidate.probe,
      scope: candidate.scope,
      limitedLaunchControl: finalized.control,
    };
  } catch {
    return failLimitedLaunchActivation(
      {
        ...prepared,
        reason: "limited_launch_database_finalize_failed",
      },
      { prismaClient, syncProjection, now },
    );
  }
}

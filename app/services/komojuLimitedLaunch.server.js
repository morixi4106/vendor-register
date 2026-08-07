import crypto from "node:crypto";

import prisma from "../db.server.js";
import { inspectKomojuLimitedLaunchScope } from "./komojuLimitedLaunchScope.server.js";
import {
  KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_CHECK_KEY,
  OPERATIONAL_ATTESTATION_STATUS,
  recordOperationalReadinessAttestation,
} from "./operationalReadiness.server.js";
import { buildProductionReleaseFingerprint } from "./productionRelease.server.js";
import { refreshKomojuLimitedLaunchControl } from "./komojuLimitedLaunchControl.server.js";

const LIMITED_LAUNCH_VALIDITY_DAYS = 7;
const LIMITED_LAUNCH_PREVIEW_TTL_MS = 15 * 60 * 1000;
const LIMITED_LAUNCH_SOURCE = "komoju_zero_balance_limited_launch";
const LIMITED_LAUNCH_ACTOR = "system:komoju-zero-balance-limited-launch";
const LIMITED_STRATEGY = "ZERO_BALANCE_LIMITED_LAUNCH";

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

function previewSnapshot(candidate, evidence) {
  return {
    version: 1,
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

function signPreview(snapshot, generatedAt, env) {
  const secret = previewSecret(env);
  if (!secret) return null;
  const payload = `${generatedAt.getTime()}.${JSON.stringify(snapshot)}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return `v1.${generatedAt.getTime()}.${signature}`;
}

function verifyPreviewToken(token, snapshot, { env, now }) {
  const parts = clean(token).split(".");
  const generatedAtMs = Number(parts[1]);
  if (
    parts.length !== 3 ||
    parts[0] !== "v1" ||
    !Number.isInteger(generatedAtMs) ||
    generatedAtMs > now.getTime() ||
    now.getTime() - generatedAtMs > LIMITED_LAUNCH_PREVIEW_TTL_MS
  ) {
    return false;
  }
  const expected = signPreview(snapshot, new Date(generatedAtMs), env);
  if (!expected) return false;
  const actualBuffer = Buffer.from(clean(token));
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

async function inspectCandidate(
  { probeId, releaseExpectation, evidenceReference, evidenceHash },
  { prismaClient, env, now },
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
    maxOrderCount < 1 ||
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
  const completionDeadline = addDays(now, LIMITED_LAUNCH_VALIDITY_DAYS);
  if (
    expectedBankDepositAt.getTime() < now.getTime() ||
    expectedBankDepositAt.getTime() > completionDeadline.getTime()
  ) {
    return { ok: false, reason: "limited_launch_payout_deadline_invalid" };
  }

  const allowedProducts = await prismaClient.product.findMany({
    where: {
      approvalStatus: "approved",
      shopifyProductId: { not: null },
      OR: [{ shopDomain: probe.shopDomain }, { shopDomain: null }],
      vendorStore: {
        is: { isPlatformStore: true, isTestStore: false },
      },
    },
    select: { id: true, name: true, shopifyProductId: true },
    orderBy: { id: "asc" },
  });
  const allowedProductIds = allowedProducts.map((product) => product.id);
  const allowedShopifyProductIds = allowedProducts
    .map((product) => clean(product.shopifyProductId))
    .filter(Boolean);
  const attachedProductIds = Array.isArray(orderEvidence.products)
    ? orderEvidence.products
        .map((product) => clean(product?.id))
        .filter(Boolean)
    : [];
  if (
    allowedProductIds.length === 0 ||
    allowedShopifyProductIds.length === 0 ||
    attachedProductIds.some(
      (productId) => !allowedProductIds.includes(productId),
    )
  ) {
    return { ok: false, reason: "limited_launch_product_allowlist_invalid" };
  }

  return {
    ok: true,
    probe,
    existing,
    existingMetadata: asObject(existing?.metadataJson),
    scope,
    allowedProducts,
    allowedProductIds,
    allowedShopifyProductIds,
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
  { prismaClient = prisma, env = process.env, now = new Date() } = {},
) {
  const candidate = await inspectCandidate(input, {
    prismaClient,
    env,
    now,
  });
  if (!candidate.ok) return candidate;
  if (candidate.existing) {
    return { ok: false, reason: "limited_launch_exception_already_used" };
  }
  const snapshot = previewSnapshot(candidate, candidate.evidence);
  const previewToken = signPreview(snapshot, now, env);
  if (!previewToken) {
    return { ok: false, reason: "limited_launch_preview_unavailable" };
  }
  return {
    ok: true,
    preview: {
      previewToken,
      generatedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + LIMITED_LAUNCH_PREVIEW_TTL_MS,
      ).toISOString(),
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
      evidenceReference: candidate.evidence.reference,
      evidenceHash: candidate.evidence.hash,
    },
  };
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
    refreshControl = refreshKomojuLimitedLaunchControl,
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

  const execute = async (tx) => {
    const candidate = await inspectCandidate(
      {
        probeId,
        releaseExpectation,
        evidenceReference,
        evidenceHash,
      },
      { prismaClient: tx, env, now },
    );
    if (!candidate.ok) return candidate;
    if (candidate.existing) {
      if (
        candidate.existingMetadata.probeId === candidate.probe.id &&
        candidate.existing.evidenceHash === candidate.evidence.hash &&
        candidate.existingMetadata.evidencePackageReference ===
          candidate.evidence.reference
      ) {
        return {
          ok: true,
          existing: true,
          attestation: candidate.existing,
          probe: candidate.probe,
        };
      }
      return { ok: false, reason: "limited_launch_exception_already_used" };
    }
    const snapshot = previewSnapshot(candidate, candidate.evidence);
    if (!verifyPreviewToken(previewToken, snapshot, { env, now })) {
      return { ok: false, reason: "limited_launch_preview_changed" };
    }

    const metadataJson = {
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
      allowedProductNames: candidate.allowedProducts.map(
        (product) => product.name,
      ),
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
      thirdPartyCommerceDisabled:
        candidate.scope.thirdPartyCommerceDisabled,
      euEnabledSellerCount: candidate.scope.euEnabledSellerCount,
      euEnabledProductCount: candidate.scope.euEnabledProductCount,
      internationalEnabledProductCount:
        candidate.scope.internationalEnabledProductCount,
      evidencePackageReference: candidate.evidence.reference,
      recordedBy: actor,
      strictE2eStillRequired: true,
    };
    const recorded = await recordOperationalReadinessAttestation(
      {
        checkKey: KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_CHECK_KEY,
        status: OPERATIONAL_ATTESTATION_STATUS.CONFIRMED,
        evidenceReference: `komoju-limited-launch:${candidate.probe.id}`,
        evidenceHash: candidate.evidence.hash,
        notes:
          "新規KOMOJUの未精算残高0円に対する国内運営直販限定の期限付き公開。期限内に全額返金E2Eを完了する。",
        confirmedBy: LIMITED_LAUNCH_ACTOR,
        metadataJson,
      },
      { prismaClient: tx, now, env },
    );
    if (recorded.ok) {
      await tx.komojuLimitedLaunchControl.create({
        data: {
          shopDomain: candidate.probe.shopDomain,
          attestationId: recorded.attestation.id,
          probeId: candidate.probe.id,
          status: "ACTIVE",
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
          allowedShopifyProductIdsJson:
            candidate.allowedShopifyProductIds,
          metadataJson: {
            seedMarketplaceOrderId: candidate.probe.marketplaceOrderId,
            seedShopifyOrderId: candidate.probe.shopifyOrderId,
            evidencePackageReference: candidate.evidence.reference,
          },
        },
      });
    }
    return recorded.ok
      ? {
          ...recorded,
          existing: false,
          probe: candidate.probe,
          scope: candidate.scope,
        }
      : recorded;
  };

  const result =
    typeof prismaClient.$transaction !== "function"
      ? await execute(prismaClient)
      : await prismaClient.$transaction(execute, {
          isolationLevel: "Serializable",
        });
  if (result.ok) {
    const control = await refreshControl(
      { shopDomain: result.probe.shopDomain, applyEmergencyHold: false },
      { prismaClient, now },
    );
    if (!control.ok) {
      return { ok: false, reason: control.reason, recorded: result };
    }
    return { ...result, limitedLaunchControl: control.control };
  }
  return result;
}

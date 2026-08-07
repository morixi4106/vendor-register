import prisma from "../db.server.js";
import { inspectKomojuLimitedLaunchScope } from "./komojuLimitedLaunchScope.server.js";
import {
  KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_CHECK_KEY,
  OPERATIONAL_ATTESTATION_STATUS,
  recordOperationalReadinessAttestation,
} from "./operationalReadiness.server.js";
import { buildProductionReleaseFingerprint } from "./productionRelease.server.js";

const LIMITED_LAUNCH_VALIDITY_DAYS = 7;
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

export { inspectKomojuLimitedLaunchScope } from "./komojuLimitedLaunchScope.server.js";

export async function recordKomojuZeroBalanceLimitedLaunch(
  {
    probeId,
    actorKey,
    releaseExpectation,
    evidenceReference,
    evidenceHash,
    confirm,
  },
  { prismaClient = prisma, env = process.env, now = new Date() } = {},
) {
  const actor = clean(actorKey);
  const reference = clean(evidenceReference);
  const hash = normalizeSha256(evidenceHash);
  const release = buildReleaseContext(releaseExpectation);
  if (
    !actor ||
    !reference ||
    !hash ||
    confirm !== "activate_zero_balance_limited_launch" ||
    !release.configured
  ) {
    return { ok: false, reason: "limited_launch_confirmation_invalid" };
  }

  const execute = async (tx) => {
    const probe = await tx.productionTransactionProbe.findUnique({
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
    const actualPaidAmount = toNonNegativeInteger(
      paidEvidence.actualPaidAmount,
    );
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
      externalReadiness.domesticPlatformDirectOnlyConfirmed !== true
    ) {
      return { ok: false, reason: "limited_launch_paid_evidence_incomplete" };
    }

    const scope = await inspectKomojuLimitedLaunchScope({
      prismaClient: tx,
      env,
    });
    if (!scope.ready) {
      return { ok: false, reason: "limited_launch_scope_not_restricted" };
    }

    const existing = await tx.operationalReadinessAttestation.findUnique({
      where: {
        checkKey_scopeType_scopeId: {
          checkKey: KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_CHECK_KEY,
          scopeType: "PLATFORM",
          scopeId: "GLOBAL",
        },
      },
    });
    const existingMetadata = asObject(existing?.metadataJson);
    if (existing) {
      if (
        existingMetadata.probeId === probe.id &&
        existing.evidenceHash === hash &&
        existingMetadata.evidencePackageReference === reference
      ) {
        return { ok: true, existing: true, attestation: existing, probe };
      }
      return { ok: false, reason: "limited_launch_exception_already_used" };
    }

    const completionDeadline = addDays(now, LIMITED_LAUNCH_VALIDITY_DAYS);
    const metadataJson = {
      verificationSource: LIMITED_LAUNCH_SOURCE,
      probeId: probe.id,
      shopDomain: probe.shopDomain,
      shopifyOrderId: probe.shopifyOrderId,
      marketplaceOrderId: probe.marketplaceOrderId,
      releaseId: probe.releaseId,
      releaseFingerprint: probe.releaseFingerprint,
      saleVerifiedAt: new Date(probe.paidVerifiedAt).toISOString(),
      completionDeadline: completionDeadline.toISOString(),
      actualPaidAmount,
      currencyCode: clean(paidEvidence.currencyCode).toUpperCase(),
      maximumPlannedChargeAmount,
      companyRefundReserveAmount,
      confirmedKomojuUnsettledBalanceAmount: 0,
      zeroUnsettledBalanceConfirmed: true,
      companyRefundReserveConfirmed: true,
      directRefundFallbackConfirmed: true,
      domesticPlatformDirectOnlyConfirmed: true,
      thirdPartyCommerceDisabled: scope.thirdPartyCommerceDisabled,
      euEnabledSellerCount: scope.euEnabledSellerCount,
      euEnabledProductCount: scope.euEnabledProductCount,
      internationalEnabledProductCount:
        scope.internationalEnabledProductCount,
      evidencePackageReference: reference,
      recordedBy: actor,
      strictE2eStillRequired: true,
    };
    const recorded = await recordOperationalReadinessAttestation(
      {
        checkKey: KOMOJU_ZERO_BALANCE_LIMITED_LAUNCH_CHECK_KEY,
        status: OPERATIONAL_ATTESTATION_STATUS.CONFIRMED,
        evidenceReference: `komoju-limited-launch:${probe.id}`,
        evidenceHash: hash,
        notes:
          "新規KOMOJUの未精算残高0円に対する国内運営直販限定の期限付き公開。期限内に全額返金E2Eを完了する。",
        confirmedBy: LIMITED_LAUNCH_ACTOR,
        metadataJson,
      },
      { prismaClient: tx, now, env },
    );
    return recorded.ok
      ? { ...recorded, existing: false, probe, scope }
      : recorded;
  };

  if (typeof prismaClient.$transaction !== "function") {
    return execute(prismaClient);
  }
  return prismaClient.$transaction(execute, {
    isolationLevel: "Serializable",
  });
}

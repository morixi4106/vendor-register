import prisma from "../db.server.js";
import {
  buildProductionReleaseExpectation,
  buildProductionReleaseFingerprint,
} from "./productionRelease.server.js";
import {
  recordOperationalReadinessAttestation,
  SHOPIFY_PAYMENTS_PAYOUT_CHECK_KEY,
} from "./operationalReadiness.server.js";

export const SHOPIFY_PAYOUT_EVIDENCE_STATUS = Object.freeze({
  SUBMITTED: "SUBMITTED",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
});

const SINGLE_OPERATOR_CONFIRMATION = "単独運用リスクを受諾";

export function getSingleOperatorPayoutConfirmationText() {
  return SINGLE_OPERATOR_CONFIRMATION;
}

export async function listShopifyPayoutEvidence(
  { shopDomain, releaseId },
  { prismaClient = prisma } = {},
) {
  return prismaClient.shopifyPayoutEvidence.findMany({
    where: {
      shopDomain: normalizeShopDomain(shopDomain),
      ...(clean(releaseId) ? { releaseId: clean(releaseId) } : {}),
    },
    orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
    take: 20,
  });
}

export async function submitShopifyPayoutEvidence(
  input,
  { prismaClient = prisma, env = process.env, now = new Date() } = {},
) {
  const release = buildProductionReleaseExpectation({ env });
  if (!release.configured || !release.releaseId) {
    return { ok: false, reason: "release_unconfigured" };
  }

  const normalized = normalizeSubmission(input, { now });
  if (!normalized.ok) return normalized;
  if (
    release.shopDomain &&
    normalized.data.shopDomain !== normalizeShopDomain(release.shopDomain)
  ) {
    return { ok: false, reason: "shop_domain_mismatch" };
  }

  const releaseFingerprint = buildProductionReleaseFingerprint(release);
  const unique = {
    shopDomain: normalized.data.shopDomain,
    payoutId: normalized.data.payoutId,
    releaseId: release.releaseId,
  };
  const existing = await prismaClient.shopifyPayoutEvidence.findUnique({
    where: { shopDomain_payoutId_releaseId: unique },
  });
  if (existing?.status === SHOPIFY_PAYOUT_EVIDENCE_STATUS.APPROVED) {
    return { ok: false, reason: "approved_evidence_is_immutable" };
  }
  const submittedBy = clean(input.submittedBy);
  if (!submittedBy) {
    return { ok: false, reason: "submitter_required" };
  }
  if (existing && existing.submittedBy !== submittedBy) {
    return { ok: false, reason: "payout_evidence_submitter_mismatch" };
  }

  const data = {
    ...normalized.data,
    releaseId: release.releaseId,
    releaseFingerprint,
    status: SHOPIFY_PAYOUT_EVIDENCE_STATUS.SUBMITTED,
    submittedBy,
    submittedAt: now,
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: null,
    singleOperatorWaiver: false,
    singleOperatorWaiverReason: null,
    metadataJson: {
      verificationSource: "operator_submitted_bank_evidence",
      releaseId: release.releaseId,
      submittedAt: now.toISOString(),
    },
  };
  const evidence = existing
    ? await prismaClient.shopifyPayoutEvidence.update({
        where: { id: existing.id },
        data,
      })
    : await prismaClient.shopifyPayoutEvidence.create({ data });

  return { ok: true, evidence, release };
}

export async function approveShopifyPayoutEvidence(
  {
    evidenceId,
    reviewedBy,
    reviewerAccountOwner = false,
    allowSingleOperatorWaiver = false,
    singleOperatorConfirmation = null,
    singleOperatorWaiverReason = null,
  },
  { prismaClient = prisma, env = process.env, now = new Date() } = {},
) {
  const release = buildProductionReleaseExpectation({ env });
  if (!release.configured || !release.releaseId) {
    return { ok: false, reason: "release_unconfigured" };
  }
  const actor = clean(reviewedBy);
  if (!actor) return { ok: false, reason: "reviewer_required" };

  return runTransaction(prismaClient, async (tx) => {
    const existing = await tx.shopifyPayoutEvidence.findUnique({
      where: { id: clean(evidenceId) },
    });
    if (!existing) return { ok: false, reason: "payout_evidence_not_found" };
    if (existing.status !== SHOPIFY_PAYOUT_EVIDENCE_STATUS.SUBMITTED) {
      return { ok: false, reason: "payout_evidence_not_pending" };
    }
    if (
      existing.releaseId !== release.releaseId ||
      existing.releaseFingerprint !== buildProductionReleaseFingerprint(release)
    ) {
      return { ok: false, reason: "release_mismatch" };
    }

    const sameOperator = existing.submittedBy === actor;
    const waiverReason = clean(singleOperatorWaiverReason);
    const waiverAllowed = Boolean(
      sameOperator &&
      allowSingleOperatorWaiver &&
      reviewerAccountOwner &&
      clean(singleOperatorConfirmation) === SINGLE_OPERATOR_CONFIRMATION &&
      waiverReason.length >= 30,
    );
    if (sameOperator && !waiverAllowed) {
      return {
        ok: false,
        reason: "independent_payout_approval_required",
      };
    }

    const updatedCount = await tx.shopifyPayoutEvidence.updateMany({
      where: {
        id: existing.id,
        status: SHOPIFY_PAYOUT_EVIDENCE_STATUS.SUBMITTED,
      },
      data: {
        status: SHOPIFY_PAYOUT_EVIDENCE_STATUS.APPROVED,
        reviewedBy: actor,
        reviewedAt: now,
        rejectionReason: null,
        singleOperatorWaiver: waiverAllowed,
        singleOperatorWaiverReason: waiverAllowed ? waiverReason : null,
        metadataJson: {
          ...asObject(existing.metadataJson),
          approvalMode: waiverAllowed
            ? "SINGLE_OPERATOR_WAIVER"
            : "INDEPENDENT",
          reviewedAt: now.toISOString(),
        },
      },
    });
    if (updatedCount.count !== 1) {
      return { ok: false, reason: "payout_evidence_approval_conflict" };
    }

    const approved = await tx.shopifyPayoutEvidence.findUnique({
      where: { id: existing.id },
    });
    const approvalMode = waiverAllowed
      ? "SINGLE_OPERATOR_WAIVER"
      : "INDEPENDENT";
    const attestation = await recordOperationalReadinessAttestation(
      {
        checkKey: SHOPIFY_PAYMENTS_PAYOUT_CHECK_KEY,
        evidenceReference: approved.evidenceReference,
        evidenceHash: approved.evidenceHash,
        confirmedBy: actor,
        notes: waiverAllowed
          ? `単独運用例外: ${waiverReason}`
          : "登録者とは異なる確認者が銀行着金証拠を承認",
        metadataJson: buildAttestationMetadata(approved, approvalMode),
        verifiedPayoutEvidence: approved,
      },
      { prismaClient: tx, now },
    );
    if (!attestation.ok) {
      throw new Error(`payout_attestation_failed:${attestation.reason}`);
    }

    return {
      ok: true,
      evidence: approved,
      attestation: attestation.attestation,
      approvalMode,
    };
  });
}

export async function rejectShopifyPayoutEvidence(
  { evidenceId, reviewedBy, rejectionReason },
  { prismaClient = prisma, now = new Date() } = {},
) {
  const actor = clean(reviewedBy);
  const reason = clean(rejectionReason);
  if (!actor) return { ok: false, reason: "reviewer_required" };
  if (reason.length < 10) {
    return { ok: false, reason: "rejection_reason_required" };
  }
  const result = await prismaClient.shopifyPayoutEvidence.updateMany({
    where: {
      id: clean(evidenceId),
      status: SHOPIFY_PAYOUT_EVIDENCE_STATUS.SUBMITTED,
    },
    data: {
      status: SHOPIFY_PAYOUT_EVIDENCE_STATUS.REJECTED,
      reviewedBy: actor,
      reviewedAt: now,
      rejectionReason: reason,
      singleOperatorWaiver: false,
      singleOperatorWaiverReason: null,
    },
  });
  return result.count === 1
    ? { ok: true }
    : { ok: false, reason: "payout_evidence_not_pending" };
}

function normalizeSubmission(input, { now }) {
  const shopDomain = normalizeShopDomain(input.shopDomain);
  const payoutId = clean(input.payoutId);
  const payoutStatus = clean(input.payoutStatus).toUpperCase();
  const amount = Number(input.amount);
  const currencyCode = clean(input.currencyCode).toUpperCase();
  const shopifyPayoutDate = parseDate(input.shopifyPayoutDate);
  const bankDepositedAt = parseDate(input.bankDepositedAt);
  const bankReferenceMasked = clean(input.bankReferenceMasked);
  const evidenceReference = clean(input.evidenceReference);
  const evidenceHash = clean(input.evidenceHash).toLowerCase();

  if (!shopDomain || !shopDomain.endsWith(".myshopify.com")) {
    return { ok: false, reason: "invalid_shop_domain" };
  }
  if (!payoutId || payoutId.length > 160) {
    return { ok: false, reason: "invalid_payout_id" };
  }
  if (payoutStatus !== "DEPOSITED") {
    return { ok: false, reason: "payout_not_deposited" };
  }
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { ok: false, reason: "invalid_payout_amount" };
  }
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    return { ok: false, reason: "invalid_currency_code" };
  }
  if (!shopifyPayoutDate || !bankDepositedAt) {
    return { ok: false, reason: "invalid_payout_dates" };
  }
  if (
    bankDepositedAt.getTime() < shopifyPayoutDate.getTime() ||
    bankDepositedAt.getTime() > now.getTime() + 86_400_000
  ) {
    return { ok: false, reason: "invalid_bank_deposit_date" };
  }
  if (!bankReferenceMasked || bankReferenceMasked.length > 160) {
    return { ok: false, reason: "bank_reference_required" };
  }
  if (!evidenceReference || evidenceReference.length > 500) {
    return { ok: false, reason: "evidence_reference_required" };
  }
  if (!/^[a-f0-9]{64}$/.test(evidenceHash)) {
    return { ok: false, reason: "evidence_hash_required" };
  }

  return {
    ok: true,
    data: {
      shopDomain,
      payoutId,
      payoutStatus,
      amount,
      currencyCode,
      shopifyPayoutDate,
      bankDepositedAt,
      bankReferenceMasked,
      evidenceReference,
      evidenceHash,
    },
  };
}

function buildAttestationMetadata(evidence, approvalMode) {
  return {
    verificationSource: "shopify_payout_evidence",
    payoutEvidenceId: evidence.id,
    releaseId: evidence.releaseId,
    releaseFingerprint: evidence.releaseFingerprint,
    payoutId: evidence.payoutId,
    payoutStatus: evidence.payoutStatus,
    amount: evidence.amount,
    currencyCode: evidence.currencyCode,
    shopifyPayoutDate: evidence.shopifyPayoutDate.toISOString(),
    bankDepositedAt: evidence.bankDepositedAt.toISOString(),
    bankReferenceMasked: evidence.bankReferenceMasked,
    submittedBy: evidence.submittedBy,
    reviewedBy: evidence.reviewedBy,
    approvalMode,
    singleOperatorWaiver: evidence.singleOperatorWaiver,
    approvedAt: evidence.reviewedAt?.toISOString() || null,
  };
}

function normalizeShopDomain(value) {
  return clean(value)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0];
}

function parseDate(value) {
  const normalized = clean(value);
  if (!normalized) return null;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date : null;
}

function clean(value) {
  return String(value || "").trim();
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function runTransaction(prismaClient, callback) {
  return typeof prismaClient.$transaction === "function"
    ? prismaClient.$transaction(callback)
    : callback(prismaClient);
}

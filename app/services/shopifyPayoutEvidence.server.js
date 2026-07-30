import crypto from "node:crypto";

import prisma from "../db.server.js";
import { shopifyGraphQLWithOfflineSession } from "../utils/shopifyAdmin.server.js";
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
  APPROVED_WITH_WAIVER: "APPROVED_WITH_WAIVER",
  REJECTED: "REJECTED",
});

const SINGLE_OPERATOR_CONFIRMATION = "単独運用リスクを受諾";
const SHOPIFY_API_VERSION = "2026-04";
const MAX_PAYOUT_AGE_DAYS = 90;
const SHOPIFY_PAYOUT_QUERY = `#graphql
  query VerifyShopifyPaymentsPayout($id: ID!) {
    node(id: $id) {
      ... on ShopifyPaymentsPayout {
        id
        legacyResourceId
        issuedAt
        status
        transactionType
        externalTraceId
        net {
          amount
          currencyCode
        }
      }
    }
  }
`;

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
  {
    prismaClient = prisma,
    env = process.env,
    now = new Date(),
    verifyShopifyPayoutImpl = verifyShopifyPayout,
  } = {},
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

  let shopifyVerification;
  try {
    shopifyVerification = await verifyShopifyPayoutImpl(
      {
        shopDomain: normalized.data.shopDomain,
        payoutId: normalized.data.payoutId,
        bankReferenceMasked: normalized.data.bankReferenceMasked,
      },
      { now },
    );
  } catch (error) {
    return { ok: false, reason: normalizeVerificationError(error) };
  }
  if (!shopifyVerification?.ok) {
    return {
      ok: false,
      reason:
        shopifyVerification?.reason || "shopify_payout_verification_failed",
    };
  }

  const bankDepositedAt = normalized.data.bankDepositedAt;
  if (
    bankDepositedAt.getTime() < shopifyVerification.issuedAt.getTime() ||
    bankDepositedAt.getTime() > now.getTime() ||
    now.getTime() - bankDepositedAt.getTime() >
      MAX_PAYOUT_AGE_DAYS * 86_400_000
  ) {
    return { ok: false, reason: "invalid_bank_deposit_date" };
  }

  const releaseFingerprint = buildProductionReleaseFingerprint(release);
  const legacyResourceId = clean(shopifyVerification.legacyResourceId);
  const payoutIdentifiers = [
    { shopifyPayoutGid: shopifyVerification.id },
    { payoutId: shopifyVerification.id },
    ...(legacyResourceId
      ? [
          { payoutId: legacyResourceId },
          { shopifyLegacyResourceId: legacyResourceId },
        ]
      : []),
  ];
  const existing = await prismaClient.shopifyPayoutEvidence.findFirst({
    where: {
      shopDomain: normalized.data.shopDomain,
      OR: payoutIdentifiers,
    },
  });
  if (existing && existing.releaseId !== release.releaseId) {
    return { ok: false, reason: "payout_evidence_already_used" };
  }
  if (
    [
      SHOPIFY_PAYOUT_EVIDENCE_STATUS.APPROVED,
      SHOPIFY_PAYOUT_EVIDENCE_STATUS.APPROVED_WITH_WAIVER,
    ].includes(existing?.status)
  ) {
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
    payoutStatus: "DEPOSITED",
    amount: shopifyVerification.amount,
    currencyCode: shopifyVerification.currencyCode,
    shopifyPayoutDate: shopifyVerification.issuedAt,
    shopifyPayoutGid: shopifyVerification.id,
    shopifyLegacyResourceId: shopifyVerification.legacyResourceId,
    shopifyVerifiedAt: now,
    shopifyExternalTraceIdHash: shopifyVerification.externalTraceIdHash,
    shopifyVerificationJson: {
      source: "shopify_admin_graphql",
      apiVersion: SHOPIFY_API_VERSION,
      status: shopifyVerification.status,
      transactionType: shopifyVerification.transactionType,
      verifiedAt: now.toISOString(),
      traceSuffixMatched: true,
    },
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
      verificationSource: "shopify_api_and_operator_bank_evidence",
      releaseId: release.releaseId,
      submittedAt: now.toISOString(),
      shopifyVerifiedAt: now.toISOString(),
    },
  };
  let evidence;
  try {
    evidence = existing
      ? await prismaClient.shopifyPayoutEvidence.update({
          where: { id: existing.id },
          data,
        })
      : await prismaClient.shopifyPayoutEvidence.create({ data });
  } catch (error) {
    if (error?.code === "P2002") {
      return { ok: false, reason: "payout_evidence_already_used" };
    }
    throw error;
  }

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
    if (!hasCurrentShopifyVerification(existing, now)) {
      return { ok: false, reason: "shopify_payout_verification_required" };
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
      return { ok: false, reason: "independent_payout_approval_required" };
    }

    const approvalMode = waiverAllowed
      ? "SINGLE_OPERATOR_WAIVER"
      : "INDEPENDENT";
    const targetStatus = waiverAllowed
      ? SHOPIFY_PAYOUT_EVIDENCE_STATUS.APPROVED_WITH_WAIVER
      : SHOPIFY_PAYOUT_EVIDENCE_STATUS.APPROVED;
    const updatedCount = await tx.shopifyPayoutEvidence.updateMany({
      where: {
        id: existing.id,
        status: SHOPIFY_PAYOUT_EVIDENCE_STATUS.SUBMITTED,
      },
      data: {
        status: targetStatus,
        reviewedBy: actor,
        reviewedAt: now,
        rejectionReason: null,
        singleOperatorWaiver: waiverAllowed,
        singleOperatorWaiverReason: waiverAllowed ? waiverReason : null,
        metadataJson: {
          ...asObject(existing.metadataJson),
          approvalMode,
          reviewedAt: now.toISOString(),
          readinessEligible: !waiverAllowed,
        },
      },
    });
    if (updatedCount.count !== 1) {
      return { ok: false, reason: "payout_evidence_approval_conflict" };
    }

    const approved = await tx.shopifyPayoutEvidence.findUnique({
      where: { id: existing.id },
    });
    if (waiverAllowed) {
      return {
        ok: true,
        evidence: approved,
        attestation: null,
        approvalMode,
        readinessEligible: false,
      };
    }

    const attestation = await recordOperationalReadinessAttestation(
      {
        checkKey: SHOPIFY_PAYMENTS_PAYOUT_CHECK_KEY,
        evidenceReference: approved.evidenceReference,
        evidenceHash: approved.evidenceHash,
        confirmedBy: actor,
        notes:
          "登録者と異なる確認者が、Shopify Payoutと銀行着金証拠を照合しました。",
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
      readinessEligible: true,
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

export async function verifyShopifyPayout(
  { shopDomain, payoutId, bankReferenceMasked },
  { graphQL = shopifyGraphQLWithOfflineSession, now = new Date() } = {},
) {
  const normalizedShop = normalizeShopDomain(shopDomain);
  const normalizedPayoutId = normalizePayoutId(payoutId);
  if (!normalizedShop || !normalizedPayoutId) {
    return { ok: false, reason: "invalid_payout_id" };
  }

  const { data } = await graphQL({
    shopDomain: normalizedShop,
    apiVersion: SHOPIFY_API_VERSION,
    query: SHOPIFY_PAYOUT_QUERY,
    variables: { id: normalizedPayoutId },
  });
  const payout = data?.node;
  if (!payout?.id) {
    return { ok: false, reason: "shopify_payout_not_found" };
  }
  if (clean(payout.status).toUpperCase() !== "PAID") {
    return { ok: false, reason: "shopify_payout_not_paid" };
  }
  if (clean(payout.transactionType).toUpperCase() !== "DEPOSIT") {
    return { ok: false, reason: "shopify_payout_not_deposit" };
  }

  const currencyCode = clean(payout.net?.currencyCode).toUpperCase();
  const amount = moneyToMinorUnits(payout.net?.amount, currencyCode);
  const issuedAt = parseDate(payout.issuedAt);
  if (!issuedAt || issuedAt.getTime() > now.getTime() || amount <= 0) {
    return { ok: false, reason: "shopify_payout_invalid" };
  }
  const externalTraceId = clean(payout.externalTraceId);
  if (!externalTraceId) {
    return { ok: false, reason: "shopify_payout_trace_missing" };
  }
  if (!maskedReferenceMatches(bankReferenceMasked, externalTraceId)) {
    return { ok: false, reason: "bank_reference_mismatch" };
  }

  return {
    ok: true,
    id: clean(payout.id),
    legacyResourceId: clean(payout.legacyResourceId) || null,
    status: "PAID",
    transactionType: "DEPOSIT",
    amount,
    currencyCode,
    issuedAt,
    externalTraceIdHash: sha256(externalTraceId),
  };
}

function normalizeSubmission(input, { now }) {
  const shopDomain = normalizeShopDomain(input.shopDomain);
  const payoutId = normalizePayoutId(input.payoutId);
  const bankDepositedAt = parseDate(input.bankDepositedAt);
  const bankReferenceMasked = clean(input.bankReferenceMasked);
  const evidenceReference = clean(input.evidenceReference);
  const evidenceHash = clean(input.evidenceHash).toLowerCase();

  if (!shopDomain || !shopDomain.endsWith(".myshopify.com")) {
    return { ok: false, reason: "invalid_shop_domain" };
  }
  if (!payoutId) return { ok: false, reason: "invalid_payout_id" };
  if (!bankDepositedAt) {
    return { ok: false, reason: "invalid_payout_dates" };
  }
  if (bankDepositedAt.getTime() > now.getTime()) {
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
    shopifyPayoutGid: evidence.shopifyPayoutGid,
    shopifyLegacyResourceId: evidence.shopifyLegacyResourceId,
    shopifyVerifiedAt: evidence.shopifyVerifiedAt?.toISOString() || null,
    shopifyExternalTraceIdHash: evidence.shopifyExternalTraceIdHash,
    approvedAt: evidence.reviewedAt?.toISOString() || null,
  };
}

function hasCurrentShopifyVerification(evidence, now) {
  const verifiedAt = parseDate(evidence?.shopifyVerifiedAt);
  const payoutDate = parseDate(evidence?.shopifyPayoutDate);
  const bankDate = parseDate(evidence?.bankDepositedAt);
  const verification = asObject(evidence?.shopifyVerificationJson);
  return Boolean(
    verifiedAt &&
      verifiedAt.getTime() <= now.getTime() &&
      payoutDate &&
      bankDate &&
      bankDate.getTime() <= now.getTime() &&
      now.getTime() - bankDate.getTime() <=
        MAX_PAYOUT_AGE_DAYS * 86_400_000 &&
      clean(evidence?.shopifyPayoutGid) === clean(evidence?.payoutId) &&
      /^[a-f0-9]{64}$/.test(clean(evidence?.shopifyExternalTraceIdHash)) &&
      clean(verification.source) === "shopify_admin_graphql" &&
      clean(verification.status).toUpperCase() === "PAID" &&
      clean(verification.transactionType).toUpperCase() === "DEPOSIT",
  );
}

function normalizePayoutId(value) {
  const normalized = clean(value);
  if (/^\d{1,30}$/.test(normalized)) {
    return `gid://shopify/ShopifyPaymentsPayout/${normalized}`;
  }
  return /^gid:\/\/shopify\/ShopifyPaymentsPayout\/\d{1,30}$/.test(normalized)
    ? normalized
    : null;
}

function moneyToMinorUnits(value, currencyCode) {
  const normalized = clean(value);
  const exponents = {
    BHD: 3,
    CLP: 0,
    JPY: 0,
    KRW: 0,
    KWD: 3,
    OMR: 3,
    TND: 3,
  };
  const exponent = exponents[currencyCode] ?? 2;
  const match = normalized.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match || !/^[A-Z]{3}$/.test(currencyCode)) {
    throw new Error("shopify_payout_amount_invalid");
  }
  const fraction = match[2] || "";
  if (fraction.length > exponent) {
    throw new Error("shopify_payout_amount_precision_invalid");
  }
  const minor = Number(`${match[1]}${fraction.padEnd(exponent, "0")}`);
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new Error("shopify_payout_amount_invalid");
  }
  return minor;
}

function maskedReferenceMatches(masked, externalTraceId) {
  const submitted = clean(masked).replace(/[^a-z0-9]/gi, "").toLowerCase();
  const source = clean(externalTraceId)
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  return (
    submitted.length >= 4 &&
    source.length >= 4 &&
    submitted.endsWith(source.slice(-4))
  );
}

function normalizeVerificationError(error) {
  const message = clean(error?.message || error);
  if (
    /access denied|permission|forbidden|unauthorized|missing_required_scope/i.test(
      message,
    )
  ) {
    return "shopify_payout_scope_missing";
  }
  return "shopify_payout_verification_failed";
}

function normalizeShopDomain(value) {
  return clean(value)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0];
}

function parseDate(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  const normalized = clean(value);
  if (!normalized) return null;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date : null;
}

function clean(value) {
  return String(value || "").trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
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

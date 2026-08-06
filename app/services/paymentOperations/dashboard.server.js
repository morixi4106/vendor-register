import prisma from "../../db.server.js";
import { classifyPaymentGateway } from "./classification.js";

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function toInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function metadataObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export async function inspectPaymentOperations(
  { prismaClient = prisma, now = new Date() } = {},
) {
  if (!prismaClient?.marketplacePaymentAttempt?.count) {
    return { available: false, reason: "payment_models_unavailable" };
  }
  const expiredCutoff = now;
  const [
    pendingExpiredCount,
    attemptReviewCount,
    refundReviewCount,
    refundFailedCount,
    unmatchedSettlementCount,
  ] = await Promise.all([
    prismaClient.marketplacePaymentAttempt.count({
      where: {
        status: "PENDING",
        expiresAt: { lt: expiredCutoff },
      },
    }),
    prismaClient.marketplacePaymentAttempt.count({
      where: { requiresReview: true, reviewedAt: null },
    }),
    prismaClient.paymentRefundOperation.count({
      where: {
        status: {
          in: ["REVIEW_REQUIRED", "AWAITING_PROVIDER", "PROVIDER_CONFIRMED"],
        },
      },
    }),
    prismaClient.paymentRefundOperation.count({ where: { status: "FAILED" } }),
    prismaClient.paymentSettlementLine.count({
      where: { matchStatus: "UNMATCHED" },
    }),
  ]);
  return {
    available: true,
    pendingExpiredCount,
    attemptReviewCount,
    refundReviewCount,
    refundFailedCount,
    unmatchedSettlementCount,
    criticalCount: refundFailedCount + attemptReviewCount,
    attentionCount:
      pendingExpiredCount + refundReviewCount + unmatchedSettlementCount,
  };
}

export async function getPaymentOperationsDashboard(
  { prismaClient = prisma, now = new Date() } = {},
) {
  const inspection = await inspectPaymentOperations({ prismaClient, now });
  if (!inspection.available) {
    return {
      inspection,
      attempts: [],
      refunds: [],
      settlementBatches: [],
    };
  }
  const [attempts, refunds, settlementBatches] = await Promise.all([
    prismaClient.marketplacePaymentAttempt.findMany({
      orderBy: [{ requiresReview: "desc" }, { updatedAt: "desc" }],
      take: 100,
    }),
    prismaClient.paymentRefundOperation.findMany({
      orderBy: [{ updatedAt: "desc" }],
      take: 100,
    }),
    prismaClient.paymentSettlementBatch.findMany({
      orderBy: [{ payoutDate: "desc" }, { createdAt: "desc" }],
      take: 50,
      include: { _count: { select: { lines: true } } },
    }),
  ]);
  return { inspection, attempts, refunds, settlementBatches };
}

export async function reviewPaymentAttempt(
  { attemptId, actor, note },
  { prismaClient = prisma, now = new Date() } = {},
) {
  if (!attemptId || !actor) return { ok: false, reason: "review_input_missing" };
  const existing = await prismaClient.marketplacePaymentAttempt.findUnique({
    where: { id: attemptId },
    select: { metadataJson: true },
  });
  if (!existing) return { ok: false, reason: "payment_attempt_not_found" };
  const attempt = await prismaClient.marketplacePaymentAttempt.update({
    where: { id: attemptId },
    data: {
      requiresReview: false,
      reviewedAt: now,
      reviewedBy: actor,
      metadataJson: {
        ...metadataObject(existing.metadataJson),
        reviewNote: normalizeText(note) || null,
      },
    },
  });
  return { ok: true, attempt };
}

export async function recordPaymentSettlementBatch(
  values,
  { prismaClient = prisma, now = new Date() } = {},
) {
  const provider = normalizeText(values.provider).toUpperCase();
  const externalBatchId = normalizeText(values.externalBatchId);
  const submittedBy = normalizeText(values.actor);
  const evidenceReference = normalizeText(values.evidenceReference);
  const evidenceHash = normalizeText(values.evidenceHash);
  const grossAmount = Math.max(0, toInteger(values.grossAmount));
  const refundAmount = Math.max(0, toInteger(values.refundAmount));
  const feeAmount = Math.max(0, toInteger(values.feeAmount));
  const netAmount = toInteger(values.netAmount);
  const expectedNetAmount = grossAmount - refundAmount - feeAmount;
  if (
    !["KOMOJU", "SHOPIFY_PAYMENTS"].includes(provider) ||
    !externalBatchId ||
    !submittedBy ||
    !evidenceReference
  ) {
    return { ok: false, reason: "settlement_batch_input_invalid" };
  }
  if (values.confirm !== "settlement_evidence_recorded") {
    return { ok: false, reason: "confirmation_required" };
  }
  const batch = await prismaClient.paymentSettlementBatch.upsert({
    where: {
      provider_externalBatchId: { provider, externalBatchId },
    },
    create: {
      provider,
      externalBatchId,
      status: netAmount === expectedNetAmount ? "RECONCILED" : "REVIEW_REQUIRED",
      grossAmount,
      refundAmount,
      feeAmount,
      netAmount,
      currencyCode: normalizeLower(values.currencyCode || "jpy"),
      payoutDate: toDate(values.payoutDate),
      bankDepositedAt: toDate(values.bankDepositedAt),
      evidenceReference,
      evidenceHash: evidenceHash || null,
      submittedBy,
      reviewedBy: netAmount === expectedNetAmount ? submittedBy : null,
      reviewedAt: netAmount === expectedNetAmount ? now : null,
      metadataJson: { expectedNetAmount },
    },
    update: {
      status: netAmount === expectedNetAmount ? "RECONCILED" : "REVIEW_REQUIRED",
      grossAmount,
      refundAmount,
      feeAmount,
      netAmount,
      currencyCode: normalizeLower(values.currencyCode || "jpy"),
      payoutDate: toDate(values.payoutDate),
      bankDepositedAt: toDate(values.bankDepositedAt),
      evidenceReference,
      evidenceHash: evidenceHash || null,
      reviewedBy: netAmount === expectedNetAmount ? submittedBy : null,
      reviewedAt: netAmount === expectedNetAmount ? now : null,
      metadataJson: { expectedNetAmount },
    },
  });
  return { ok: true, batch, expectedNetAmount };
}

export async function backfillPaymentAttemptsFromPaidLedger(
  { actor, limit = 200 },
  { prismaClient = prisma, now = new Date() } = {},
) {
  if (!actor) return { ok: false, reason: "actor_missing" };
  const boundedLimit = Math.max(1, Math.min(500, toInteger(limit) || 200));
  const entries = await prismaClient.ledgerEntry.findMany({
    where: { entryType: "shopify_order_paid" },
    orderBy: { occurredAt: "desc" },
    take: boundedLimit,
    select: {
      id: true,
      amount: true,
      currencyCode: true,
      occurredAt: true,
      metadataJson: true,
    },
  });
  let createdOrUpdated = 0;
  let skipped = 0;
  for (const entry of entries) {
    const metadata = metadataObject(entry.metadataJson);
    const shopDomain = normalizeLower(metadata.shopDomain);
    const shopifyOrderId = normalizeText(metadata.shopifyOrderId);
    const gatewayNames = Array.isArray(metadata.shopifyPaymentGatewayNames)
      ? metadata.shopifyPaymentGatewayNames.map(normalizeText).filter(Boolean)
      : [];
    if (!shopDomain || !shopifyOrderId || gatewayNames.length === 0) {
      skipped += 1;
      continue;
    }
    for (const gatewayName of gatewayNames) {
      const classification = classifyPaymentGateway(gatewayName, gatewayName);
      const attemptKey = `backfill:ledger:${entry.id}:${normalizeLower(gatewayName)}`;
      await prismaClient.marketplacePaymentAttempt.upsert({
        where: {
          shopDomain_attemptKey: { shopDomain, attemptKey },
        },
        create: {
          shopDomain,
          shopifyOrderId,
          attemptKey,
          provider: classification.provider,
          paymentMethod: classification.paymentMethod,
          gatewayName,
          formattedGateway: gatewayName,
          financialStatus: "PAID",
          status: "CAPTURED",
          amount: entry.amount,
          currencyCode: entry.currencyCode,
          requiresReview: classification.provider === "UNKNOWN",
          reviewReason:
            classification.provider === "UNKNOWN"
              ? "unknown_payment_gateway"
              : null,
          capturedAt: entry.occurredAt,
          processedAt: entry.occurredAt,
          metadataJson: { source: "paid_ledger_backfill", actor },
        },
        update: {
          provider: classification.provider,
          paymentMethod: classification.paymentMethod,
          gatewayName,
          formattedGateway: gatewayName,
          status: "CAPTURED",
          capturedAt: entry.occurredAt,
          metadataJson: {
            source: "paid_ledger_backfill",
            actor,
            updatedAt: now.toISOString(),
          },
        },
      });
      createdOrUpdated += 1;
    }
  }
  return { ok: true, processed: entries.length, createdOrUpdated, skipped };
}

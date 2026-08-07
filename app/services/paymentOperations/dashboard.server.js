import prisma from "../../db.server.js";
import { syncShopifyOrderPaymentAttempts } from "./sync.server.js";

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
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function uniqueIds(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

function normalizeSha256(value) {
  const normalized = normalizeLower(value);
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function sameInstant(left, right) {
  const leftDate = toDate(left);
  const rightDate = toDate(right);
  return Boolean(
    leftDate && rightDate && leftDate.getTime() === rightDate.getTime(),
  );
}

function tokyoDateKey(value) {
  const date = toDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function settlementLineSignature(line) {
  const occurredAt = toDate(line.occurredAt);
  return JSON.stringify({
    externalLineId: normalizeText(line.externalLineId),
    lineType: normalizeText(line.lineType),
    paymentAttemptId: normalizeText(line.paymentAttemptId) || null,
    refundOperationId: normalizeText(line.refundOperationId) || null,
    marketplaceOrderId: normalizeText(line.marketplaceOrderId) || null,
    providerReference: normalizeText(line.providerReference) || null,
    amount: toInteger(line.amount),
    feeAmount: toInteger(line.feeAmount),
    currencyCode: normalizeLower(line.currencyCode),
    matchStatus: normalizeText(line.matchStatus),
    occurredAt: occurredAt?.toISOString() || null,
  });
}

function settlementBatchMatches(existing, expected, expectedLines) {
  if (!existing || existing.status !== "RECONCILED") return false;
  const fieldsMatch =
    existing.provider === expected.provider &&
    existing.externalBatchId === expected.externalBatchId &&
    existing.grossAmount === expected.grossAmount &&
    existing.refundAmount === expected.refundAmount &&
    existing.feeAmount === expected.feeAmount &&
    existing.netAmount === expected.netAmount &&
    normalizeLower(existing.currencyCode) === expected.currencyCode &&
    sameInstant(existing.payoutDate, expected.payoutDate) &&
    sameInstant(existing.bankDepositedAt, expected.bankDepositedAt) &&
    normalizeText(existing.evidenceReference) === expected.evidenceReference &&
    normalizeLower(existing.evidenceHash) === expected.evidenceHash;
  if (!fieldsMatch) return false;
  const actualSignatures = (existing.lines || [])
    .map(settlementLineSignature)
    .sort();
  const expectedSignatures = expectedLines.map(settlementLineSignature).sort();
  return (
    JSON.stringify(actualSignatures) === JSON.stringify(expectedSignatures)
  );
}

export async function inspectPaymentOperations({
  prismaClient = prisma,
  now = new Date(),
} = {}) {
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
    settlementBatchReviewCount,
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
    prismaClient.paymentSettlementBatch.count({
      where: { status: { not: "RECONCILED" } },
    }),
  ]);
  return {
    available: true,
    pendingExpiredCount,
    attemptReviewCount,
    refundReviewCount,
    refundFailedCount,
    unmatchedSettlementCount,
    settlementBatchReviewCount,
    criticalCount: refundFailedCount + attemptReviewCount,
    attentionCount:
      pendingExpiredCount +
      refundReviewCount +
      unmatchedSettlementCount +
      settlementBatchReviewCount,
  };
}

export async function getPaymentOperationsDashboard({
  prismaClient = prisma,
  now = new Date(),
} = {}) {
  const inspection = await inspectPaymentOperations({ prismaClient, now });
  if (!inspection.available) {
    return {
      inspection,
      attempts: [],
      refunds: [],
      settlementBatches: [],
      directCustomerRefunds: [],
      directRefundReservations: [],
    };
  }
  const [
    attempts,
    refunds,
    settlementBatches,
    directCustomerRefunds,
    directRefundReservations,
  ] =
    await Promise.all([
    prismaClient.marketplacePaymentAttempt.findMany({
      orderBy: [{ requiresReview: "desc" }, { updatedAt: "desc" }],
      take: 100,
      include: {
        settlementLine: {
          select: {
            id: true,
            batchId: true,
            matchStatus: true,
          },
        },
      },
    }),
    prismaClient.paymentRefundOperation.findMany({
      orderBy: [{ updatedAt: "desc" }],
      take: 100,
      include: {
        settlementLine: {
          select: {
            id: true,
            batchId: true,
            matchStatus: true,
          },
        },
      },
    }),
    prismaClient.paymentSettlementBatch.findMany({
      orderBy: [{ payoutDate: "desc" }, { createdAt: "desc" }],
      take: 50,
      include: { _count: { select: { lines: true } } },
    }),
    prismaClient.directCustomerRefund?.findMany
      ? prismaClient.directCustomerRefund.findMany({
          orderBy: [{ completedAt: "desc" }],
          take: 50,
        })
      : [],
    prismaClient.orderRefundGuard?.findMany
      ? prismaClient.orderRefundGuard.findMany({
          where: { channel: "DIRECT", status: "RESERVED" },
          orderBy: [{ reservedAt: "desc" }],
          take: 50,
        })
      : [],
  ]);
  return {
    inspection,
    attempts,
    refunds,
    settlementBatches,
    directCustomerRefunds,
    directRefundReservations,
  };
}

export async function reviewPaymentAttempt(
  { attemptId, actor, note },
  { prismaClient = prisma, now = new Date() } = {},
) {
  if (!attemptId || !actor)
    return { ok: false, reason: "review_input_missing" };
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
  const evidenceHash = normalizeSha256(values.evidenceHash);
  const paymentAttemptIds = uniqueIds(values.paymentAttemptIds);
  const refundOperationIds = uniqueIds(values.refundOperationIds);
  const grossAmount = Math.max(0, toInteger(values.grossAmount));
  const refundAmount = Math.max(0, toInteger(values.refundAmount));
  const feeAmount = Math.max(0, toInteger(values.feeAmount));
  const netAmount = toInteger(values.netAmount);
  const expectedNetAmount = grossAmount - refundAmount - feeAmount;
  const payoutDate = toDate(values.payoutDate);
  const bankDepositedAt = toDate(values.bankDepositedAt);
  if (
    !["KOMOJU", "SHOPIFY_PAYMENTS"].includes(provider) ||
    !externalBatchId ||
    !submittedBy ||
    !evidenceReference ||
    !evidenceHash ||
    paymentAttemptIds.length === 0 ||
    !payoutDate ||
    !bankDepositedAt
  ) {
    return { ok: false, reason: "settlement_batch_input_invalid" };
  }
  if (values.confirm !== "settlement_evidence_recorded") {
    return { ok: false, reason: "confirmation_required" };
  }
  if (
    payoutDate.getTime() > bankDepositedAt.getTime() ||
    tokyoDateKey(bankDepositedAt) > tokyoDateKey(now)
  ) {
    return { ok: false, reason: "settlement_date_invalid" };
  }
  const currencyCode = normalizeLower(values.currencyCode || "jpy");
  try {
    return await prismaClient.$transaction(async (tx) => {
      const [attempts, refunds, existingBatch, evidenceOwner] =
        await Promise.all([
          tx.marketplacePaymentAttempt.findMany({
            where: { id: { in: paymentAttemptIds } },
          }),
          refundOperationIds.length > 0
            ? tx.paymentRefundOperation.findMany({
                where: { id: { in: refundOperationIds } },
              })
            : Promise.resolve([]),
          tx.paymentSettlementBatch.findUnique({
            where: {
              provider_externalBatchId: { provider, externalBatchId },
            },
            include: { lines: true },
          }),
          tx.paymentSettlementBatch.findUnique({ where: { evidenceHash } }),
        ]);
      if (attempts.length !== paymentAttemptIds.length) {
        return { ok: false, reason: "settlement_payment_attempt_missing" };
      }
      if (refunds.length !== refundOperationIds.length) {
        return { ok: false, reason: "settlement_refund_operation_missing" };
      }
      const attemptsValid = attempts.every(
        (attempt) =>
          attempt.provider === provider &&
          attempt.status === "CAPTURED" &&
          attempt.test !== true &&
          attempt.requiresReview !== true &&
          attempt.amount > 0 &&
          normalizeLower(attempt.currencyCode) === currencyCode,
      );
      if (!attemptsValid) {
        return { ok: false, reason: "settlement_payment_attempt_invalid" };
      }
      const refundsValid = refunds.every(
        (refund) =>
          refund.provider === provider &&
          refund.status === "LEDGER_APPLIED" &&
          refund.amount > 0 &&
          normalizeLower(refund.currencyCode) === currencyCode,
      );
      if (!refundsValid) {
        return { ok: false, reason: "settlement_refund_operation_invalid" };
      }
      const latestPaymentDate = attempts
        .map(
          (attempt) =>
            attempt.processedAt || attempt.capturedAt || attempt.createdAt,
        )
        .filter(Boolean)
        .sort((left, right) => right.getTime() - left.getTime())[0];
      if (
        latestPaymentDate &&
        tokyoDateKey(bankDepositedAt) < tokyoDateKey(latestPaymentDate)
      ) {
        return {
          ok: false,
          reason: "settlement_bank_deposit_precedes_payment",
        };
      }
      const linkedGrossAmount = attempts.reduce(
        (sum, attempt) => sum + attempt.amount,
        0,
      );
      const linkedRefundAmount = refunds.reduce(
        (sum, refund) => sum + refund.amount,
        0,
      );
      const directlyReconciled =
        grossAmount === linkedGrossAmount &&
        refundAmount === linkedRefundAmount &&
        netAmount === expectedNetAmount;
      if (!directlyReconciled) {
        return {
          ok: false,
          reason: "settlement_direct_totals_mismatch",
          expectedNetAmount,
          linkedGrossAmount,
          linkedRefundAmount,
        };
      }
      const expectedLines = [
        ...attempts.map((attempt) => ({
          externalLineId: `payment:${attempt.shopifyTransactionId || attempt.id}`,
          lineType: "PAYMENT",
          paymentAttemptId: attempt.id,
          refundOperationId: null,
          marketplaceOrderId: attempt.marketplaceOrderId,
          providerReference: attempt.shopifyTransactionId,
          amount: attempt.amount,
          feeAmount: 0,
          currencyCode,
          matchStatus: "MATCHED",
          occurredAt: attempt.processedAt || attempt.capturedAt,
        })),
        ...refunds.map((refund) => ({
          externalLineId: `refund:${refund.providerReference || refund.id}`,
          lineType: "REFUND",
          paymentAttemptId: null,
          refundOperationId: refund.id,
          marketplaceOrderId: refund.marketplaceOrderId,
          providerReference: refund.providerReference,
          amount: refund.amount,
          feeAmount: 0,
          currencyCode,
          matchStatus: "MATCHED",
          occurredAt: refund.providerConfirmedAt || refund.ledgerAppliedAt,
        })),
        ...(feeAmount > 0
          ? [
              {
                externalLineId: "fee:aggregate",
                lineType: "FEE",
                paymentAttemptId: null,
                refundOperationId: null,
                marketplaceOrderId: null,
                providerReference: null,
                amount: 0,
                feeAmount,
                currencyCode,
                matchStatus: "MATCHED",
                occurredAt: payoutDate,
              },
            ]
          : []),
      ];
      const expectedBatch = {
        provider,
        externalBatchId,
        grossAmount,
        refundAmount,
        feeAmount,
        netAmount,
        currencyCode,
        payoutDate,
        bankDepositedAt,
        evidenceReference,
        evidenceHash,
      };
      if (existingBatch) {
        if (
          settlementBatchMatches(existingBatch, expectedBatch, expectedLines)
        ) {
          return {
            ok: true,
            reason: null,
            idempotent: true,
            batch: existingBatch,
            expectedNetAmount,
            linkedGrossAmount,
            linkedRefundAmount,
          };
        }
        return { ok: false, reason: "settlement_batch_immutable" };
      }
      if (evidenceOwner) {
        return {
          ok: false,
          reason: "settlement_evidence_hash_already_registered",
        };
      }
      const duplicateLine = await tx.paymentSettlementLine.findFirst({
        where: {
          OR: [
            { paymentAttemptId: { in: paymentAttemptIds } },
            ...(refundOperationIds.length > 0
              ? [{ refundOperationId: { in: refundOperationIds } }]
              : []),
          ],
        },
        select: { id: true },
      });
      if (duplicateLine) {
        return { ok: false, reason: "settlement_line_already_registered" };
      }
      const status = "RECONCILED";
      const batch = await tx.paymentSettlementBatch.create({
        data: {
          provider,
          externalBatchId,
          status,
          grossAmount,
          refundAmount,
          feeAmount,
          netAmount,
          currencyCode,
          payoutDate,
          bankDepositedAt,
          evidenceReference,
          evidenceHash,
          submittedBy,
          reviewedBy: submittedBy,
          reviewedAt: now,
          metadataJson: {
            expectedNetAmount,
            linkedGrossAmount,
            linkedRefundAmount,
            directLineReconciliation: directlyReconciled,
          },
        },
      });
      await tx.paymentSettlementLine.createMany({
        data: expectedLines.map((line) => ({ ...line, batchId: batch.id })),
      });
      return {
        ok: true,
        reason: null,
        batch,
        expectedNetAmount,
        linkedGrossAmount,
        linkedRefundAmount,
      };
    });
  } catch (error) {
    if (error?.code === "P2002") {
      return { ok: false, reason: "settlement_unique_conflict" };
    }
    throw error;
  }
}

function paidLedgerBackfillOrders(entries) {
  const orders = new Map();
  let skippedLedgerRows = 0;
  let metadataGatewayMissingRows = 0;
  let metadataGatewayAnomalyRows = 0;

  for (const entry of entries) {
    const metadata = metadataObject(entry.metadataJson);
    const shopDomain = normalizeLower(metadata.shopDomain);
    const shopifyOrderId = normalizeText(metadata.shopifyOrderId);
    const gatewayNames = Array.isArray(metadata.shopifyPaymentGatewayNames)
      ? metadata.shopifyPaymentGatewayNames.map(normalizeText).filter(Boolean)
      : [];
    if (gatewayNames.length === 0) metadataGatewayMissingRows += 1;
    if (gatewayNames.length > 1) metadataGatewayAnomalyRows += 1;
    if (!shopDomain || !shopifyOrderId) {
      skippedLedgerRows += 1;
      continue;
    }

    const orderKey = `${shopDomain}\u0000${shopifyOrderId}`;
    const existing = orders.get(orderKey);
    if (existing) {
      existing.ledgerRowCount += 1;
      continue;
    }
    orders.set(orderKey, {
      shopDomain,
      shopifyOrderId,
      ledgerRowCount: 1,
      payload: {
        admin_graphql_api_id: shopifyOrderId,
        name: normalizeText(metadata.shopifyOrderName) || null,
        processed_at: entry.occurredAt,
        financial_status: "PAID",
        currency: entry.currencyCode,
      },
    });
  }

  return {
    orders: [...orders.values()],
    skippedLedgerRows,
    metadataGatewayMissingRows,
    metadataGatewayAnomalyRows,
    duplicateLedgerRows: [...orders.values()].reduce(
      (total, order) => total + Math.max(0, order.ledgerRowCount - 1),
      0,
    ),
  };
}

function incrementReason(reasons, reason) {
  const key = normalizeText(reason) || "unknown";
  reasons[key] = (reasons[key] || 0) + 1;
}

async function runPaidLedgerBackfillPreflight(
  { limit = 200 },
  {
    prismaClient = prisma,
    now = new Date(),
    syncShopifyOrderPaymentAttemptsImpl = syncShopifyOrderPaymentAttempts,
  } = {},
) {
  const boundedLimit = Math.max(1, Math.min(500, toInteger(limit) || 200));
  const nonTestLedgerWhere = {
    entryType: "shopify_order_paid",
    seller: {
      is: {
        vendorStore: { is: { isTestStore: false } },
      },
    },
  };
  const testLedgerWhere = {
    entryType: "shopify_order_paid",
    seller: {
      is: {
        vendorStore: { is: { isTestStore: true } },
      },
    },
  };
  const [entries, excludedTestLedgerRows] = await Promise.all([
    prismaClient.ledgerEntry.findMany({
      where: nonTestLedgerWhere,
      orderBy: { occurredAt: "desc" },
      take: boundedLimit,
      select: {
        id: true,
        amount: true,
        currencyCode: true,
        occurredAt: true,
        metadataJson: true,
      },
    }),
    typeof prismaClient.ledgerEntry.count === "function"
      ? prismaClient.ledgerEntry.count({ where: testLedgerWhere })
      : Promise.resolve(0),
  ]);
  const grouped = paidLedgerBackfillOrders(entries);
  const blockerReasons = {};
  let projectedCreates = 0;
  let projectedUpdates = 0;
  let projectedAttempts = 0;
  let existingAttemptOrders = 0;
  let reviewRequiredOrders = 0;
  let multipleAttemptOrders = 0;
  let unknownAttemptCount = 0;

  const orderPreflights = [];
  for (const order of grouped.orders) {
    const result = await syncShopifyOrderPaymentAttemptsImpl(
      {
        shop: order.shopDomain,
        payload: order.payload,
        sourceTopic: "PAID_LEDGER_BACKFILL",
      },
      {
        prismaClient,
        now,
        canonicalOnly: true,
        dryRun: true,
      },
    );
    const attempts = Array.isArray(result?.attempts) ? result.attempts : [];
    const unknownAttempts = attempts.filter(
      (attempt) => attempt?.requiresReview,
    ).length;
    projectedCreates += toInteger(result?.creates);
    projectedUpdates += toInteger(result?.updates);
    projectedAttempts += toInteger(result?.attemptCount);
    if (toInteger(result?.updates) > 0) existingAttemptOrders += 1;
    unknownAttemptCount += unknownAttempts;
    if (result?.multipleAttempts) multipleAttemptOrders += 1;
    if (!result?.tracked || result?.reviewRequired || !result?.ok) {
      reviewRequiredOrders += 1;
      incrementReason(
        blockerReasons,
        result?.reason ||
          (result?.multipleAttempts
            ? "multiple_payment_attempts"
            : unknownAttempts > 0
              ? "unknown_payment_gateway"
              : "payment_backfill_preflight_failed"),
      );
    }
    orderPreflights.push({ order, result });
  }

  if (grouped.skippedLedgerRows > 0) {
    incrementReason(blockerReasons, "payment_order_identity_missing");
  }

  return {
    ok: true,
    dryRun: true,
    canApply:
      grouped.orders.length > 0 &&
      reviewRequiredOrders === 0 &&
      grouped.skippedLedgerRows === 0,
    processedLedgerRows: entries.length,
    excludedTestLedgerRows,
    uniqueOrders: grouped.orders.length,
    skippedLedgerRows: grouped.skippedLedgerRows,
    duplicateLedgerRows: grouped.duplicateLedgerRows,
    metadataGatewayMissingRows: grouped.metadataGatewayMissingRows,
    metadataGatewayAnomalyRows: grouped.metadataGatewayAnomalyRows,
    projectedAttempts,
    projectedCreates,
    projectedUpdates,
    existingAttemptOrders,
    reviewRequiredOrders,
    multipleAttemptOrders,
    unknownAttemptCount,
    blockerReasons,
    orderPreflights,
  };
}

function publicBackfillSummary(preflight) {
  const summary = { ...preflight };
  delete summary.orderPreflights;
  return summary;
}

export async function previewPaymentAttemptsFromPaidLedger(
  { limit = 200 } = {},
  dependencies = {},
) {
  const preflight = await runPaidLedgerBackfillPreflight(
    { limit },
    dependencies,
  );
  return publicBackfillSummary(preflight);
}

export async function backfillPaymentAttemptsFromPaidLedger(
  { actor, limit = 200 },
  dependencies = {},
) {
  if (!actor) return { ok: false, reason: "actor_missing" };
  const {
    prismaClient = prisma,
    now = new Date(),
    syncShopifyOrderPaymentAttemptsImpl = syncShopifyOrderPaymentAttempts,
  } = dependencies;
  const preflight = await runPaidLedgerBackfillPreflight(
    { limit },
    { prismaClient, now, syncShopifyOrderPaymentAttemptsImpl },
  );
  const summary = publicBackfillSummary(preflight);
  if (!preflight.canApply) {
    return {
      ...summary,
      ok: false,
      reason:
        preflight.uniqueOrders === 0
          ? "payment_backfill_orders_not_found"
          : "payment_backfill_preflight_blocked",
    };
  }

  let createdOrUpdated = 0;
  for (const { order } of preflight.orderPreflights) {
    const result = await syncShopifyOrderPaymentAttemptsImpl(
      {
        shop: order.shopDomain,
        payload: order.payload,
        sourceTopic: "PAID_LEDGER_BACKFILL",
      },
      { prismaClient, now, canonicalOnly: true },
    );
    if (!result?.ok || !result?.tracked || result?.reviewRequired) {
      return {
        ...summary,
        ok: false,
        reason: "payment_backfill_changed_after_preflight",
        createdOrUpdated,
      };
    }
    createdOrUpdated += toInteger(result.attemptCount);
  }

  return {
    ...summary,
    ok: true,
    dryRun: false,
    actor,
    createdOrUpdated,
  };
}

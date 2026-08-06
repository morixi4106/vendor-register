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
      incrementReason(blockerReasons, result?.reason || (
        result?.multipleAttempts
          ? "multiple_payment_attempts"
          : unknownAttempts > 0
            ? "unknown_payment_gateway"
            : "payment_backfill_preflight_failed"
      ));
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
      reason: preflight.uniqueOrders === 0
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

import prisma from "../../db.server.js";
import { moneyAmountToMinorUnits } from "../sellerPayments/values.js";
import {
  PAYMENT_PROVIDER,
  PAYMENT_REFUND_MODE,
  classifyPaymentGateway,
  getPaymentRefundMode,
  isSuccessfulRefundTransaction,
} from "./classification.js";

export const PAYMENT_REFUND_STATUS = Object.freeze({
  OBSERVED: "OBSERVED",
  AWAITING_PROVIDER: "AWAITING_PROVIDER",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  PROVIDER_CONFIRMED: "PROVIDER_CONFIRMED",
  APPLYING_LEDGER: "APPLYING_LEDGER",
  LEDGER_APPLIED: "LEDGER_APPLIED",
  FAILED: "FAILED",
});

async function reserveProviderRefundGuard(
  { marketplaceOrder, shopDomain, shopifyOrderId, shopifyRefundId },
  { prismaClient, now },
) {
  if (!marketplaceOrder?.id || !prismaClient?.orderRefundGuard?.findUnique) {
    return { ok: true, skipped: true, guard: null };
  }
  let guard = await prismaClient.orderRefundGuard.findUnique({
    where: { marketplaceOrderId: marketplaceOrder.id },
  });
  if (!guard) {
    try {
      guard = await prismaClient.orderRefundGuard.create({
        data: {
          marketplaceOrderId: marketplaceOrder.id,
          shopDomain,
          shopifyOrderId,
          channel: "PROVIDER",
          status: "RESERVED",
          operationReference: shopifyRefundId,
          reservedAt: now,
          metadataJson: { source: "shopify_refund_webhook" },
        },
      });
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      guard = await prismaClient.orderRefundGuard.findUnique({
        where: { marketplaceOrderId: marketplaceOrder.id },
      });
    }
  }
  if (guard?.channel === "DIRECT") {
    return {
      ok: false,
      conflict: true,
      reason: "direct_customer_refund_already_completed",
      guard,
    };
  }
  return { ok: true, guard };
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeGid(type, value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  return normalized.startsWith("gid://")
    ? normalized
    : `gid://shopify/${type}/${normalized}`;
}

function getRefundTransactions(payload) {
  return Array.isArray(payload?.transactions) ? payload.transactions : [];
}

function refundAmount(payload) {
  const transactions = getRefundTransactions(payload);
  const successful = transactions.filter(isSuccessfulRefundTransaction);
  const currencyCode = normalizeLower(
    successful[0]?.currency ||
      successful[0]?.amount_set?.shop_money?.currency_code ||
      payload?.currency ||
      payload?.refund_line_items?.[0]?.subtotal_set?.shop_money?.currency_code ||
      "jpy",
  );
  const transactionTotal = successful.reduce(
    (sum, transaction) =>
      sum +
      moneyAmountToMinorUnits(
        transaction?.amount_set?.shop_money?.amount ?? transaction?.amount,
        currencyCode,
      ),
    0,
  );
  if (transactionTotal > 0) return { amount: transactionTotal, currencyCode };
  const lineTotal = (Array.isArray(payload?.refund_line_items)
    ? payload.refund_line_items
    : []
  ).reduce(
    (sum, line) =>
      sum +
      moneyAmountToMinorUnits(
        line?.subtotal_set?.shop_money?.amount ?? line?.subtotal,
        currencyCode,
      ),
    0,
  );
  return { amount: lineTotal, currencyCode };
}

function buildRefundSnapshot(payload) {
  return {
    id: payload?.id || null,
    admin_graphql_api_id: payload?.admin_graphql_api_id || null,
    order_id: payload?.order_id || null,
    currency: payload?.currency || null,
    created_at: payload?.created_at || null,
    processed_at: payload?.processed_at || null,
    refund_line_items: Array.isArray(payload?.refund_line_items)
      ? payload.refund_line_items.map((line) => ({
          id: line?.id || null,
          quantity: line?.quantity || 0,
          line_item_id: line?.line_item_id || null,
          product_id: line?.product_id || line?.line_item?.product_id || null,
          subtotal: line?.subtotal || null,
          subtotal_set: line?.subtotal_set || null,
          line_item: line?.line_item
            ? {
                id: line.line_item.id || null,
                admin_graphql_api_id:
                  line.line_item.admin_graphql_api_id || null,
                product_id: line.line_item.product_id || null,
                variant_id: line.line_item.variant_id || null,
                price: line.line_item.price || null,
                price_set: line.line_item.price_set || null,
              }
            : null,
        }))
      : [],
    transactions: getRefundTransactions(payload).map((transaction) => ({
      id: transaction?.id || null,
      admin_graphql_api_id: transaction?.admin_graphql_api_id || null,
      kind: transaction?.kind || null,
      status: transaction?.status || null,
      gateway: transaction?.gateway || null,
      amount: transaction?.amount || null,
      amount_set: transaction?.amount_set || null,
      currency: transaction?.currency || null,
      processed_at: transaction?.processed_at || null,
    })),
  };
}

function isStrictRefundConfirmationEnabled(env) {
  return normalizeLower(env.PAYMENT_REFUND_CONFIRMATION_ENFORCED) === "true";
}

function resolveRefundClassification(payload, paymentAttempt) {
  const transaction = getRefundTransactions(payload).find(
    (item) => normalizeText(item?.kind).toUpperCase() === "REFUND",
  );
  const transactionClassification = classifyPaymentGateway(
    transaction?.gateway,
    transaction?.gateway,
  );
  const provider =
    transactionClassification.provider !== PAYMENT_PROVIDER.UNKNOWN
      ? transactionClassification.provider
      : paymentAttempt?.provider || PAYMENT_PROVIDER.UNKNOWN;
  const paymentMethod =
    transactionClassification.paymentMethod !== "OTHER"
      ? transactionClassification.paymentMethod
      : paymentAttempt?.paymentMethod || "OTHER";
  return {
    provider,
    paymentMethod,
    refundMode: getPaymentRefundMode({ provider, paymentMethod }),
    transaction,
  };
}

export async function observeShopifyRefundOperation(
  { payload, shop },
  { prismaClient = prisma, env = process.env, now = new Date() } = {},
) {
  if (!prismaClient?.paymentRefundOperation?.upsert) {
    return {
      ok: true,
      tracked: false,
      allowLedger: true,
      reason: "payment_models_unavailable",
    };
  }

  const shopDomain = normalizeLower(shop || payload?.shop_domain || payload?.shop);
  const shopifyOrderId = normalizeGid("Order", payload?.order_id);
  const shopifyRefundId = normalizeGid(
    "Refund",
    payload?.admin_graphql_api_id || payload?.id,
  );
  if (!shopDomain || !shopifyOrderId || !shopifyRefundId) {
    return {
      ok: false,
      terminal: true,
      allowLedger: false,
      reason: "payment_refund_identity_missing",
    };
  }

  const paymentAttempt = prismaClient?.marketplacePaymentAttempt?.findFirst
    ? await prismaClient.marketplacePaymentAttempt.findFirst({
        where: { shopDomain, shopifyOrderId },
        orderBy: [{ capturedAt: "desc" }, { updatedAt: "desc" }],
      })
    : null;
  const marketplaceOrder = prismaClient?.marketplaceOrder?.findUnique
    ? await prismaClient.marketplaceOrder.findUnique({
        where: {
          shopDomain_shopifyOrderId: { shopDomain, shopifyOrderId },
        },
        select: { id: true },
      })
    : null;
  const refundGuard = await reserveProviderRefundGuard(
    { marketplaceOrder, shopDomain, shopifyOrderId, shopifyRefundId },
    { prismaClient, now },
  );
  const refundChannelConflict = refundGuard.conflict === true;
  const classification = resolveRefundClassification(payload, paymentAttempt);
  const successfulProviderTransaction = getRefundTransactions(payload).some(
    isSuccessfulRefundTransaction,
  );
  const strict = isStrictRefundConfirmationEnabled(env);
  const manual = classification.refundMode === PAYMENT_REFUND_MODE.KOMOJU_MANUAL;
  const unknown = classification.refundMode === PAYMENT_REFUND_MODE.REVIEW_REQUIRED;
  const allowLedger =
    !refundChannelConflict &&
    !manual &&
    (!strict ||
      successfulProviderTransaction ||
      classification.provider === PAYMENT_PROVIDER.SHOPIFY_PAYMENTS);
  const status = refundChannelConflict || manual || (strict && unknown)
    ? PAYMENT_REFUND_STATUS.REVIEW_REQUIRED
    : strict && !successfulProviderTransaction
      ? PAYMENT_REFUND_STATUS.AWAITING_PROVIDER
      : successfulProviderTransaction
        ? PAYMENT_REFUND_STATUS.PROVIDER_CONFIRMED
        : PAYMENT_REFUND_STATUS.OBSERVED;
  const { amount, currencyCode } = refundAmount(payload);
  const operationKey = `${shopDomain}:${shopifyRefundId}`;
  const snapshot = buildRefundSnapshot(payload);
  const existing = prismaClient.paymentRefundOperation.findUnique
    ? await prismaClient.paymentRefundOperation.findUnique({
        where: { operationKey },
      })
    : null;
  if (existing?.ledgerAppliedAt || existing?.status === PAYMENT_REFUND_STATUS.LEDGER_APPLIED) {
    return {
      ok: true,
      tracked: true,
      allowLedger: false,
      duplicate: true,
      reason: "payment_refund_ledger_already_applied",
      operation: existing,
    };
  }

  const operation = await prismaClient.paymentRefundOperation.upsert({
    where: { operationKey },
    create: {
      operationKey,
      shopDomain,
      shopifyOrderId,
      marketplaceOrderId: marketplaceOrder?.id || null,
      paymentAttemptId: paymentAttempt?.id || null,
      shopifyRefundId,
      provider: classification.provider,
      paymentMethod: classification.paymentMethod,
      refundMode: classification.refundMode,
      status,
      amount,
      currencyCode,
      shopifyRefundSnapshotJson: snapshot,
      shopifyRecordedAt: now,
      providerConfirmedAt: successfulProviderTransaction ? now : null,
      metadataJson: {
        strictConfirmation: strict,
        successfulProviderTransaction,
        gateway: classification.transaction?.gateway || null,
        refundChannelConflict,
        refundGuardId: refundGuard.guard?.id || null,
      },
    },
    update: {
      marketplaceOrderId: marketplaceOrder?.id || undefined,
      paymentAttemptId: paymentAttempt?.id || undefined,
      provider: classification.provider,
      paymentMethod: classification.paymentMethod,
      refundMode: classification.refundMode,
      status,
      amount,
      currencyCode,
      shopifyRefundSnapshotJson: snapshot,
      shopifyRecordedAt: now,
      providerConfirmedAt: successfulProviderTransaction ? now : undefined,
      failureCode: null,
      metadataJson: {
        strictConfirmation: strict,
        successfulProviderTransaction,
        gateway: classification.transaction?.gateway || null,
        refundChannelConflict,
        refundGuardId: refundGuard.guard?.id || null,
      },
    },
  });

  return {
    ok: true,
    tracked: true,
    allowLedger,
    reason: allowLedger
      ? null
      : refundChannelConflict
        ? "direct_customer_refund_already_completed"
        : "payment_refund_confirmation_required",
    operation,
  };
}

function ledgerEntryIdsFromResult(result) {
  return [
    result?.ledgerEntry?.id,
    ...(Array.isArray(result?.ledgerEntries)
      ? result.ledgerEntries.map((entry) => entry?.id)
      : []),
  ].filter(Boolean);
}

export async function markPaymentRefundLedgerApplied(
  operationId,
  settlementResult,
  { prismaClient = prisma, now = new Date() } = {},
) {
  if (!operationId || !prismaClient?.paymentRefundOperation?.update) return null;
  const operation = await prismaClient.paymentRefundOperation.update({
    where: { id: operationId },
    data: settlementResult?.ok
      ? {
          status: PAYMENT_REFUND_STATUS.LEDGER_APPLIED,
          ledgerAppliedAt: now,
          ledgerEntryIdsJson: ledgerEntryIdsFromResult(settlementResult),
          failureCode: null,
        }
      : {
          status: PAYMENT_REFUND_STATUS.FAILED,
          failureCode: normalizeText(settlementResult?.reason) || "ledger_apply_failed",
        },
  });
  if (
    settlementResult?.ok &&
    operation.marketplaceOrderId &&
    prismaClient?.orderRefundGuard?.updateMany
  ) {
    await prismaClient.orderRefundGuard.updateMany({
      where: {
        marketplaceOrderId: operation.marketplaceOrderId,
        channel: "PROVIDER",
      },
      data: {
        status: "COMPLETED",
        completedAt: now,
        amount: operation.amount,
        currencyCode: operation.currencyCode,
        operationReference: operation.shopifyRefundId || operation.operationKey,
      },
    });
  }
  return operation;
}

export async function confirmManualPaymentRefundOperation(
  {
    operationId,
    providerReference,
    evidenceReference,
    evidenceHash,
    refundFeeAmount = 0,
    actor,
    confirm,
  },
  { prismaClient = prisma, env = process.env, now = new Date() } = {},
) {
  if (normalizeLower(env.KOMOJU_PAYMENT_OPERATIONS_ENABLED) !== "true") {
    return { ok: false, reason: "komoju_payment_operations_disabled" };
  }
  if (confirm !== "provider_refund_confirmed") {
    return { ok: false, reason: "confirmation_required" };
  }
  const normalizedReference = normalizeText(providerReference);
  const normalizedEvidence = normalizeText(evidenceReference);
  if (!operationId || !normalizedReference || !normalizedEvidence || !actor) {
    return { ok: false, reason: "manual_refund_evidence_incomplete" };
  }
  const operation = await prismaClient.paymentRefundOperation.findUnique({
    where: { id: operationId },
  });
  if (!operation) return { ok: false, reason: "refund_operation_not_found" };
  if (operation.refundMode !== PAYMENT_REFUND_MODE.KOMOJU_MANUAL) {
    return { ok: false, reason: "refund_operation_not_manual_komoju" };
  }
  if (operation.ledgerAppliedAt) {
    return {
      ok: true,
      duplicate: true,
      operation,
      payload: operation.shopifyRefundSnapshotJson || null,
    };
  }

  const claim = await prismaClient.paymentRefundOperation.updateMany({
    where: {
      id: operation.id,
      ledgerAppliedAt: null,
      status: { not: PAYMENT_REFUND_STATUS.APPLYING_LEDGER },
    },
    data: {
      status: PAYMENT_REFUND_STATUS.APPLYING_LEDGER,
      providerReference: normalizedReference,
      evidenceReference: normalizedEvidence,
      evidenceHash: normalizeText(evidenceHash) || null,
      refundFeeAmount: Math.max(0, Math.trunc(Number(refundFeeAmount) || 0)),
      providerConfirmedAt: now,
      reviewedAt: now,
      reviewedBy: actor,
      failureCode: null,
    },
  });
  if (claim.count !== 1) {
    const current = await prismaClient.paymentRefundOperation.findUnique({
      where: { id: operation.id },
    });
    return current?.ledgerAppliedAt
      ? {
          ok: true,
          duplicate: true,
          operation: current,
          payload: current.shopifyRefundSnapshotJson || null,
        }
      : { ok: false, reason: "refund_operation_in_progress", operation: current };
  }
  const confirmed = await prismaClient.paymentRefundOperation.findUnique({
    where: { id: operation.id },
  });
  if (!confirmed) {
    return { ok: false, reason: "refund_operation_lost_after_claim" };
  }

  const payload = confirmed.shopifyRefundSnapshotJson;
  if (!payload || typeof payload !== "object") {
    await prismaClient.paymentRefundOperation.update({
      where: { id: confirmed.id },
      data: {
        status: PAYMENT_REFUND_STATUS.FAILED,
        failureCode: "refund_snapshot_missing",
      },
    });
    return { ok: false, reason: "refund_snapshot_missing", operation: confirmed };
  }

  const { processShopifyRefundSettlement } = await import(
    "../sellerPayments.server.js"
  );
  const settlement = await processShopifyRefundSettlement(
    { payload, shop: confirmed.shopDomain },
    { prismaClient, env },
  );
  const updated = await markPaymentRefundLedgerApplied(
    confirmed.id,
    settlement,
    { prismaClient, now },
  );
  return {
    ok: Boolean(settlement?.ok),
    reason: settlement?.reason || null,
    operation: updated,
    settlement,
    payload,
  };
}

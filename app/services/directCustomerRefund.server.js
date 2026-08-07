import prisma from "../db.server.js";
import {
  createLedgerEntry,
  runSerializableTransaction,
} from "./sellerPayments/shared.server.js";
import {
  findShopifyOrderLedgerEntries,
  getSellerOrderPaymentStatusAfterRefund,
  summarizeShopifyOrderLedgerEntries,
} from "./sellerPayments/settlements/common.server.js";

export const ORDER_REFUND_CHANNEL = Object.freeze({
  PROVIDER: "PROVIDER",
  DIRECT: "DIRECT",
});

export const ORDER_REFUND_GUARD_STATUS = Object.freeze({
  RESERVED: "RESERVED",
  COMPLETED: "COMPLETED",
  CONFLICT: "CONFLICT",
});

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeShop(value) {
  return clean(value).toLowerCase();
}

function normalizeCurrency(value) {
  return clean(value || "jpy").toLowerCase();
}

function normalizeSha256(value) {
  const normalized = clean(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function toPositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function orderReferenceClauses(reference) {
  const normalized = clean(reference);
  const withoutHash = normalized.replace(/^#/, "");
  const clauses = [
    { shopifyOrderId: normalized },
    { shopifyOrderName: normalized },
    { shopifyOrderNumber: withoutHash },
  ];
  if (/^\d+$/.test(normalized)) {
    clauses.push({ shopifyOrderId: `gid://shopify/Order/${normalized}` });
  }
  return clauses;
}

function sameDirectRefund(existing, expected) {
  return Boolean(
    existing &&
      existing.status === "COMPLETED" &&
      existing.amount === expected.amount &&
      normalizeCurrency(existing.currencyCode) === expected.currencyCode &&
      existing.recipientConsentReference === expected.recipientConsentReference &&
      existing.recipientConsentHash === expected.recipientConsentHash &&
      existing.transferEvidenceReference === expected.transferEvidenceReference &&
      existing.transferEvidenceHash === expected.transferEvidenceHash &&
      clean(existing.transferReferenceMasked) === expected.transferReferenceMasked,
  );
}

export async function recordDirectCustomerRefund(
  {
    shopDomain,
    orderReference,
    amount,
    currencyCode,
    recipientConsentReference,
    recipientConsentHash,
    transferEvidenceReference,
    transferEvidenceHash,
    transferReferenceMasked,
    actor,
    confirm,
  },
  {
    prismaClient = prisma,
    now = new Date(),
    refreshLimitedLaunchControl = null,
  } = {},
) {
  const shop = normalizeShop(shopDomain);
  const reference = clean(orderReference);
  const refundAmount = toPositiveInteger(amount);
  const currency = normalizeCurrency(currencyCode);
  const consentReference = clean(recipientConsentReference);
  const consentHash = normalizeSha256(recipientConsentHash);
  const evidenceReference = clean(transferEvidenceReference);
  const evidenceHash = normalizeSha256(transferEvidenceHash);
  const maskedReference = clean(transferReferenceMasked);
  const completedBy = clean(actor);
  if (
    !shop ||
    !reference ||
    !refundAmount ||
    !currency ||
    !consentReference ||
    !consentHash ||
    !evidenceReference ||
    !evidenceHash ||
    !maskedReference ||
    !completedBy ||
    confirm !== "direct_customer_refund_completed"
  ) {
    return { ok: false, reason: "direct_refund_input_invalid" };
  }

  const result = await runSerializableTransaction(prismaClient, async (tx) => {
    const orders = await tx.marketplaceOrder.findMany({
      where: { shopDomain: shop, OR: orderReferenceClauses(reference) },
      take: 2,
      include: {
        sellerOrders: { include: { lines: true } },
        paymentAttempts: {
          where: { status: "CAPTURED", test: false },
          orderBy: [{ capturedAt: "desc" }, { updatedAt: "desc" }],
        },
        paymentRefundOperations: true,
        refundGuard: true,
        directCustomerRefund: true,
      },
    });
    if (orders.length !== 1) {
      return {
        ok: false,
        reason:
          orders.length === 0
            ? "direct_refund_order_not_found"
            : "direct_refund_order_ambiguous",
      };
    }
    const order = orders[0];
    const expected = {
      amount: refundAmount,
      currencyCode: currency,
      recipientConsentReference: consentReference,
      recipientConsentHash: consentHash,
      transferEvidenceReference: evidenceReference,
      transferEvidenceHash: evidenceHash,
      transferReferenceMasked: maskedReference,
    };
    if (sameDirectRefund(order.directCustomerRefund, expected)) {
      return {
        ok: true,
        existing: true,
        directRefund: order.directCustomerRefund,
      };
    }
    if (order.directCustomerRefund) {
      return { ok: false, reason: "direct_refund_immutable" };
    }
    if (
      refundAmount !== order.totalAmount ||
      currency !== normalizeCurrency(order.currencyCode)
    ) {
      return { ok: false, reason: "direct_refund_must_equal_full_order" };
    }
    const paymentAttempt = order.paymentAttempts.find(
      (attempt) =>
        attempt.provider === "KOMOJU" &&
        attempt.amount === refundAmount &&
        normalizeCurrency(attempt.currencyCode) === currency,
    );
    if (!paymentAttempt) {
      return { ok: false, reason: "direct_refund_komoju_sale_not_found" };
    }
    const providerRefundExists = order.paymentRefundOperations.some(
      (operation) =>
        operation.ledgerAppliedAt ||
        operation.providerConfirmedAt ||
        ["PROVIDER_CONFIRMED", "LEDGER_APPLIED"].includes(operation.status),
    );
    if (providerRefundExists || order.refundGuard?.channel === ORDER_REFUND_CHANNEL.PROVIDER) {
      return { ok: false, reason: "provider_refund_already_started" };
    }

    const orderLedgerEntries = await findShopifyOrderLedgerEntries(
      order.shopifyOrderId,
      tx,
    );
    const refundableSellerOrders = order.sellerOrders
      .map((sellerOrder) => ({
        sellerOrder,
        summary: summarizeShopifyOrderLedgerEntries(
          orderLedgerEntries,
          sellerOrder.sellerId,
        ),
      }))
      .filter(({ summary }) => summary.remainingAmount > 0);
    if (refundableSellerOrders.length === 0) {
      return { ok: false, reason: "direct_refund_paid_ledger_not_found" };
    }
    const refundableLedgerAmount = refundableSellerOrders.reduce(
      (total, { summary }) => total + summary.remainingAmount,
      0,
    );
    if (refundableLedgerAmount !== refundAmount) {
      return { ok: false, reason: "direct_refund_ledger_amount_mismatch" };
    }

    const operationKey = `direct:${shop}:${order.shopifyOrderId}`;
    const guard = order.refundGuard
      ? await tx.orderRefundGuard.update({
          where: { id: order.refundGuard.id },
          data: {
            channel: ORDER_REFUND_CHANNEL.DIRECT,
            status: ORDER_REFUND_GUARD_STATUS.RESERVED,
            amount: refundAmount,
            currencyCode: currency,
            operationReference: operationKey,
            metadataJson: { reservedBy: completedBy },
          },
        })
      : await tx.orderRefundGuard.create({
          data: {
            marketplaceOrderId: order.id,
            shopDomain: shop,
            shopifyOrderId: order.shopifyOrderId,
            channel: ORDER_REFUND_CHANNEL.DIRECT,
            status: ORDER_REFUND_GUARD_STATUS.RESERVED,
            amount: refundAmount,
            currencyCode: currency,
            operationReference: operationKey,
            metadataJson: { reservedBy: completedBy },
          },
        });

    const ledgerEntries = [];
    for (const { sellerOrder, summary } of refundableSellerOrders) {
      const seller = await tx.seller.findUnique({
        where: { id: sellerOrder.sellerId },
        include: { stripeAccount: true },
      });
      const ledgerEntry = await createLedgerEntry(
        {
          sellerId: sellerOrder.sellerId,
          sellerStripeAccountId: seller?.stripeAccount?.id || null,
          stripeAccountId: seller?.stripeAccount?.stripeAccountId || null,
          entryType: "direct_customer_refund",
          stripeObjectId: operationKey,
          amount: summary.remainingAmount,
          currencyCode: currency,
          direction: "debit",
          description: "Direct customer refund",
          metadataJson: {
            shopDomain: shop,
            shopifyOrderId: order.shopifyOrderId,
            marketplaceOrderId: order.id,
            sellerOrderId: sellerOrder.id,
            refundChannel: ORDER_REFUND_CHANNEL.DIRECT,
            transferEvidenceHash: evidenceHash,
          },
          occurredAt: now,
        },
        { prismaClient: tx },
      );
      ledgerEntries.push(ledgerEntry);
      for (const line of sellerOrder.lines) {
        await tx.sellerOrderLine.update({
          where: { id: line.id },
          data: { refundedQuantity: line.quantity },
        });
      }
      const nextRefundAmount = Math.max(
        sellerOrder.sellerRefundAmount,
        summary.paidAmount,
      );
      await tx.sellerOrder.update({
        where: { id: sellerOrder.id },
        data: {
          sellerRefundAmount: nextRefundAmount,
          paymentStatus: getSellerOrderPaymentStatusAfterRefund({
            paidAmount: summary.paidAmount,
            refundAmount: nextRefundAmount,
            fallback: sellerOrder.paymentStatus,
          }),
        },
      });
    }
    const directRefund = await tx.directCustomerRefund.create({
      data: {
        operationKey,
        marketplaceOrderId: order.id,
        paymentAttemptId: paymentAttempt.id,
        shopDomain: shop,
        shopifyOrderId: order.shopifyOrderId,
        status: "COMPLETED",
        amount: refundAmount,
        currencyCode: currency,
        recipientConsentReference: consentReference,
        recipientConsentHash: consentHash,
        transferEvidenceReference: evidenceReference,
        transferEvidenceHash: evidenceHash,
        transferReferenceMasked: maskedReference,
        completedBy,
        completedAt: now,
        ledgerEntryIdsJson: ledgerEntries.map((entry) => entry.id),
        metadataJson: { refundGuardId: guard.id },
      },
    });
    await tx.orderRefundGuard.update({
      where: { id: guard.id },
      data: {
        status: ORDER_REFUND_GUARD_STATUS.COMPLETED,
        completedAt: now,
        metadataJson: {
          reservedBy: completedBy,
          directCustomerRefundId: directRefund.id,
        },
      },
    });
    return { ok: true, existing: false, directRefund, ledgerEntries };
  });
  if (result.ok) {
    const refresh =
      refreshLimitedLaunchControl ||
      (await import("./komojuLimitedLaunchControl.server.js"))
        .refreshKomojuLimitedLaunchControl;
    const control = await refresh(
      { shopDomain: shop, applyEmergencyHold: true },
      { prismaClient, now },
    );
    if (control?.ok === false) {
      return {
        ok: false,
        reason: control.reason || "limited_launch_refresh_failed",
        directRefundRecorded: true,
      };
    }
    return { ...result, limitedLaunchControl: control };
  }
  return result;
}

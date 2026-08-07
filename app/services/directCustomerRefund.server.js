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

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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

function preparedGuardMatches(guard, expected) {
  const metadata = asObject(guard?.metadataJson);
  return Boolean(
    guard?.channel === ORDER_REFUND_CHANNEL.DIRECT &&
      guard?.status === ORDER_REFUND_GUARD_STATUS.RESERVED &&
      guard?.amount === expected.amount &&
      normalizeCurrency(guard?.currencyCode) === expected.currencyCode &&
      metadata.recipientConsentReference === expected.recipientConsentReference &&
      metadata.recipientConsentHash === expected.recipientConsentHash,
  );
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

async function loadDirectRefundOrder(tx, { shop, reference }) {
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
  return { ok: true, order: orders[0] };
}

async function validateDirectRefundOrder(
  tx,
  { order, amount, currencyCode, allowReservedDirectGuard = false },
) {
  if (
    amount !== order.totalAmount ||
    currencyCode !== normalizeCurrency(order.currencyCode)
  ) {
    return { ok: false, reason: "direct_refund_must_equal_full_order" };
  }
  const paymentAttempt = order.paymentAttempts.find(
    (attempt) =>
      attempt.provider === "KOMOJU" &&
      attempt.amount === amount &&
      normalizeCurrency(attempt.currencyCode) === currencyCode,
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
  const directReservationAllowed =
    allowReservedDirectGuard &&
    order.refundGuard?.channel === ORDER_REFUND_CHANNEL.DIRECT &&
    order.refundGuard?.status === ORDER_REFUND_GUARD_STATUS.RESERVED;
  if (
    providerRefundExists ||
    (order.refundGuard && !directReservationAllowed)
  ) {
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
  if (refundableLedgerAmount !== amount) {
    return { ok: false, reason: "direct_refund_ledger_amount_mismatch" };
  }
  return { ok: true, paymentAttempt, refundableSellerOrders };
}

async function refreshRefundControl(
  { shopDomain, prismaClient, now, refreshLimitedLaunchControl },
) {
  const refresh =
    refreshLimitedLaunchControl ||
    (await import("./komojuLimitedLaunchControl.server.js"))
      .refreshKomojuLimitedLaunchControl;
  return refresh(
    { shopDomain, applyEmergencyHold: true },
    { prismaClient, now },
  );
}

export async function prepareDirectCustomerRefund(
  {
    shopDomain,
    orderReference,
    amount,
    currencyCode,
    recipientConsentReference,
    recipientConsentHash,
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
  const preparedBy = clean(actor);
  if (
    !shop ||
    !reference ||
    !refundAmount ||
    !currency ||
    !consentReference ||
    !consentHash ||
    !preparedBy ||
    confirm !== "direct_customer_refund_prepare"
  ) {
    return { ok: false, reason: "direct_refund_prepare_input_invalid" };
  }

  const result = await runSerializableTransaction(prismaClient, async (tx) => {
    const loaded = await loadDirectRefundOrder(tx, { shop, reference });
    if (!loaded.ok) return loaded;
    const { order } = loaded;
    const expected = {
      amount: refundAmount,
      currencyCode: currency,
      recipientConsentReference: consentReference,
      recipientConsentHash: consentHash,
    };
    if (preparedGuardMatches(order.refundGuard, expected)) {
      return { ok: true, existing: true, guard: order.refundGuard, order };
    }
    if (
      order.refundGuard?.channel === ORDER_REFUND_CHANNEL.DIRECT ||
      order.directCustomerRefund
    ) {
      return { ok: false, reason: "direct_refund_immutable" };
    }
    if (order.refundGuard?.channel === ORDER_REFUND_CHANNEL.PROVIDER) {
      const guard = await tx.orderRefundGuard.update({
        where: { id: order.refundGuard.id },
        data: {
          status: ORDER_REFUND_GUARD_STATUS.CONFLICT,
          metadataJson: {
            ...asObject(order.refundGuard.metadataJson),
            conflictReason: "direct_refund_after_provider_reservation",
            conflictDetectedAt: now.toISOString(),
            conflictDetectedBy: preparedBy,
          },
        },
      });
      return {
        ok: false,
        conflict: true,
        reason: "provider_refund_already_started",
        guard,
      };
    }
    const validated = await validateDirectRefundOrder(tx, {
      order,
      amount: refundAmount,
      currencyCode: currency,
    });
    if (!validated.ok) return validated;

    const operationReference = `direct:${shop}:${order.shopifyOrderId}`;
    const guard = await tx.orderRefundGuard.create({
      data: {
        marketplaceOrderId: order.id,
        shopDomain: shop,
        shopifyOrderId: order.shopifyOrderId,
        channel: ORDER_REFUND_CHANNEL.DIRECT,
        status: ORDER_REFUND_GUARD_STATUS.RESERVED,
        amount: refundAmount,
        currencyCode: currency,
        operationReference,
        reservedAt: now,
        metadataJson: {
          recipientConsentReference: consentReference,
          recipientConsentHash: consentHash,
          preparedBy,
          preparedAt: now.toISOString(),
        },
      },
    });
    return { ok: true, existing: false, guard, order };
  });

  if (result.ok || result.conflict) {
    const control = await refreshRefundControl({
      shopDomain: shop,
      prismaClient,
      now,
      refreshLimitedLaunchControl,
    });
    if (control?.ok === false) {
      return {
        ok: false,
        reason: control.reason || "limited_launch_refresh_failed",
        directRefundReserved: result.ok,
        conflictRecorded: result.conflict === true,
      };
    }
    return { ...result, limitedLaunchControl: control };
  }
  return result;
}

export async function completeDirectCustomerRefund(
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
    const loaded = await loadDirectRefundOrder(tx, { shop, reference });
    if (!loaded.ok) return loaded;
    const { order } = loaded;
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
      return { ok: true, existing: true, directRefund: order.directCustomerRefund };
    }
    if (order.directCustomerRefund) {
      return { ok: false, reason: "direct_refund_immutable" };
    }
    if (!preparedGuardMatches(order.refundGuard, expected)) {
      return {
        ok: false,
        reason:
          order.refundGuard?.channel === ORDER_REFUND_CHANNEL.PROVIDER
            ? "provider_refund_already_started"
            : "direct_refund_not_prepared",
      };
    }
    const validated = await validateDirectRefundOrder(tx, {
      order,
      amount: refundAmount,
      currencyCode: currency,
      allowReservedDirectGuard: true,
    });
    if (!validated.ok) return validated;

    const operationKey = order.refundGuard.operationReference;
    const ledgerEntries = [];
    for (const { sellerOrder, summary } of validated.refundableSellerOrders) {
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
        paymentAttemptId: validated.paymentAttempt.id,
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
        metadataJson: { refundGuardId: order.refundGuard.id },
      },
    });
    await tx.orderRefundGuard.update({
      where: { id: order.refundGuard.id },
      data: {
        status: ORDER_REFUND_GUARD_STATUS.COMPLETED,
        completedAt: now,
        metadataJson: {
          ...asObject(order.refundGuard.metadataJson),
          completedBy,
          directCustomerRefundId: directRefund.id,
        },
      },
    });
    return { ok: true, existing: false, directRefund, ledgerEntries };
  });

  if (result.ok) {
    const control = await refreshRefundControl({
      shopDomain: shop,
      prismaClient,
      now,
      refreshLimitedLaunchControl,
    });
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

// Backward-compatible service entry point. New operator UI calls prepare and complete separately.
export async function recordDirectCustomerRefund(input, options = {}) {
  const existing = await completeDirectCustomerRefund(input, options);
  if (existing.ok) {
    return existing;
  }
  if (
    existing.reason !== "direct_refund_not_prepared" &&
    existing.reason !== "provider_refund_already_started"
  ) {
    return existing;
  }
  const prepared = await prepareDirectCustomerRefund(
    { ...input, confirm: "direct_customer_refund_prepare" },
    options,
  );
  if (!prepared.ok) return prepared;
  return completeDirectCustomerRefund(input, options);
}

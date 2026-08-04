import prisma from "../../db.server.js";
import { DEFAULT_ORDER_CURRENCY, DEFAULT_SALES_CREDIT_LOCK_MINUTES, SALES_CREDIT_SUPPORTED_CURRENCY } from "./constants.js";
import { addMinutes, clampInteger, isPlainObject, normalizeLowercase, normalizeText, toPositiveInteger } from "./values.js";
import { getSalesCreditOffsetMetadata, getSellerSalesCreditSummary, runInTransaction, validateSalesCreditOffsetExpectation } from "./shared.server.js";
export async function authorizeSalesCreditOffset({
  sellerId,
  amount,
  currencyCode,
  checkoutReference = null,
  idempotencyKey = null,
  expiresAt = undefined,
  lockMinutes = DEFAULT_SALES_CREDIT_LOCK_MINUTES,
  metadataJson = null
}, {
  prismaClient = prisma,
  now = new Date()
} = {}) {
  const normalizedSellerId = normalizeText(sellerId);
  const normalizedAmount = toPositiveInteger(amount);
  const normalizedCurrency = normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;
  const normalizedIdempotencyKey = normalizeText(idempotencyKey);
  if (!normalizedSellerId) {
    return {
      ok: false,
      reason: "seller_required"
    };
  }
  if (normalizedAmount == null) {
    return {
      ok: false,
      reason: "invalid_amount"
    };
  }
  if (normalizedCurrency !== SALES_CREDIT_SUPPORTED_CURRENCY) {
    return {
      ok: false,
      reason: "unsupported_sales_credit_currency",
      currencyCode: normalizedCurrency,
      supportedCurrencyCode: SALES_CREDIT_SUPPORTED_CURRENCY
    };
  }
  return runInTransaction(prismaClient, async tx => {
    if (normalizedIdempotencyKey) {
      const existing = await tx.salesCreditOffset.findUnique({
        where: {
          idempotencyKey: normalizedIdempotencyKey
        }
      });
      if (existing) {
        if (existing.status !== "authorized") {
          return {
            ok: false,
            reason: "sales_credit_idempotency_key_used",
            offset: existing
          };
        }
        const expectation = validateSalesCreditOffsetExpectation(existing, {
          expectedSellerId: normalizedSellerId,
          expectedAmount: normalizedAmount,
          expectedCurrencyCode: normalizedCurrency
        });
        if (!expectation.ok) {
          return {
            ok: false,
            reason: "sales_credit_idempotency_mismatch",
            mismatchReason: expectation.reason,
            offset: existing
          };
        }
        return {
          ok: true,
          duplicate: true,
          offset: existing
        };
      }
    }
    const summary = await getSellerSalesCreditSummary({
      sellerId: normalizedSellerId,
      currencyCode: normalizedCurrency
    }, {
      prismaClient: tx,
      now
    });
    if (!summary.canUseSalesCredit) {
      return {
        ok: false,
        reason: summary.unavailableReason || "sales_credit_unavailable",
        summary
      };
    }
    if (summary.availableAmount < normalizedAmount) {
      return {
        ok: false,
        reason: "insufficient_sales_credit",
        availableAmount: summary.availableAmount,
        requestedAmount: normalizedAmount,
        summary
      };
    }
    const offset = await tx.salesCreditOffset.create({
      data: {
        sellerId: normalizedSellerId,
        amount: normalizedAmount,
        currencyCode: normalizedCurrency,
        status: "authorized",
        checkoutReference: normalizeText(checkoutReference),
        idempotencyKey: normalizedIdempotencyKey,
        expiresAt: expiresAt === null ? null : expiresAt ? new Date(expiresAt) : addMinutes(now, clampInteger(lockMinutes)),
        metadataJson
      }
    });
    return {
      ok: true,
      duplicate: false,
      offset,
      summary
    };
  });
}
export async function markSalesCreditOffsetCheckoutCreated({
  offsetId,
  draftOrderId = null,
  invoiceUrl = null,
  metadataJson = null
}, {
  prismaClient = prisma,
  now = new Date()
} = {}) {
  const normalizedOffsetId = normalizeText(offsetId);
  if (!normalizedOffsetId) {
    return {
      ok: false,
      reason: "offset_required"
    };
  }
  const offset = await prismaClient.salesCreditOffset.findUnique({
    where: {
      id: normalizedOffsetId
    }
  });
  if (!offset) {
    return {
      ok: false,
      reason: "offset_not_found"
    };
  }
  if (offset.status !== "authorized") {
    return {
      ok: true,
      duplicate: true,
      offset
    };
  }
  const existingMetadata = getSalesCreditOffsetMetadata(offset);
  const updated = await prismaClient.salesCreditOffset.update({
    where: {
      id: offset.id
    },
    data: {
      metadataJson: {
        ...existingMetadata,
        ...(isPlainObject(metadataJson) ? metadataJson : {}),
        draftOrderId: normalizeText(draftOrderId) || existingMetadata.draftOrderId || null,
        invoiceUrl: normalizeText(invoiceUrl) || existingMetadata.invoiceUrl || null,
        checkoutCreatedAt: now.toISOString()
      }
    }
  });
  return {
    ok: true,
    duplicate: false,
    offset: updated
  };
}
export async function releaseSalesCreditOffset({
  offsetId,
  reason = "released"
}, {
  prismaClient = prisma,
  now = new Date()
} = {}) {
  const normalizedOffsetId = normalizeText(offsetId);
  if (!normalizedOffsetId) {
    return {
      ok: false,
      reason: "offset_required"
    };
  }
  const offset = await prismaClient.salesCreditOffset.findUnique({
    where: {
      id: normalizedOffsetId
    }
  });
  if (!offset) {
    return {
      ok: false,
      reason: "offset_not_found"
    };
  }
  if (offset.status !== "authorized") {
    return {
      ok: true,
      duplicate: true,
      offset
    };
  }
  const updated = await prismaClient.salesCreditOffset.update({
    where: {
      id: offset.id
    },
    data: {
      status: "released",
      releasedAt: now,
      releaseReason: normalizeText(reason) || "released"
    }
  });
  return {
    ok: true,
    duplicate: false,
    offset: updated
  };
}

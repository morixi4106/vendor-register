import prisma from "../../../db.server.js";
import { DEFAULT_ORDER_CURRENCY } from "../constants.js";
import { clampInteger, normalizeLowercase, normalizeText } from "../values.js";
import { createLedgerEntry, reverseSalesCreditOffsetForRefund, runInTransaction } from "../shared.server.js";
import { findShopifyOrderLedgerEntries, getSalesCreditOffsetFromPaidEntries, getSellerOrderPaymentStatusAfterRefund, normalizeShopifyOrderId, summarizeShopifyOrderLedgerEntries, uniqueValues } from "./common.server.js";
function isMultiSellerShopifyCancelledSettlementEnabled(env = process.env) {
  return normalizeLowercase(env.MULTI_SELLER_SHOPIFY_CANCELLED_SETTLEMENT_ENABLED) === "true";
}
async function updateSellerOrderShadowForCancellation({
  shopDomain,
  shopifyOrderId,
  sellerId,
  settlementAmount
}, {
  prismaClient = prisma
} = {}) {
  if (!prismaClient?.sellerOrder?.findFirst || !prismaClient?.sellerOrder?.update) {
    return {
      ok: true,
      skipped: true,
      reason: "shadow_models_unavailable"
    };
  }
  const sellerOrder = await prismaClient.sellerOrder.findFirst({
    where: {
      shopifyOrderId,
      sellerId,
      marketplaceOrder: {
        shopDomain
      }
    },
    select: {
      id: true,
      sellerRefundAmount: true,
      sellerPayableAmount: true,
      sellerNetAmount: true,
      paymentStatus: true
    }
  });
  if (!sellerOrder?.id) {
    return {
      ok: true,
      skipped: true,
      reason: "seller_order_not_found"
    };
  }
  const nextRefundAmount = clampInteger(sellerOrder.sellerRefundAmount) + clampInteger(settlementAmount);
  const paidAmount = clampInteger(sellerOrder.sellerPayableAmount) || clampInteger(sellerOrder.sellerNetAmount);
  const nextPaymentStatus = paidAmount > 0 && nextRefundAmount >= paidAmount ? "cancelled" : getSellerOrderPaymentStatusAfterRefund({
    paidAmount,
    refundAmount: nextRefundAmount,
    fallback: sellerOrder.paymentStatus
  });
  const updatedSellerOrder = await prismaClient.sellerOrder.update({
    where: {
      id: sellerOrder.id
    },
    data: {
      sellerRefundAmount: nextRefundAmount,
      paymentStatus: nextPaymentStatus
    }
  });
  return {
    ok: true,
    sellerOrder: updatedSellerOrder,
    refundAmount: nextRefundAmount
  };
}
export async function processShopifyOrderCancelledSettlement({
  payload,
  shop
}, {
  prismaClient = prisma,
  env = process.env
} = {}) {
  const shopDomain = normalizeLowercase(shop || payload?.shop_domain || payload?.shop);
  const shopifyOrderId = normalizeShopifyOrderId(payload);
  const shopifyOrderName = normalizeText(payload?.name || payload?.order_number);
  const currencyCode = normalizeLowercase(payload?.currency || payload?.presentment_currency) || DEFAULT_ORDER_CURRENCY;
  const multiSellerCancelledSettlementEnabled = isMultiSellerShopifyCancelledSettlementEnabled(env);
  if (!shopDomain || !shopifyOrderId) {
    return {
      ok: false,
      terminal: true,
      expectedSkip: true,
      reason: "invalid_shopify_cancelled_order_payload"
    };
  }
  const existingCancellationEntry = await prismaClient.ledgerEntry.findFirst({
    where: {
      entryType: "shopify_order_cancelled",
      stripeObjectId: shopifyOrderId
    }
  });
  if (existingCancellationEntry && !multiSellerCancelledSettlementEnabled) {
    return {
      ok: true,
      duplicate: true,
      ledgerEntry: existingCancellationEntry
    };
  }
  const orderLedgerEntries = await findShopifyOrderLedgerEntries(shopifyOrderId, prismaClient);
  const paidEntries = orderLedgerEntries.filter(entry => entry?.entryType === "shopify_order_paid");
  const sellerIds = uniqueValues(paidEntries.map(entry => entry?.sellerId));
  if (sellerIds.length === 0) {
    return {
      ok: true,
      reason: "shopify_cancelled_order_not_settled",
      amount: 0,
      currencyCode
    };
  }
  if (sellerIds.length > 1 && !multiSellerCancelledSettlementEnabled) {
    return {
      ok: false,
      reason: "multi_seller_shopify_cancelled_order_unsupported",
      sellerIds
    };
  }
  if (sellerIds.length > 1) {
    const existingCancellationEntries = orderLedgerEntries.filter(entry => entry?.entryType === "shopify_order_cancelled" && entry?.stripeObjectId === shopifyOrderId);
    if (existingCancellationEntries.length > 0 || existingCancellationEntry?.stripeObjectId === shopifyOrderId) {
      return {
        ok: true,
        duplicate: true,
        multiSeller: true,
        ledgerEntries: existingCancellationEntries.length > 0 ? existingCancellationEntries : [existingCancellationEntry]
      };
    }
    const salesCreditOffset = getSalesCreditOffsetFromPaidEntries(paidEntries);
    if (salesCreditOffset?.offsetId) {
      return {
        ok: false,
        reason: "multi_seller_sales_credit_cancelled_order_unsupported",
        sellerIds
      };
    }
    const occurredAt = payload?.cancelled_at ? new Date(payload.cancelled_at) : payload?.updated_at ? new Date(payload.updated_at) : new Date();
    return runInTransaction(prismaClient, async tx => {
      const ledgerEntries = [];
      const sellerOrderShadowCancellations = [];
      let settlementAmount = 0;
      for (const sellerId of sellerIds) {
        const orderLedgerSummary = summarizeShopifyOrderLedgerEntries(orderLedgerEntries, sellerId);
        const sellerSettlementAmount = orderLedgerSummary.remainingAmount;
        if (sellerSettlementAmount <= 0) {
          continue;
        }
        const paidEntry = paidEntries.find(entry => entry?.sellerId === sellerId);
        const ledgerEntry = await createLedgerEntry({
          sellerId,
          sellerStripeAccountId: paidEntry?.sellerStripeAccountId || null,
          stripeAccountId: paidEntry?.stripeAccountId || null,
          entryType: "shopify_order_cancelled",
          stripeObjectId: shopifyOrderId,
          amount: sellerSettlementAmount,
          currencyCode,
          direction: "debit",
          description: "Shopify order cancelled",
          metadataJson: {
            shopDomain,
            shopifyOrderId,
            shopifyOrderName,
            shopifyOrderNumericId: normalizeText(payload?.id),
            cancelReason: normalizeText(payload?.cancel_reason),
            cancelledAt: normalizeText(payload?.cancelled_at),
            settlementMode: "shopify_cancelled_order_to_monthly_settlement",
            multiSellerCancelledSettlement: true,
            paidAmount: orderLedgerSummary.paidAmount,
            reversedAmountBeforeCancellation: orderLedgerSummary.reversedAmount
          },
          occurredAt
        }, {
          prismaClient: tx
        });
        const sellerOrderShadowCancellation = await updateSellerOrderShadowForCancellation({
          shopDomain,
          shopifyOrderId,
          sellerId,
          settlementAmount: sellerSettlementAmount
        }, {
          prismaClient: tx
        });
        ledgerEntries.push(ledgerEntry);
        sellerOrderShadowCancellations.push({
          sellerId,
          ...sellerOrderShadowCancellation
        });
        settlementAmount += sellerSettlementAmount;
      }
      if (ledgerEntries.length === 0) {
        return {
          ok: true,
          reason: "shopify_cancelled_order_already_reversed",
          multiSeller: true,
          sellerIds,
          amount: 0,
          currencyCode
        };
      }
      return {
        ok: true,
        duplicate: false,
        multiSeller: true,
        ledgerEntries,
        sellerIds,
        amount: settlementAmount,
        currencyCode,
        sellerOrderShadowCancellations
      };
    });
  }
  if (existingCancellationEntry) {
    return {
      ok: true,
      duplicate: true,
      ledgerEntry: existingCancellationEntry
    };
  }
  const sellerId = sellerIds[0];
  const orderLedgerSummary = summarizeShopifyOrderLedgerEntries(orderLedgerEntries, sellerId);
  const settlementAmount = orderLedgerSummary.remainingAmount;
  if (settlementAmount <= 0) {
    return {
      ok: true,
      reason: "shopify_cancelled_order_already_reversed",
      sellerId,
      amount: 0,
      currencyCode
    };
  }
  const paidEntry = paidEntries.find(entry => entry?.sellerId === sellerId);
  const salesCreditOffset = getSalesCreditOffsetFromPaidEntries(paidEntries);
  const occurredAt = payload?.cancelled_at ? new Date(payload.cancelled_at) : payload?.updated_at ? new Date(payload.updated_at) : new Date();
  return runInTransaction(prismaClient, async tx => {
    const ledgerEntry = await createLedgerEntry({
      sellerId,
      sellerStripeAccountId: paidEntry?.sellerStripeAccountId || null,
      stripeAccountId: paidEntry?.stripeAccountId || null,
      entryType: "shopify_order_cancelled",
      stripeObjectId: shopifyOrderId,
      amount: settlementAmount,
      currencyCode,
      direction: "debit",
      description: "Shopify order cancelled",
      metadataJson: {
        shopDomain,
        shopifyOrderId,
        shopifyOrderName,
        shopifyOrderNumericId: normalizeText(payload?.id),
        cancelReason: normalizeText(payload?.cancel_reason),
        cancelledAt: normalizeText(payload?.cancelled_at),
        settlementMode: "shopify_cancelled_order_to_monthly_settlement",
        paidAmount: orderLedgerSummary.paidAmount,
        reversedAmountBeforeCancellation: orderLedgerSummary.reversedAmount,
        salesCreditOffsetId: salesCreditOffset?.offsetId || null,
        salesCreditOffsetReversed: Boolean(salesCreditOffset?.offsetId)
      },
      occurredAt
    }, {
      prismaClient: tx
    });
    const salesCreditReversal = salesCreditOffset?.offsetId ? await reverseSalesCreditOffsetForRefund({
      offsetId: salesCreditOffset.offsetId,
      metadataJson: {
        shopDomain,
        shopifyOrderId,
        reversalReason: "shopify_order_cancelled"
      }
    }, {
      prismaClient: tx,
      now: occurredAt
    }) : null;
    const sellerOrderShadowCancellation = await updateSellerOrderShadowForCancellation({
      shopDomain,
      shopifyOrderId,
      sellerId,
      settlementAmount
    }, {
      prismaClient: tx
    });
    return {
      ok: true,
      duplicate: false,
      ledgerEntry,
      sellerId,
      amount: settlementAmount,
      currencyCode,
      salesCreditReversal,
      sellerOrderShadowCancellation
    };
  });
}

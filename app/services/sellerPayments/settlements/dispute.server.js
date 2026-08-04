import prisma from "../../../db.server.js";
import { DEFAULT_ORDER_CURRENCY } from "../constants.js";
import { clampInteger, moneyAmountToMinorUnits, normalizeLowercase, normalizeText } from "../values.js";
import { SELLER_REVIEW_REASON_DISPUTE, createLedgerEntry, normalizeShopifyGid, runInTransaction, setSellerReviewStatus } from "../shared.server.js";
import { SHOPIFY_ORDER_SETTLEMENT_ENTRY_TYPES, getSalesCreditOffsetFromPaidEntries, summarizeShopifyOrderLedgerEntries, uniqueValues } from "./common.server.js";
const SHOPIFY_ORDER_DISPUTE_ENTRY_TYPES = ["dispute_created", "dispute_funds_reinstated"];
const SHOPIFY_ORDER_RISK_ENTRY_TYPES = [...SHOPIFY_ORDER_SETTLEMENT_ENTRY_TYPES, ...SHOPIFY_ORDER_DISPUTE_ENTRY_TYPES];
const SHOPIFY_DISPUTE_RELEASE_STATUSES = new Set(["charge_refunded", "won"]);
function normalizeShopifyDisputeId(payload) {
  return normalizeText(payload?.admin_graphql_api_id) || normalizeShopifyGid("ShopifyPaymentsDispute", payload?.id);
}
function normalizeShopifyDisputeOrderId(payload) {
  return normalizeShopifyGid("Order", payload?.order_id) || normalizeShopifyGid("Order", payload?.order?.admin_graphql_api_id) || normalizeShopifyGid("Order", payload?.order?.id);
}
function isMultiSellerShopifyDisputeSettlementEnabled(env = process.env) {
  return normalizeLowercase(env.MULTI_SELLER_SHOPIFY_DISPUTE_SETTLEMENT_ENABLED) === "true";
}
async function updateSellerOrderShadowRiskStatus({
  shopDomain,
  shopifyOrderId,
  sellerId,
  riskStatus
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
      riskStatus: true
    }
  });
  if (!sellerOrder?.id) {
    return {
      ok: true,
      skipped: true,
      reason: "seller_order_not_found"
    };
  }
  if (sellerOrder.riskStatus === riskStatus) {
    return {
      ok: true,
      sellerOrder,
      unchanged: true
    };
  }
  const updatedSellerOrder = await prismaClient.sellerOrder.update({
    where: {
      id: sellerOrder.id
    },
    data: {
      riskStatus
    }
  });
  return {
    ok: true,
    sellerOrder: updatedSellerOrder
  };
}
async function findShopifyOrderRiskLedgerEntries(shopifyOrderId, prismaClient) {
  if (!shopifyOrderId) {
    return [];
  }
  return prismaClient.ledgerEntry.findMany({
    where: {
      entryType: {
        in: SHOPIFY_ORDER_RISK_ENTRY_TYPES
      },
      OR: [{
        stripeObjectId: shopifyOrderId
      }, {
        metadataJson: {
          path: ["shopifyOrderId"],
          equals: shopifyOrderId
        }
      }]
    }
  });
}
function summarizeShopifyOrderRiskLedgerEntries(entries, sellerId = null) {
  const settlementSummary = summarizeShopifyOrderLedgerEntries(entries, sellerId);
  const sellerLedgerEntries = sellerId ? entries.filter(entry => entry?.sellerId === sellerId) : entries;
  const disputeHoldAmount = sellerLedgerEntries.filter(entry => entry?.entryType === "dispute_created").reduce((total, entry) => total + clampInteger(entry?.amount), 0);
  const disputeReleasedAmount = sellerLedgerEntries.filter(entry => entry?.entryType === "dispute_funds_reinstated").reduce((total, entry) => total + clampInteger(entry?.amount), 0);
  const disputeHeldAmount = Math.max(0, disputeHoldAmount - disputeReleasedAmount);
  return {
    ...settlementSummary,
    disputeHeldAmount,
    remainingHoldableAmount: Math.max(0, settlementSummary.remainingAmount - disputeHeldAmount)
  };
}
function allocateAmountByWeight(totalAmount, weightedItems) {
  const targetAmount = clampInteger(totalAmount);
  const items = Array.isArray(weightedItems) ? weightedItems.map((item, index) => ({
    ...item,
    index,
    weight: clampInteger(item?.weight)
  })) : [];
  const totalWeight = items.reduce((total, item) => total + item.weight, 0);
  if (targetAmount <= 0 || totalWeight <= 0) {
    return items.map(item => ({
      ...item,
      amount: 0
    }));
  }
  const cappedTargetAmount = Math.min(targetAmount, totalWeight);
  let allocatedAmount = 0;
  const allocations = items.map(item => {
    const exactAmount = cappedTargetAmount * item.weight / totalWeight;
    const amount = Math.min(item.weight, Math.floor(exactAmount));
    allocatedAmount += amount;
    return {
      ...item,
      amount,
      remainder: exactAmount - amount
    };
  });
  let remainingAmount = cappedTargetAmount - allocatedAmount;
  const byRemainder = [...allocations].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const allocation of byRemainder) {
    if (remainingAmount <= 0) {
      break;
    }
    if (allocation.amount >= allocation.weight) {
      continue;
    }
    allocation.amount += 1;
    remainingAmount -= 1;
  }
  return allocations.sort((a, b) => a.index - b.index).map(({
    remainder: _remainder,
    index: _index,
    ...allocation
  }) => allocation);
}
export async function processShopifyDisputeSettlement({
  payload,
  shop,
  topic
}, {
  prismaClient = prisma,
  env = process.env
} = {}) {
  const shopDomain = normalizeLowercase(shop || payload?.shop_domain || payload?.shop);
  const shopifyDisputeId = normalizeShopifyDisputeId(payload);
  const shopifyOrderId = normalizeShopifyDisputeOrderId(payload);
  const disputeStatus = normalizeLowercase(payload?.status);
  const disputeType = normalizeLowercase(payload?.type);
  const disputeReason = normalizeLowercase(payload?.reason);
  const normalizedTopic = normalizeText(topic) || "disputes/create";
  const multiSellerDisputeSettlementEnabled = isMultiSellerShopifyDisputeSettlementEnabled(env);
  if (!shopDomain || !shopifyDisputeId || !shopifyOrderId) {
    return {
      ok: false,
      terminal: true,
      expectedSkip: true,
      reason: "invalid_shopify_dispute_payload"
    };
  }
  const orderLedgerEntries = await findShopifyOrderRiskLedgerEntries(shopifyOrderId, prismaClient);
  const paidEntries = orderLedgerEntries.filter(entry => entry?.entryType === "shopify_order_paid");
  const sellerIds = uniqueValues(paidEntries.map(entry => entry?.sellerId));
  if (sellerIds.length === 0) {
    return {
      ok: true,
      reason: "shopify_dispute_order_not_settled",
      amount: 0
    };
  }
  if (sellerIds.length > 1 && !multiSellerDisputeSettlementEnabled) {
    return {
      ok: false,
      reason: "multi_seller_shopify_dispute_unsupported",
      sellerIds
    };
  }
  const paidEntry = paidEntries[0];
  const currencyCode = normalizeLowercase(payload?.currency) || normalizeLowercase(paidEntry?.currencyCode) || DEFAULT_ORDER_CURRENCY;
  const requestedDisputeAmount = moneyAmountToMinorUnits(payload?.amount, currencyCode);
  const occurredAt = payload?.initiated_at ? new Date(payload.initiated_at) : payload?.finalized_on ? new Date(payload.finalized_on) : new Date();
  if (sellerIds.length > 1) {
    const salesCreditOffset = getSalesCreditOffsetFromPaidEntries(paidEntries);
    if (salesCreditOffset?.offsetId) {
      return {
        ok: false,
        reason: "multi_seller_sales_credit_dispute_unsupported",
        sellerIds
      };
    }
    if (SHOPIFY_DISPUTE_RELEASE_STATUSES.has(disputeStatus)) {
      const existingReleaseEntries = orderLedgerEntries.filter(entry => entry?.entryType === "dispute_funds_reinstated" && entry?.stripeObjectId === shopifyDisputeId);
      if (existingReleaseEntries.length > 0) {
        return {
          ok: true,
          duplicate: true,
          multiSeller: true,
          ledgerEntries: existingReleaseEntries
        };
      }
      const sellerRiskSummaries = sellerIds.map(sellerId => ({
        sellerId,
        paidEntry: paidEntries.find(entry => entry?.sellerId === sellerId),
        riskSummary: summarizeShopifyOrderRiskLedgerEntries(orderLedgerEntries, sellerId)
      }));
      const totalHeldAmount = sellerRiskSummaries.reduce((total, sellerRiskSummary) => total + sellerRiskSummary.riskSummary.disputeHeldAmount, 0);
      const targetReleaseAmount = Math.min(requestedDisputeAmount || totalHeldAmount, totalHeldAmount);
      if (targetReleaseAmount <= 0) {
        return {
          ok: true,
          reason: "shopify_dispute_no_held_funds_to_release",
          multiSeller: true,
          sellerIds,
          amount: 0,
          currencyCode
        };
      }
      const allocations = allocateAmountByWeight(targetReleaseAmount, sellerRiskSummaries.map(sellerRiskSummary => ({
        ...sellerRiskSummary,
        weight: sellerRiskSummary.riskSummary.disputeHeldAmount
      }))).filter(allocation => allocation.amount > 0);
      return runInTransaction(prismaClient, async tx => {
        const ledgerEntries = [];
        const sellerOrderShadowRisks = [];
        for (const allocation of allocations) {
          const ledgerEntry = await createLedgerEntry({
            sellerId: allocation.sellerId,
            sellerStripeAccountId: allocation.paidEntry?.sellerStripeAccountId || null,
            stripeAccountId: allocation.paidEntry?.stripeAccountId || null,
            entryType: "dispute_funds_reinstated",
            stripeObjectId: shopifyDisputeId,
            amount: allocation.amount,
            currencyCode,
            direction: "credit",
            description: "Shopify dispute funds released",
            metadataJson: {
              shopDomain,
              shopifyDisputeId,
              shopifyDisputeNumericId: normalizeText(payload?.id),
              shopifyOrderId,
              shopifyOrderNumericId: normalizeText(payload?.order_id),
              disputeType,
              disputeStatus,
              disputeReason,
              networkReasonCode: normalizeText(payload?.network_reason_code),
              evidenceDueBy: normalizeText(payload?.evidence_due_by),
              evidenceSentOn: normalizeText(payload?.evidence_sent_on),
              finalizedOn: normalizeText(payload?.finalized_on),
              disputeEventType: normalizedTopic,
              settlementMode: "shopify_dispute_to_monthly_settlement",
              multiSellerDisputeSettlement: true,
              requestedDisputeAmount,
              totalHeldAmountBeforeRelease: totalHeldAmount,
              sellerHeldAmountBeforeRelease: allocation.riskSummary.disputeHeldAmount
            },
            occurredAt
          }, {
            prismaClient: tx
          });
          const sellerOrderShadowRisk = await updateSellerOrderShadowRiskStatus({
            shopDomain,
            shopifyOrderId,
            sellerId: allocation.sellerId,
            riskStatus: "normal"
          }, {
            prismaClient: tx
          });
          ledgerEntries.push(ledgerEntry);
          sellerOrderShadowRisks.push({
            sellerId: allocation.sellerId,
            ...sellerOrderShadowRisk
          });
        }
        return {
          ok: true,
          duplicate: false,
          multiSeller: true,
          ledgerEntries,
          sellerIds,
          amount: ledgerEntries.reduce((total, entry) => total + clampInteger(entry?.amount), 0),
          currencyCode,
          sellerOrderShadowRisks
        };
      });
    }
    const existingHoldEntries = orderLedgerEntries.filter(entry => entry?.entryType === "dispute_created" && entry?.stripeObjectId === shopifyDisputeId);
    if (existingHoldEntries.length > 0) {
      return {
        ok: true,
        duplicate: true,
        multiSeller: true,
        ledgerEntries: existingHoldEntries
      };
    }
    const sellerRiskSummaries = sellerIds.map(sellerId => ({
      sellerId,
      paidEntry: paidEntries.find(entry => entry?.sellerId === sellerId),
      riskSummary: summarizeShopifyOrderRiskLedgerEntries(orderLedgerEntries, sellerId)
    }));
    const totalHoldableAmount = sellerRiskSummaries.reduce((total, sellerRiskSummary) => total + sellerRiskSummary.riskSummary.remainingHoldableAmount, 0);
    const targetHoldAmount = Math.min(requestedDisputeAmount || totalHoldableAmount, totalHoldableAmount);
    if (targetHoldAmount <= 0) {
      return {
        ok: true,
        reason: "shopify_dispute_order_already_reversed_or_held",
        multiSeller: true,
        sellerIds,
        amount: 0,
        currencyCode
      };
    }
    const allocations = allocateAmountByWeight(targetHoldAmount, sellerRiskSummaries.map(sellerRiskSummary => ({
      ...sellerRiskSummary,
      weight: sellerRiskSummary.riskSummary.remainingHoldableAmount
    }))).filter(allocation => allocation.amount > 0);
    return runInTransaction(prismaClient, async tx => {
      const ledgerEntries = [];
      const sellerOrderShadowRisks = [];
      for (const allocation of allocations) {
        await setSellerReviewStatus({
          sellerId: allocation.sellerId,
          reason: SELLER_REVIEW_REASON_DISPUTE,
          changedBy: `shopify.${normalizedTopic}`
        }, {
          prismaClient: tx
        });
        const ledgerEntry = await createLedgerEntry({
          sellerId: allocation.sellerId,
          sellerStripeAccountId: allocation.paidEntry?.sellerStripeAccountId || null,
          stripeAccountId: allocation.paidEntry?.stripeAccountId || null,
          entryType: "dispute_created",
          stripeObjectId: shopifyDisputeId,
          amount: allocation.amount,
          currencyCode,
          direction: "debit",
          description: "Shopify dispute opened",
          metadataJson: {
            shopDomain,
            shopifyDisputeId,
            shopifyDisputeNumericId: normalizeText(payload?.id),
            shopifyOrderId,
            shopifyOrderNumericId: normalizeText(payload?.order_id),
            disputeType,
            disputeStatus,
            disputeReason,
            networkReasonCode: normalizeText(payload?.network_reason_code),
            evidenceDueBy: normalizeText(payload?.evidence_due_by),
            evidenceSentOn: normalizeText(payload?.evidence_sent_on),
            finalizedOn: normalizeText(payload?.finalized_on),
            disputeEventType: normalizedTopic,
            settlementMode: "shopify_dispute_to_monthly_settlement",
            multiSellerDisputeSettlement: true,
            requestedDisputeAmount,
            totalHoldableAmountBeforeDispute: totalHoldableAmount,
            sellerHoldableAmountBeforeDispute: allocation.riskSummary.remainingHoldableAmount
          },
          occurredAt
        }, {
          prismaClient: tx
        });
        const sellerOrderShadowRisk = await updateSellerOrderShadowRiskStatus({
          shopDomain,
          shopifyOrderId,
          sellerId: allocation.sellerId,
          riskStatus: "disputed"
        }, {
          prismaClient: tx
        });
        ledgerEntries.push(ledgerEntry);
        sellerOrderShadowRisks.push({
          sellerId: allocation.sellerId,
          ...sellerOrderShadowRisk
        });
      }
      return {
        ok: true,
        duplicate: false,
        multiSeller: true,
        ledgerEntries,
        sellerIds,
        amount: ledgerEntries.reduce((total, entry) => total + clampInteger(entry?.amount), 0),
        currencyCode,
        sellerOrderShadowRisks
      };
    });
  }
  const sellerId = sellerIds[0];
  const singleSellerPaidEntry = paidEntries.find(entry => entry?.sellerId === sellerId);
  const orderRiskSummary = summarizeShopifyOrderRiskLedgerEntries(orderLedgerEntries, sellerId);
  const metadataJson = {
    shopDomain,
    shopifyDisputeId,
    shopifyDisputeNumericId: normalizeText(payload?.id),
    shopifyOrderId,
    shopifyOrderNumericId: normalizeText(payload?.order_id),
    disputeType,
    disputeStatus,
    disputeReason,
    networkReasonCode: normalizeText(payload?.network_reason_code),
    evidenceDueBy: normalizeText(payload?.evidence_due_by),
    evidenceSentOn: normalizeText(payload?.evidence_sent_on),
    finalizedOn: normalizeText(payload?.finalized_on),
    disputeEventType: normalizedTopic,
    settlementMode: "shopify_dispute_to_monthly_settlement"
  };
  if (SHOPIFY_DISPUTE_RELEASE_STATUSES.has(disputeStatus)) {
    const existingReleaseEntry = await prismaClient.ledgerEntry.findFirst({
      where: {
        entryType: "dispute_funds_reinstated",
        stripeObjectId: shopifyDisputeId
      }
    });
    if (existingReleaseEntry) {
      return {
        ok: true,
        duplicate: true,
        ledgerEntry: existingReleaseEntry
      };
    }
    const settlementAmount = Math.min(requestedDisputeAmount || orderRiskSummary.disputeHeldAmount, orderRiskSummary.disputeHeldAmount);
    if (settlementAmount <= 0) {
      return {
        ok: true,
        reason: "shopify_dispute_no_held_funds_to_release",
        sellerId,
        amount: 0,
        currencyCode
      };
    }
    const ledgerEntry = await createLedgerEntry({
      sellerId,
      sellerStripeAccountId: singleSellerPaidEntry?.sellerStripeAccountId || null,
      stripeAccountId: singleSellerPaidEntry?.stripeAccountId || null,
      entryType: "dispute_funds_reinstated",
      stripeObjectId: shopifyDisputeId,
      amount: settlementAmount,
      currencyCode,
      direction: "credit",
      description: "Shopify dispute funds released",
      metadataJson: {
        ...metadataJson,
        heldAmountBeforeRelease: orderRiskSummary.disputeHeldAmount
      },
      occurredAt
    }, {
      prismaClient
    });
    const sellerOrderShadowRisk = await updateSellerOrderShadowRiskStatus({
      shopDomain,
      shopifyOrderId,
      sellerId,
      riskStatus: "normal"
    }, {
      prismaClient
    });
    return {
      ok: true,
      duplicate: false,
      ledgerEntry,
      sellerId,
      amount: settlementAmount,
      currencyCode,
      sellerOrderShadowRisk
    };
  }
  await setSellerReviewStatus({
    sellerId,
    reason: SELLER_REVIEW_REASON_DISPUTE,
    changedBy: `shopify.${normalizedTopic}`
  }, {
    prismaClient
  });
  const existingHoldEntry = await prismaClient.ledgerEntry.findFirst({
    where: {
      entryType: "dispute_created",
      stripeObjectId: shopifyDisputeId
    }
  });
  if (existingHoldEntry) {
    return {
      ok: true,
      duplicate: true,
      ledgerEntry: existingHoldEntry
    };
  }
  const settlementAmount = Math.min(requestedDisputeAmount || orderRiskSummary.remainingHoldableAmount, orderRiskSummary.remainingHoldableAmount);
  if (settlementAmount <= 0) {
    return {
      ok: true,
      reason: "shopify_dispute_order_already_reversed_or_held",
      sellerId,
      amount: 0,
      currencyCode
    };
  }
  const ledgerEntry = await createLedgerEntry({
    sellerId,
    sellerStripeAccountId: singleSellerPaidEntry?.sellerStripeAccountId || null,
    stripeAccountId: singleSellerPaidEntry?.stripeAccountId || null,
    entryType: "dispute_created",
    stripeObjectId: shopifyDisputeId,
    amount: settlementAmount,
    currencyCode,
    direction: "debit",
    description: "Shopify dispute opened",
    metadataJson: {
      ...metadataJson,
      remainingHoldableAmountBeforeDispute: orderRiskSummary.remainingHoldableAmount
    },
    occurredAt
  }, {
    prismaClient
  });
  const sellerOrderShadowRisk = await updateSellerOrderShadowRiskStatus({
    shopDomain,
    shopifyOrderId,
    sellerId,
    riskStatus: "disputed"
  }, {
    prismaClient
  });
  return {
    ok: true,
    duplicate: false,
    ledgerEntry,
    sellerId,
    amount: settlementAmount,
    currencyCode,
    sellerOrderShadowRisk
  };
}

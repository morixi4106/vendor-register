import prisma from "../../../db.server.js";
import { DEFAULT_ORDER_CURRENCY } from "../constants.js";
import { calculateSellerPayoutableLedgerBalance, getLedgerEntryMetadata, SELLER_PAYOUT_LEDGER_ENTRY_SIGNS } from "../salesCreditCalculations.js";
import { clampInteger, normalizeLowercase, normalizeText } from "../values.js";
import { SHOPIFY_ORDER_REVERSAL_ENTRY_TYPES, createLedgerEntry, normalizeShopifyGid, runInTransaction } from "../shared.server.js";
const LEDGER_REPAIR_SCOPE_NEGATIVE_PAYOUTABLE_BALANCE = "negative_payoutable_balance";
const LEDGER_REPAIR_SCOPE_SHOPIFY_ORDER_REVERSAL_OVERAGE = "shopify_order_reversal_overage";
function getLedgerEntryShopifyOrderId(entry) {
  const metadata = getLedgerEntryMetadata(entry);
  const metadataOrderId = normalizeText(metadata.shopifyOrderId);
  if (metadataOrderId) {
    return metadataOrderId;
  }
  if (entry?.entryType === "shopify_order_paid" || entry?.entryType === "shopify_order_cancelled") {
    return normalizeShopifyGid("Order", entry?.stripeObjectId) || normalizeText(entry?.stripeObjectId);
  }
  return "";
}
function getLedgerEntryShopifyOrderName(entry) {
  return normalizeText(getLedgerEntryMetadata(entry).shopifyOrderName);
}
function getLedgerEntryRepairScope(entry) {
  return normalizeText(getLedgerEntryMetadata(entry).repairScope);
}
function buildSellerOrderReversalOverageRepairCandidates(seller, currencyCode) {
  const groups = new Map();
  for (const entry of Array.isArray(seller?.ledgerEntries) ? seller.ledgerEntries : []) {
    const shopifyOrderId = getLedgerEntryShopifyOrderId(entry);
    if (!shopifyOrderId) {
      continue;
    }
    const group = groups.get(shopifyOrderId) || {
      sellerId: seller.id,
      shopifyOrderId,
      shopifyOrderName: "",
      paidAmount: 0,
      reversedAmount: 0,
      repairedAmount: 0,
      latestLedgerEntry: null
    };
    if (!group.shopifyOrderName) {
      group.shopifyOrderName = getLedgerEntryShopifyOrderName(entry);
    }
    if (!group.latestLedgerEntry) {
      group.latestLedgerEntry = entry;
    }
    if (entry.entryType === "shopify_order_paid") {
      group.paidAmount += clampInteger(entry.amount);
    } else if (SHOPIFY_ORDER_REVERSAL_ENTRY_TYPES.includes(entry.entryType)) {
      group.reversedAmount += clampInteger(entry.amount);
    } else if (entry.entryType === "ledger_adjustment" && getLedgerEntryRepairScope(entry) === LEDGER_REPAIR_SCOPE_SHOPIFY_ORDER_REVERSAL_OVERAGE) {
      group.repairedAmount += clampInteger(entry.amount);
    }
    groups.set(shopifyOrderId, group);
  }
  return Array.from(groups.values()).map(group => {
    const repairAmount = group.reversedAmount - group.paidAmount - group.repairedAmount;
    if (repairAmount <= 0) {
      return null;
    }
    return {
      sellerId: seller.id,
      sellerStatus: seller.status,
      vendorStoreName: seller.vendor?.vendorStore?.storeName || seller.vendor?.storeName || "-",
      isTestStore: Boolean(seller.vendor?.vendorStore?.isTestStore),
      currencyCode,
      repairScope: LEDGER_REPAIR_SCOPE_SHOPIFY_ORDER_REVERSAL_OVERAGE,
      repairAmount,
      payoutableLedgerBalance: null,
      reason: "shopify_order_reversal_overage",
      shopifyOrderId: group.shopifyOrderId,
      shopifyOrderName: group.shopifyOrderName,
      paidAmount: group.paidAmount,
      reversedAmount: group.reversedAmount,
      repairedAmount: group.repairedAmount,
      latestLedgerEntry: group.latestLedgerEntry
    };
  }).filter(Boolean);
}
export async function listSellerLedgerRepairCandidates({
  currencyCode = DEFAULT_ORDER_CURRENCY
} = {}, {
  prismaClient = prisma
} = {}) {
  const normalizedCurrency = normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;
  const payoutEntryTypes = Object.keys(SELLER_PAYOUT_LEDGER_ENTRY_SIGNS);
  const sellers = await prismaClient.seller.findMany({
    where: {
      sellerLegalRole: "MARKETPLACE_SELLER"
    },
    orderBy: [{
      createdAt: "desc"
    }],
    include: {
      vendor: {
        include: {
          vendorStore: true
        }
      },
      ledgerEntries: {
        where: {
          currencyCode: normalizedCurrency,
          entryType: {
            in: payoutEntryTypes
          }
        },
        select: {
          id: true,
          entryType: true,
          amount: true,
          currencyCode: true,
          stripeObjectId: true,
          metadataJson: true,
          occurredAt: true,
          createdAt: true
        },
        orderBy: [{
          occurredAt: "desc"
        }, {
          createdAt: "desc"
        }]
      }
    }
  });
  return sellers.flatMap(seller => {
    const payoutableLedgerBalance = calculateSellerPayoutableLedgerBalance(seller.ledgerEntries);
    const orderRepairCandidates = buildSellerOrderReversalOverageRepairCandidates(seller, normalizedCurrency);
    const orderRepairTotal = orderRepairCandidates.reduce((total, candidate) => total + clampInteger(candidate.repairAmount), 0);
    const remainingNegativeBalance = Math.min(0, payoutableLedgerBalance + orderRepairTotal);
    const candidates = [...orderRepairCandidates];
    if (remainingNegativeBalance < 0) {
      candidates.push({
        sellerId: seller.id,
        sellerStatus: seller.status,
        vendorStoreName: seller.vendor?.vendorStore?.storeName || seller.vendor?.storeName || "-",
        isTestStore: Boolean(seller.vendor?.vendorStore?.isTestStore),
        currencyCode: normalizedCurrency,
        repairScope: LEDGER_REPAIR_SCOPE_NEGATIVE_PAYOUTABLE_BALANCE,
        payoutableLedgerBalance: remainingNegativeBalance,
        repairAmount: Math.abs(remainingNegativeBalance),
        reason: "negative_payoutable_ledger_balance",
        latestLedgerEntry: seller.ledgerEntries[0] || null
      });
    }
    return candidates;
  });
}
export async function repairSellerNegativeLedgerBalance({
  sellerId,
  currencyCode = DEFAULT_ORDER_CURRENCY,
  repairedBy = "admin",
  repairedByJson = null,
  reason = "negative_payoutable_ledger_balance",
  repairScope = LEDGER_REPAIR_SCOPE_NEGATIVE_PAYOUTABLE_BALANCE,
  shopifyOrderId = ""
}, {
  prismaClient = prisma,
  now = new Date()
} = {}) {
  const normalizedSellerId = normalizeText(sellerId);
  const normalizedCurrency = normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;
  const normalizedRepairScope = normalizeText(repairScope) || LEDGER_REPAIR_SCOPE_NEGATIVE_PAYOUTABLE_BALANCE;
  const normalizedShopifyOrderId = normalizeText(shopifyOrderId);
  if (!normalizedSellerId) {
    return {
      ok: false,
      reason: "seller_not_found"
    };
  }
  return runInTransaction(prismaClient, async tx => {
    const seller = await tx.seller.findUnique({
      where: {
        id: normalizedSellerId
      },
      include: {
        vendor: true,
        stripeAccount: true
      }
    });
    if (!seller) {
      return {
        ok: false,
        reason: "seller_not_found"
      };
    }
    const entries = await tx.ledgerEntry.findMany({
      where: {
        sellerId: normalizedSellerId,
        currencyCode: normalizedCurrency,
        entryType: {
          in: Object.keys(SELLER_PAYOUT_LEDGER_ENTRY_SIGNS)
        }
      },
      select: {
        id: true,
        entryType: true,
        amount: true,
        stripeObjectId: true,
        metadataJson: true
      }
    });
    const payoutableLedgerBalance = calculateSellerPayoutableLedgerBalance(entries);
    let repairAmount = 0;
    let repairMetadata = {};
    if (normalizedRepairScope === LEDGER_REPAIR_SCOPE_SHOPIFY_ORDER_REVERSAL_OVERAGE) {
      if (!normalizedShopifyOrderId) {
        return {
          ok: false,
          reason: "shopify_order_id_missing"
        };
      }
      const orderEntries = entries.filter(entry => getLedgerEntryShopifyOrderId(entry) === normalizedShopifyOrderId);
      const paidAmount = orderEntries.filter(entry => entry?.entryType === "shopify_order_paid").reduce((total, entry) => total + clampInteger(entry?.amount), 0);
      const reversedAmount = orderEntries.filter(entry => SHOPIFY_ORDER_REVERSAL_ENTRY_TYPES.includes(entry?.entryType)).reduce((total, entry) => total + clampInteger(entry?.amount), 0);
      const repairedAmount = orderEntries.filter(entry => entry?.entryType === "ledger_adjustment" && getLedgerEntryRepairScope(entry) === LEDGER_REPAIR_SCOPE_SHOPIFY_ORDER_REVERSAL_OVERAGE).reduce((total, entry) => total + clampInteger(entry?.amount), 0);
      repairAmount = Math.max(0, reversedAmount - paidAmount - repairedAmount);
      repairMetadata = {
        shopifyOrderId: normalizedShopifyOrderId,
        shopifyOrderName: orderEntries.map(getLedgerEntryShopifyOrderName).find(Boolean) || null,
        paidAmount,
        reversedAmount,
        alreadyRepairedAmount: repairedAmount
      };
      if (repairAmount <= 0) {
        return {
          ok: true,
          repaired: false,
          reason: "no_reversal_overage",
          sellerId: normalizedSellerId,
          amount: 0,
          currencyCode: normalizedCurrency,
          payoutableLedgerBalance
        };
      }
    } else {
      repairAmount = Math.abs(Math.min(0, payoutableLedgerBalance));
      if (repairAmount <= 0) {
        return {
          ok: true,
          repaired: false,
          reason: "no_negative_balance",
          sellerId: normalizedSellerId,
          amount: 0,
          currencyCode: normalizedCurrency,
          payoutableLedgerBalance
        };
      }
    }
    const ledgerEntry = await createLedgerEntry({
      sellerId: normalizedSellerId,
      sellerStripeAccountId: seller.stripeAccount?.id || null,
      stripeAccountId: seller.stripeAccount?.stripeAccountId || null,
      entryType: "ledger_adjustment",
      stripeObjectId: `ledger-repair:${normalizedSellerId}:${normalizedCurrency}:${now.getTime()}`,
      amount: repairAmount,
      currencyCode: normalizedCurrency,
      direction: "credit",
      description: "Admin ledger repair",
      metadataJson: {
        repairReason: normalizeText(reason),
        repairedBy: normalizeText(repairedBy),
        repairedByJson: repairedByJson || null,
        previousPayoutableLedgerBalance: payoutableLedgerBalance,
        repairAmount,
        repairScope: normalizedRepairScope,
        ...repairMetadata
      },
      occurredAt: now
    }, {
      prismaClient: tx
    });
    return {
      ok: true,
      repaired: true,
      ledgerEntry,
      sellerId: normalizedSellerId,
      amount: repairAmount,
      currencyCode: normalizedCurrency,
      previousPayoutableLedgerBalance: payoutableLedgerBalance,
      nextPayoutableLedgerBalance: normalizedRepairScope === LEDGER_REPAIR_SCOPE_NEGATIVE_PAYOUTABLE_BALANCE ? 0 : payoutableLedgerBalance + repairAmount
    };
  });
}

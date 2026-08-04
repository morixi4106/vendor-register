import { createRequire } from "node:module";
import Stripe from "stripe";
import isoCountries from "i18n-iso-countries";
import prisma from "../../db.server.js";
import { formatMoney } from "../../utils/money.js";
import { isMarketplaceSeller } from "../../utils/sellerRoles.js";
import { DEFAULT_ORDER_CURRENCY } from "./constants.js";
import { calculateSellerSalesCreditAvailability, SALES_CREDIT_OFFSET_LOCK_STATUSES, SALES_CREDIT_PAYOUT_LOCK_STATUSES, SELLER_SALES_CREDIT_ENTRY_SIGNS } from "./salesCreditCalculations.js";
import { isPlainObject, normalizeLowercase, normalizeText, normalizeUppercase, toPositiveInteger } from "./values.js";
export const require = createRequire(import.meta.url);
export const jaLocale = require("i18n-iso-countries/langs/ja.json");
isoCountries.registerLocale(jaLocale);
export const SELLER_REVIEW_REASON_DISPUTE = "dispute_review_required";
export const SHOPIFY_ORDER_REVERSAL_ENTRY_TYPES = ["refund", "shopify_order_cancelled"];
export let stripeClientSingleton = null;
export function getSalesCreditOffsetMetadata(offset) {
  return isPlainObject(offset?.metadataJson) ? offset.metadataJson : {};
}
export function validateSalesCreditOffsetExpectation(offset, {
  expectedSellerId = null,
  expectedAmount = null,
  expectedCurrencyCode = null,
  expectedTargetSellerId = null
} = {}) {
  const normalizedSellerId = normalizeText(expectedSellerId);
  const normalizedAmount = toPositiveInteger(expectedAmount);
  const normalizedCurrencyCode = normalizeLowercase(expectedCurrencyCode);
  const normalizedTargetSellerId = normalizeText(expectedTargetSellerId);
  if (normalizedSellerId && offset.sellerId !== normalizedSellerId) {
    return {
      ok: false,
      reason: "sales_credit_offset_seller_mismatch"
    };
  }
  if (normalizedAmount != null && offset.amount !== normalizedAmount) {
    return {
      ok: false,
      reason: "sales_credit_offset_amount_mismatch"
    };
  }
  if (normalizedCurrencyCode && normalizeLowercase(offset.currencyCode) !== normalizedCurrencyCode) {
    return {
      ok: false,
      reason: "sales_credit_offset_currency_mismatch"
    };
  }
  if (normalizedTargetSellerId) {
    const metadataTargetSellerId = normalizeText(getSalesCreditOffsetMetadata(offset).targetSellerId);
    if (metadataTargetSellerId && metadataTargetSellerId !== normalizedTargetSellerId) {
      return {
        ok: false,
        reason: "sales_credit_offset_target_mismatch"
      };
    }
  }
  return {
    ok: true
  };
}
export async function runInTransaction(prismaClient, callback) {
  if (typeof prismaClient?.$transaction === "function") {
    return prismaClient.$transaction(callback);
  }
  return callback(prismaClient);
}
export function normalizeShopifyGid(kind, value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith(`gid://shopify/${kind}/`)) {
    return normalized;
  }
  if (/^\d+$/.test(normalized)) {
    return `gid://shopify/${kind}/${normalized}`;
  }
  return normalized;
}
export function getStripeSecretKey() {
  const secretKey = normalizeText(process.env.STRIPE_SECRET_KEY);
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY_MISSING");
  }
  return secretKey;
}
export function getStripePublishableKey() {
  return normalizeText(process.env.STRIPE_PUBLISHABLE_KEY);
}
export function getStripeClient() {
  if (!stripeClientSingleton) {
    stripeClientSingleton = new Stripe(getStripeSecretKey());
  }
  return stripeClientSingleton;
}
export function getConfiguredSellerPayoutProvider(env = process.env) {
  return normalizeLowercase(env.SELLER_PAYOUT_PROVIDER) === "wise" ? "wise" : "manual";
}
export function createPayoutRunStatusLabel(status) {
  switch (status) {
    case "draft":
      return "下書き";
    case "approved":
      return "承認済み";
    case "processing":
      return "送金処理中";
    case "reconciliation_required":
      return "照合確認が必要";
    case "executed":
      return "実行済み";
    case "returned":
      return "返金済み";
    case "failed":
      return "失敗";
    default:
      return status || "-";
  }
}
export function createSellerVerificationStatusLabel(status) {
  switch (status) {
    case "VERIFIED":
      return "確認済み";
    case "PHONE_REQUIRED":
      return "電話確認待ち";
    case "PHONE_VERIFIED":
      return "電話確認済み";
    case "DOCUMENT_REQUIRED":
      return "本人確認書類待ち";
    case "DOCUMENT_PENDING":
      return "本人確認中";
    case "REJECTED":
      return "差し戻し";
    case "SUSPENDED":
      return "停止中";
    case "NONE":
    default:
      return "未確認";
  }
}
export function createDocumentVerificationStatusLabel(status) {
  switch (status) {
    case "VERIFIED":
      return "確認済み";
    case "PENDING":
      return "確認中";
    case "REJECTED":
      return "差し戻し";
    case "NONE":
    default:
      return "未確認";
  }
}
export function createSellerEuStatusLabel(status) {
  switch (status) {
    case "SELF_CERT_REQUIRED":
      return "自己申告待ち";
    case "PHONE_REQUIRED":
      return "電話確認待ち";
    case "ALLOWED_UNDER_SMALL_PLATFORM_POLICY":
      return "限定許可";
    case "FULL_KYBC_REQUIRED":
      return "KYBC待ち";
    case "FULL_KYBC_APPROVED":
      return "EU販売確認済み";
    case "SUSPENDED":
      return "停止中";
    case "DISABLED":
    default:
      return "EU販売OFF";
  }
}
export function serializeStripeAccountSummary(stripeAccount) {
  if (!stripeAccount) {
    return null;
  }
  return {
    id: stripeAccount.id,
    sellerId: stripeAccount.sellerId,
    stripeAccountId: stripeAccount.stripeAccountId,
    countryCode: stripeAccount.countryCode || null,
    defaultCurrency: stripeAccount.defaultCurrency || null,
    detailsSubmitted: Boolean(stripeAccount.detailsSubmitted),
    chargesEnabled: Boolean(stripeAccount.chargesEnabled),
    payoutsEnabled: Boolean(stripeAccount.payoutsEnabled),
    payoutSchedule: stripeAccount.payoutSchedule || "manual",
    dashboardType: stripeAccount.dashboardType || "none",
    onboardingCompletedAt: stripeAccount.onboardingCompletedAt || null,
    updatedAt: stripeAccount.updatedAt
  };
}
export function serializePayoutRecipientSummary(payoutRecipient) {
  if (!payoutRecipient) {
    return null;
  }
  return {
    id: payoutRecipient.id,
    sellerId: payoutRecipient.sellerId,
    provider: payoutRecipient.provider || "wise",
    status: payoutRecipient.status || "pending",
    countryCode: payoutRecipient.countryCode || null,
    currencyCode: payoutRecipient.currencyCode || DEFAULT_ORDER_CURRENCY,
    legalType: payoutRecipient.legalType || null,
    accountHolderName: payoutRecipient.accountHolderName || null,
    wiseProfileId: payoutRecipient.wiseProfileId || null,
    wiseRecipientId: payoutRecipient.wiseRecipientId || null,
    accountSummary: payoutRecipient.accountSummary || null,
    longAccountSummary: payoutRecipient.longAccountSummary || null,
    lastSyncedAt: payoutRecipient.lastSyncedAt || null,
    createdAt: payoutRecipient.createdAt,
    updatedAt: payoutRecipient.updatedAt
  };
}
export function isActivePayoutRecipient(payoutRecipient) {
  return Boolean(payoutRecipient && payoutRecipient.status === "active" && (payoutRecipient.wiseRecipientId || payoutRecipient.accountHolderName || payoutRecipient.accountSummary));
}
export function getSellerPayoutVerificationState(seller) {
  const phoneVerified = Boolean(seller?.phoneVerifiedAt);
  const documentVerified = normalizeUppercase(seller?.documentVerificationStatus) === "VERIFIED";
  const payoutDestinationRegistered = isActivePayoutRecipient(seller?.payoutRecipient);
  const nameMatched = Boolean(seller?.verificationNameMatched);
  const payoutNameMatched = Boolean(seller?.payoutNameMatched);
  const complete = phoneVerified && documentVerified && payoutDestinationRegistered && nameMatched && payoutNameMatched;
  const missing = [];
  if (!phoneVerified) missing.push("phone_verification");
  if (!documentVerified) missing.push("document_verification");
  if (!payoutDestinationRegistered) missing.push("payout_destination");
  if (!nameMatched) missing.push("name_match");
  if (!payoutNameMatched) missing.push("payout_name_match");
  return {
    complete,
    missing,
    phoneVerified,
    phoneVerifiedAt: seller?.phoneVerifiedAt || null,
    documentVerificationStatus: normalizeUppercase(seller?.documentVerificationStatus) || "NONE",
    documentVerificationStatusLabel: createDocumentVerificationStatusLabel(normalizeUppercase(seller?.documentVerificationStatus) || "NONE"),
    documentVerifiedAt: seller?.documentVerifiedAt || null,
    payoutDestinationRegistered,
    nameMatched,
    payoutNameMatched,
    sellerVerificationStatus: normalizeUppercase(seller?.sellerVerificationStatus) || "NONE",
    sellerVerificationStatusLabel: createSellerVerificationStatusLabel(normalizeUppercase(seller?.sellerVerificationStatus) || "NONE"),
    euSellerStatus: normalizeUppercase(seller?.euSellerStatus) || "DISABLED",
    euSellerStatusLabel: createSellerEuStatusLabel(normalizeUppercase(seller?.euSellerStatus) || "DISABLED"),
    reviewNotes: seller?.verificationReviewNotes || null
  };
}
export async function setSellerReviewStatus({
  sellerId,
  reason,
  changedBy = "system.stripe"
}, {
  prismaClient = prisma
} = {}) {
  if (!sellerId) {
    return null;
  }
  const seller = await prismaClient.seller.findUnique({
    where: {
      id: sellerId
    }
  });
  if (!seller) {
    return null;
  }
  const normalizedReason = normalizeText(reason);
  if (seller.status === "review" && seller.statusReason === normalizedReason) {
    return seller;
  }
  if (typeof prismaClient.$transaction === "function") {
    return prismaClient.$transaction(async tx => {
      const updatedSeller = await tx.seller.update({
        where: {
          id: sellerId
        },
        data: {
          status: "review",
          statusReason: normalizedReason
        }
      });
      await tx.sellerStatusHistory.create({
        data: {
          sellerId,
          fromStatus: seller.status,
          toStatus: "review",
          changedBy,
          reason: normalizedReason
        }
      });
      return updatedSeller;
    });
  }
  const updatedSeller = await prismaClient.seller.update({
    where: {
      id: sellerId
    },
    data: {
      status: "review",
      statusReason: normalizedReason
    }
  });
  if (prismaClient.sellerStatusHistory?.create) {
    await prismaClient.sellerStatusHistory.create({
      data: {
        sellerId,
        fromStatus: seller.status,
        toStatus: "review",
        changedBy,
        reason: normalizedReason
      }
    });
  }
  return updatedSeller;
}
export async function syncSellerStripeAccountFromAccountUpdate(account, {
  prismaClient = prisma
} = {}) {
  const stripeAccountId = normalizeText(account?.id);
  if (!stripeAccountId) {
    return null;
  }
  const existing = await prismaClient.sellerStripeAccount.findUnique({
    where: {
      stripeAccountId
    }
  });
  if (!existing) {
    return null;
  }
  return prismaClient.sellerStripeAccount.update({
    where: {
      stripeAccountId
    },
    data: {
      countryCode: normalizeUppercase(account?.country),
      defaultCurrency: normalizeLowercase(account?.default_currency),
      detailsSubmitted: Boolean(account?.details_submitted),
      chargesEnabled: Boolean(account?.charges_enabled),
      payoutsEnabled: Boolean(account?.payouts_enabled),
      onboardingCompletedAt: account?.details_submitted && !existing.onboardingCompletedAt ? new Date() : existing.onboardingCompletedAt,
      requirementsJson: isPlainObject(account?.requirements) ? account.requirements : null
    }
  });
}
export async function createLedgerEntry(data, {
  prismaClient = prisma
} = {}) {
  return prismaClient.ledgerEntry.create({
    data
  });
}
export function createSalesCreditSummaryLabels(summary, currencyCode) {
  const displayCurrency = normalizeUppercase(currencyCode) || "JPY";
  return {
    availableAmountLabel: formatMoney(summary.availableAmount, displayCurrency),
    totalLedgerBalanceLabel: formatMoney(summary.totalLedgerBalance, displayCurrency),
    maturedSalesAmountLabel: formatMoney(summary.maturedSalesAmount, displayCurrency),
    grossMaturedSalesAmountLabel: formatMoney(summary.grossMaturedSalesAmount, displayCurrency),
    ineligibleMaturedSalesAmountLabel: formatMoney(summary.ineligibleMaturedSalesAmount, displayCurrency),
    pendingSalesAmountLabel: formatMoney(summary.pendingSalesAmount, displayCurrency),
    pendingRiskReserveAmountLabel: formatMoney(summary.pendingRiskReserveAmount, displayCurrency),
    offsetLockedAmountLabel: formatMoney(summary.offsetLockedAmount, displayCurrency),
    payoutLockedAmountLabel: formatMoney(summary.payoutLockedAmount, displayCurrency)
  };
}
export async function getSellerSalesCreditSummary({
  sellerId,
  vendorId,
  currencyCode
}, {
  prismaClient = prisma,
  now = new Date()
} = {}) {
  const normalizedCurrency = normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;
  let seller = null;
  if (normalizeText(sellerId)) {
    seller = await prismaClient.seller.findUnique({
      where: {
        id: normalizeText(sellerId)
      },
      include: {
        payoutRecipient: true
      }
    });
  } else if (normalizeText(vendorId)) {
    seller = await prismaClient.seller.findUnique({
      where: {
        vendorId: normalizeText(vendorId)
      },
      include: {
        payoutRecipient: true
      }
    });
  }
  if (!seller) {
    const empty = calculateSellerSalesCreditAvailability([], {
      now
    });
    return {
      sellerId: null,
      currencyCode: normalizedCurrency,
      ...empty,
      ...createSalesCreditSummaryLabels(empty, normalizedCurrency),
      canUseSalesCredit: false,
      unavailableReason: "seller_not_found"
    };
  }
  if (!isMarketplaceSeller(seller)) {
    const empty = calculateSellerSalesCreditAvailability([], {
      now
    });
    return {
      sellerId: seller.id,
      currencyCode: normalizedCurrency,
      ...empty,
      ...createSalesCreditSummaryLabels(empty, normalizedCurrency),
      canUseSalesCredit: false,
      unavailableReason: "platform_seller_sales_credit_disabled",
      payoutVerification: getSellerPayoutVerificationState(seller)
    };
  }
  const [entries, offsetLocks, payoutRuns] = await Promise.all([prismaClient.ledgerEntry.findMany({
    where: {
      sellerId: seller.id,
      currencyCode: normalizedCurrency,
      entryType: {
        in: Object.keys(SELLER_SALES_CREDIT_ENTRY_SIGNS)
      }
    },
    select: {
      entryType: true,
      amount: true,
      occurredAt: true,
      metadataJson: true
    }
  }), prismaClient.salesCreditOffset.findMany({
    where: {
      sellerId: seller.id,
      currencyCode: normalizedCurrency,
      status: {
        in: Array.from(SALES_CREDIT_OFFSET_LOCK_STATUSES)
      }
    },
    select: {
      amount: true,
      status: true,
      expiresAt: true
    }
  }), prismaClient.payoutRun.findMany({
    where: {
      sellerId: seller.id,
      currencyCode: normalizedCurrency,
      status: {
        in: Array.from(SALES_CREDIT_PAYOUT_LOCK_STATUSES)
      }
    },
    select: {
      amount: true,
      status: true
    }
  })]);
  const summary = calculateSellerSalesCreditAvailability(entries, {
    offsetLocks,
    payoutRuns,
    now
  });
  const payoutVerification = getSellerPayoutVerificationState(seller);
  const sellerRestricted = ["restricted", "banned"].includes(seller.status);
  const canUseSalesCredit = seller.status === "active" && !sellerRestricted && payoutVerification.complete && summary.availableAmount > 0;
  let unavailableReason = null;
  if (sellerRestricted) {
    unavailableReason = "seller_restricted";
  } else if (seller.status !== "active") {
    unavailableReason = "seller_not_active";
  } else if (!payoutVerification.complete) {
    unavailableReason = "seller_verification_required";
  } else if (summary.availableAmount <= 0) {
    unavailableReason = "no_available_sales_credit";
  }
  return {
    sellerId: seller.id,
    currencyCode: normalizedCurrency,
    ...summary,
    ...createSalesCreditSummaryLabels(summary, normalizedCurrency),
    canUseSalesCredit,
    unavailableReason,
    payoutVerification
  };
}
export async function captureSalesCreditOffset({
  offsetId,
  orderId = null,
  metadataJson = null,
  expectedSellerId = null,
  expectedAmount = null,
  expectedCurrencyCode = null,
  expectedTargetSellerId = null
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
  return runInTransaction(prismaClient, async tx => {
    const offset = await tx.salesCreditOffset.findUnique({
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
    const expectation = validateSalesCreditOffsetExpectation(offset, {
      expectedSellerId,
      expectedAmount,
      expectedCurrencyCode,
      expectedTargetSellerId
    });
    if (!expectation.ok) {
      return {
        ok: false,
        reason: expectation.reason,
        offset
      };
    }
    if (offset.status === "captured") {
      return {
        ok: true,
        duplicate: true,
        offset
      };
    }
    if (offset.status !== "authorized") {
      return {
        ok: false,
        reason: "offset_not_capturable",
        offset
      };
    }
    if (offset.expiresAt && new Date(offset.expiresAt) <= now) {
      const expired = await tx.salesCreditOffset.update({
        where: {
          id: offset.id
        },
        data: {
          status: "expired",
          releasedAt: now,
          releaseReason: "expired"
        }
      });
      return {
        ok: false,
        reason: "offset_expired",
        offset: expired
      };
    }
    const updated = await tx.salesCreditOffset.update({
      where: {
        id: offset.id
      },
      data: {
        status: "captured",
        capturedAt: now
      }
    });
    const existingLedgerEntry = await tx.ledgerEntry.findFirst({
      where: {
        entryType: "sales_credit_offset_captured",
        stripeObjectId: offset.id
      }
    });
    const ledgerEntry = existingLedgerEntry || (await createLedgerEntry({
      sellerId: offset.sellerId,
      orderId: normalizeText(orderId),
      entryType: "sales_credit_offset_captured",
      stripeObjectId: offset.id,
      amount: offset.amount,
      currencyCode: offset.currencyCode,
      direction: "debit",
      description: "Sales credit applied to purchase",
      metadataJson: {
        salesCreditOffsetId: offset.id,
        checkoutReference: offset.checkoutReference,
        ...getSalesCreditOffsetMetadata(offset),
        ...(isPlainObject(metadataJson) ? metadataJson : {})
      },
      occurredAt: now
    }, {
      prismaClient: tx
    }));
    return {
      ok: true,
      duplicate: Boolean(existingLedgerEntry),
      offset: updated,
      ledgerEntry
    };
  });
}
export async function reverseSalesCreditOffsetForRefund({
  offsetId,
  orderId = null,
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
  return runInTransaction(prismaClient, async tx => {
    const offset = await tx.salesCreditOffset.findUnique({
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
    if (offset.status === "refunded") {
      const existingLedgerEntry = await tx.ledgerEntry.findFirst({
        where: {
          entryType: "sales_credit_offset_refund_reversal",
          stripeObjectId: offset.id
        }
      });
      return {
        ok: true,
        duplicate: true,
        offset,
        ledgerEntry: existingLedgerEntry || null
      };
    }
    if (offset.status !== "captured") {
      return {
        ok: false,
        reason: "offset_not_refundable",
        offset
      };
    }
    const updated = await tx.salesCreditOffset.update({
      where: {
        id: offset.id
      },
      data: {
        status: "refunded",
        releasedAt: now,
        releaseReason: "refund_reversal"
      }
    });
    const existingLedgerEntry = await tx.ledgerEntry.findFirst({
      where: {
        entryType: "sales_credit_offset_refund_reversal",
        stripeObjectId: offset.id
      }
    });
    const ledgerEntry = existingLedgerEntry || (await createLedgerEntry({
      sellerId: offset.sellerId,
      orderId: normalizeText(orderId),
      entryType: "sales_credit_offset_refund_reversal",
      stripeObjectId: offset.id,
      amount: offset.amount,
      currencyCode: offset.currencyCode,
      direction: "credit",
      description: "Sales credit returned after refund",
      metadataJson: {
        salesCreditOffsetId: offset.id,
        checkoutReference: offset.checkoutReference,
        ...getSalesCreditOffsetMetadata(offset),
        ...(isPlainObject(metadataJson) ? metadataJson : {})
      },
      occurredAt: now
    }, {
      prismaClient: tx
    }));
    return {
      ok: true,
      duplicate: Boolean(existingLedgerEntry),
      offset: updated,
      ledgerEntry
    };
  });
}
export async function runSerializableTransaction(prismaClient, callback) {
  if (typeof prismaClient?.$transaction !== "function") {
    return callback(prismaClient);
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await prismaClient.$transaction(callback, {
        isolationLevel: "Serializable"
      });
    } catch (error) {
      if (error?.code !== "P2034" || attempt === 3) throw error;
    }
  }
  throw new Error("Serializable transaction retry exhausted.");
}

import { createHash } from "node:crypto";
import prisma from "../../../db.server.js";
import { isMarketplaceSeller } from "../../../utils/sellerRoles.js";
import { calculateGovernedPayoutAvailability, evaluateSellerSettlementExecutionReadiness, evaluateSellerGovernanceReadiness, getSellerAgreementReadinessOptions, isMarketplaceGovernanceGateEnabled } from "../../marketplaceGovernance.server.js";
import { DEFAULT_ORDER_CURRENCY } from "../constants.js";
import { calculateSellerPayoutableLedgerBalance, SELLER_PAYOUT_LEDGER_ENTRY_SIGNS } from "../salesCreditCalculations.js";
import { clampInteger, normalizeLowercase, normalizeText, normalizeUppercase } from "../values.js";
import { getSellerPayoutVerificationState, getStripeSecretKey, runSerializableTransaction } from "../shared.server.js";
export async function createConnectedAccountPayout({
  stripeAccountId,
  amount,
  currencyCode,
  payoutRunId,
  sellerId,
  fetchImpl = fetch
}) {
  const normalizedStripeAccountId = normalizeText(stripeAccountId);
  if (!normalizedStripeAccountId) {
    throw new Error("STRIPE_CONNECTED_ACCOUNT_ID_MISSING");
  }
  const body = new URLSearchParams();
  body.set("amount", String(clampInteger(amount)));
  body.set("currency", normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY);
  body.set("description", `Manual payout ${payoutRunId}`);
  body.set("metadata[payoutRunId]", payoutRunId);
  body.set("metadata[sellerId]", sellerId);
  const response = await fetchImpl("https://api.stripe.com/v1/payouts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getStripeSecretKey()}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": `seller-payout-${payoutRunId}`,
      "Stripe-Account": normalizedStripeAccountId
    },
    body
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const stripeError = payload?.error || {};
    const error = new Error(normalizeText(stripeError.message) || "Stripe payout creation failed.");
    error.code = normalizeText(stripeError.code);
    error.type = normalizeText(stripeError.type);
    error.param = normalizeText(stripeError.param);
    throw error;
  }
  return payload;
}
export function buildPayoutApprovalRecipientSnapshot(payoutRecipient, {
  transferMethod,
  currencyCode
} = {}) {
  if (!payoutRecipient) return null;
  return {
    snapshotVersion: "payout-recipient-approval-v1",
    transferMethod: normalizeText(transferMethod),
    payoutRecipientId: payoutRecipient.id,
    provider: payoutRecipient.provider || null,
    status: payoutRecipient.status || null,
    countryCode: normalizeUppercase(payoutRecipient.countryCode),
    currencyCode: normalizeLowercase(currencyCode || payoutRecipient.currencyCode) || DEFAULT_ORDER_CURRENCY,
    accountHolderName: normalizeText(payoutRecipient.accountHolderName),
    wiseRecipientId: normalizeText(payoutRecipient.wiseRecipientId),
    wiseRecipientHash: normalizeText(payoutRecipient.wiseRecipientHash),
    accountSummary: normalizeText(payoutRecipient.accountSummary),
    longAccountSummary: normalizeText(payoutRecipient.longAccountSummary),
    recipientUpdatedAt: payoutRecipient.updatedAt || null
  };
}
export function hashPayoutApprovalRecipientSnapshot(snapshot) {
  if (!snapshot) return null;
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
export function validatePayoutApprovalExecutionSnapshot(payoutRun, payoutRecipient) {
  if (!payoutRun?.approvedTransferMethod || !payoutRun?.approvedCurrencyCode || !payoutRun?.approvedRecipientHash || !payoutRun?.approvedRecipientSnapshotJson) {
    return {
      ok: false,
      reason: "payout_approval_snapshot_missing"
    };
  }
  if (payoutRun.transferMethod !== payoutRun.approvedTransferMethod) {
    return {
      ok: false,
      reason: "payout_transfer_method_changed"
    };
  }
  if (normalizeLowercase(payoutRun.currencyCode) !== normalizeLowercase(payoutRun.approvedCurrencyCode)) {
    return {
      ok: false,
      reason: "payout_currency_changed"
    };
  }
  if (payoutRun.approvedPayoutRecipientId !== payoutRecipient?.id) {
    return {
      ok: false,
      reason: "payout_recipient_changed"
    };
  }
  const currentSnapshot = buildPayoutApprovalRecipientSnapshot(payoutRecipient, {
    transferMethod: payoutRun.transferMethod,
    currencyCode: payoutRun.currencyCode
  });
  if (hashPayoutApprovalRecipientSnapshot(currentSnapshot) !== payoutRun.approvedRecipientHash) {
    return {
      ok: false,
      reason: "payout_recipient_changed"
    };
  }
  return {
    ok: true,
    snapshot: currentSnapshot
  };
}
export async function getSellerPayoutableLedgerBalance({
  sellerId,
  currencyCode
}, {
  prismaClient = prisma
} = {}) {
  const normalizedSellerId = normalizeText(sellerId);
  const normalizedCurrency = normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;
  if (!normalizedSellerId) {
    return 0;
  }
  const entries = await prismaClient.ledgerEntry.findMany({
    where: {
      sellerId: normalizedSellerId,
      currencyCode: normalizedCurrency,
      entryType: {
        in: Object.keys(SELLER_PAYOUT_LEDGER_ENTRY_SIGNS)
      }
    },
    select: {
      entryType: true,
      amount: true
    }
  });
  return calculateSellerPayoutableLedgerBalance(entries);
}
export async function getReservedPayoutRunAmount({
  sellerId,
  currencyCode,
  excludePayoutRunId = null
}, {
  prismaClient = prisma
} = {}) {
  if (!prismaClient?.payoutRun?.findMany) return 0;
  const runs = await prismaClient.payoutRun.findMany({
    where: {
      sellerId: normalizeText(sellerId),
      currencyCode: normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY,
      status: {
        in: ["draft", "approved", "processing", "reconciliation_required"]
      },
      ...(excludePayoutRunId ? {
        id: {
          not: normalizeText(excludePayoutRunId)
        }
      } : {})
    },
    select: {
      amount: true
    }
  });
  return runs.reduce((total, run) => total + Math.max(0, clampInteger(run?.amount)), 0);
}
export async function getSellerPayoutAvailability({
  seller,
  currencyCode,
  excludePayoutRunId = null
}, {
  prismaClient = prisma
} = {}) {
  const ledgerBalance = await getSellerPayoutableLedgerBalance({
    sellerId: seller.id,
    currencyCode
  }, {
    prismaClient
  });
  const reservedPayoutAmount = await getReservedPayoutRunAmount({
    sellerId: seller.id,
    currencyCode,
    excludePayoutRunId
  }, {
    prismaClient
  });
  const unreservedLedgerBalance = Math.max(0, ledgerBalance - reservedPayoutAmount);
  const governed = calculateGovernedPayoutAvailability(unreservedLedgerBalance, seller.settlementControl);
  return {
    ...governed,
    ledgerBalance,
    unreservedLedgerBalance,
    reservedPayoutAmount
  };
}
export async function assertPayoutEligibleSeller(sellerId, {
  prismaClient = prisma,
  env = process.env,
  seller: providedSeller = null
} = {}) {
  const seller = providedSeller || (await prismaClient.seller.findUnique({
    where: {
      id: sellerId
    },
    include: {
      vendor: {
        include: {
          vendorStore: {
            include: {
              returnAddresses: true
            }
          }
        }
      },
      stripeAccount: true,
      payoutRecipient: true,
      settlementControl: true,
      complianceProfile: true,
      agreementAcceptances: {
        orderBy: {
          acceptedAt: "desc"
        }
      }
    }
  }));
  if (!seller?.vendor) {
    return {
      ok: false,
      reason: "seller_not_found"
    };
  }
  if (!isMarketplaceSeller(seller)) {
    return {
      ok: false,
      reason: "platform_seller_payout_disabled"
    };
  }
  if (["restricted", "banned"].includes(seller.status)) {
    return {
      ok: false,
      reason: "seller_payout_restricted"
    };
  }
  if (seller.status !== "active") {
    return {
      ok: false,
      reason: "seller_not_active"
    };
  }
  if (seller.vendor.vendorStore?.isTestStore === true) {
    return {
      ok: false,
      reason: "test_store_payout_disabled"
    };
  }
  if (normalizeUppercase(seller.complianceProfile?.countryCode) !== "JP") {
    return {
      ok: false,
      reason: "unsupported_settlement_country"
    };
  }
  if (seller.settlementControl?.payoutHold) {
    return {
      ok: false,
      reason: "seller_payout_hold",
      holdReason: seller.settlementControl.holdReason || null
    };
  }
  const settlementReadiness = evaluateSellerSettlementExecutionReadiness(seller, {
    env
  });
  if (!settlementReadiness.ready) {
    return {
      ok: false,
      reason: "seller_settlement_disabled",
      settlementReasons: settlementReadiness.reasons,
      settlementScope: settlementReadiness.settlementScope
    };
  }
  if (isMarketplaceGovernanceGateEnabled(env)) {
    const governanceReadiness = evaluateSellerGovernanceReadiness({
      ...seller,
      vendorStore: seller.vendor.vendorStore
    }, getSellerAgreementReadinessOptions(env, {
      requirePayoutReadiness: true
    }));
    if (!governanceReadiness.ready) {
      return {
        ok: false,
        reason: "seller_governance_required",
        governanceReasons: governanceReadiness.reasons
      };
    }
  }
  const payoutVerification = getSellerPayoutVerificationState(seller);
  if (!payoutVerification.complete) {
    return {
      ok: false,
      reason: "seller_verification_required",
      verification: payoutVerification
    };
  }
  return {
    ok: true,
    seller,
    verification: payoutVerification
  };
}
export const PAYOUT_ELIGIBILITY_SELLER_INCLUDE = {
  vendor: {
    include: {
      vendorStore: {
        include: {
          returnAddresses: true
        }
      }
    }
  },
  stripeAccount: true,
  payoutRecipient: true,
  settlementControl: true,
  complianceProfile: true,
  agreementAcceptances: {
    orderBy: {
      acceptedAt: "desc"
    }
  }
};
export async function claimPayoutRunForExecution({
  payoutRunId,
  executedBy,
  executedByJson,
  transferMethod
}, {
  prismaClient = prisma,
  env = process.env
} = {}) {
  return runSerializableTransaction(prismaClient, async tx => {
    const payoutRun = await tx.payoutRun.findUnique({
      where: {
        id: payoutRunId
      },
      include: {
        seller: {
          include: PAYOUT_ELIGIBILITY_SELLER_INCLUDE
        },
        sellerPayoutRecipient: true
      }
    });
    if (!payoutRun?.seller) return {
      ok: false,
      reason: "payout_run_not_found"
    };
    if (payoutRun.status !== "approved") {
      return {
        ok: false,
        reason: "payout_run_not_executable"
      };
    }
    if (!payoutRun.createdBy || !payoutRun.approvedBy) {
      return {
        ok: false,
        reason: "payout_audit_identity_missing"
      };
    }
    if (payoutRun.createdBy === payoutRun.approvedBy) {
      return {
        ok: false,
        reason: "payout_maker_checker_required"
      };
    }
    if (payoutRun.createdBy && payoutRun.createdBy === executedBy) {
      return {
        ok: false,
        reason: "payout_maker_checker_required"
      };
    }
    if (normalizeLowercase(payoutRun.currencyCode) !== "jpy") {
      return {
        ok: false,
        reason: "unsupported_settlement_currency"
      };
    }
    if (transferMethod !== payoutRun.transferMethod) {
      return {
        ok: false,
        reason: "payout_transfer_method_changed"
      };
    }
    if (transferMethod === "stripe_connect_payout" && !payoutRun.seller.stripeAccount?.payoutsEnabled) {
      return {
        ok: false,
        reason: "payouts_not_enabled"
      };
    }
    const payoutRecipient = payoutRun.sellerPayoutRecipient || payoutRun.seller.payoutRecipient;
    if (transferMethod === "wise_api" && (!payoutRecipient || payoutRecipient.provider !== "wise" || payoutRecipient.status !== "active" || !payoutRecipient.wiseRecipientId)) {
      return {
        ok: false,
        reason: "wise_recipient_missing"
      };
    }
    const approvalSnapshot = validatePayoutApprovalExecutionSnapshot(payoutRun, payoutRecipient);
    if (!approvalSnapshot.ok) return approvalSnapshot;
    const eligibility = await assertPayoutEligibleSeller(payoutRun.sellerId, {
      prismaClient: tx,
      env,
      seller: payoutRun.seller
    });
    if (!eligibility.ok) return eligibility;
    const availability = await getSellerPayoutAvailability({
      seller: eligibility.seller,
      currencyCode: payoutRun.currencyCode,
      excludePayoutRunId: payoutRun.id
    }, {
      prismaClient: tx
    });
    if (availability.availableAmount < payoutRun.amount) {
      return {
        ok: false,
        reason: "insufficient_available_balance_at_execution",
        governedAvailableAmount: availability.availableAmount,
        requestedAmount: payoutRun.amount
      };
    }
    const processingAt = new Date();
    const claimed = await tx.payoutRun.updateMany({
      where: {
        id: payoutRun.id,
        status: "approved"
      },
      data: {
        status: "processing",
        processingAt,
        processingBy: executedBy,
        processingByJson: executedByJson
      }
    });
    if (claimed.count !== 1) {
      return {
        ok: false,
        reason: "payout_run_state_conflict"
      };
    }
    return {
      ok: true,
      payoutRun: {
        ...payoutRun,
        status: "processing",
        processingAt,
        processingBy: executedBy
      },
      seller: eligibility.seller
    };
  });
}

import prisma from "../../../db.server.js";
import { DEFAULT_ORDER_CURRENCY } from "../constants.js";
import { clampInteger, normalizeLowercase, normalizeText, toPositiveInteger } from "../values.js";
import { createLedgerEntry, getConfiguredSellerPayoutProvider, getStripeClient, isActivePayoutRecipient, runSerializableTransaction } from "../shared.server.js";
import { PAYOUT_ELIGIBILITY_SELLER_INCLUDE, assertPayoutEligibleSeller, buildPayoutApprovalRecipientSnapshot, claimPayoutRunForExecution, createConnectedAccountPayout, getSellerPayoutAvailability, hashPayoutApprovalRecipientSnapshot } from "./common.server.js";
export async function createPayoutRun({
  sellerId,
  amount,
  currencyCode,
  createdBy = "admin",
  createdByJson = null
}, {
  prismaClient = prisma,
  env = process.env
} = {}) {
  const normalizedAmount = toPositiveInteger(amount);
  const normalizedCurrency = normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;
  const payoutProvider = getConfiguredSellerPayoutProvider(env);
  if (normalizedAmount == null) {
    return {
      ok: false,
      reason: "invalid_amount"
    };
  }
  if (normalizedCurrency !== "jpy") {
    return {
      ok: false,
      reason: "unsupported_settlement_currency"
    };
  }
  try {
    return await runSerializableTransaction(prismaClient, async tx => {
      const eligibility = await assertPayoutEligibleSeller(sellerId, {
        prismaClient: tx,
        env
      });
      if (!eligibility.ok) return eligibility;
      const availability = await getSellerPayoutAvailability({
        seller: eligibility.seller,
        currencyCode: normalizedCurrency
      }, {
        prismaClient: tx
      });
      if (availability.availableAmount < normalizedAmount) {
        const governanceReducedAvailability = availability.availableAmount < availability.unreservedLedgerBalance;
        return {
          ok: false,
          reason: availability.reservedPayoutAmount > 0 ? "insufficient_unreserved_ledger_balance" : governanceReducedAvailability ? "insufficient_governed_balance" : "insufficient_ledger_balance",
          availableLedgerBalance: availability.ledgerBalance,
          unreservedLedgerBalance: availability.unreservedLedgerBalance,
          reservedPayoutAmount: availability.reservedPayoutAmount,
          governedAvailableAmount: availability.availableAmount,
          reserveAmount: availability.reserveAmount,
          directInvoiceBalance: availability.directInvoiceBalance,
          requestedAmount: normalizedAmount,
          currencyCode: normalizedCurrency
        };
      }
      const payoutRecipient = eligibility.seller.payoutRecipient || null;
      if (payoutProvider === "wise" && (!payoutRecipient || payoutRecipient.provider !== "wise" || payoutRecipient.status !== "active" || !payoutRecipient.wiseRecipientId)) {
        return {
          ok: false,
          reason: "wise_recipient_missing"
        };
      }
      if (payoutProvider === "manual" && !isActivePayoutRecipient(payoutRecipient)) {
        return {
          ok: false,
          reason: "manual_recipient_missing"
        };
      }
      const payoutRun = await tx.payoutRun.create({
        data: {
          sellerId: eligibility.seller.id,
          sellerStripeAccountId: eligibility.seller.stripeAccount?.id || null,
          sellerPayoutRecipientId: payoutRecipient?.id || null,
          stripeAccountId: eligibility.seller.stripeAccount?.stripeAccountId || null,
          amount: normalizedAmount,
          currencyCode: normalizedCurrency,
          status: "draft",
          transferMethod: payoutProvider === "wise" ? "wise_api" : "manual_bank_transfer",
          createdBy: normalizeText(createdBy),
          createdByJson
        }
      });
      return {
        ok: true,
        payoutRun,
        availableLedgerBalance: availability.ledgerBalance,
        reservedPayoutAmount: availability.reservedPayoutAmount
      };
    });
  } catch (error) {
    if (error?.code === "P2034") {
      return {
        ok: false,
        reason: "payout_reservation_conflict"
      };
    }
    throw error;
  }
}
export async function approvePayoutRun({
  payoutRunId,
  approvedBy = "admin",
  approvedByJson = null
}, {
  prismaClient = prisma,
  env = process.env
} = {}) {
  try {
    return await runSerializableTransaction(prismaClient, async tx => {
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
      if (payoutRun.status !== "draft") {
        return {
          ok: false,
          reason: "payout_run_not_approvable"
        };
      }
      if (!payoutRun.createdBy) {
        return {
          ok: false,
          reason: "payout_creator_missing"
        };
      }
      if (payoutRun.createdBy && payoutRun.createdBy === approvedBy) {
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
      const payoutRecipient = payoutRun.sellerPayoutRecipient || payoutRun.seller.payoutRecipient;
      if (!isActivePayoutRecipient(payoutRecipient)) {
        return {
          ok: false,
          reason: "payout_recipient_missing"
        };
      }
      if (payoutRun.transferMethod === "wise_api" && (payoutRecipient.provider !== "wise" || !payoutRecipient.wiseRecipientId)) {
        return {
          ok: false,
          reason: "wise_recipient_missing"
        };
      }
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
          reason: "insufficient_available_balance_at_approval",
          availableLedgerBalance: availability.ledgerBalance,
          reservedPayoutAmount: availability.reservedPayoutAmount,
          governedAvailableAmount: availability.availableAmount,
          requestedAmount: payoutRun.amount
        };
      }
      const approvedTransferMethod = payoutRun.transferMethod || "stripe_connect_payout";
      const approvedRecipientSnapshot = buildPayoutApprovalRecipientSnapshot(payoutRecipient, {
        transferMethod: approvedTransferMethod,
        currencyCode: payoutRun.currencyCode
      });
      const approvedRecipientHash = hashPayoutApprovalRecipientSnapshot(approvedRecipientSnapshot);
      const claimed = await tx.payoutRun.updateMany({
        where: {
          id: payoutRunId,
          status: "draft"
        },
        data: {
          status: "approved",
          approvedAt: new Date(),
          approvedBy,
          approvedByJson,
          transferMethod: approvedTransferMethod,
          approvedTransferMethod,
          approvedPayoutRecipientId: payoutRecipient.id,
          approvedRecipientHash,
          approvedRecipientSnapshotJson: approvedRecipientSnapshot,
          approvedCurrencyCode: payoutRun.currencyCode
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
        payoutRun: await tx.payoutRun.findUnique({
          where: {
            id: payoutRunId
          }
        })
      };
    });
  } catch (error) {
    if (error?.code === "P2034") {
      return {
        ok: false,
        reason: "payout_reservation_conflict"
      };
    }
    throw error;
  }
}
export async function markPayoutRunManuallyPaid({
  payoutRunId,
  executedBy = "admin",
  executedByJson = null,
  externalTransferId = null,
  transferMemo = null
}, {
  prismaClient = prisma,
  env = process.env
} = {}) {
  const payoutRun = await prismaClient.payoutRun.findUnique({
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
  if (!payoutRun?.seller) {
    return {
      ok: false,
      reason: "payout_run_not_found"
    };
  }
  if (!["approved", "processing"].includes(payoutRun.status)) {
    return {
      ok: false,
      reason: "payout_run_not_executable"
    };
  }
  if (payoutRun.transferMethod !== "manual_bank_transfer") {
    return {
      ok: false,
      reason: "payout_transfer_method_mismatch"
    };
  }
  if (payoutRun.status === "approved") {
    const claimed = await claimPayoutRunForExecution({
      payoutRunId,
      executedBy,
      executedByJson,
      transferMethod: "manual_bank_transfer"
    }, {
      prismaClient,
      env
    });
    if (!claimed.ok) return claimed;
    return {
      ...claimed,
      pending: true,
      requiresCompletion: true
    };
  }
  const now = new Date();
  const normalizedExternalTransferId = normalizeText(externalTransferId);
  const normalizedTransferMemo = normalizeText(transferMemo);
  if (payoutRun.processingBy && payoutRun.processingBy !== executedBy) {
    return {
      ok: false,
      reason: "payout_processing_owner_mismatch"
    };
  }
  if (!normalizedExternalTransferId) {
    return {
      ok: false,
      reason: "external_transfer_id_required"
    };
  }
  return runSerializableTransaction(prismaClient, async tx => {
    const completed = await tx.payoutRun.updateMany({
      where: {
        id: payoutRun.id,
        status: "processing",
        processingBy: payoutRun.processingBy || executedBy,
        transferMethod: "manual_bank_transfer"
      },
      data: {
        status: "executed",
        executedAt: now,
        executedBy,
        executedByJson,
        externalTransferId: normalizedExternalTransferId,
        transferMemo: normalizedTransferMemo,
        failureCode: null,
        failureMessage: null
      }
    });
    if (completed.count !== 1) {
      return {
        ok: false,
        reason: "payout_run_state_conflict"
      };
    }
    const updated = await tx.payoutRun.findUnique({
      where: {
        id: payoutRun.id
      }
    });
    await createLedgerEntry({
      sellerId: payoutRun.sellerId,
      sellerStripeAccountId: payoutRun.sellerStripeAccountId,
      payoutRunId: payoutRun.id,
      stripeAccountId: payoutRun.stripeAccountId,
      entryType: "payout_paid",
      stripeObjectId: normalizedExternalTransferId || payoutRun.id,
      amount: payoutRun.amount,
      currencyCode: payoutRun.currencyCode,
      direction: "debit",
      description: "Manual seller payout paid",
      metadataJson: {
        transferMethod: "manual_bank_transfer",
        externalTransferId: normalizedExternalTransferId,
        transferMemo: normalizedTransferMemo,
        executedBy
      },
      occurredAt: now
    }, {
      prismaClient: tx
    });
    return {
      ok: true,
      payoutRun: updated,
      externalTransferId: normalizedExternalTransferId
    };
  }).catch(error => {
    if (error?.code === "P2002") {
      return {
        ok: false,
        reason: "external_transfer_id_duplicate"
      };
    }
    throw error;
  });
}
async function getConnectedAccountAvailableBalanceAmount({
  stripeClient,
  stripeAccountId,
  currencyCode
}) {
  if (!stripeClient?.balance?.retrieve || !stripeAccountId) {
    return null;
  }
  const balance = await stripeClient.balance.retrieve({}, {
    stripeAccount: stripeAccountId
  });
  const normalizedCurrency = normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;
  const availableRows = Array.isArray(balance?.available) ? balance.available : [];
  return availableRows.filter(row => normalizeLowercase(row?.currency) === normalizedCurrency).reduce((total, row) => total + clampInteger(row?.amount), 0);
}
export async function executePayoutRun({
  payoutRunId,
  executedBy = "admin"
}, {
  prismaClient = prisma,
  stripeClient,
  createPayout = createConnectedAccountPayout,
  env = process.env
} = {}) {
  const payoutCandidate = await prismaClient.payoutRun.findUnique({
    where: {
      id: payoutRunId
    },
    include: {
      seller: {
        include: PAYOUT_ELIGIBILITY_SELLER_INCLUDE
      }
    }
  });
  if (!payoutCandidate?.seller?.stripeAccount) {
    return {
      ok: false,
      reason: "payout_run_not_found"
    };
  }
  if (payoutCandidate.status !== "approved") {
    return {
      ok: false,
      reason: "payout_run_not_executable"
    };
  }
  if (!payoutCandidate.seller.stripeAccount.payoutsEnabled) {
    return {
      ok: false,
      reason: "payouts_not_enabled"
    };
  }
  const balanceStripeClient = stripeClient || (createPayout === createConnectedAccountPayout ? getStripeClient() : null);
  const availableBalance = await getConnectedAccountAvailableBalanceAmount({
    stripeClient: balanceStripeClient,
    stripeAccountId: payoutCandidate.stripeAccountId,
    currencyCode: payoutCandidate.currencyCode
  });
  if (availableBalance != null && availableBalance < payoutCandidate.amount) {
    return {
      ok: false,
      reason: "insufficient_stripe_available_balance",
      availableBalance,
      payoutRun: payoutCandidate
    };
  }
  let claimedExecution;
  try {
    claimedExecution = await claimPayoutRunForExecution({
      payoutRunId,
      executedBy,
      executedByJson: null,
      transferMethod: "stripe_connect_payout"
    }, {
      prismaClient,
      env
    });
  } catch (error) {
    if (error?.code === "P2034") {
      return {
        ok: false,
        reason: "payout_reservation_conflict"
      };
    }
    throw error;
  }
  if (!claimedExecution.ok) return claimedExecution;
  const payoutRun = claimedExecution.payoutRun;
  if (!claimedExecution.seller?.stripeAccount) {
    return {
      ok: false,
      reason: "payout_run_not_found"
    };
  }
  try {
    const payout = await createPayout({
      stripeAccountId: payoutRun.stripeAccountId,
      amount: payoutRun.amount,
      currencyCode: payoutRun.currencyCode,
      payoutRunId: payoutRun.id,
      sellerId: payoutRun.sellerId
    });
    const updated = await prismaClient.payoutRun.update({
      where: {
        id: payoutRun.id
      },
      data: {
        status: "executed",
        executedAt: new Date(),
        executedBy,
        stripePayoutId: payout.id
      }
    });
    return {
      ok: true,
      payoutRun: updated,
      stripePayoutId: payout.id
    };
  } catch (error) {
    const code = normalizeText(error?.code);
    const message = error instanceof Error ? error.message : String(error);
    const updated = await prismaClient.payoutRun.update({
      where: {
        id: payoutRun.id
      },
      data: {
        status: "failed",
        failureCode: code,
        failureMessage: normalizeText(message)
      }
    });
    return {
      ok: false,
      reason: "payout_execution_failed",
      payoutRun: updated
    };
  }
}

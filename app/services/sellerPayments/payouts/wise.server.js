import { randomUUID } from "node:crypto";
import prisma from "../../../db.server.js";
import { DEFAULT_ORDER_CURRENCY } from "../constants.js";
import { decimalAmountFromMinorUnits, isPlainObject, normalizeLowercase, normalizeText, normalizeUppercase } from "../values.js";
import { createLedgerEntry, getConfiguredSellerPayoutProvider, runSerializableTransaction } from "../shared.server.js";
import { claimPayoutRunForExecution } from "./common.server.js";
function getWisePayoutConfig(env = process.env) {
  const apiBaseUrl = normalizeText(env.WISE_API_BASE_URL)?.replace(/\/+$/, "");
  const apiToken = normalizeText(env.WISE_API_TOKEN);
  const profileId = normalizeText(env.WISE_PROFILE_ID);
  const sourceCurrency = normalizeUppercase(env.WISE_SOURCE_CURRENCY) || DEFAULT_ORDER_CURRENCY.toUpperCase();
  const liveTransfersEnabled = ["1", "true", "yes", "on"].includes(normalizeLowercase(env.WISE_LIVE_TRANSFERS_ENABLED) || "");
  const normalizedBaseUrl = apiBaseUrl || "https://api.wise-sandbox.com";
  const missing = [];
  if (!apiToken) missing.push("WISE_API_TOKEN");
  if (!profileId) missing.push("WISE_PROFILE_ID");
  if (!normalizedBaseUrl) missing.push("WISE_API_BASE_URL");
  if (!sourceCurrency) missing.push("WISE_SOURCE_CURRENCY");
  return {
    apiBaseUrl: normalizedBaseUrl,
    apiToken,
    profileId,
    sourceCurrency,
    missing,
    isSandbox: /sandbox/i.test(normalizedBaseUrl),
    liveTransfersEnabled
  };
}
function normalizeWiseRecipientId(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : normalized;
}
function normalizeWiseTransferId(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}
function createWiseReference(payoutRunId) {
  return `Settlement ${String(payoutRunId || "").slice(0, 24)}`;
}
async function wiseApiRequest({
  path,
  method = "GET",
  body = null
}, {
  config,
  fetchImpl = fetch
} = {}) {
  const response = await fetchImpl(`${config.apiBaseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json"
    },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    const firstError = errors[0] || payload?.error || payload;
    const message = normalizeText(firstError?.message) || normalizeText(firstError?.code) || `Wise API request failed with ${response.status}.`;
    const error = new Error(message);
    error.status = response.status;
    error.code = normalizeText(firstError?.code) || normalizeText(payload?.code);
    error.payload = payload;
    throw error;
  }
  return payload;
}
async function createWiseQuote({
  payoutRun,
  recipient,
  config
}, {
  fetchImpl = fetch
} = {}) {
  const sourceCurrency = normalizeUppercase(config.sourceCurrency) || DEFAULT_ORDER_CURRENCY.toUpperCase();
  const targetCurrency = normalizeUppercase(recipient.currencyCode) || normalizeUppercase(payoutRun.currencyCode) || sourceCurrency;
  return wiseApiRequest({
    path: `/v3/profiles/${config.profileId}/quotes`,
    method: "POST",
    body: {
      sourceCurrency,
      targetCurrency,
      sourceAmount: decimalAmountFromMinorUnits(payoutRun.amount, sourceCurrency),
      targetAmount: null,
      targetAccount: normalizeWiseRecipientId(recipient.wiseRecipientId)
    }
  }, {
    config,
    fetchImpl
  });
}
async function createWiseTransfer({
  payoutRun,
  recipient,
  quote,
  customerTransactionId,
  config
}, {
  fetchImpl = fetch
} = {}) {
  return wiseApiRequest({
    path: "/v1/transfers",
    method: "POST",
    body: {
      targetAccount: normalizeWiseRecipientId(recipient.wiseRecipientId),
      quoteUuid: normalizeText(quote?.id),
      customerTransactionId,
      details: {
        reference: createWiseReference(payoutRun.id)
      }
    }
  }, {
    config,
    fetchImpl
  });
}
async function fundWiseTransfer({
  transferId,
  config
}, {
  fetchImpl = fetch
} = {}) {
  return wiseApiRequest({
    path: `/v3/profiles/${config.profileId}/transfers/${transferId}/payments`,
    method: "POST",
    body: {
      type: "BALANCE"
    }
  }, {
    config,
    fetchImpl
  });
}
async function retrieveWiseTransfer({
  transferId,
  config
}, {
  fetchImpl = fetch
} = {}) {
  return wiseApiRequest({
    path: `/v1/transfers/${transferId}`
  }, {
    config,
    fetchImpl
  });
}
const WISE_TRANSFER_COMPLETED_STATUSES = new Set(["outgoing_payment_sent"]);
const WISE_TRANSFER_RECONCILIATION_STATUSES = new Set(["bounced_back", "cancelled", "charged_back"]);
function toNullableNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
function getWiseQuoteFeeAmount(quote) {
  const directFee = toNullableNumber(quote?.fee) || toNullableNumber(quote?.feeAmount) || toNullableNumber(quote?.totalFee);
  if (directFee != null) {
    return directFee;
  }
  const paymentOptions = Array.isArray(quote?.paymentOptions) ? quote.paymentOptions : [];
  const balanceOption = paymentOptions.find(option => normalizeLowercase(option?.payIn) === "balance");
  return toNullableNumber(balanceOption?.fee?.total) || toNullableNumber(paymentOptions[0]?.fee?.total);
}
function getWiseTransferStatus(...payloads) {
  for (const payload of payloads) {
    const status = normalizeLowercase(payload?.status) || normalizeLowercase(payload?.current_state) || normalizeLowercase(payload?.data?.current_state);
    if (status) {
      return status;
    }
  }
  return null;
}
function mergeWisePayload(existingPayload, patch) {
  return {
    ...(isPlainObject(existingPayload) ? existingPayload : {}),
    ...patch
  };
}
async function markWisePayoutRunCompleted({
  payoutRun,
  transferStatus,
  transferPayload = null,
  executedBy = "admin"
}, {
  prismaClient = prisma
} = {}) {
  const now = new Date();
  return prismaClient.$transaction(async tx => {
    const updated = await tx.payoutRun.update({
      where: {
        id: payoutRun.id
      },
      data: {
        status: "executed",
        executedAt: payoutRun.executedAt || now,
        executedBy: payoutRun.executedBy || executedBy,
        wiseTransferStatus: transferStatus,
        wisePayloadJson: mergeWisePayload(payoutRun.wisePayloadJson, {
          finalTransfer: transferPayload
        }),
        failureCode: null,
        failureMessage: null,
        wiseFailureCode: null,
        wiseFailureMessage: null,
        reconciliationRequiredAt: null,
        reconciliationReason: null
      }
    });
    const existingPaidEntry = await tx.ledgerEntry.findFirst({
      where: {
        payoutRunId: payoutRun.id,
        entryType: "payout_paid"
      }
    });
    if (!existingPaidEntry) {
      await createLedgerEntry({
        sellerId: payoutRun.sellerId,
        sellerStripeAccountId: payoutRun.sellerStripeAccountId,
        payoutRunId: payoutRun.id,
        stripeAccountId: payoutRun.stripeAccountId,
        entryType: "payout_paid",
        stripeObjectId: normalizeWiseTransferId(payoutRun.wiseTransferId) || payoutRun.id,
        amount: payoutRun.amount,
        currencyCode: payoutRun.currencyCode,
        direction: "debit",
        description: "Wise seller settlement paid",
        metadataJson: {
          transferMethod: "wise_api",
          wiseTransferId: normalizeWiseTransferId(payoutRun.wiseTransferId),
          wiseTransferStatus: transferStatus,
          executedBy
        },
        occurredAt: now
      }, {
        prismaClient: tx
      });
    }
    return {
      ok: true,
      payoutRun: updated,
      ledgerEntryCreated: !existingPaidEntry
    };
  });
}
async function markWisePayoutRunReconciliationRequired({
  payoutRun,
  transferStatus,
  failureCode = null,
  failureMessage = null,
  transferPayload = null
}, {
  prismaClient = prisma
} = {}) {
  const updated = await prismaClient.payoutRun.update({
    where: {
      id: payoutRun.id
    },
    data: {
      status: "reconciliation_required",
      reconciliationRequiredAt: payoutRun.reconciliationRequiredAt || new Date(),
      reconciliationReason: normalizeText(failureCode) || transferStatus || "wise_result_unknown",
      wiseTransferStatus: transferStatus || payoutRun.wiseTransferStatus,
      wiseFailureCode: normalizeText(failureCode) || transferStatus,
      wiseFailureMessage: normalizeText(failureMessage),
      failureCode: normalizeText(failureCode) || transferStatus,
      failureMessage: normalizeText(failureMessage),
      wisePayloadJson: mergeWisePayload(payoutRun.wisePayloadJson, {
        reconciliationTransfer: transferPayload
      })
    }
  });
  return {
    ok: false,
    reason: "wise_transfer_reconciliation_required",
    reconciliationRequired: true,
    payoutRun: updated
  };
}
async function markWisePayoutRunReturned({
  payoutRun,
  transferStatus,
  transferPayload = null
}, {
  prismaClient = prisma
} = {}) {
  const now = new Date();
  return runSerializableTransaction(prismaClient, async tx => {
    const latest = await tx.payoutRun.findUnique({
      where: {
        id: payoutRun.id
      }
    });
    if (!latest) return {
      ok: false,
      reason: "payout_run_not_found"
    };
    const paidEntry = await tx.ledgerEntry.findFirst({
      where: {
        payoutRunId: latest.id,
        entryType: "payout_paid"
      }
    });
    const existingReturnedEntry = await tx.ledgerEntry.findFirst({
      where: {
        payoutRunId: latest.id,
        entryType: "payout_returned"
      }
    });
    let returnedEntry = existingReturnedEntry;
    if (paidEntry && !returnedEntry) {
      returnedEntry = await createLedgerEntry({
        sellerId: latest.sellerId,
        sellerStripeAccountId: latest.sellerStripeAccountId,
        payoutRunId: latest.id,
        stripeAccountId: latest.stripeAccountId,
        entryType: "payout_returned",
        stripeObjectId: normalizeWiseTransferId(latest.wiseTransferId) || latest.id,
        amount: latest.amount,
        currencyCode: latest.currencyCode,
        direction: "credit",
        description: "Wise seller settlement returned",
        metadataJson: {
          transferMethod: "wise_api",
          wiseTransferId: normalizeWiseTransferId(latest.wiseTransferId),
          wiseTransferStatus: transferStatus,
          originalPayoutLedgerEntryId: paidEntry.id
        },
        occurredAt: now
      }, {
        prismaClient: tx
      });
    }
    const updated = await tx.payoutRun.update({
      where: {
        id: latest.id
      },
      data: {
        status: "returned",
        returnedAt: latest.returnedAt || now,
        wiseTransferStatus: transferStatus,
        wisePayloadJson: mergeWisePayload(latest.wisePayloadJson, {
          refundedTransfer: transferPayload
        }),
        reconciliationRequiredAt: null,
        reconciliationReason: null,
        failureCode: null,
        failureMessage: null,
        wiseFailureCode: null,
        wiseFailureMessage: null
      }
    });
    return {
      ok: true,
      returned: true,
      payoutRun: updated,
      ledgerEntry: returnedEntry,
      ledgerEntryCreated: Boolean(paidEntry && !existingReturnedEntry)
    };
  });
}
async function applyWiseTransferStatus({
  payoutRun,
  transferStatus,
  transferPayload = null,
  executedBy = "admin"
}, {
  prismaClient = prisma
} = {}) {
  if (WISE_TRANSFER_COMPLETED_STATUSES.has(transferStatus)) {
    return markWisePayoutRunCompleted({
      payoutRun,
      transferStatus,
      transferPayload,
      executedBy
    }, {
      prismaClient
    });
  }
  if (transferStatus === "funds_refunded") {
    return markWisePayoutRunReturned({
      payoutRun,
      transferStatus,
      transferPayload
    }, {
      prismaClient
    });
  }
  if (WISE_TRANSFER_RECONCILIATION_STATUSES.has(transferStatus)) {
    return markWisePayoutRunReconciliationRequired({
      payoutRun,
      transferStatus,
      failureCode: transferStatus,
      failureMessage: `Wise transfer requires reconciliation after status ${transferStatus}.`,
      transferPayload
    }, {
      prismaClient
    });
  }
  const updated = await prismaClient.payoutRun.update({
    where: {
      id: payoutRun.id
    },
    data: {
      status: "processing",
      reconciliationRequiredAt: null,
      reconciliationReason: null,
      wiseTransferStatus: transferStatus,
      wisePayloadJson: mergeWisePayload(payoutRun.wisePayloadJson, {
        latestTransfer: transferPayload
      })
    }
  });
  return {
    ok: true,
    pending: true,
    payoutRun: updated
  };
}
export async function executeWisePayoutRun({
  payoutRunId,
  executedBy = "admin",
  executedByJson = null
}, {
  prismaClient = prisma,
  fetchImpl = fetch,
  env = process.env
} = {}) {
  if (getConfiguredSellerPayoutProvider(env) !== "wise") {
    return {
      ok: false,
      reason: "wise_payout_not_enabled"
    };
  }
  const config = getWisePayoutConfig(env);
  if (config.missing.length > 0) {
    return {
      ok: false,
      reason: "wise_env_missing",
      missing: config.missing
    };
  }
  if (!config.isSandbox && !config.liveTransfersEnabled) {
    return {
      ok: false,
      reason: "wise_live_transfers_disabled"
    };
  }
  let claimedExecution;
  try {
    claimedExecution = await claimPayoutRunForExecution({
      payoutRunId,
      executedBy,
      executedByJson,
      transferMethod: "wise_api"
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
  const payoutRecipient = payoutRun.sellerPayoutRecipient || claimedExecution.seller.payoutRecipient;
  if (!payoutRecipient || payoutRecipient.provider !== "wise" || payoutRecipient.status !== "active" || !payoutRecipient.wiseRecipientId) {
    return {
      ok: false,
      reason: "wise_recipient_missing"
    };
  }
  const customerTransactionId = payoutRun.wiseCustomerTransactionId || randomUUID();
  const sourceCurrency = normalizeUppercase(config.sourceCurrency) || DEFAULT_ORDER_CURRENCY.toUpperCase();
  const targetCurrency = normalizeUppercase(payoutRecipient.currencyCode) || normalizeUppercase(payoutRun.currencyCode) || sourceCurrency;
  const sourceAmount = decimalAmountFromMinorUnits(payoutRun.amount, sourceCurrency);
  const preparedPayoutRun = await prismaClient.payoutRun.update({
    where: {
      id: payoutRun.id
    },
    data: {
      wiseCustomerTransactionId: customerTransactionId,
      wiseSourceCurrency: sourceCurrency,
      wiseTargetCurrency: targetCurrency,
      wiseSourceAmount: sourceAmount,
      failureCode: null,
      failureMessage: null,
      wiseFailureCode: null,
      wiseFailureMessage: null
    }
  });
  try {
    const quote = await createWiseQuote({
      payoutRun: preparedPayoutRun,
      recipient: payoutRecipient,
      config
    }, {
      fetchImpl
    });
    const quoteId = normalizeText(quote?.id);
    if (!quoteId) {
      throw new Error("Wise quote response did not include an id.");
    }
    await prismaClient.payoutRun.update({
      where: {
        id: payoutRun.id
      },
      data: {
        wiseQuoteId: quoteId,
        wiseSourceAmount: toNullableNumber(quote.sourceAmount) || sourceAmount,
        wiseTargetAmount: toNullableNumber(quote.targetAmount),
        wiseFeeAmount: getWiseQuoteFeeAmount(quote),
        wiseRate: toNullableNumber(quote.rate),
        wisePayloadJson: mergeWisePayload(preparedPayoutRun.wisePayloadJson, {
          quote
        })
      }
    });
    const transfer = await createWiseTransfer({
      payoutRun: preparedPayoutRun,
      recipient: payoutRecipient,
      quote,
      customerTransactionId,
      config
    }, {
      fetchImpl
    });
    const transferId = normalizeWiseTransferId(transfer?.id);
    if (!transferId) {
      throw new Error("Wise transfer response did not include an id.");
    }
    const transferCreatedPayoutRun = await prismaClient.payoutRun.update({
      where: {
        id: payoutRun.id
      },
      data: {
        status: "processing",
        wiseTransferId: transferId,
        externalTransferId: transferId,
        wiseTransferStatus: getWiseTransferStatus(transfer) || "incoming_payment_waiting",
        wisePayloadJson: mergeWisePayload(preparedPayoutRun.wisePayloadJson, {
          quote,
          transfer
        })
      }
    });
    const funding = await fundWiseTransfer({
      transferId,
      config
    }, {
      fetchImpl
    });
    const transferStatus = getWiseTransferStatus(funding, transfer) || "processing";
    const processingPayoutRun = await prismaClient.payoutRun.update({
      where: {
        id: payoutRun.id
      },
      data: {
        status: "processing",
        wiseTransferStatus: transferStatus,
        wisePayloadJson: mergeWisePayload(transferCreatedPayoutRun.wisePayloadJson, {
          quote,
          transfer,
          funding
        })
      }
    });
    return applyWiseTransferStatus({
      payoutRun: processingPayoutRun,
      transferStatus,
      transferPayload: transfer,
      executedBy
    }, {
      prismaClient
    });
  } catch (error) {
    const code = normalizeText(error?.code) || "wise_api_error";
    const message = error instanceof Error ? error.message : String(error);
    const latest = await prismaClient.payoutRun.findUnique({
      where: {
        id: payoutRun.id
      }
    });
    return markWisePayoutRunReconciliationRequired({
      payoutRun: latest || payoutRun,
      transferStatus: latest?.wiseTransferStatus || payoutRun.wiseTransferStatus || null,
      failureCode: code,
      failureMessage: message
    }, {
      prismaClient
    });
  }
}
export async function syncWisePayoutRunStatus({
  payoutRunId,
  executedBy = "admin"
}, {
  prismaClient = prisma,
  fetchImpl = fetch,
  env = process.env
} = {}) {
  const config = getWisePayoutConfig(env);
  if (config.missing.length > 0) {
    return {
      ok: false,
      reason: "wise_env_missing",
      missing: config.missing
    };
  }
  const payoutRun = await prismaClient.payoutRun.findUnique({
    where: {
      id: payoutRunId
    }
  });
  if (!payoutRun?.wiseTransferId) {
    return {
      ok: false,
      reason: "wise_transfer_missing"
    };
  }
  const transfer = await retrieveWiseTransfer({
    transferId: payoutRun.wiseTransferId,
    config
  }, {
    fetchImpl
  });
  const transferStatus = getWiseTransferStatus(transfer) || "processing";
  return applyWiseTransferStatus({
    payoutRun,
    transferStatus,
    transferPayload: transfer,
    executedBy
  }, {
    prismaClient
  });
}

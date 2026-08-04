import prisma from "../../db.server.js";
import { DEFAULT_ORDER_CURRENCY } from "./constants.js";
import { clampInteger, normalizeLowercase, normalizeText } from "./values.js";
import { SELLER_REVIEW_REASON_DISPUTE, createLedgerEntry, getStripeClient, setSellerReviewStatus, syncSellerStripeAccountFromAccountUpdate } from "./shared.server.js";
const SELLER_REVIEW_REASON_PAYOUT_FAILED = "payout_external_account_update_required";
const SELLER_REVIEW_REASON_EXTERNAL_ACCOUNT_UPDATED = "payout_external_account_admin_review_required";
function getStripeWebhookSecrets() {
  const secrets = [{
    type: "connect",
    secret: normalizeText(process.env.STRIPE_CONNECT_WEBHOOK_SECRET)
  }, {
    type: "platform",
    secret: normalizeText(process.env.STRIPE_WEBHOOK_SECRET)
  }].filter(item => item.secret);
  const uniqueSecrets = [];
  for (const item of secrets) {
    if (!uniqueSecrets.some(existing => existing.secret === item.secret)) {
      uniqueSecrets.push(item);
    }
  }
  if (uniqueSecrets.length === 0) {
    throw new Error("STRIPE_WEBHOOK_SECRET_MISSING");
  }
  return uniqueSecrets;
}
async function processAccountUpdated(event, {
  prismaClient = prisma
} = {}) {
  const updatedStripeAccount = await syncSellerStripeAccountFromAccountUpdate(event.data?.object, {
    prismaClient
  });
  if (!updatedStripeAccount?.sellerId) {
    return;
  }
  const seller = await prismaClient.seller.findUnique({
    where: {
      id: updatedStripeAccount.sellerId
    }
  });
  if (seller?.status === "review" && seller.statusReason === SELLER_REVIEW_REASON_PAYOUT_FAILED && event.data?.object?.payouts_enabled === true) {
    await setSellerReviewStatus({
      sellerId: updatedStripeAccount.sellerId,
      reason: SELLER_REVIEW_REASON_EXTERNAL_ACCOUNT_UPDATED,
      changedBy: "stripe.account.updated"
    }, {
      prismaClient
    });
  }
}
async function processExternalAccountUpdated(event, {
  prismaClient = prisma
} = {}) {
  const stripeAccountId = normalizeText(event.account);
  if (!stripeAccountId) {
    return;
  }
  const stripeAccount = await prismaClient.sellerStripeAccount.findUnique({
    where: {
      stripeAccountId
    }
  });
  if (!stripeAccount?.sellerId) {
    return;
  }
  await setSellerReviewStatus({
    sellerId: stripeAccount.sellerId,
    reason: SELLER_REVIEW_REASON_EXTERNAL_ACCOUNT_UPDATED,
    changedBy: "stripe.account.external_account.updated"
  }, {
    prismaClient
  });
}
async function markStripeEventProcessed(stripeEventId, {
  prismaClient = prisma
} = {}) {
  return prismaClient.stripeEvent.update({
    where: {
      stripeEventId
    },
    data: {
      processingStatus: "processed",
      processedAt: new Date(),
      errorMessage: null
    }
  });
}
async function markStripeEventFailed(stripeEventId, message, {
  prismaClient = prisma
} = {}) {
  return prismaClient.stripeEvent.update({
    where: {
      stripeEventId
    },
    data: {
      processingStatus: "failed",
      errorMessage: normalizeText(message) || "stripe_event_processing_failed"
    }
  });
}
async function findOrderByChargeId(chargeId, prismaClient = prisma) {
  if (!chargeId) {
    return null;
  }
  return prismaClient.order.findFirst({
    where: {
      stripeChargeId: chargeId
    }
  });
}
async function findOrderByPaymentIntentId(paymentIntentId, prismaClient = prisma) {
  if (!paymentIntentId) {
    return null;
  }
  return prismaClient.order.findFirst({
    where: {
      stripePaymentIntentId: paymentIntentId
    }
  });
}
async function findPayoutRunByStripeReference({
  stripePayoutId,
  payoutRunId
}, prismaClient = prisma) {
  if (stripePayoutId) {
    const byPayoutId = await prismaClient.payoutRun.findFirst({
      where: {
        stripePayoutId
      }
    });
    if (byPayoutId) {
      return byPayoutId;
    }
  }
  if (payoutRunId) {
    return prismaClient.payoutRun.findUnique({
      where: {
        id: payoutRunId
      }
    });
  }
  return null;
}
async function processPaymentIntentSucceeded(event, {
  prismaClient = prisma,
  stripeEventRecordId = null
} = {}) {
  const paymentIntent = event.data?.object;
  const paymentIntentId = normalizeText(paymentIntent?.id);
  const orderId = normalizeText(paymentIntent?.metadata?.orderId);
  const latestChargeId = normalizeText(paymentIntent?.latest_charge?.id) || normalizeText(paymentIntent?.latest_charge);
  const stripeAccountId = normalizeText(event.account);
  const occurredAt = new Date((paymentIntent?.created || event.created) * 1000);
  const order = orderId ? await prismaClient.order.findUnique({
    where: {
      id: orderId
    }
  }) : await findOrderByPaymentIntentId(paymentIntentId, prismaClient);
  if (!order) {
    return;
  }
  await prismaClient.order.update({
    where: {
      id: order.id
    },
    data: {
      status: "paid",
      paidAt: order.paidAt || new Date(),
      stripePaymentIntentId: paymentIntentId || order.stripePaymentIntentId,
      stripeChargeId: latestChargeId || order.stripeChargeId,
      stripeAccountId: stripeAccountId || order.stripeAccountId
    }
  });
  await createLedgerEntry({
    sellerId: order.sellerId,
    sellerStripeAccountId: order.sellerStripeAccountId,
    orderId: order.id,
    stripeEventId: stripeEventRecordId,
    stripeAccountId: stripeAccountId || order.stripeAccountId,
    entryType: "charge",
    stripeObjectId: latestChargeId || paymentIntentId,
    amount: clampInteger(paymentIntent?.amount_received ?? paymentIntent?.amount),
    currencyCode: normalizeLowercase(paymentIntent?.currency) || order.currencyCode,
    direction: "credit",
    description: "Direct charge paid",
    metadataJson: {
      paymentIntentId
    },
    occurredAt
  }, {
    prismaClient
  });
}
async function processApplicationFeeCreated(event, {
  prismaClient = prisma,
  stripeEventRecordId = null
} = {}) {
  const applicationFee = event.data?.object;
  const chargeId = normalizeText(applicationFee?.charge);
  const order = await findOrderByChargeId(chargeId, prismaClient);
  const occurredAt = new Date((applicationFee?.created || event.created) * 1000);
  await createLedgerEntry({
    sellerId: order?.sellerId || null,
    sellerStripeAccountId: order?.sellerStripeAccountId || null,
    orderId: order?.id || null,
    stripeEventId: stripeEventRecordId,
    stripeAccountId: normalizeText(event.account) || order?.stripeAccountId || null,
    entryType: "application_fee",
    stripeObjectId: normalizeText(applicationFee?.id),
    amount: clampInteger(applicationFee?.amount),
    currencyCode: normalizeLowercase(applicationFee?.currency) || DEFAULT_ORDER_CURRENCY,
    direction: "credit",
    description: "Application fee created",
    metadataJson: {
      chargeId
    },
    occurredAt
  }, {
    prismaClient
  });
}
async function processApplicationFeeRefunded(event, {
  prismaClient = prisma,
  stripeEventRecordId = null
} = {}) {
  const object = event.data?.object;
  const chargeId = normalizeText(object?.charge);
  const order = await findOrderByChargeId(chargeId, prismaClient);
  const occurredAt = new Date((object?.created || event.created) * 1000);
  await createLedgerEntry({
    sellerId: order?.sellerId || null,
    sellerStripeAccountId: order?.sellerStripeAccountId || null,
    orderId: order?.id || null,
    stripeEventId: stripeEventRecordId,
    stripeAccountId: normalizeText(event.account) || order?.stripeAccountId || null,
    entryType: "application_fee_refund",
    stripeObjectId: normalizeText(object?.id),
    amount: clampInteger(object?.amount_refunded ?? object?.amount),
    currencyCode: normalizeLowercase(object?.currency) || DEFAULT_ORDER_CURRENCY,
    direction: "debit",
    description: "Application fee refunded",
    metadataJson: {
      chargeId,
      feeId: normalizeText(object?.fee)
    },
    occurredAt
  }, {
    prismaClient
  });
}
async function processChargeRefunded(event, {
  prismaClient = prisma,
  stripeEventRecordId = null
} = {}) {
  const charge = event.data?.object;
  const chargeId = normalizeText(charge?.id);
  const order = await findOrderByChargeId(chargeId, prismaClient);
  const occurredAt = new Date((charge?.created || event.created) * 1000);
  if (order) {
    await prismaClient.order.update({
      where: {
        id: order.id
      },
      data: {
        status: "refunded"
      }
    });
  }
  await createLedgerEntry({
    sellerId: order?.sellerId || null,
    sellerStripeAccountId: order?.sellerStripeAccountId || null,
    orderId: order?.id || null,
    stripeEventId: stripeEventRecordId,
    stripeAccountId: normalizeText(event.account) || order?.stripeAccountId || null,
    entryType: "refund",
    stripeObjectId: chargeId,
    amount: clampInteger(charge?.amount_refunded),
    currencyCode: normalizeLowercase(charge?.currency) || DEFAULT_ORDER_CURRENCY,
    direction: "debit",
    description: "Charge refunded",
    metadataJson: {
      refunded: Boolean(charge?.refunded)
    },
    occurredAt
  }, {
    prismaClient
  });
}
async function processRefundEvent(event, {
  prismaClient = prisma,
  stripeEventRecordId = null
} = {}) {
  const refund = event.data?.object;
  const chargeId = normalizeText(refund?.charge);
  const order = await findOrderByChargeId(chargeId, prismaClient);
  const occurredAt = new Date((refund?.created || event.created) * 1000);
  if (order && normalizeText(refund?.status) === "succeeded") {
    await prismaClient.order.update({
      where: {
        id: order.id
      },
      data: {
        status: "refunded"
      }
    });
  }
  await createLedgerEntry({
    sellerId: order?.sellerId || null,
    sellerStripeAccountId: order?.sellerStripeAccountId || null,
    orderId: order?.id || null,
    stripeEventId: stripeEventRecordId,
    stripeAccountId: normalizeText(event.account) || order?.stripeAccountId || null,
    entryType: "refund",
    stripeObjectId: normalizeText(refund?.id),
    amount: clampInteger(refund?.amount),
    currencyCode: normalizeLowercase(refund?.currency) || DEFAULT_ORDER_CURRENCY,
    direction: "debit",
    description: "Refund updated",
    metadataJson: {
      chargeId,
      refundStatus: normalizeText(refund?.status)
    },
    occurredAt
  }, {
    prismaClient
  });
}
async function processDisputeEvent(event, type, {
  prismaClient = prisma,
  stripeEventRecordId = null
} = {}) {
  const dispute = event.data?.object;
  const chargeId = normalizeText(dispute?.charge);
  const order = await findOrderByChargeId(chargeId, prismaClient);
  const occurredAt = new Date((dispute?.created || event.created) * 1000);
  const disputeStatus = normalizeText(dispute?.status);
  if (order) {
    await prismaClient.order.update({
      where: {
        id: order.id
      },
      data: {
        status: type === "dispute_created" ? "disputed" : disputeStatus === "won" ? "paid" : "disputed"
      }
    });
    if (type === "dispute_created" || type === "dispute_updated" || type === "dispute_funds_withdrawn" || type === "dispute_closed" && disputeStatus !== "won") {
      await setSellerReviewStatus({
        sellerId: order.sellerId,
        reason: SELLER_REVIEW_REASON_DISPUTE,
        changedBy: `stripe.${event.type}`
      }, {
        prismaClient
      });
    }
  }
  await createLedgerEntry({
    sellerId: order?.sellerId || null,
    sellerStripeAccountId: order?.sellerStripeAccountId || null,
    orderId: order?.id || null,
    stripeEventId: stripeEventRecordId,
    stripeAccountId: normalizeText(event.account) || order?.stripeAccountId || null,
    entryType: type,
    stripeObjectId: normalizeText(dispute?.id),
    amount: clampInteger(dispute?.amount),
    currencyCode: normalizeLowercase(dispute?.currency) || DEFAULT_ORDER_CURRENCY,
    direction: type === "dispute_funds_reinstated" ? "credit" : "debit",
    description: type === "dispute_created" ? "Charge dispute opened" : type === "dispute_funds_withdrawn" ? "Dispute funds withdrawn" : type === "dispute_funds_reinstated" ? "Dispute funds reinstated" : "Charge dispute updated",
    metadataJson: {
      chargeId,
      disputeStatus,
      disputeEventType: event.type
    },
    occurredAt
  }, {
    prismaClient
  });
}
async function processPayoutEvent(event, type, {
  prismaClient = prisma,
  stripeEventRecordId = null
} = {}) {
  const payout = event.data?.object;
  const payoutRun = await findPayoutRunByStripeReference({
    stripePayoutId: normalizeText(payout?.id),
    payoutRunId: normalizeText(payout?.metadata?.payoutRunId)
  }, prismaClient);
  const occurredAt = new Date((payout?.created || event.created) * 1000);
  const nextStatus = type === "payout_failed" ? "failed" : payoutRun?.status === "approved" ? "executed" : payoutRun?.status || "executed";
  if (payoutRun) {
    await prismaClient.payoutRun.update({
      where: {
        id: payoutRun.id
      },
      data: {
        stripePayoutId: normalizeText(payout?.id) || payoutRun.stripePayoutId,
        status: nextStatus,
        failureCode: type === "payout_failed" ? normalizeText(payout?.failure_code) : payoutRun.failureCode,
        failureMessage: type === "payout_failed" ? normalizeText(payout?.failure_message) : payoutRun.failureMessage
      }
    });
    if (type === "payout_failed") {
      await setSellerReviewStatus({
        sellerId: payoutRun.sellerId,
        reason: SELLER_REVIEW_REASON_PAYOUT_FAILED,
        changedBy: "stripe.payout.failed"
      }, {
        prismaClient
      });
    }
  }
  if (type === "payout_paid") {
    await createLedgerEntry({
      sellerId: payoutRun?.sellerId || null,
      sellerStripeAccountId: payoutRun?.sellerStripeAccountId || null,
      stripeEventId: stripeEventRecordId,
      payoutRunId: payoutRun?.id || null,
      stripeAccountId: normalizeText(event.account) || payoutRun?.stripeAccountId || null,
      entryType: type,
      stripeObjectId: normalizeText(payout?.id),
      amount: clampInteger(payout?.amount),
      currencyCode: normalizeLowercase(payout?.currency) || DEFAULT_ORDER_CURRENCY,
      direction: "debit",
      description: `Payout ${type}`,
      metadataJson: {
        destination: normalizeText(payout?.destination),
        arrivalDate: payout?.arrival_date || null
      },
      occurredAt
    }, {
      prismaClient
    });
  }
}
async function processStripeEventByType(event, {
  prismaClient = prisma,
  stripeEventRecordId = null
} = {}) {
  switch (event.type) {
    case "account.updated":
      await processAccountUpdated(event, {
        prismaClient
      });
      return;
    case "account.external_account.updated":
      await processExternalAccountUpdated(event, {
        prismaClient
      });
      return;
    case "payment_intent.succeeded":
      await processPaymentIntentSucceeded(event, {
        prismaClient,
        stripeEventRecordId
      });
      return;
    case "application_fee.created":
      await processApplicationFeeCreated(event, {
        prismaClient,
        stripeEventRecordId
      });
      return;
    case "application_fee.refunded":
    case "application_fee.refund.updated":
      await processApplicationFeeRefunded(event, {
        prismaClient,
        stripeEventRecordId
      });
      return;
    case "charge.refunded":
      await processChargeRefunded(event, {
        prismaClient,
        stripeEventRecordId
      });
      return;
    case "refund.created":
    case "refund.updated":
      await processRefundEvent(event, {
        prismaClient,
        stripeEventRecordId
      });
      return;
    case "charge.dispute.created":
      await processDisputeEvent(event, "dispute_created", {
        prismaClient,
        stripeEventRecordId
      });
      return;
    case "charge.dispute.updated":
      await processDisputeEvent(event, "dispute_updated", {
        prismaClient,
        stripeEventRecordId
      });
      return;
    case "charge.dispute.funds_withdrawn":
      await processDisputeEvent(event, "dispute_funds_withdrawn", {
        prismaClient,
        stripeEventRecordId
      });
      return;
    case "charge.dispute.funds_reinstated":
      await processDisputeEvent(event, "dispute_funds_reinstated", {
        prismaClient,
        stripeEventRecordId
      });
      return;
    case "charge.dispute.closed":
      await processDisputeEvent(event, "dispute_closed", {
        prismaClient,
        stripeEventRecordId
      });
      return;
    case "payout.created":
      await processPayoutEvent(event, "payout_created", {
        prismaClient,
        stripeEventRecordId
      });
      return;
    case "payout.paid":
      await processPayoutEvent(event, "payout_paid", {
        prismaClient,
        stripeEventRecordId
      });
      return;
    case "payout.failed":
      await processPayoutEvent(event, "payout_failed", {
        prismaClient,
        stripeEventRecordId
      });
      return;
    default:
      return;
  }
}
export async function handleStripeWebhook({
  rawBody,
  signature
}, {
  prismaClient = prisma,
  stripeClient = getStripeClient()
} = {}) {
  const webhookSecrets = getStripeWebhookSecrets();
  let event = null;
  let webhookSecretType = null;
  let signatureError = null;
  for (const webhookSecret of webhookSecrets) {
    try {
      event = stripeClient.webhooks.constructEvent(rawBody, signature, webhookSecret.secret);
      webhookSecretType = webhookSecret.type;
      break;
    } catch (error) {
      signatureError = error;
    }
  }
  if (!event) {
    throw signatureError || new Error("STRIPE_WEBHOOK_SIGNATURE_INVALID");
  }
  const existingEvent = await prismaClient.stripeEvent.findUnique({
    where: {
      stripeEventId: event.id
    }
  });
  if (existingEvent) {
    return {
      ok: true,
      duplicate: true,
      eventId: event.id,
      webhookSecretType
    };
  }
  const stripeObject = event?.data?.object || {};
  const safeMetadata = ["orderId", "sellerId", "vendorId", "payoutRunId"].reduce((result, key) => {
    const value = normalizeText(stripeObject?.metadata?.[key]);
    if (value) result[key] = value;
    return result;
  }, {});
  const payloadJson = {
    schemaVersion: 1,
    eventId: normalizeText(event.id),
    eventType: normalizeText(event.type),
    eventCreated: Number.isFinite(Number(event.created)) ? Number(event.created) : null,
    accountId: normalizeText(event.account),
    livemode: Boolean(event.livemode),
    webhookSecretType,
    object: {
      id: normalizeText(stripeObject.id),
      objectType: normalizeText(stripeObject.object),
      status: normalizeText(stripeObject.status),
      amount: Number.isFinite(Number(stripeObject.amount)) ? Number(stripeObject.amount) : null,
      amountReceived: Number.isFinite(Number(stripeObject.amount_received)) ? Number(stripeObject.amount_received) : null,
      amountPaid: Number.isFinite(Number(stripeObject.amount_paid)) ? Number(stripeObject.amount_paid) : null,
      currency: normalizeText(stripeObject.currency)?.toLowerCase() || null,
      paymentIntentId: normalizeText(stripeObject.payment_intent || (stripeObject.object === "payment_intent" ? stripeObject.id : null)),
      chargeId: normalizeText(stripeObject.charge || stripeObject.latest_charge),
      payoutId: normalizeText(stripeObject.payout || (stripeObject.object === "payout" ? stripeObject.id : null)),
      failureCode: normalizeText(stripeObject.failure_code || stripeObject.last_payment_error?.code),
      metadata: safeMetadata
    }
  };
  const savedEvent = await prismaClient.stripeEvent.create({
    data: {
      stripeEventId: event.id,
      stripeAccountId: normalizeText(event.account),
      type: event.type,
      livemode: Boolean(event.livemode),
      payloadJson,
      processingStatus: "pending"
    }
  });
  try {
    await processStripeEventByType(event, {
      prismaClient,
      stripeEventRecordId: savedEvent.id
    });
    await markStripeEventProcessed(event.id, {
      prismaClient
    });
    return {
      ok: true,
      duplicate: false,
      eventId: event.id,
      webhookSecretType
    };
  } catch (error) {
    console.error("stripe webhook processing error:", error);
    await markStripeEventFailed(event.id, error instanceof Error ? error.message : String(error), {
      prismaClient
    });
    throw error;
  }
}

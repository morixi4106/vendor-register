import crypto from "node:crypto";

import prisma from "../db.server.js";

const PROCESSING_LEASE_MS = 10 * 60 * 1000;

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeTopic(value) {
  return normalizeText(value).toUpperCase().replaceAll("/", "_");
}

function toValidDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function payloadHash(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload ?? null))
    .digest("hex");
}

function getResourceId(payload) {
  return normalizeText(
    payload?.admin_graphql_api_id ||
      payload?.order_id ||
      payload?.id ||
      payload?.refund_id,
  );
}

function getHeader(request, name) {
  return normalizeText(request?.headers?.get?.(name));
}

export function buildShopifyWebhookReceiptInput({
  request,
  payload,
  topic,
  shop,
  now = new Date(),
}) {
  const shopDomain = normalizeText(
    shop || getHeader(request, "x-shopify-shop-domain"),
  ).toLowerCase();
  const normalizedTopic = normalizeTopic(
    topic || getHeader(request, "x-shopify-topic"),
  );
  const hash = payloadHash(payload);
  const webhookId =
    getHeader(request, "x-shopify-webhook-id") ||
    `legacy:${normalizedTopic}:${hash}`;

  return {
    shopDomain,
    webhookId,
    eventId: getHeader(request, "x-shopify-event-id") || null,
    topic: normalizedTopic,
    resourceId: getResourceId(payload) || null,
    payloadHash: hash,
    triggeredAt:
      toValidDate(getHeader(request, "x-shopify-triggered-at")) || null,
    receivedAt: now,
    lastAttemptAt: now,
  };
}

export async function beginShopifyWebhookProcessing(
  input,
  { prismaClient = prisma, now = new Date() } = {},
) {
  if (!prismaClient?.shopifyWebhookReceipt) {
    return {
      ok: true,
      tracked: false,
      duplicate: false,
      reason: "webhook_receipt_store_unavailable",
    };
  }

  const receiptInput = buildShopifyWebhookReceiptInput({
    ...input,
    now,
  });
  if (
    !receiptInput.shopDomain ||
    !receiptInput.webhookId ||
    !receiptInput.topic
  ) {
    return {
      ok: false,
      tracked: false,
      duplicate: false,
      reason: "webhook_receipt_input_invalid",
    };
  }

  try {
    const receipt = await prismaClient.shopifyWebhookReceipt.create({
      data: {
        ...receiptInput,
        processingStatus: "PROCESSING",
        attemptCount: 1,
      },
    });
    return { ok: true, tracked: true, duplicate: false, receipt };
  } catch (error) {
    if (error?.code !== "P2002") throw error;
  }

  const existing = await prismaClient.shopifyWebhookReceipt.findUnique({
    where: {
      shopDomain_webhookId: {
        shopDomain: receiptInput.shopDomain,
        webhookId: receiptInput.webhookId,
      },
    },
  });
  if (!existing) {
    return {
      ok: false,
      tracked: true,
      duplicate: false,
      reason: "webhook_receipt_conflict_unresolved",
    };
  }
  if (existing.payloadHash !== receiptInput.payloadHash) {
    return {
      ok: false,
      tracked: true,
      duplicate: false,
      reason: "webhook_receipt_payload_hash_conflict",
      receipt: existing,
    };
  }
  if (existing.processingStatus === "PROCESSED") {
    return {
      ok: true,
      tracked: true,
      duplicate: true,
      reason: "webhook_already_processed",
      receipt: existing,
    };
  }

  const leaseExpired =
    !existing.lastAttemptAt ||
    existing.lastAttemptAt.getTime() <= now.getTime() - PROCESSING_LEASE_MS;
  if (existing.processingStatus === "PROCESSING" && !leaseExpired) {
    return {
      ok: true,
      tracked: true,
      duplicate: true,
      reason: "webhook_processing_in_progress",
      receipt: existing,
    };
  }

  const claimed = await prismaClient.shopifyWebhookReceipt.updateMany({
    where: {
      id: existing.id,
      lastAttemptAt: existing.lastAttemptAt,
      processingStatus: existing.processingStatus,
    },
    data: {
      processingStatus: "PROCESSING",
      attemptCount: { increment: 1 },
      lastAttemptAt: now,
      lastErrorCode: null,
    },
  });
  if (claimed.count !== 1) {
    return {
      ok: true,
      tracked: true,
      duplicate: true,
      reason: "webhook_retry_claim_lost",
      receipt: existing,
    };
  }

  return {
    ok: true,
    tracked: true,
    duplicate: false,
    retry: true,
    receipt: {
      ...existing,
      processingStatus: "PROCESSING",
      attemptCount: existing.attemptCount + 1,
      lastAttemptAt: now,
    },
  };
}

export async function completeShopifyWebhookProcessing(
  receipt,
  { prismaClient = prisma, now = new Date(), metadataJson = null } = {},
) {
  if (!receipt?.tracked || !receipt?.receipt?.id) return;
  await prismaClient.shopifyWebhookReceipt.updateMany({
    where: {
      id: receipt.receipt.id,
      processingStatus: "PROCESSING",
    },
    data: {
      processingStatus: "PROCESSED",
      processedAt: now,
      lastErrorCode: null,
      metadataJson,
    },
  });
}

export async function failShopifyWebhookProcessing(
  receipt,
  error,
  { prismaClient = prisma, now = new Date() } = {},
) {
  if (!receipt?.tracked || !receipt?.receipt?.id) return;
  await prismaClient.shopifyWebhookReceipt.updateMany({
    where: {
      id: receipt.receipt.id,
      processingStatus: "PROCESSING",
    },
    data: {
      processingStatus: "FAILED",
      lastAttemptAt: now,
      lastErrorCode: normalizeText(
        error?.code ||
          error?.reason ||
          error?.name ||
          "webhook_processing_failed",
      ).slice(0, 120),
    },
  });
}

export function normalizeShopifyWebhookHandlerResult(result) {
  const normalized =
    result && typeof result === "object" ? { ...result } : { ok: true };
  if (normalized.ok !== false) {
    return {
      ...normalized,
      ok: true,
      terminal: true,
      retryable: false,
    };
  }
  if (
    normalized.terminal === true ||
    normalized.quarantined === true ||
    normalized.retryable === false
  ) {
    return {
      ...normalized,
      terminal: true,
      retryable: false,
      expectedSkip:
        normalized.expectedSkip === true || normalized.quarantined === true,
    };
  }
  return {
    ...normalized,
    terminal: false,
    retryable: true,
  };
}

export async function withShopifyWebhookReceipt(
  { request, payload, topic, shop, handler },
  { prismaClient = prisma, now = new Date() } = {},
) {
  const receipt = await beginShopifyWebhookProcessing(
    { request, payload, topic, shop },
    { prismaClient, now },
  );
  if (!receipt.ok) {
    const error = new Error(receipt.reason || "webhook_receipt_rejected");
    error.code = receipt.reason || "webhook_receipt_rejected";
    throw error;
  }
  if (receipt.duplicate) {
    return {
      ok: true,
      duplicate: true,
      reason: receipt.reason,
      result: null,
    };
  }

  try {
    const result = normalizeShopifyWebhookHandlerResult(await handler());
    if (result.retryable === true) {
      const error = new Error(
        normalizeText(result.reason) || "webhook_handler_retry_required",
      );
      error.code =
        normalizeText(result.reason) || "webhook_handler_retry_required";
      error.result = result;
      throw error;
    }
    await completeShopifyWebhookProcessing(receipt, {
      prismaClient,
      now: new Date(),
      metadataJson: {
        handled: true,
        resultOk: result.ok === true,
        terminal: result.terminal === true,
        expectedSkip: result.expectedSkip === true,
        resultReason: normalizeText(result?.reason) || null,
      },
    });
    return { ok: true, duplicate: false, result };
  } catch (error) {
    await failShopifyWebhookProcessing(receipt, error, {
      prismaClient,
      now: new Date(),
    }).catch(() => {});
    throw error;
  }
}

export const SHOPIFY_WEBHOOK_INBOX = Object.freeze({
  processingLeaseMs: PROCESSING_LEASE_MS,
});

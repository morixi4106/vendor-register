import assert from "node:assert/strict";
import test from "node:test";

import {
  beginShopifyWebhookProcessing,
  buildShopifyWebhookReceiptInput,
  SHOPIFY_WEBHOOK_INBOX,
  withShopifyWebhookReceipt,
} from "../../app/services/shopifyWebhookInbox.server.js";

function requestWithHeaders(headers = {}) {
  return new Request("https://example.test/webhook", { headers });
}

function createReceiptStore() {
  const rows = [];
  return {
    rows,
    prisma: {
      shopifyWebhookReceipt: {
        async create({ data }) {
          if (
            rows.some(
              (row) =>
                row.shopDomain === data.shopDomain &&
                row.webhookId === data.webhookId,
            )
          ) {
            const error = new Error("duplicate");
            error.code = "P2002";
            throw error;
          }
          const row = { id: `receipt-${rows.length + 1}`, ...data };
          rows.push(row);
          return row;
        },
        async findUnique({ where }) {
          const key = where.shopDomain_webhookId;
          const row =
            rows.find(
              (row) =>
                row.shopDomain === key.shopDomain &&
                row.webhookId === key.webhookId,
            ) || null;
          return row ? { ...row } : null;
        },
        async updateMany({ where, data }) {
          const row = rows.find((candidate) => {
            if (candidate.id !== where.id) return false;
            if (
              where.processingStatus &&
              candidate.processingStatus !== where.processingStatus
            ) {
              return false;
            }
            if (
              Object.hasOwn(where, "lastAttemptAt") &&
              candidate.lastAttemptAt !== where.lastAttemptAt
            ) {
              return false;
            }
            return true;
          });
          if (!row) return { count: 0 };
          const attemptIncrement = data.attemptCount?.increment || 0;
          const previousAttemptCount = row.attemptCount;
          Object.assign(row, data);
          if (attemptIncrement) {
            row.attemptCount = previousAttemptCount + attemptIncrement;
          }
          return { count: 1 };
        },
      },
    },
  };
}

const baseInput = {
  request: requestWithHeaders({
    "x-shopify-webhook-id": "webhook-1",
    "x-shopify-event-id": "event-1",
  }),
  payload: { admin_graphql_api_id: "gid://shopify/Order/1" },
  topic: "ORDERS_PAID",
  shop: "example.myshopify.com",
};

test("receipt input preserves Shopify identifiers without storing payload contents", () => {
  const input = buildShopifyWebhookReceiptInput(baseInput);
  assert.equal(input.webhookId, "webhook-1");
  assert.equal(input.eventId, "event-1");
  assert.equal(input.topic, "ORDERS_PAID");
  assert.equal(input.resourceId, "gid://shopify/Order/1");
  assert.match(input.payloadHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(input, "payload"), false);
});

test("processed webhook retries are deduplicated", async () => {
  const store = createReceiptStore();
  let calls = 0;

  const first = await withShopifyWebhookReceipt(
    { ...baseInput, handler: async () => ({ ok: true }) },
    { prismaClient: store.prisma },
  );
  const second = await withShopifyWebhookReceipt(
    {
      ...baseInput,
      handler: async () => {
        calls += 1;
      },
    },
    { prismaClient: store.prisma },
  );

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(calls, 0);
  assert.equal(store.rows[0].processingStatus, "PROCESSED");
});

test("stale processing receipts are reclaimed but active leases are not", async () => {
  const store = createReceiptStore();
  const startedAt = new Date("2026-07-24T00:00:00.000Z");
  await beginShopifyWebhookProcessing(baseInput, {
    prismaClient: store.prisma,
    now: startedAt,
  });

  const active = await beginShopifyWebhookProcessing(baseInput, {
    prismaClient: store.prisma,
    now: new Date(
      startedAt.getTime() + SHOPIFY_WEBHOOK_INBOX.processingLeaseMs - 1,
    ),
  });
  const stale = await beginShopifyWebhookProcessing(baseInput, {
    prismaClient: store.prisma,
    now: new Date(
      startedAt.getTime() + SHOPIFY_WEBHOOK_INBOX.processingLeaseMs + 1,
    ),
  });

  assert.equal(active.duplicate, true);
  assert.equal(active.reason, "webhook_processing_in_progress");
  assert.equal(stale.duplicate, false);
  assert.equal(stale.retry, true);
  assert.equal(stale.receipt.attemptCount, 2);
});

test("same webhook id with a different payload is rejected", async () => {
  const store = createReceiptStore();
  await beginShopifyWebhookProcessing(baseInput, {
    prismaClient: store.prisma,
  });
  const conflict = await beginShopifyWebhookProcessing(
    { ...baseInput, payload: { id: "different-order" } },
    { prismaClient: store.prisma },
  );

  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "webhook_receipt_payload_hash_conflict");
});

test("handler failures mark the receipt failed for a later retry", async () => {
  const store = createReceiptStore();
  await assert.rejects(
    withShopifyWebhookReceipt(
      {
        ...baseInput,
        handler: async () => {
          const error = new Error("boom");
          error.code = "TEST_FAILURE";
          throw error;
        },
      },
      { prismaClient: store.prisma },
    ),
    /boom/,
  );

  assert.equal(store.rows[0].processingStatus, "FAILED");
  assert.equal(store.rows[0].lastErrorCode, "TEST_FAILURE");
  const retry = await beginShopifyWebhookProcessing(baseInput, {
    prismaClient: store.prisma,
  });
  assert.equal(retry.retry, true);
});

test("a bare ok false result is retryable and cannot be marked processed", async () => {
  const store = createReceiptStore();
  await assert.rejects(
    withShopifyWebhookReceipt(
      {
        ...baseInput,
        handler: async () => ({
          ok: false,
          reason: "seller_mapping_temporarily_unavailable",
        }),
      },
      { prismaClient: store.prisma },
    ),
    /seller_mapping_temporarily_unavailable/,
  );

  assert.equal(store.rows[0].processingStatus, "FAILED");
  assert.equal(
    store.rows[0].lastErrorCode,
    "seller_mapping_temporarily_unavailable",
  );
});

test("a quarantined result is an explicit safe terminal outcome", async () => {
  const store = createReceiptStore();
  const delivery = await withShopifyWebhookReceipt(
    {
      ...baseInput,
      handler: async () => ({
        ok: false,
        quarantined: true,
        reason: "paid_order_sale_eligibility_review_required",
      }),
    },
    { prismaClient: store.prisma },
  );

  assert.equal(delivery.result.terminal, true);
  assert.equal(delivery.result.retryable, false);
  assert.equal(delivery.result.expectedSkip, true);
  assert.equal(store.rows[0].processingStatus, "PROCESSED");
  assert.equal(store.rows[0].metadataJson.expectedSkip, true);
});

test("an explicitly non-retryable failure is a terminal outcome", async () => {
  const store = createReceiptStore();
  const delivery = await withShopifyWebhookReceipt(
    {
      ...baseInput,
      handler: async () => ({
        ok: false,
        retryable: false,
        expectedSkip: true,
        reason: "invalid_shopify_order_payload",
      }),
    },
    { prismaClient: store.prisma },
  );

  assert.equal(delivery.result.terminal, true);
  assert.equal(delivery.result.retryable, false);
  assert.equal(store.rows[0].processingStatus, "PROCESSED");
});

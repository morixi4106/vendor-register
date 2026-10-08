import assert from "node:assert/strict";
import test from "node:test";
import {
  receivePrivacyRightsRequest,
  resolvePrivacyRightsRequest,
} from "../../app/services/privacyRights.server.js";

test("Shopify privacy requests persist no raw email or payload and are idempotent", async () => {
  const rows = new Map();
  const prismaClient = {
    privacyRightsRequest: {
      upsert: async ({ where, create }) => {
        if (!rows.has(where.requestKey))
          rows.set(where.requestKey, {
            id: "request",
            status: "RECEIVED",
            ...create,
          });
        return rows.get(where.requestKey);
      },
    },
  };
  const now = new Date("2026-10-08T00:00:00Z");
  const args = {
    shopDomain: "shop.myshopify.com",
    topic: "CUSTOMERS_REDACT",
    webhookId: "delivery",
    payload: {
      customer: { id: 123, email: "customer@example.com", phone: "12345678" },
      orders_to_redact: [1001],
    },
  };
  const options = {
    prismaClient,
    now,
    env: { PRIVACY_HASH_SECRET: "x".repeat(64) },
  };
  await receivePrivacyRightsRequest(args, options);
  await receivePrivacyRightsRequest(args, options);
  assert.equal(rows.size, 1);
  const row = [...rows.values()][0];
  assert.equal(row.status, "RECEIVED");
  assert.equal(row.shopifyCustomerId, "123");
  assert.equal(row.deadlineAt.toISOString(), "2026-11-07T00:00:00.000Z");
  assert.ok(!JSON.stringify(row).includes("customer@example.com"));
  assert.ok(!JSON.stringify(row).includes("12345678"));
});

test("privacy completion requires evidence and cannot rewrite a completed decision", async () => {
  let updates = 0;
  const prismaClient = {
    privacyRightsRequest: {
      updateMany: async ({ where }) => {
        assert.equal(where.status, "RECEIVED");
        updates++;
        return { count: 0 };
      },
    },
  };
  assert.equal(
    (
      await resolvePrivacyRightsRequest(
        { id: "request", status: "COMPLETED" },
        { prismaClient },
      )
    ).ok,
    false,
  );
  assert.equal(updates, 0);
  assert.equal(
    (
      await resolvePrivacyRightsRequest(
        {
          id: "request",
          status: "COMPLETED",
          evidenceReference: "ticket",
          evidenceHash: "a".repeat(64),
          actor: "owner",
        },
        { prismaClient },
      )
    ).ok,
    false,
  );
});

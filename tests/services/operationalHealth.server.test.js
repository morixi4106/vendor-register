import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateShopifyProductCatalogSyncRun,
  recordOperationalHeartbeat,
} from "../../app/services/operationalHealth.server.js";

test("evaluateShopifyProductCatalogSyncRun only accepts a complete sync", () => {
  assert.deepEqual(
    evaluateShopifyProductCatalogSyncRun({
      result: { unresolved: 0 },
      checkoutPolicies: { ok: true, failedCount: 0 },
    }),
    {
      complete: true,
      errorCode: null,
      unresolved: 0,
      checkoutPolicyFailedCount: 0,
    },
  );

  assert.deepEqual(
    evaluateShopifyProductCatalogSyncRun({
      result: { unresolved: 2 },
      checkoutPolicies: { ok: false, failedCount: 1 },
    }),
    {
      complete: false,
      errorCode: "shopify_product_catalog_sync_incomplete",
      unresolved: 2,
      checkoutPolicyFailedCount: 1,
    },
  );
});

test("recordOperationalHeartbeat records success and clears the last error", async () => {
  const calls = [];
  const now = new Date("2026-07-17T12:00:00.000Z");
  const prismaClient = {
    operationalHeartbeat: {
      upsert: async (input) => {
        calls.push(input);
        return input.update;
      },
    },
  };

  await recordOperationalHeartbeat(
    {
      key: "withdrawal_email_outbox",
      status: "succeeded",
      metadataJson: { processed: 2 },
    },
    { prismaClient, now },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].where, { key: "withdrawal_email_outbox" });
  assert.equal(calls[0].update.lastSucceededAt, now);
  assert.equal(calls[0].update.lastErrorCode, null);
  assert.deepEqual(calls[0].update.metadataJson, { processed: 2 });
});

test("recordOperationalHeartbeat rejects unsupported statuses", async () => {
  await assert.rejects(
    recordOperationalHeartbeat(
      { key: "worker", status: "unknown" },
      { prismaClient: {} },
    ),
    /operational_heartbeat_status_invalid/,
  );
});

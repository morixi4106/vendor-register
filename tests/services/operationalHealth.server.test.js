import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateShopifyProductCatalogSyncFreshness,
  evaluateShopifyProductCatalogSyncRun,
  recordOperationalHeartbeat,
} from "../../app/services/operationalHealth.server.js";

test("evaluateShopifyProductCatalogSyncRun only accepts a complete sync", () => {
  assert.deepEqual(
    evaluateShopifyProductCatalogSyncRun({
      result: {
        ok: true,
        complete: true,
        unresolved: 0,
        incompleteReason: null,
      },
      checkoutPolicies: { ok: true, failedCount: 0 },
    }),
    {
      complete: true,
      errorCode: null,
      unresolved: 0,
      checkoutPolicyFailedCount: 0,
      catalogComplete: true,
      incompleteReason: null,
    },
  );

  assert.deepEqual(
    evaluateShopifyProductCatalogSyncRun({
      result: {
        ok: false,
        complete: false,
        unresolved: 2,
        incompleteReason: "safety_page_limit_reached",
      },
      checkoutPolicies: { ok: true, failedCount: 0 },
    }),
    {
      complete: false,
      errorCode: "shopify_product_catalog_sync_incomplete",
      unresolved: 2,
      checkoutPolicyFailedCount: 0,
      catalogComplete: false,
      incompleteReason: "safety_page_limit_reached",
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

test("catalog freshness becomes critical at the configured fail-safe limit", () => {
  const now = new Date("2026-07-24T12:00:00.000Z");
  const freshness = evaluateShopifyProductCatalogSyncFreshness({
    heartbeat: {
      lastSucceededAt: new Date("2026-07-24T08:59:59.000Z"),
    },
    now,
  });

  assert.equal(freshness.status, "critical");
  assert.equal(freshness.reason, "catalog_sync_critical_stale");
  assert.equal(freshness.ageMinutes > 180, true);
});

test("catalog freshness fails closed without a successful heartbeat", () => {
  const freshness = evaluateShopifyProductCatalogSyncFreshness({
    heartbeat: null,
    now: new Date("2026-07-24T12:00:00.000Z"),
  });

  assert.equal(freshness.status, "critical");
  assert.equal(freshness.reason, "catalog_sync_success_missing");
});

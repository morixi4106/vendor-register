import assert from "node:assert/strict";
import test from "node:test";

import {
  activateShopifyControlLossHold,
  CRITICAL_SHOPIFY_SCOPES,
  inspectCriticalShopifyScopes,
  SHOPIFY_APP_CONTROL_HEARTBEAT_KEY,
} from "../../app/services/shopifyAppControlLoss.server.js";

test("critical scope inspection identifies removed capabilities", () => {
  const complete = inspectCriticalShopifyScopes(CRITICAL_SHOPIFY_SCOPES);
  const missing = inspectCriticalShopifyScopes(
    CRITICAL_SHOPIFY_SCOPES.filter(
      (scope) => scope !== "write_publications",
    ).join(","),
  );

  assert.equal(complete.ready, true);
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.missingScopes, ["write_publications"]);
});

test("control loss activates a fail-closed platform hold and heartbeat", async () => {
  const calls = [];
  const prismaClient = {
    platformOperationalControl: {
      async upsert(args) {
        calls.push({ type: "control", args });
        return args.create;
      },
    },
    operationalHeartbeat: {
      async upsert(args) {
        calls.push({ type: "heartbeat", args });
        return args.create;
      },
    },
  };
  const result = await activateShopifyControlLossHold(
    {
      shopDomain: "example.myshopify.com",
      reason: "shopify_critical_scopes_missing",
      missingScopes: ["write_publications"],
      eventType: "APP_SCOPES_UPDATE",
    },
    {
      prismaClient,
      now: new Date("2026-07-24T00:00:00.000Z"),
    },
  );

  assert.equal(result.held, true);
  const control = calls.find((entry) => entry.type === "control").args;
  assert.equal(control.create.checkoutHold, true);
  assert.equal(control.create.checkoutControlState, "PARTIAL_FAILURE");
  assert.deepEqual(control.create.metadataJson.missingScopes, [
    "write_publications",
  ]);
  const heartbeat = calls.find((entry) => entry.type === "heartbeat").args;
  assert.equal(heartbeat.where.key, SHOPIFY_APP_CONTROL_HEARTBEAT_KEY);
  assert.equal(
    heartbeat.create.lastErrorCode,
    "shopify_critical_scopes_missing",
  );
});

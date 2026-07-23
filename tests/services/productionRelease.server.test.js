import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProductionReleaseExpectation,
  createProductionProbeChallenge,
  inspectProductionReleaseEvidence,
  verifyProductionProbeChallenge,
} from "../../app/services/productionRelease.server.js";

function buildReadiness(metadataJson) {
  return {
    rows: [
      {
        definition: {
          key: "CHECKOUT_VALIDATION_LIVE_PROBE_COMPLETED",
        },
        ready: true,
        attestation: { metadataJson },
      },
    ],
  };
}

function completeProbes() {
  const definitions = {
    directProductAllowed: "checkout_allowed",
    blockedProductRejected: "checkout_rejected",
    globalStopRejected: "checkout_rejected",
    shopPayObserved: "checkout_allowed",
  };
  return Object.fromEntries(
    Object.entries(definitions).map(([scenarioId, expectedResult]) => [
      scenarioId,
      {
        scenarioId,
        passed: true,
        expectedResult,
        actualResult: expectedResult,
        observedAt: "2026-07-24T10:00:00.000Z",
        evidenceReference: `evidence:${scenarioId}`,
        evidenceHash: "a".repeat(64),
        projectionRevision: "42",
      },
    ]),
  );
}

test("production release evidence matches the current Render and Shopify identities", () => {
  const checkoutValidation = {
    validation: {
      id: "gid://shopify/Validation/1",
      shopifyFunction: {
        id: "gid://shopify/ShopifyFunction/1",
        apiVersion: "2026-04",
      },
    },
  };
  const expected = buildProductionReleaseExpectation({
    env: {
      RENDER_GIT_COMMIT: "a".repeat(40),
      SHOPIFY_APP_VERSION: "version-42",
      SHOPIFY_PRIMARY_SHOP_DOMAIN: "example.myshopify.com",
    },
    checkoutValidation,
  });
  const metadataJson = {
    releaseManifest: { ...expected },
    challengeNonce: "nonce-with-at-least-16-characters",
    executedBy: "shopify_user:1",
    probes: completeProbes(),
  };

  const result = inspectProductionReleaseEvidence({
    operationalReadiness: buildReadiness(metadataJson),
    expected,
  });

  assert.equal(result.ready, true);
  assert.deepEqual(result.mismatches, []);
});

test("production release evidence rejects a stale Function or Render identity", () => {
  const expected = buildProductionReleaseExpectation({
    env: {
      RENDER_GIT_COMMIT: "b".repeat(40),
      SHOPIFY_APP_VERSION: "version-43",
      SHOPIFY_PRIMARY_SHOP_DOMAIN: "example.myshopify.com",
    },
    checkoutValidation: {
      validation: {
        id: "gid://shopify/Validation/2",
        shopifyFunction: {
          id: "gid://shopify/ShopifyFunction/2",
          apiVersion: "2026-04",
        },
      },
    },
  });
  const metadataJson = {
    releaseManifest: {
      ...expected,
      renderCommit: "old-commit",
      functionId: "gid://shopify/ShopifyFunction/old",
    },
    challengeNonce: "nonce-with-at-least-16-characters",
    executedBy: "shopify_user:1",
    probes: completeProbes(),
  };

  const result = inspectProductionReleaseEvidence({
    operationalReadiness: buildReadiness(metadataJson),
    expected,
  });

  assert.equal(result.ready, false);
  assert.equal(result.mismatches.includes("renderCommit_mismatch"), true);
  assert.equal(result.mismatches.includes("functionId_mismatch"), true);
});

test("production probe challenge is signed, scoped, and expires", () => {
  const now = new Date("2026-07-24T00:00:00.000Z");
  const env = {
    PRODUCTION_PROBE_SIGNING_SECRET: "probe-secret-".repeat(4),
    RENDER_GIT_COMMIT: "c".repeat(40),
    SHOPIFY_APP_VERSION: "version-44",
    SHOPIFY_PRIMARY_SHOP_DOMAIN: "example.myshopify.com",
  };
  const expected = buildProductionReleaseExpectation({ env });
  const challenge = createProductionProbeChallenge(
    {
      expected,
      shopDomain: "example.myshopify.com",
      actorKey: "shopify_user:1",
      now,
      ttlMinutes: 30,
    },
    { env },
  );

  assert.equal(
    verifyProductionProbeChallenge(
      challenge.token,
      {
        expected,
        shopDomain: "example.myshopify.com",
        actorKey: "shopify_user:1",
        now: new Date("2026-07-24T00:10:00.000Z"),
      },
      { env },
    ).ok,
    true,
  );
  assert.equal(
    verifyProductionProbeChallenge(
      challenge.token,
      {
        expected,
        shopDomain: "other.myshopify.com",
        actorKey: "shopify_user:1",
        now: new Date("2026-07-24T00:10:00.000Z"),
      },
      { env },
    ).ok,
    false,
  );
  assert.equal(
    verifyProductionProbeChallenge(
      challenge.token,
      {
        expected,
        shopDomain: "example.myshopify.com",
        actorKey: "shopify_user:1",
        now: new Date("2026-07-24T00:31:00.000Z"),
      },
      { env },
    ).ok,
    false,
  );
});

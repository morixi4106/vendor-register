import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPlatformCheckoutEmergencyHold,
  buildOperationalReadinessChecks,
  inspectOperationalReadiness,
  recordOperationalReadinessAttestation,
  recoverPlatformCheckoutEmergencyHold,
  setAutomatedEmailHold,
  setPlatformCheckoutHold,
} from "../../app/services/operationalReadiness.server.js";

test("operational attestation requires evidence and receives a finite validity window", async () => {
  let stored = null;
  const prismaClient = {
    operationalReadinessAttestation: {
      async upsert({ create }) {
        stored = { id: "attestation_1", ...create };
        return stored;
      },
    },
  };
  const now = new Date("2026-07-23T00:00:00Z");

  const rejected = await recordOperationalReadinessAttestation(
    {
      checkKey: "EMAIL_DELIVERY_CONFIRMED",
      confirmedBy: "operator_1",
    },
    { prismaClient, now },
  );
  assert.equal(rejected.ok, false);

  const accepted = await recordOperationalReadinessAttestation(
    {
      checkKey: "EMAIL_DELIVERY_CONFIRMED",
      evidenceReference: "ticket-123",
      confirmedBy: "operator_1",
    },
    { prismaClient, now },
  );
  assert.equal(accepted.ok, true);
  assert.equal(stored.status, "CONFIRMED");
  assert.equal(stored.expiresAt.toISOString(), "2026-07-30T00:00:00.000Z");
});

test("checkout live probe attestation requires a complete release manifest and four probes", async () => {
  const now = new Date("2026-07-24T00:00:00Z");
  let saved = null;
  const prismaClient = {
    operationalReadinessAttestation: {
      async upsert({ create }) {
        saved = create;
        return { id: "att_live_probe", ...create };
      },
    },
  };

  const incomplete = await recordOperationalReadinessAttestation(
    {
      checkKey: "CHECKOUT_VALIDATION_LIVE_PROBE_COMPLETED",
      evidenceReference: "checkout-probe-1",
      confirmedBy: "operator@example.com",
      metadataJson: {
        releaseManifest: { releaseId: "r1" },
        probes: {},
      },
    },
    { prismaClient, now },
  );
  assert.equal(incomplete.ok, false);

  const complete = await recordOperationalReadinessAttestation(
    {
      checkKey: "CHECKOUT_VALIDATION_LIVE_PROBE_COMPLETED",
      evidenceReference: "checkout-probe-1",
      confirmedBy: "operator@example.com",
      metadataJson: {
        releaseManifest: {
          releaseId: "r1",
          renderCommit: "a".repeat(40),
          migrationVersion: "20260723153000",
          shopifyAppVersion: "v1",
          shopDomain: "example.myshopify.com",
          functionHandle: "marketplace-purchase-control",
          functionUid: "function-uid",
          functionId: "gid://shopify/ShopifyFunction/1",
          functionApiVersion: "2026-04",
          validationId: "gid://shopify/Validation/1",
          policyVersion: "sale-eligibility-2026-07-v1",
          projectionSchemaVersion: 2,
        },
        challengeNonce: "nonce-with-at-least-16-characters",
        executedBy: "shopify_user:1",
        probes: {
          directProductAllowed: buildProbe(
            "directProductAllowed",
            "checkout_allowed",
          ),
          blockedProductRejected: buildProbe(
            "blockedProductRejected",
            "checkout_rejected",
          ),
          globalStopRejected: buildProbe(
            "globalStopRejected",
            "checkout_rejected",
          ),
          shopPayObserved: buildProbe("shopPayObserved", "checkout_allowed"),
        },
      },
    },
    { prismaClient, now },
  );

  assert.equal(complete.ok, true);
  assert.equal(saved.metadataJson.probes.globalStopRejected.passed, true);
});

function buildProbe(scenarioId, expectedResult) {
  return {
    scenarioId,
    passed: true,
    expectedResult,
    actualResult: expectedResult,
    observedAt: "2026-07-24T00:00:00.000Z",
    evidenceReference: `evidence:${scenarioId}`,
    projectionRevision: "42",
  };
}

test("readiness inspection marks expired evidence as blocking", async () => {
  const prismaClient = {
    operationalReadinessAttestation: {
      async findMany() {
        return [
          {
            checkKey: "EMAIL_DELIVERY_CONFIRMED",
            status: "CONFIRMED",
            evidenceReference: "mail-log",
            confirmedBy: "operator_1",
            confirmedAt: new Date("2026-07-01T00:00:00Z"),
            expiresAt: new Date("2026-07-08T00:00:00Z"),
          },
        ];
      },
    },
  };
  const inspection = await inspectOperationalReadiness({
    prismaClient,
    now: new Date("2026-07-23T00:00:00Z"),
  });
  const row = inspection.rows.find(
    (entry) => entry.definition.key === "EMAIL_DELIVERY_CONFIRMED",
  );

  assert.equal(row.ready, false);
  assert.equal(row.reason, "expired");
  assert.ok(
    buildOperationalReadinessChecks({ inspection }).some(
      (check) =>
        check.id === "operational_attestation_email_delivery_confirmed" &&
        check.status === "fail",
    ),
  );
});

test("emergency hold is persisted before all platform products are unpublished", async () => {
  const events = [];
  const prismaClient = {
    platformOperationalControl: {
      async upsert({ create }) {
        events.push("hold");
        return { ...create };
      },
      async update({ data }) {
        events.push("metadata");
        return { key: "GLOBAL", checkoutHold: true, ...data };
      },
    },
    product: {
      async findMany() {
        return [
          {
            id: "product_1",
            shopDomain: "shop.myshopify.com",
            shopifyProductId: "gid://shopify/Product/1",
          },
        ];
      },
    },
  };

  const result = await applyPlatformCheckoutEmergencyHold(
    { reason: "incident", changedBy: "operator_1" },
    {
      prismaClient,
      enforceResourceBoundary: async () => {
        events.push("unpublish");
        return { ok: true };
      },
      now: new Date("2026-07-23T00:00:00Z"),
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(events, ["hold", "unpublish", "metadata"]);
});

test("concurrent purchase stop requests keep one active control", async () => {
  const existingControl = {
    id: "control-existing",
    activeKey: "shop.myshopify.com:PURCHASE_STOP:PLATFORM:GLOBAL",
    state: "ACTIVATING",
  };
  let externalBarrierCalls = 0;
  const prismaClient = {
    operationalControl: {
      async create() {
        const error = new Error("unique constraint");
        error.code = "P2002";
        throw error;
      },
      async findFirst() {
        return existingControl;
      },
    },
    product: {
      async findMany() {
        return [
          {
            id: "product-1",
            shopDomain: "shop.myshopify.com",
            shopifyProductId: "gid://shopify/Product/1",
          },
        ];
      },
    },
  };

  const result = await applyPlatformCheckoutEmergencyHold(
    { reason: "incident", changedBy: "operator-2" },
    {
      prismaClient,
      syncShopControl: async () => {
        externalBarrierCalls += 1;
        return { ok: true };
      },
      now: new Date("2026-07-23T00:00:00Z"),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "purchase_stop_already_active");
  assert.equal(result.operationalControl.id, "control-existing");
  assert.equal(externalBarrierCalls, 0);
});

test("emergency hold records PARTIAL_FAILURE when one Shopify barrier fails", async () => {
  const platform = {
    key: "GLOBAL",
    checkoutHold: false,
    checkoutControlState: "IDLE",
    metadataJson: {},
  };
  let controlState = null;
  const prismaClient = {
    platformOperationalControl: {
      async findUnique() {
        return platform;
      },
      async upsert({ update }) {
        Object.assign(platform, update);
        return platform;
      },
      async update({ data }) {
        Object.assign(platform, data);
        return platform;
      },
    },
    operationalControl: {
      async create({ data }) {
        controlState = data.state;
        return { id: "control-1", revision: 1, ...data };
      },
      async update({ data }) {
        controlState = data.state;
        return { id: "control-1", state: controlState, ...data };
      },
      async findFirst() {
        return null;
      },
    },
    operationalControlExecution: {
      async upsert() {
        return {};
      },
    },
    product: {
      async findMany() {
        return [
          {
            id: "product-1",
            shopDomain: "shop.myshopify.com",
            shopifyProductId: "gid://shopify/Product/1",
          },
        ];
      },
    },
  };

  const result = await applyPlatformCheckoutEmergencyHold(
    { reason: "incident", changedBy: "operator-1" },
    {
      prismaClient,
      syncShopControl: async () => ({ ok: true, state: "BLOCKED" }),
      ensureCheckoutValidation: async () => ({
        ok: true,
        active: true,
        validation: {
          id: "validation-1",
          enabled: true,
          blockOnFailure: true,
        },
      }),
      syncCheckoutPolicy: async () => ({
        ok: false,
        reason: "publication_boundary_verification_failed",
      }),
      now: new Date("2026-07-23T00:00:00Z"),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.failureCount, 1);
  assert.equal(controlState, "PARTIAL_FAILURE");
  assert.equal(platform.checkoutHold, true);
  assert.equal(platform.checkoutControlState, "PARTIAL_FAILURE");
});

test("emergency hold release requires recovery evidence", async () => {
  const prismaClient = {
    platformOperationalControl: {
      async upsert() {
        throw new Error("must not write");
      },
    },
  };
  const result = await setPlatformCheckoutHold(
    {
      hold: false,
      reason: "recovered",
      changedBy: "operator_1",
    },
    { prismaClient },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "release_evidence_required");
});

test("the operator who activates a hold cannot approve its release", async () => {
  const current = {
    key: "GLOBAL",
    automatedEmailHold: true,
    changedBy: "operator_1",
    metadataJson: {
      holds: {
        automatedEmail: {
          active: true,
          activatedBy: "operator_1",
        },
      },
    },
  };
  const prismaClient = {
    platformOperationalControl: {
      async findUnique() {
        return current;
      },
      async upsert() {
        throw new Error("must not write");
      },
    },
  };

  const result = await setAutomatedEmailHold(
    {
      hold: false,
      reason: "recovered",
      changedBy: "operator_1",
      releaseEvidenceReference: "incident-123",
    },
    { prismaClient },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "independent_release_approval_required");
});

test("a different operator can release a hold with recovery evidence", async () => {
  let updated = null;
  const current = {
    key: "GLOBAL",
    checkoutHold: true,
    changedBy: "operator_1",
    metadataJson: {
      holds: {
        checkout: {
          active: true,
          activatedBy: "operator_1",
          activatedAt: "2026-07-23T00:00:00.000Z",
        },
      },
    },
  };
  const prismaClient = {
    platformOperationalControl: {
      async findUnique() {
        return current;
      },
      async upsert({ update }) {
        updated = { ...current, ...update };
        return updated;
      },
    },
  };

  const result = await setPlatformCheckoutHold(
    {
      hold: false,
      reason: "verified recovery",
      changedBy: "operator_2",
      releaseEvidenceReference: "incident-123",
    },
    {
      prismaClient,
      now: new Date("2026-07-23T01:00:00Z"),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(updated.checkoutHold, false);
  assert.equal(updated.metadataJson.holds.checkout.activatedBy, "operator_1");
  assert.equal(updated.metadataJson.holds.checkout.releasedBy, "operator_2");
});

test("purchase stop recovery rejects the operator who activated it", async () => {
  const prismaClient = {
    operationalControl: {
      async findFirst() {
        return {
          id: "control-1",
          state: "ACTIVE",
          revision: 1,
          requestedByUserId: "operator-1",
          activatedByUserId: "operator-1",
        };
      },
      async updateMany() {
        throw new Error("must not start recovery");
      },
    },
  };

  const result = await recoverPlatformCheckoutEmergencyHold(
    {
      reason: "verified",
      changedBy: "operator-1",
      releaseEvidenceReference: "incident-1",
    },
    { prismaClient },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "independent_release_approval_required");
});

test("purchase stop recovery uses revision compare-and-swap", async () => {
  const prismaClient = {
    operationalControl: {
      async findFirst() {
        return {
          id: "control-1",
          state: "ACTIVE",
          revision: 3,
          requestedByUserId: "operator-1",
          activatedByUserId: "operator-1",
        };
      },
      async updateMany() {
        return { count: 0 };
      },
    },
  };

  const result = await recoverPlatformCheckoutEmergencyHold(
    {
      reason: "verified",
      changedBy: "operator-2",
      releaseEvidenceReference: "incident-1",
    },
    { prismaClient },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "purchase_stop_recovery_conflict");
});

test("inactive checkout validation prevents every product restoration", async () => {
  let control = {
    id: "control-1",
    shopDomain: "shop.myshopify.com",
    state: "ACTIVE",
    revision: 1,
    requestedByUserId: "operator-1",
    activatedByUserId: "operator-1",
    preControlSnapshotJson: {
      shopDomains: ["shop.myshopify.com"],
    },
  };
  const platform = {
    key: "GLOBAL",
    checkoutHold: true,
    checkoutControlState: "ACTIVE",
  };
  let restoreCalls = 0;
  let policyCalls = 0;
  const prismaClient = {
    operationalControl: {
      async findFirst() {
        return control;
      },
      async updateMany({ where, data }) {
        if (
          where.id !== control.id ||
          where.revision !== control.revision ||
          where.state !== control.state
        ) {
          return { count: 0 };
        }
        control = {
          ...control,
          ...data,
          revision: control.revision + 1,
        };
        return { count: 1 };
      },
      async findUnique() {
        return control;
      },
      async update({ data }) {
        control = { ...control, ...data };
        return control;
      },
    },
    platformOperationalControl: {
      async update({ data }) {
        Object.assign(platform, data);
        return platform;
      },
    },
    operationalControlExecution: {
      async upsert() {
        return {};
      },
      async findMany() {
        return [
          {
            targetId: "product-1",
            beforeStateJson: {
              publicationIds: ["gid://shopify/Publication/1"],
            },
          },
        ];
      },
    },
    product: {
      async findMany() {
        return [
          {
            id: "product-1",
            approvalStatus: "approved",
            shopDomain: "shop.myshopify.com",
            shopifyProductId: "gid://shopify/Product/1",
            vendorStore: {
              id: "store-1",
              isPlatformStore: true,
              isTestStore: false,
            },
            complianceEvidence: [],
            complianceDecisions: [],
          },
        ];
      },
    },
  };

  const result = await recoverPlatformCheckoutEmergencyHold(
    {
      reason: "verified",
      changedBy: "operator-2",
      releaseEvidenceReference: "incident-1",
    },
    {
      prismaClient,
      inspectCheckoutValidation: async () => ({
        ok: true,
        active: false,
        reason: "validation_disabled",
      }),
      syncCheckoutPolicy: async () => {
        policyCalls += 1;
        return { ok: true };
      },
      restorePublications: async () => {
        restoreCalls += 1;
        return { ok: true };
      },
      env: { MARKETPLACE_GOVERNANCE_GATE_ENABLED: "false" },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "purchase_stop_recovery_failed");
  assert.equal(policyCalls, 0);
  assert.equal(restoreCalls, 0);
  assert.equal(control.state, "RECOVERY_FAILED");
  assert.equal(platform.checkoutHold, true);
  assert.equal(platform.checkoutControlState, "RECOVERY_FAILED");
});

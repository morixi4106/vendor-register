import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPlatformCheckoutEmergencyHold,
  buildOperationalReadinessChecks,
  inspectOperationalReadiness,
  LIVE_ORDER_REFUND_E2E_CHECK_KEY,
  recordOperationalReadinessAttestation,
  recoverPlatformCheckoutEmergencyHold,
  setAutomatedEmailHold,
  setPlatformCheckoutHold,
  SHOPIFY_PAYMENTS_PAYOUT_CHECK_KEY,
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

test("live order refund E2E cannot be manually attested", async () => {
  let writes = 0;
  const prismaClient = {
    operationalReadinessAttestation: {
      async upsert() {
        writes += 1;
        return {};
      },
    },
  };

  const manual = await recordOperationalReadinessAttestation(
    {
      checkKey: LIVE_ORDER_REFUND_E2E_CHECK_KEY,
      evidenceReference: "manual-note",
      confirmedBy: "operator@example.com",
    },
    { prismaClient },
  );
  assert.equal(manual.ok, false);
  assert.equal(manual.reason, "production_transaction_probe_required");
  assert.equal(writes, 0);

  const automated = await recordOperationalReadinessAttestation(
    {
      checkKey: LIVE_ORDER_REFUND_E2E_CHECK_KEY,
      evidenceReference: "production-transaction-probe:probe_1",
      evidenceHash: "b".repeat(64),
      confirmedBy: "system:production-transaction-probe",
      metadataJson: {
        verificationSource: "production_transaction_probe",
        probeId: "probe_1",
        releaseId: "aaaaaaaaaaaa:app-v1",
        releaseFingerprint: "c".repeat(64),
        completedAt: "2026-07-29T00:00:00.000Z",
      },
    },
    { prismaClient },
  );
  assert.equal(automated.ok, true);
  assert.equal(writes, 1);
});

test("Shopify payout readiness cannot be manually attested", async () => {
  let writes = 0;
  const prismaClient = {
    operationalReadinessAttestation: {
      async upsert() {
        writes += 1;
        return {};
      },
    },
  };
  const result = await recordOperationalReadinessAttestation(
    {
      checkKey: SHOPIFY_PAYMENTS_PAYOUT_CHECK_KEY,
      evidenceReference: "manual-note",
      evidenceHash: "a".repeat(64),
      confirmedBy: "operator@example.com",
    },
    { prismaClient },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "verified_payout_evidence_required");
  assert.equal(writes, 0);
});

test("Shopify payout readiness fails closed when the approved record changes", async () => {
  const evidence = {
    id: "payout_evidence_1",
    releaseId: "aaaaaaaaaaaa:app-v1",
    releaseFingerprint: "c".repeat(64),
    payoutId: "gid://shopify/ShopifyPaymentsPayout/123",
    shopifyPayoutGid: "gid://shopify/ShopifyPaymentsPayout/123",
    shopifyLegacyResourceId: "123",
    payoutStatus: "DEPOSITED",
    status: "APPROVED",
    amount: 250,
    currencyCode: "JPY",
    shopifyPayoutDate: new Date("2026-07-28T00:00:00Z"),
    bankDepositedAt: new Date("2026-07-30T00:00:00Z"),
    bankReferenceMasked: "reference-****1234",
    shopifyVerifiedAt: new Date("2026-07-30T00:30:00Z"),
    shopifyExternalTraceIdHash: "f".repeat(64),
    shopifyVerificationJson: {
      source: "shopify_admin_graphql",
      status: "PAID",
      transactionType: "DEPOSIT",
    },
    evidenceReference: "secure-evidence:payout-1",
    evidenceHash: "b".repeat(64),
    submittedBy: "shopify_user:submitter",
    reviewedBy: "shopify_user:reviewer",
    singleOperatorWaiver: false,
    singleOperatorWaiverReason: null,
  };
  const attestation = {
    checkKey: SHOPIFY_PAYMENTS_PAYOUT_CHECK_KEY,
    status: "CONFIRMED",
    evidenceReference: evidence.evidenceReference,
    evidenceHash: evidence.evidenceHash,
    confirmedBy: evidence.reviewedBy,
    confirmedAt: new Date("2026-07-30T01:00:00Z"),
    expiresAt: new Date("2026-10-28T01:00:00Z"),
    metadataJson: {
      verificationSource: "shopify_payout_evidence",
      payoutEvidenceId: evidence.id,
      releaseId: evidence.releaseId,
      releaseFingerprint: evidence.releaseFingerprint,
      payoutId: evidence.payoutId,
      payoutStatus: evidence.payoutStatus,
      amount: evidence.amount,
      currencyCode: evidence.currencyCode,
      approvalMode: "INDEPENDENT",
    },
  };
  const prismaClient = {
    operationalReadinessAttestation: {
      async findMany() {
        return [attestation];
      },
    },
    shopifyPayoutEvidence: {
      async findUnique() {
        return evidence;
      },
    },
  };
  const matching = await inspectOperationalReadiness({
    prismaClient,
    now: new Date("2026-07-30T02:00:00Z"),
    env: {
      RENDER_GIT_COMMIT: "a".repeat(40),
      SHOPIFY_APP_VERSION: "app-v1",
    },
  });
  assert.equal(
    matching.rows.find(
      (row) => row.definition.key === SHOPIFY_PAYMENTS_PAYOUT_CHECK_KEY,
    ).ready,
    true,
  );

  evidence.evidenceHash = "d".repeat(64);
  const changed = await inspectOperationalReadiness({
    prismaClient,
    now: new Date("2026-07-30T02:00:00Z"),
    env: {
      RENDER_GIT_COMMIT: "a".repeat(40),
      SHOPIFY_APP_VERSION: "app-v1",
    },
  });
  const row = changed.rows.find(
    (entry) => entry.definition.key === SHOPIFY_PAYMENTS_PAYOUT_CHECK_KEY,
  );
  assert.equal(row.ready, false);
  assert.equal(row.reason, "payout_evidence_invalid");
});

test("single-operator payout readiness is valid only while direct-only safeguards remain active", async () => {
  const evidence = {
    id: "payout_evidence_single",
    releaseId: "aaaaaaaaaaaa:app-v1",
    releaseFingerprint: "c".repeat(64),
    payoutId: "gid://shopify/ShopifyPaymentsPayout/123",
    shopifyPayoutGid: "gid://shopify/ShopifyPaymentsPayout/123",
    payoutStatus: "DEPOSITED",
    status: "APPROVED_WITH_WAIVER",
    amount: 250,
    currencyCode: "JPY",
    shopifyPayoutDate: new Date("2026-07-28T00:00:00Z"),
    bankDepositedAt: new Date("2026-07-30T00:00:00Z"),
    bankReferenceMasked: "1234",
    shopifyVerifiedAt: new Date("2026-07-30T00:30:00Z"),
    shopifyExternalTraceIdHash: "f".repeat(64),
    shopifyVerificationJson: {
      source: "shopify_admin_graphql",
      status: "PAID",
      transactionType: "DEPOSIT",
    },
    evidenceReference: "secure-evidence:payout-single",
    evidenceHash: "b".repeat(64),
    submittedBy: "shopify_user:owner",
    reviewedBy: "shopify_user:owner",
    singleOperatorWaiver: true,
    singleOperatorWaiverReason:
      "一人運用のため、Shopify API照合と銀行着金証拠を所有者本人が再確認しました。",
  };
  const attestation = {
    checkKey: SHOPIFY_PAYMENTS_PAYOUT_CHECK_KEY,
    status: "CONFIRMED",
    evidenceReference: evidence.evidenceReference,
    evidenceHash: evidence.evidenceHash,
    confirmedBy: evidence.reviewedBy,
    confirmedAt: new Date("2026-07-30T01:00:00Z"),
    expiresAt: new Date("2026-10-28T01:00:00Z"),
    metadataJson: {
      verificationSource: "shopify_payout_evidence",
      payoutEvidenceId: evidence.id,
      releaseId: evidence.releaseId,
      releaseFingerprint: evidence.releaseFingerprint,
      payoutId: evidence.payoutId,
      payoutStatus: evidence.payoutStatus,
      amount: evidence.amount,
      currencyCode: evidence.currencyCode,
      approvalMode: "SINGLE_OPERATOR_WAIVER",
      singleOperatorWaiver: true,
      singleOperatorScope: "DOMESTIC_PLATFORM_DIRECT_ONLY",
    },
  };
  const prismaClient = {
    operationalReadinessAttestation: {
      async findMany() {
        return [attestation];
      },
    },
    shopifyPayoutEvidence: {
      async findUnique() {
        return evidence;
      },
    },
  };
  const directOnlyEnv = {
    RENDER_GIT_COMMIT: "a".repeat(40),
    SHOPIFY_APP_VERSION: "app-v1",
    SINGLE_OPERATOR_PAYOUT_ATTESTATION_ENABLED: "true",
  };

  const accepted = await inspectOperationalReadiness({
    prismaClient,
    now: new Date("2026-07-30T02:00:00Z"),
    env: directOnlyEnv,
  });
  assert.equal(
    accepted.rows.find(
      (row) => row.definition.key === SHOPIFY_PAYMENTS_PAYOUT_CHECK_KEY,
    ).ready,
    true,
  );

  const invalidated = await inspectOperationalReadiness({
    prismaClient,
    now: new Date("2026-07-30T02:00:00Z"),
    env: {
      ...directOnlyEnv,
      MARKETPLACE_SETTLEMENT_ACTIONS_ENABLED: "true",
    },
  });
  const row = invalidated.rows.find(
    (entry) => entry.definition.key === SHOPIFY_PAYMENTS_PAYOUT_CHECK_KEY,
  );
  assert.equal(row.ready, false);
  assert.equal(row.reason, "payout_evidence_invalid");
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

test("live order refund evidence is valid only for the current release", async () => {
  const prismaClient = {
    operationalReadinessAttestation: {
      async findMany() {
        return [
          {
            checkKey: LIVE_ORDER_REFUND_E2E_CHECK_KEY,
            status: "CONFIRMED",
            evidenceReference: "production-transaction-probe:probe_1",
            confirmedBy: "system:production-transaction-probe",
            confirmedAt: new Date("2026-07-29T00:00:00Z"),
            expiresAt: new Date("2026-10-27T00:00:00Z"),
            metadataJson: {
              verificationSource: "production_transaction_probe",
              releaseId: "aaaaaaaaaaaa:app-v1",
            },
          },
        ];
      },
    },
  };
  const base = {
    prismaClient,
    now: new Date("2026-07-29T01:00:00Z"),
  };
  const matching = await inspectOperationalReadiness({
    ...base,
    env: {
      RENDER_GIT_COMMIT: "a".repeat(40),
      SHOPIFY_APP_VERSION: "app-v1",
    },
  });
  assert.equal(
    matching.rows.find(
      (row) => row.definition.key === LIVE_ORDER_REFUND_E2E_CHECK_KEY,
    ).ready,
    true,
  );

  const changed = await inspectOperationalReadiness({
    ...base,
    env: {
      RENDER_GIT_COMMIT: "b".repeat(40),
      SHOPIFY_APP_VERSION: "app-v2",
    },
  });
  const row = changed.rows.find(
    (entry) => entry.definition.key === LIVE_ORDER_REFUND_E2E_CHECK_KEY,
  );
  assert.equal(row.ready, false);
  assert.equal(row.reason, "release_mismatch");
});

test("live order refund evidence fails closed when the deployed release is unknown", async () => {
  const prismaClient = {
    operationalReadinessAttestation: {
      async findMany() {
        return [
          {
            checkKey: LIVE_ORDER_REFUND_E2E_CHECK_KEY,
            status: "CONFIRMED",
            evidenceReference: "production-transaction-probe:probe_1",
            confirmedBy: "system:production-transaction-probe",
            confirmedAt: new Date("2026-07-29T00:00:00Z"),
            expiresAt: new Date("2026-10-27T00:00:00Z"),
            metadataJson: {
              verificationSource: "production_transaction_probe",
              releaseId: "aaaaaaaaaaaa:app-v1",
            },
          },
        ];
      },
    },
  };
  const inspection = await inspectOperationalReadiness({
    prismaClient,
    now: new Date("2026-07-29T01:00:00Z"),
    env: {},
  });
  const row = inspection.rows.find(
    (entry) => entry.definition.key === LIVE_ORDER_REFUND_E2E_CHECK_KEY,
  );

  assert.equal(row.ready, false);
  assert.equal(row.reason, "release_unconfigured");
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

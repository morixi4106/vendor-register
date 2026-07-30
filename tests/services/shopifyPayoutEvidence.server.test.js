import assert from "node:assert/strict";
import test from "node:test";

import {
  approveShopifyPayoutEvidence,
  getSingleOperatorPayoutConfirmationText,
  submitShopifyPayoutEvidence,
} from "../../app/services/shopifyPayoutEvidence.server.js";

const ENV = {
  RENDER_GIT_COMMIT: "a".repeat(40),
  SHOPIFY_APP_VERSION: "app-v1",
  SHOPIFY_PRIMARY_SHOP_DOMAIN: "shop.myshopify.com",
};
const NOW = new Date("2026-07-30T12:00:00.000Z");

test("payout evidence requires structured deposited evidence and SHA-256", async () => {
  const database = buildDatabase();
  const rejected = await submitShopifyPayoutEvidence(
    {
      ...validSubmission(),
      evidenceHash: "",
    },
    { prismaClient: database, env: ENV, now: NOW },
  );

  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "evidence_hash_required");
  assert.equal(database.records.size, 0);

  const accepted = await submitShopifyPayoutEvidence(validSubmission(), {
    prismaClient: database,
    env: ENV,
    now: NOW,
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.evidence.status, "SUBMITTED");
  assert.equal(accepted.evidence.payoutStatus, "DEPOSITED");
  assert.equal(accepted.evidence.releaseId, "aaaaaaaaaaaa:app-v1");
});

test("another operator cannot replace pending payout evidence", async () => {
  const database = buildDatabase();
  const submitted = await submitShopifyPayoutEvidence(validSubmission(), {
    prismaClient: database,
    env: ENV,
    now: NOW,
  });

  const rejected = await submitShopifyPayoutEvidence(
    {
      ...validSubmission(),
      evidenceHash: "c".repeat(64),
      submittedBy: "shopify_user:different",
    },
    { prismaClient: database, env: ENV, now: NOW },
  );

  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "payout_evidence_submitter_mismatch");
  assert.equal(
    database.records.get(submitted.evidence.id).evidenceHash,
    "b".repeat(64),
  );
});

test("a different operator can approve payout evidence and create the release attestation", async () => {
  const database = buildDatabase();
  const submitted = await submitShopifyPayoutEvidence(validSubmission(), {
    prismaClient: database,
    env: ENV,
    now: NOW,
  });

  const approved = await approveShopifyPayoutEvidence(
    {
      evidenceId: submitted.evidence.id,
      reviewedBy: "shopify_user:reviewer",
    },
    {
      prismaClient: database,
      env: ENV,
      now: new Date("2026-07-30T13:00:00.000Z"),
    },
  );

  assert.equal(approved.ok, true);
  assert.equal(approved.approvalMode, "INDEPENDENT");
  assert.equal(approved.evidence.status, "APPROVED");
  assert.equal(
    database.attestation.metadataJson.verificationSource,
    "shopify_payout_evidence",
  );
  assert.equal(
    database.attestation.metadataJson.payoutEvidenceId,
    submitted.evidence.id,
  );
  assert.equal(database.attestation.evidenceHash, "b".repeat(64));
});

test("the submitter cannot approve the same payout without an explicit owner waiver", async () => {
  const database = buildDatabase();
  const submitted = await submitShopifyPayoutEvidence(validSubmission(), {
    prismaClient: database,
    env: ENV,
    now: NOW,
  });

  const rejected = await approveShopifyPayoutEvidence(
    {
      evidenceId: submitted.evidence.id,
      reviewedBy: "shopify_user:submitter",
    },
    { prismaClient: database, env: ENV, now: NOW },
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "independent_payout_approval_required");
  assert.equal(database.attestation, null);
});

test("the account owner can record a documented single-operator exception", async () => {
  const database = buildDatabase();
  const submitted = await submitShopifyPayoutEvidence(validSubmission(), {
    prismaClient: database,
    env: ENV,
    now: NOW,
  });
  const waiverReason =
    "第二確認者が存在しない一人運用のため、銀行明細とShopify Payoutを本人が照合した残存リスクを受諾します。";

  const approved = await approveShopifyPayoutEvidence(
    {
      evidenceId: submitted.evidence.id,
      reviewedBy: "shopify_user:submitter",
      reviewerAccountOwner: true,
      allowSingleOperatorWaiver: true,
      singleOperatorConfirmation: getSingleOperatorPayoutConfirmationText(),
      singleOperatorWaiverReason: waiverReason,
    },
    { prismaClient: database, env: ENV, now: NOW },
  );

  assert.equal(approved.ok, true);
  assert.equal(approved.approvalMode, "SINGLE_OPERATOR_WAIVER");
  assert.equal(approved.evidence.singleOperatorWaiver, true);
  assert.equal(approved.evidence.singleOperatorWaiverReason, waiverReason);
});

function validSubmission() {
  return {
    shopDomain: "shop.myshopify.com",
    payoutId: "po_123",
    payoutStatus: "DEPOSITED",
    amount: "250",
    currencyCode: "JPY",
    shopifyPayoutDate: "2026-07-28",
    bankDepositedAt: "2026-07-30",
    bankReferenceMasked: "reference-****1234",
    evidenceReference: "secure-evidence:payout-2026-07-30",
    evidenceHash: "b".repeat(64),
    submittedBy: "shopify_user:submitter",
  };
}

function buildDatabase() {
  const database = {
    records: new Map(),
    attestation: null,
    nextId: 1,
  };
  database.shopifyPayoutEvidence = {
    async findUnique({ where }) {
      if (where.id) return database.records.get(where.id) || null;
      const composite = where.shopDomain_payoutId_releaseId;
      return (
        [...database.records.values()].find(
          (record) =>
            record.shopDomain === composite.shopDomain &&
            record.payoutId === composite.payoutId &&
            record.releaseId === composite.releaseId,
        ) || null
      );
    },
    async create({ data }) {
      const record = {
        id: `evidence_${database.nextId++}`,
        createdAt: NOW,
        updatedAt: NOW,
        ...data,
      };
      database.records.set(record.id, record);
      return record;
    },
    async update({ where, data }) {
      const current = database.records.get(where.id);
      const updated = { ...current, ...data, updatedAt: NOW };
      database.records.set(where.id, updated);
      return updated;
    },
    async updateMany({ where, data }) {
      const current = database.records.get(where.id);
      if (!current || current.status !== where.status) return { count: 0 };
      database.records.set(where.id, {
        ...current,
        ...data,
        updatedAt: NOW,
      });
      return { count: 1 };
    },
  };
  database.operationalReadinessAttestation = {
    async upsert({ create, update }) {
      database.attestation = database.attestation
        ? { ...database.attestation, ...update }
        : { id: "attestation_1", ...create };
      return database.attestation;
    },
  };
  database.$transaction = (callback) => callback(database);
  return database;
}

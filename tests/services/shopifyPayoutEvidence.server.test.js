import assert from "node:assert/strict";
import test from "node:test";

import {
  approveShopifyPayoutEvidence,
  getSingleOperatorPayoutConfirmationText,
  submitShopifyPayoutEvidence,
  verifyShopifyPayout,
} from "../../app/services/shopifyPayoutEvidence.server.js";

const ENV = {
  RENDER_GIT_COMMIT: "a".repeat(40),
  SHOPIFY_APP_VERSION: "app-v1",
  SHOPIFY_PRIMARY_SHOP_DOMAIN: "shop.myshopify.com",
};
const NOW = new Date("2026-07-30T12:00:00.000Z");
const PAYOUT_GID = "gid://shopify/ShopifyPaymentsPayout/123";

test("payout evidence requires a SHA-256 evidence hash", async () => {
  const database = buildDatabase();
  const rejected = await submit(validSubmission({ evidenceHash: "" }), {
    database,
  });

  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "evidence_hash_required");
  assert.equal(database.records.size, 0);
});

test("bank reference input is limited to exactly four alphanumeric suffix characters", async () => {
  for (const bankReferenceMasked of ["123", "reference-1234", "****"]) {
    const database = buildDatabase();
    const rejected = await submit(
      validSubmission({ bankReferenceMasked }),
      { database },
    );

    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, "bank_reference_suffix_invalid");
    assert.equal(database.records.size, 0);
  }
});

test("bank reference suffix is normalized before it is stored", async () => {
  const database = buildDatabase();
  const accepted = await submit(
    validSubmission({ bankReferenceMasked: "aB12" }),
    { database },
  );

  assert.equal(accepted.ok, true);
  assert.equal(accepted.evidence.bankReferenceMasked, "AB12");
});

test("a payout deposited on the Shopify issue date is accepted by calendar date", async () => {
  const database = buildDatabase();
  const accepted = await submit(validSubmission(), {
    database,
    verification: validVerification({
      issuedAt: new Date("2026-07-30T09:00:00.000Z"),
    }),
  });

  assert.equal(accepted.ok, true);
});

test("Shopify values replace operator-supplied financial facts", async () => {
  const database = buildDatabase();
  const accepted = await submit(validSubmission(), { database });

  assert.equal(accepted.ok, true);
  assert.equal(accepted.evidence.status, "SUBMITTED");
  assert.equal(accepted.evidence.payoutStatus, "DEPOSITED");
  assert.equal(accepted.evidence.amount, 250);
  assert.equal(accepted.evidence.currencyCode, "JPY");
  assert.equal(accepted.evidence.shopifyPayoutGid, PAYOUT_GID);
  assert.equal(accepted.evidence.releaseId, "aaaaaaaaaaaa:app-v1");
});

test("another operator cannot replace pending payout evidence", async () => {
  const database = buildDatabase();
  const submitted = await submit(validSubmission(), { database });

  const rejected = await submit(
    validSubmission({
      evidenceHash: "c".repeat(64),
      submittedBy: "shopify_user:different",
    }),
    { database },
  );

  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "payout_evidence_submitter_mismatch");
  assert.equal(
    database.records.get(submitted.evidence.id).evidenceHash,
    "b".repeat(64),
  );
});

test("a different operator can approve API-verified payout evidence", async () => {
  const database = buildDatabase();
  const submitted = await submit(validSubmission(), { database });

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
  assert.equal(approved.readinessEligible, true);
  assert.equal(approved.evidence.status, "APPROVED");
  assert.equal(
    database.attestation.metadataJson.verificationSource,
    "shopify_payout_evidence",
  );
});

test("the submitter cannot approve the same payout without an explicit owner waiver", async () => {
  const database = buildDatabase();
  const submitted = await submit(validSubmission(), { database });

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

test("an owner waiver can satisfy readiness only for domestic platform direct sales", async () => {
  const database = buildDatabase();
  const submitted = await submit(validSubmission(), { database });
  const waiverReason =
    "第二確認者を用意できない一人運用のため、銀行明細とShopify Payoutを本人が照合した残存リスクを記録します。";

  const approved = await approveShopifyPayoutEvidence(
    {
      evidenceId: submitted.evidence.id,
      reviewedBy: "shopify_user:submitter",
      reviewerAccountOwner: true,
      allowSingleOperatorWaiver: true,
      singleOperatorConfirmation: getSingleOperatorPayoutConfirmationText(),
      singleOperatorWaiverReason: waiverReason,
    },
    {
      prismaClient: database,
      env: {
        ...ENV,
        SINGLE_OPERATOR_PAYOUT_ATTESTATION_ENABLED: "true",
      },
      now: NOW,
    },
  );

  assert.equal(approved.ok, true);
  assert.equal(approved.approvalMode, "SINGLE_OPERATOR_WAIVER");
  assert.equal(approved.readinessEligible, true);
  assert.equal(approved.evidence.status, "APPROVED_WITH_WAIVER");
  assert.equal(
    database.attestation.metadataJson.singleOperatorScope,
    "DOMESTIC_PLATFORM_DIRECT_ONLY",
  );
});

test("an owner waiver fails closed when third-party commerce is enabled", async () => {
  const database = buildDatabase();
  const submitted = await submit(validSubmission(), { database });

  const rejected = await approveShopifyPayoutEvidence(
    {
      evidenceId: submitted.evidence.id,
      reviewedBy: "shopify_user:submitter",
      reviewerAccountOwner: true,
      allowSingleOperatorWaiver: true,
      singleOperatorConfirmation: getSingleOperatorPayoutConfirmationText(),
      singleOperatorWaiverReason:
        "一人運用のため残存リスクを記録しますが、第三者販売中は利用できないことを確認します。",
    },
    {
      prismaClient: database,
      env: {
        ...ENV,
        SINGLE_OPERATOR_PAYOUT_ATTESTATION_ENABLED: "true",
        MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED: "true",
      },
      now: NOW,
    },
  );

  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "single_operator_payout_scope_not_allowed");
  assert.equal(database.attestation, null);
});

test("the same Shopify payout cannot be reused for a later release", async () => {
  const database = buildDatabase();
  const first = await submit(validSubmission(), { database });
  assert.equal(first.ok, true);

  const reused = await submit(validSubmission(), {
    database,
    env: { ...ENV, SHOPIFY_APP_VERSION: "app-v2" },
  });
  assert.equal(reused.ok, false);
  assert.equal(reused.reason, "payout_evidence_already_used");
});

test("Shopify payout verification requires PAID DEPOSIT and matching trace suffix", async () => {
  const calls = [];
  const result = await verifyShopifyPayout(
    {
      shopDomain: "shop.myshopify.com",
      payoutId: "123",
      bankReferenceMasked: "1234",
    },
    {
      now: NOW,
      graphQL: async (request) => {
        calls.push(request);
        return {
          data: {
            node: {
              id: PAYOUT_GID,
              legacyResourceId: "123",
              issuedAt: "2026-07-28T00:00:00.000Z",
              status: "PAID",
              transactionType: "DEPOSIT",
              externalTraceId: "bank-transfer-1234",
              net: { amount: "250", currencyCode: "JPY" },
            },
          },
        };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.amount, 250);
  assert.equal(result.currencyCode, "JPY");
  assert.equal(calls[0].apiVersion, "2026-04");
  assert.equal(calls[0].variables.id, PAYOUT_GID);
  assert.equal(result.externalTraceIdHash.length, 64);
});

function validSubmission(overrides = {}) {
  return {
    shopDomain: "shop.myshopify.com",
    payoutId: PAYOUT_GID,
    bankDepositedAt: "2026-07-30",
    bankReferenceMasked: "1234",
    evidenceReference: "secure-evidence:payout-2026-07-30",
    evidenceHash: "b".repeat(64),
    submittedBy: "shopify_user:submitter",
    ...overrides,
  };
}

function validVerification(overrides = {}) {
  return {
    ok: true,
    id: PAYOUT_GID,
    legacyResourceId: "123",
    status: "PAID",
    transactionType: "DEPOSIT",
    amount: 250,
    currencyCode: "JPY",
    issuedAt: new Date("2026-07-28T00:00:00.000Z"),
    externalTraceIdHash: "f".repeat(64),
    ...overrides,
  };
}

function submit(
  input,
  {
    database,
    env = ENV,
    now = NOW,
    verification = validVerification(),
  } = {},
) {
  return submitShopifyPayoutEvidence(input, {
    prismaClient: database,
    env,
    now,
    verifyShopifyPayoutImpl: async () => verification,
  });
}

function buildDatabase() {
  const database = {
    records: new Map(),
    attestation: null,
    nextId: 1,
  };
  database.shopifyPayoutEvidence = {
    async findFirst({ where }) {
      return (
        [...database.records.values()].find(
          (record) =>
            record.shopDomain === where.shopDomain &&
            where.OR.some((candidate) =>
              Object.entries(candidate).every(
                ([key, value]) => record[key] === value,
              ),
            ),
        ) || null
      );
    },
    async findUnique({ where }) {
      if (where.id) return database.records.get(where.id) || null;
      return null;
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

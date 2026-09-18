import assert from "node:assert/strict";
import test from "node:test";

import {
  listInternationalComplianceRequirements,
  reviewInternationalComplianceRequirements,
  syncInternationalComplianceRequirements,
} from "../../app/services/internationalComplianceRequirements.server.js";
import {
  INTERNATIONAL_COMPLIANCE_REQUIREMENTS,
  INTERNATIONAL_REQUIREMENT_VERSION,
} from "../../app/utils/internationalMarketCompliance.js";

test("international compliance requirement sync is versioned and idempotent", async () => {
  const upserts = [];
  const now = new Date("2026-09-18T00:00:00.000Z");
  const result = await syncInternationalComplianceRequirements(
    { actor: "operator@example.com", now },
    {
      prismaClient: {
        complianceRequirement: {
          async upsert(input) {
            upserts.push(input);
            return { id: `requirement_${upserts.length}`, ...input.create };
          },
        },
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.version, INTERNATIONAL_REQUIREMENT_VERSION);
  assert.equal(result.count, INTERNATIONAL_COMPLIANCE_REQUIREMENTS.length);
  assert.equal(upserts.length, INTERNATIONAL_COMPLIANCE_REQUIREMENTS.length);
  assert.equal(upserts.every((entry) => entry.create.isActive === true), true);
  assert.equal(
    upserts.every((entry) => entry.create.reviewDueAt instanceof Date),
    true,
  );
  assert.equal(
    upserts.every((entry) => !("reviewDueAt" in entry.update)),
    true,
  );
  assert.equal(
    upserts.every(
      (entry) =>
        entry.create.metadataJson.managedVersion ===
        INTERNATIONAL_REQUIREMENT_VERSION,
    ),
    true,
  );
});

test("international compliance requirement listing only returns the current version", async () => {
  let query = null;
  await listInternationalComplianceRequirements({
    prismaClient: {
      complianceRequirement: {
        async findMany(input) {
          query = input;
          return [];
        },
      },
    },
  });

  assert.equal(query.where.version, INTERNATIONAL_REQUIREMENT_VERSION);
  assert.equal(query.where.isActive, true);
});

test("international requirement review requires explicit evidence and renews the complete catalog", async () => {
  const updates = [];
  const now = new Date("2026-09-18T00:00:00.000Z");
  const requirements = INTERNATIONAL_COMPLIANCE_REQUIREMENTS.map(
    (requirement, index) => ({
      id: `requirement_${index + 1}`,
      code: requirement.code,
      metadataJson: { managedVersion: INTERNATIONAL_REQUIREMENT_VERSION },
    }),
  );
  const prismaClient = {
    complianceRequirement: {
      async findMany() {
        return requirements;
      },
      async update(input) {
        updates.push(input);
        return { ...input.data, id: input.where.id };
      },
    },
  };

  const rejected = await reviewInternationalComplianceRequirements(
    {
      actor: "operator@example.com",
      confirmed: false,
      reviewReference: "ticket-123",
      evidenceHash: "a".repeat(64),
      now,
    },
    { prismaClient },
  );
  assert.equal(rejected.ok, false);
  assert.equal(updates.length, 0);

  const result = await reviewInternationalComplianceRequirements(
    {
      actor: "operator@example.com",
      confirmed: true,
      reviewReference: "ticket-123",
      evidenceHash: "A".repeat(64),
      now,
    },
    { prismaClient },
  );

  assert.equal(result.ok, true);
  assert.equal(result.count, requirements.length);
  assert.equal(updates.length, requirements.length);
  assert.equal(
    updates.every(
      (entry) =>
        entry.data.metadataJson.legalReviewEvidenceHash === "a".repeat(64) &&
        entry.data.metadataJson.legalReviewedBy === "operator@example.com" &&
        entry.data.reviewDueAt > now,
    ),
    true,
  );
});

test("international requirement review rejects an incomplete catalog", async () => {
  const result = await reviewInternationalComplianceRequirements(
    {
      actor: "operator@example.com",
      confirmed: true,
      reviewReference: "ticket-123",
      evidenceHash: "a".repeat(64),
      now: new Date("2026-09-18T00:00:00.000Z"),
    },
    {
      prismaClient: {
        complianceRequirement: {
          async findMany() {
            return [];
          },
          async update() {
            throw new Error("must not update");
          },
        },
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "international_requirement_catalog_incomplete");
});

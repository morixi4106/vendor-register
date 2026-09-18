import assert from "node:assert/strict";
import test from "node:test";

import {
  listInternationalMarketEvidence,
  saveInternationalMarketEvidence,
} from "../../app/services/internationalMarketReadiness.server.js";
import { getInternationalMarketRequirement } from "../../app/utils/internationalMarketReadiness.js";

test("market evidence is stored in the existing country-scoped attestation table", async () => {
  let received = null;
  const now = new Date("2026-09-19T00:00:00.000Z");
  const definition = getInternationalMarketRequirement(
    "INTERNATIONAL_CARRIER_SERVICE_STATUS",
  );
  const result = await saveInternationalMarketEvidence({
    countryCode: "fr",
    requirementCode: definition.code,
    evidenceReference: "evidence/fr/carrier.pdf",
    evidenceHash: "B".repeat(64),
    officialSourceUrl: definition.sourceUrl,
    confirmedBy: "operator@example.com",
    confirmations: Object.fromEntries(
      definition.confirmations.map((key) => [key, true]),
    ),
    now,
    prismaClient: {
      operationalReadinessAttestation: {
        async upsert(input) {
          received = input;
          return input.create;
        },
      },
    },
  });

  assert.equal(received.create.scopeType, "MARKET_COUNTRY");
  assert.equal(received.create.scopeId, "FR");
  assert.equal(received.create.status, "CONFIRMED");
  assert.equal(received.create.evidenceHash, "b".repeat(64));
  assert.equal(result.metadataJson.countryCode, "FR");
});

test("market evidence rejects incomplete checklists and invalid hashes", async () => {
  await assert.rejects(
    saveInternationalMarketEvidence({
      countryCode: "FR",
      requirementCode: "INTERNATIONAL_CARRIER_SERVICE_STATUS",
      evidenceReference: "ticket-1",
      evidenceHash: "invalid",
      officialSourceUrl: "https://example.com/evidence",
      confirmedBy: "operator@example.com",
      confirmations: {},
      prismaClient: {},
    }),
    /SHA-256/,
  );
});

test("market evidence listing is limited to required keys for one country", async () => {
  let query = null;
  await listInternationalMarketEvidence({
    countryCode: "US",
    prismaClient: {
      operationalReadinessAttestation: {
        async findMany(input) {
          query = input;
          return [];
        },
      },
    },
  });

  assert.equal(query.where.scopeType, "MARKET_COUNTRY");
  assert.equal(query.where.scopeId, "US");
  assert.equal(query.where.checkKey.in.includes("INTERNATIONAL_PRIVACY_TRANSFER_REVIEW"), true);
  assert.equal(query.where.checkKey.in.includes("EU_PACKAGING_EPR_READY"), false);
});

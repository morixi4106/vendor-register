import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateInternationalMarketReadiness,
  getInternationalMarketRequirements,
  isNorthernIrelandDestination,
} from "../../app/utils/internationalMarketReadiness.js";

function buildConfirmedAttestations(countryCode, now) {
  return getInternationalMarketRequirements(countryCode).map((definition) => ({
    checkKey: definition.code,
    status: "CONFIRMED",
    evidenceReference: `evidence/${countryCode}/${definition.code}.pdf`,
    evidenceHash: "a".repeat(64),
    confirmedBy: "operator@example.com",
    confirmedAt: now,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    metadataJson: {
      countryCode,
      requirementVersion: definition.version,
      officialSourceUrl: definition.sourceUrl,
      confirmations: Object.fromEntries(
        definition.confirmations.map((key) => [key, true]),
      ),
    },
  }));
}

test("domestic destination does not require international market evidence", () => {
  const result = evaluateInternationalMarketReadiness({ countryCode: "JP" });
  assert.equal(result.ready, true);
  assert.deepEqual(result.requirements, []);
});

test("EU destination requires common and EU-specific evidence", () => {
  const requirements = getInternationalMarketRequirements("FR");
  assert.equal(
    requirements.some((entry) => entry.code === "EU_WITHDRAWAL_OPERATION_READY"),
    true,
  );
  assert.equal(
    requirements.some((entry) => entry.code === "EU_PACKAGING_EPR_READY"),
    true,
  );
  assert.equal(
    requirements.some(
      (entry) => entry.code === "INTERNATIONAL_SHOPIFY_DELIVERY_ROUTE_AUDIT",
    ),
    true,
  );
});

test("current complete market evidence allows the destination", () => {
  const now = new Date("2026-09-19T00:00:00.000Z");
  const result = evaluateInternationalMarketReadiness({
    countryCode: "FR",
    attestations: buildConfirmedAttestations("FR", now),
    now,
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.reasons, []);
});

test("missing confirmation and expired evidence fail closed", () => {
  const now = new Date("2026-09-19T00:00:00.000Z");
  const attestations = buildConfirmedAttestations("FR", now);
  attestations[0].expiresAt = new Date("2026-09-18T00:00:00.000Z");
  attestations[1].metadataJson.confirmations[
    Object.keys(attestations[1].metadataJson.confirmations)[0]
  ] = false;

  const result = evaluateInternationalMarketReadiness({
    countryCode: "FR",
    attestations,
    now,
  });
  assert.equal(result.ready, false);
  assert.equal(result.reasons.some((reason) => reason.includes("expired")), true);
  assert.equal(
    result.reasons.some((reason) => reason.includes("market_confirmation_missing")),
    true,
  );
});

test("Northern Ireland is separated from the Great Britain route", () => {
  assert.equal(
    isNorthernIrelandDestination({ countryCode: "GB", postalCode: "BT1 1AA" }),
    true,
  );
  assert.equal(
    isNorthernIrelandDestination({ countryCode: "GB", provinceCode: "GB-NIR" }),
    true,
  );
  assert.equal(
    isNorthernIrelandDestination({ countryCode: "GB", postalCode: "SW1A 1AA" }),
    false,
  );

  const now = new Date("2026-09-19T00:00:00.000Z");
  const result = evaluateInternationalMarketReadiness({
    countryCode: "GB",
    postalCode: "BT1 1AA",
    attestations: buildConfirmedAttestations("GB", now),
    now,
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ["northern_ireland_not_supported"]);
});

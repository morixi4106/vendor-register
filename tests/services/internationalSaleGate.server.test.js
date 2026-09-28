import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInternationalSaleGateProjection,
  syncInternationalSaleGate,
} from "../../app/services/internationalSaleGate.server.js";
import { getInternationalMarketRequirements } from "../../app/utils/internationalMarketReadiness.js";

function confirmedEvidence(countryCode, now) {
  return getInternationalMarketRequirements(countryCode).map((definition) => ({
    checkKey: definition.code,
    scopeType: "MARKET_COUNTRY",
    scopeId: countryCode,
    status: "CONFIRMED",
    evidenceReference: `${countryCode}/${definition.code}.pdf`,
    evidenceHash: "a".repeat(64),
    confirmedBy: "operator@example.com",
    confirmedAt: now,
    expiresAt: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000),
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

test("sale gate only contains countries with complete current evidence", async () => {
  const now = new Date("2026-09-19T00:00:00.000Z");
  const result = await buildInternationalSaleGateProjection({
    now,
    revision: 4,
    prismaClient: {
      internationalShippingCountryAvailability: {
        async findMany() {
          return [
            { countryCode: "FR", status: "ACTIVE", checkedAt: now },
            { countryCode: "US", status: "ACTIVE", checkedAt: now },
          ];
        },
      },
      operationalReadinessAttestation: {
        async findMany() {
          return confirmedEvidence("FR", now);
        },
      },
    },
  });

  assert.deepEqual(result.allowedCountries, ["FR"]);
  assert.equal(result.blockedCountries[0].countryCode, "US");
  assert.equal(result.projection.r, 4);
  assert.match(result.projection.h, /^[a-f0-9]{64}$/);
});

test("sale gate sync uses compareDigest and verifies the exact value", async () => {
  const now = new Date("2026-09-19T00:00:00.000Z");
  let savedValue = null;
  let mutationVariables = null;
  const graphQL = async ({ query, variables }) => {
    if (query.includes("mutation SetInternationalSaleGate")) {
      mutationVariables = variables;
      savedValue = variables.metafields[0].value;
      return {
        data: {
          metafieldsSet: {
            metafields: [{ value: savedValue }],
            userErrors: [],
          },
        },
      };
    }
    return {
      data: {
        shop: {
          id: "gid://shopify/Shop/1",
          internationalSaleGate: savedValue
            ? { value: savedValue, compareDigest: "digest-after" }
            : {
                value: JSON.stringify({ v: 1, r: 2, c: [] }),
                compareDigest: "digest-before",
              },
        },
      },
    };
  };
  const prismaClient = {
    internationalShippingCountryAvailability: {
      async findMany() {
        return [];
      },
    },
    operationalReadinessAttestation: {
      async findMany() {
        return [];
      },
    },
  };

  const result = await syncInternationalSaleGate(
    { shopDomain: "shop.myshopify.com", prismaClient, now },
    { graphQL },
  );

  assert.equal(result.ok, true);
  assert.equal(result.projection.r, 3);
  assert.equal(
    mutationVariables.metafields[0].compareDigest,
    "digest-before",
  );
  assert.equal(result.compareDigest, "digest-after");
});

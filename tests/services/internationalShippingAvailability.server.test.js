import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateInternationalShippingAvailability,
  getInternationalShippingCountryAvailability,
  INTERNATIONAL_SERVICE_STATUS,
  isInternationalServiceActive,
  normalizeInternationalServiceStatus,
  saveInternationalShippingCountryAvailability,
} from "../../app/services/internationalShippingAvailability.server.js";

test("international shipping availability requires a current ACTIVE check", () => {
  const now = new Date("2026-09-18T00:00:00.000Z");
  const current = evaluateInternationalShippingAvailability(
    {
      status: "ACTIVE",
      checkedAt: new Date("2026-09-17T00:00:00.000Z"),
    },
    { now },
  );
  const stale = evaluateInternationalShippingAvailability(
    {
      status: "ACTIVE",
      checkedAt: new Date("2026-09-01T00:00:00.000Z"),
    },
    { now },
  );
  const partial = evaluateInternationalShippingAvailability(
    {
      status: "PARTIAL",
      checkedAt: new Date("2026-09-17T00:00:00.000Z"),
    },
    { now },
  );
  const future = evaluateInternationalShippingAvailability(
    {
      status: "ACTIVE",
      checkedAt: new Date("2026-09-19T00:00:00.000Z"),
    },
    { now },
  );

  assert.equal(current.deliverable, true);
  assert.equal(current.reason, null);
  assert.equal(stale.deliverable, false);
  assert.equal(stale.reason, "international_service_status_stale");
  assert.equal(partial.deliverable, false);
  assert.equal(partial.reason, "international_service_not_active");
  assert.equal(future.deliverable, false);
  assert.equal(future.reason, "international_service_status_invalid");
});

test("international shipping availability defaults unknown and only ACTIVE is deliverable", async () => {
  const result = await getInternationalShippingCountryAvailability({
    countryCode: "FR",
    prismaClient: {
      internationalShippingCountryAvailability: {
        findUnique: async () => null,
      },
    },
  });

  assert.equal(result.status, INTERNATIONAL_SERVICE_STATUS.UNKNOWN);
  assert.equal(result.configured, false);
  assert.equal(isInternationalServiceActive("ACTIVE"), true);
  assert.equal(isInternationalServiceActive("PARTIAL"), false);
  assert.equal(isInternationalServiceActive("SUSPENDED"), false);
  assert.equal(isInternationalServiceActive("UNKNOWN"), false);
  assert.equal(normalizeInternationalServiceStatus("unexpected"), "UNKNOWN");
});

test("international shipping availability saves an auditable country status", async () => {
  let received = null;
  const now = new Date("2026-07-21T00:00:00.000Z");
  const result = await saveInternationalShippingCountryAvailability({
    countryCode: "fr",
    status: "active",
    note: "  Japan Post checked  ",
    sourceUrl: " https://www.post.japanpost.jp/ ",
    now,
    prismaClient: {
      internationalShippingCountryAvailability: {
        async upsert(input) {
          received = input;
          return input.create;
        },
      },
    },
  });

  assert.equal(received.where.countryCode_service.countryCode, "FR");
  assert.equal(result.status, "ACTIVE");
  assert.equal(result.note, "Japan Post checked");
  assert.equal(result.sourceUrl, "https://www.post.japanpost.jp/");
  assert.equal(result.checkedAt, now);
});

test("international shipping availability rejects unsupported country codes", async () => {
  await assert.rejects(
    saveInternationalShippingCountryAvailability({
      countryCode: "XX",
      status: "ACTIVE",
      prismaClient: {},
    }),
    /料金地帯を特定できない/,
  );
});

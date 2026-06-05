import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProductCountryPolicyData,
  formatCountryCodeSummary,
  parseCountryCodeSelection,
  shouldPersistProductCountryPolicy,
  summarizeVendorDeliveryPolicy,
} from "../../app/utils/productCountryPolicy.js";

test("parseCountryCodeSelection normalizes duplicate country codes", () => {
  assert.deepEqual(
    parseCountryCodeSelection(["jp", "FR, de", "FR", "bad-code"]),
    ["DE", "FR", "JP"],
  );
});

test("buildProductCountryPolicyData creates normalized JSON arrays", () => {
  assert.deepEqual(
    buildProductCountryPolicyData("pending_review", {
      allowedCountries: ["jp", "us"],
      blockedCountries: ["fr"],
      requiresWarningCountries: ["sg"],
    }),
    {
      euSaleStatus: "PENDING_REVIEW",
      allowedCountries: ["JP", "US"],
      blockedCountries: ["FR"],
      requiresWarningCountries: ["SG"],
    },
  );
});

test("shouldPersistProductCountryPolicy keeps EU review records without country lists", () => {
  assert.equal(
    shouldPersistProductCountryPolicy("PENDING_REVIEW", {
      allowedCountries: [],
      blockedCountries: [],
      requiresWarningCountries: [],
    }),
    true,
  );
  assert.equal(
    shouldPersistProductCountryPolicy("DISABLED", {
      allowedCountries: [],
      blockedCountries: [],
      requiresWarningCountries: [],
    }),
    false,
  );
});

test("summarizeVendorDeliveryPolicy prioritizes allowed country limits", () => {
  const summary = summarizeVendorDeliveryPolicy({
    productEuStatus: "APPROVED_LOW_RISK",
    countryPolicy: {
      allowedCountries: ["JP", "US"],
      blockedCountries: ["FR"],
      requiresWarningCountries: [],
    },
  });

  assert.equal(summary.label, "配送先限定");
  assert.equal(summary.tone, "warning");
  assert.match(summary.detail, /日本/);
});

test("formatCountryCodeSummary limits long country lists", () => {
  assert.equal(
    formatCountryCodeSummary(["FR", "DE", "NL", "IT"], { limit: 2 }),
    "フランス、ドイツ ほか2件",
  );
});

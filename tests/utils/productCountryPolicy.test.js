import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProductCountryPolicyData,
  formatCountryCodeSummary,
  getDeliveryPolicyTemplateByKey,
  getRecommendedDeliveryPolicyTemplate,
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

test("getRecommendedDeliveryPolicyTemplate recommends cosmetics docs template", () => {
  const template = getRecommendedDeliveryPolicyTemplate({
    name: "NEOBEAUTE ローション",
    category: "化粧品",
  });

  assert.equal(template.key, "cosmetics-docs");
  assert.equal(template.productEuStatus, "REQUIRES_ADDITIONAL_DOCS");
});

test("getRecommendedDeliveryPolicyTemplate recommends low risk EU template", () => {
  const template = getRecommendedDeliveryPolicyTemplate({
    name: "手作りアクセサリー",
    category: "アクセサリー",
  });

  assert.equal(template.key, "low-risk-eu");
  assert.equal(template.productEuStatus, "APPROVED_LOW_RISK");
});

test("getRecommendedDeliveryPolicyTemplate prioritizes high risk keywords", () => {
  const template = getRecommendedDeliveryPolicyTemplate({
    name: "電子アクセサリー",
    category: "アクセサリー",
  });

  assert.equal(template.key, "high-risk-eu-blocked");
  assert.equal(template.productEuStatus, "REJECTED_HIGH_RISK");
});

test("getDeliveryPolicyTemplateByKey returns country limits", () => {
  const template = getDeliveryPolicyTemplateByKey("domestic-only");

  assert.deepEqual(template.allowedCountries, ["JP"]);
  assert.equal(template.productEuStatus, "DISABLED");
});

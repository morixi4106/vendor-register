import assert from "node:assert/strict";
import test from "node:test";
import { collectInternationalCheckoutInventory } from "../../app/services/internationalCheckoutInventory.server.js";
import { buildInternationalCheckoutPlan } from "../../app/services/internationalCheckoutPlan.server.js";
import {
  internationalCoverageKey,
  inspectInternationalCoverage,
} from "../../app/utils/internationalCheckoutVerification.js";
import { checkoutInventoryFixture } from "../helpers/internationalCheckoutFixture.js";

function fixture() {
  const f = checkoutInventoryFixture();
  const build = () =>
    buildInternationalCheckoutPlan({
      shopDomain: "example.myshopify.com",
      scope: f.scope,
      currencies: ["JPY"],
      releaseBinding: "a".repeat(64),
      sourceHash: "b".repeat(64),
      verificationKind: "NON_FINANCIAL",
      native: {
        available: true,
        validationReady: true,
        configHash: "c".repeat(64),
        verificationInventory: collectInternationalCheckoutInventory(f),
      },
    });
  return { ...f, build };
}

test("server builds a deterministic bounded plan from real native product/route facts", () => {
  const f = fixture(),
    plan = f.build();
  assert.equal(plan.version, "international-checkout-cases-v1");
  assert.equal(plan.coverage.length, 1);
  assert.equal(plan.coverage[0].routeKind, "FREE");
  assert.equal(plan.caseCount, 5);
  assert.equal(plan.cases.filter((row) => row.phase === "CLOSED").length, 2);
  assert.equal(plan.requiredCasesHash, f.build().requiredCasesHash);
  assert.ok(!JSON.stringify(plan).includes("callbackUrl"));
  f.method.rateProvider.price.amount = "100";
  assert.notEqual(f.build().requiredCasesHash, plan.requiredCasesHash);
  f.variantFacts[0].variants.nodes[0].id = "gid://shopify/ProductVariant/2";
  assert.notEqual(f.build().coverage[0].variantId, plan.coverage[0].variantId);
});

test("coverage is exact, does not treat same JPY as the same country/variant/route", () => {
  const row = fixture().build().coverage[0];
  assert.equal(inspectInternationalCoverage([row], [row]).complete, true);
  for (const change of [
    { country: "CA" },
    { shopifyProductId: "gid://shopify/Product/2" },
    { variantId: "gid://shopify/ProductVariant/2" },
    { methodId: "other" },
    { routeHash: "d".repeat(64) },
  ]) {
    const result = inspectInternationalCoverage([row], [{ ...row, ...change }]);
    assert.equal(result.complete, false);
    assert.equal(result.missing.length, 1);
    assert.equal(result.unexpected.length, 1);
  }
  for (const change of [
    { currency: "USD" },
    { paymentMethod: "AUTODETECT" },
    { passed: true },
    { quantity: 2 },
  ])
    assert.throws(() => internationalCoverageKey({ ...row, ...change }));
  assert.throws(() => inspectInternationalCoverage([row], [row, row]));
});

for (const field of [
  "foreignMarket",
  "missingMarket",
  "autoCurrency",
  "subnational",
  "wildcard",
  "foreignRate",
  "missingPrice",
  "multipleVariants",
  "incompleteVariants",
  "unknownProvider",
  "adaptiveCarrier",
]) {
  test(`case inventory refuses ${field} without changing native-scope semantics`, () => {
    const f = fixture();
    if (field === "foreignMarket")
      f.markets[0].currencySettings.baseCurrency.currencyCode = "USD";
    if (field === "missingMarket") delete f.markets[0].currencySettings;
    if (field === "autoCurrency")
      f.markets[0].currencySettings.localCurrencies = true;
    if (field === "subnational")
      f.zone.zone.countries[0].provinces.push({ code: "CA" });
    if (field === "wildcard") f.zone.zone.countries[0].code.restOfWorld = true;
    if (field === "foreignRate")
      f.method.rateProvider.price.currencyCode = "USD";
    if (field === "missingPrice") delete f.method.rateProvider.price.amount;
    if (field === "multipleVariants")
      f.variantFacts[0].variants.nodes.push(
        f.variantFacts[0].variants.nodes[0],
      );
    if (field === "incompleteVariants")
      f.variantFacts[0].variants.pageInfo.hasNextPage = true;
    if (field === "unknownProvider")
      f.method.rateProvider.__typename = "Unknown";
    if (field === "adaptiveCarrier")
      f.method.rateProvider = {
        __typename: "DeliveryParticipant",
        id: "carrier",
        adaptToNewServicesFlag: true,
        carrierService: { active: true },
        participantServices: [{ name: "service", active: true }],
      };
    assert.throws(f.build);
  });
}

test("all native carrier services are distinct required cases and excessive scope is rejected, not truncated", () => {
  const f = fixture();
  f.method.rateProvider = {
    __typename: "DeliveryParticipant",
    id: "participant",
    adaptToNewServicesFlag: false,
    carrierService: { id: "carrier", active: true },
    participantServices: [
      { name: "a", active: true },
      { name: "b", active: true },
    ],
  };
  const plan = f.build();
  assert.equal(plan.coverage.length, 2);
  assert.equal(plan.caseCount, 8);
  f.method.rateProvider.participantServices.reverse();
  assert.equal(f.build().requiredCasesHash, plan.requiredCasesHash);
  f.method.rateProvider.participantServices = Array.from(
    { length: 21 },
    (_, i) => ({ name: String(i), active: true }),
  );
  assert.throws(f.build);
});

test("case expansion above 2048 is rejected atomically rather than returning partial coverage", () => {
  const f = fixture(),
    template = f.build().coverage[0];
  const scope = Array.from({ length: 200 }, (_, index) => ({
    productId: `p${index}`,
    shopifyProductId: `gid://shopify/Product/${index + 1}`,
    countries: ["US"],
  }));
  const verificationInventory = scope.map((row) => ({
    shopifyProductId: row.shopifyProductId,
    variants: [template.variantId],
    routes: Array.from({ length: 4 }, (_, i) => ({
      ...template,
      service: String(i),
      routeKind: "CARRIER",
    })),
  }));
  assert.throws(
    () =>
      buildInternationalCheckoutPlan({
        shopDomain: "example.myshopify.com",
        scope,
        currencies: ["JPY"],
        releaseBinding: "a".repeat(64),
        sourceHash: "b".repeat(64),
        verificationKind: "NON_FINANCIAL",
        native: {
          available: true,
          validationReady: true,
          configHash: "c".repeat(64),
          verificationInventory,
        },
      }),
    (e) => e.code === "international_case_plan_limit",
  );
});

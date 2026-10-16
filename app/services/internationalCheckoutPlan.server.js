import {
  normalizeInternationalScope,
  internationalScopeHash,
} from "./internationalGateProjection.server.js";
import { JAPAN_POST_AIR_PACKET_COUNTRY_CODES } from "../utils/japanPostAirPacket.js";
import { requireInternationalCurrencies } from "../utils/internationalCurrencyPolicy.js";
import { proofHash, proofError } from "../utils/internationalProofContract.js";
import {
  INTERNATIONAL_CHECKOUT_SCENARIOS,
  INTERNATIONAL_CHECKOUT_VERIFIER,
  INTERNATIONAL_ARTIFACT_CASES,
  MAX_INTERNATIONAL_CASES,
  internationalCoverageKey,
} from "../utils/internationalCheckoutVerification.js";

export function buildInternationalCheckoutPlan({
  shopDomain,
  scope,
  currencies,
  native,
  releaseBinding,
  sourceHash,
  verificationKind,
}) {
  const selected = normalizeInternationalScope(scope);
  const units = requireInternationalCurrencies(currencies);
  if (
    verificationKind === "FINANCIAL" &&
    selected.some((row) => row.countries.includes("GB"))
  )
    throw proofError("international_region_unverified");
  if (
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain) ||
    ![releaseBinding, sourceHash, native?.configHash].every((v) =>
      /^[a-f0-9]{64}$/.test(v || ""),
    ) ||
    native?.available !== true ||
    native.validationReady !== true ||
    !["NON_FINANCIAL", "FINANCIAL"].includes(verificationKind) ||
    !Array.isArray(native.verificationInventory) ||
    native.verificationInventory.length > 200
  )
    throw proofError("international_case_inventory_unverified");
  const cases = [],
    coverage = [];
  const add = (scenario, phase, expectedStage, expectedOutcome, target) => {
    if (cases.length >= MAX_INTERNATIONAL_CASES)
      throw proofError("international_case_plan_limit");
    const value = { scenario, phase, expectedStage, expectedOutcome, target };
    cases.push({ ...value, caseKey: proofHash(value) });
  };
  for (const entry of selected) {
    const matches = native.verificationInventory.filter(
      (row) => row.shopifyProductId === entry.shopifyProductId,
    );
    // The existing native reader supports exactly one physical variant; do not widen it here.
    if (
      matches.length !== 1 ||
      !Array.isArray(matches[0].variants) ||
      matches[0].variants.length !== 1
    )
      throw proofError("international_case_inventory_unverified");
    const product = matches[0];
    for (const country of entry.countries) {
      const routes = product.routes.filter((row) => row.country === country);
      if (!routes.length)
        throw proofError("international_case_inventory_unverified");
      for (const route of routes) {
        const row = {
          country,
          shopifyProductId: entry.shopifyProductId,
          variantId: product.variants[0],
          quantity: 1,
          currency: "JPY",
          profileId: route.profileId,
          zoneId: route.zoneId,
          methodId: route.methodId,
          providerId: route.providerId,
          service: route.service,
          routeKind: route.routeKind,
          routeHash: route.routeHash,
          paymentProvider: "KOMOJU",
          paymentMethod: "CARD",
        };
        internationalCoverageKey(row);
        coverage.push(row);
        add(
          "allowed-before-payment",
          "OPEN",
          "CHECKOUT_INTERACTION",
          "ALLOWED",
          row,
        );
        add(
          "old-checkout-blocked",
          "CLOSED",
          "CHECKOUT_INTERACTION",
          "REJECTED",
          row,
        );
        add(
          "new-checkout-blocked",
          "CLOSED",
          "CHECKOUT_INTERACTION",
          "REJECTED",
          row,
        );
        if (verificationKind === "FINANCIAL")
          add(
            "live-payment-refund-ledger",
            "FINANCIAL",
            "CHECKOUT_COMPLETION",
            "RECONCILED",
            row,
          );
      }
    }
    const denied = JAPAN_POST_AIR_PACKET_COUNTRY_CODES.find(
      (country) => country !== "JP" && !entry.countries.includes(country),
    );
    if (!denied) throw proofError("international_case_inventory_unverified");
    add("country-rejected", "OPEN", "CHECKOUT_INTERACTION", "REJECTED", {
      shopifyProductId: entry.shopifyProductId,
      variantId: product.variants[0],
      country: denied,
    });
    add("domestic-regression", "OPEN", "CHECKOUT_INTERACTION", "ALLOWED", {
      shopifyProductId: entry.shopifyProductId,
      variantId: product.variants[0],
      country: "JP",
    });
  }
  cases.sort((a, b) => a.caseKey.localeCompare(b.caseKey));
  const keys = coverage.map(internationalCoverageKey).sort();
  if (
    new Set(keys).size !== keys.length ||
    new Set(cases.map((row) => row.caseKey)).size !== cases.length
  )
    throw proofError("international_case_plan_invalid");
  coverage.sort((a, b) =>
    internationalCoverageKey(a).localeCompare(internationalCoverageKey(b)),
  );
  const plan = {
    version: INTERNATIONAL_CHECKOUT_SCENARIOS,
    verifierVersion: INTERNATIONAL_CHECKOUT_VERIFIER,
    shopDomain,
    scopeHash: internationalScopeHash(selected, units),
    currencies: units,
    releaseBinding,
    sourceHash,
    nativeConfigHash: native.configHash,
    verificationKind,
    artifactCases: [...INTERNATIONAL_ARTIFACT_CASES],
    coverage,
    cases,
  };
  return {
    ...plan,
    requiredCasesHash: proofHash(plan),
    caseCount: cases.length,
  };
}

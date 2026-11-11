import { proofHash, shape, proofError } from "./internationalProofContract.js";
import { requireInternationalCurrencies } from "./internationalCurrencyPolicy.js";
import { JAPAN_POST_AIR_PACKET_COUNTRY_CODES } from "./japanPostAirPacket.js";

export const INTERNATIONAL_CHECKOUT_SCENARIOS =
  "international-checkout-cases-v1";
export const INTERNATIONAL_CHECKOUT_VERIFIER =
  "international-checkout-contract-v1";
export const MAX_INTERNATIONAL_CASES = 2048;
export const INTERNATIONAL_ARTIFACT_CASES = Object.freeze([
  "currency",
  "currency-missing",
  "legacy-policy",
  "projection-missing",
  "projection-malformed",
  "generation",
  "expiry",
  "northern-ireland",
  "mixed-cart",
  "work-limit",
  "revocation",
  "lease-expiry",
]);
const FIELDS = [
  "country",
  "shopifyProductId",
  "variantId",
  "quantity",
  "currency",
  "profileId",
  "zoneId",
  "methodId",
  "providerId",
  "service",
  "routeKind",
  "routeHash",
  "paymentProvider",
  "paymentMethod",
];

export function internationalCoverageKey(row) {
  shape(row, FIELDS, 2048);
  requireInternationalCurrencies([row.currency]);
  if (
    !JAPAN_POST_AIR_PACKET_COUNTRY_CODES.includes(row.country) ||
    row.country === "JP" ||
    !/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(row.shopifyProductId) ||
    !/^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/.test(row.variantId) ||
    row.quantity !== 1 ||
    !["MANUAL", "FREE", "CARRIER"].includes(row.routeKind) ||
    ![row.profileId, row.zoneId, row.methodId, row.providerId].every(
      (v) => typeof v === "string" && /^[A-Za-z0-9:/_-]{1,160}$/.test(v),
    ) ||
    typeof row.service !== "string" ||
    row.service.length > 128 ||
    [...row.service].some((c) => c.charCodeAt(0) < 32) ||
    !/^[a-f0-9]{64}$/.test(row.routeHash) ||
    row.paymentProvider !== "KOMOJU" ||
    row.paymentMethod !== "CARD"
  )
    throw proofError("international_case_plan_invalid");
  return proofHash(row);
}

// This compares coverage, not whether a trusted executor actually ran a case.
export function inspectInternationalCoverage(expected, observed) {
  if (
    ![expected, observed].every(
      (rows) =>
        Array.isArray(rows) &&
        rows.length > 0 &&
        rows.length <= MAX_INTERNATIONAL_CASES,
    )
  )
    throw proofError("international_case_plan_invalid");
  const keys = (rows) => {
    const result = rows.map(internationalCoverageKey).sort();
    if (new Set(result).size !== result.length)
      throw proofError("international_case_plan_invalid");
    return result;
  };
  const wanted = keys(expected),
    actual = keys(observed);
  const wantedSet = new Set(wanted),
    actualSet = new Set(actual);
  return {
    complete: proofHash(wanted) === proofHash(actual),
    missing: wanted.filter((key) => !actualSet.has(key)),
    unexpected: actual.filter((key) => !wantedSet.has(key)),
    coverageHash: proofHash(wanted),
  };
}

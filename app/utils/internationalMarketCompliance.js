import { EU_COUNTRY_CODES, normalizeCountryCode } from "./deliveryEligibility.js";

export const INTERNATIONAL_REQUIREMENT_VERSION = "2026-09-v2";

export const INTERNATIONAL_COMPLIANCE_REQUIREMENTS = Object.freeze([
  {
    code: "INTERNATIONAL_COSMETICS_TRANSPORT_SAFETY",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "Cosmetics international transport safety review",
    jurisdiction: "INTERNATIONAL",
    market: "CROSS_BORDER",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "Japan Post international mail conditions",
    sourceUrl: "https://www.post.japanpost.jp/int/use/restriction/index_en.html",
  },
  {
    code: "EU_COSMETICS_RESPONSIBLE_PERSON",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "EU cosmetics responsible person",
    jurisdiction: "EU",
    market: "EU",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "EU Cosmetics Regulation",
    sourceUrl: "https://eur-lex.europa.eu/eli/reg/2009/1223/oj/eng",
  },
  {
    code: "EU_COSMETICS_SAFETY_REPORT",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "EU cosmetic product safety report",
    jurisdiction: "EU",
    market: "EU",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "EU Cosmetics Regulation",
    sourceUrl: "https://eur-lex.europa.eu/eli/reg/2009/1223/oj/eng",
  },
  {
    code: "EU_COSMETICS_PRODUCT_INFORMATION_FILE",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "EU cosmetics product information file",
    jurisdiction: "EU",
    market: "EU",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "EU Cosmetics Regulation",
    sourceUrl: "https://eur-lex.europa.eu/eli/reg/2009/1223/oj/eng",
  },
  {
    code: "EU_COSMETICS_GMP",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "EU cosmetics good manufacturing practice evidence",
    jurisdiction: "EU",
    market: "EU",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "EU Cosmetics Regulation",
    sourceUrl: "https://eur-lex.europa.eu/eli/reg/2009/1223/oj/eng",
  },
  {
    code: "EU_COSMETICS_NOTIFICATION",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "EU CPNP notification",
    jurisdiction: "EU",
    market: "EU",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "ISSUER_VERIFIED",
    sourceTitle: "Cosmetic Products Notification Portal",
    sourceUrl:
      "https://single-market-economy.ec.europa.eu/sectors/cosmetics/cosmetic-product-notification-portal_en",
  },
  {
    code: "EU_COSMETICS_LABEL_REVIEW",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "EU cosmetics label and claims review",
    jurisdiction: "EU",
    market: "EU",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "EU Cosmetics Regulation",
    sourceUrl: "https://eur-lex.europa.eu/eli/reg/2009/1223/oj/eng",
  },
  {
    code: "EU_COSMETICS_SERIOUS_UNDESIRABLE_EFFECT_PROCEDURE",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "EU cosmetics serious undesirable effect procedure",
    jurisdiction: "EU",
    market: "EU",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "EU Cosmetics Regulation",
    sourceUrl: "https://eur-lex.europa.eu/eli/reg/2009/1223/oj/eng",
  },
  {
    code: "EU_COSMETICS_RECALL_TRACEABILITY_PROCEDURE",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "EU cosmetics recall and traceability procedure",
    jurisdiction: "EU",
    market: "EU",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "EU Cosmetics Regulation",
    sourceUrl: "https://eur-lex.europa.eu/eli/reg/2009/1223/oj/eng",
  },
  {
    code: "GB_COSMETICS_RESPONSIBLE_PERSON",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "Great Britain cosmetics responsible person",
    jurisdiction: "GB",
    market: "GB",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "Making cosmetic products available in Great Britain",
    sourceUrl:
      "https://www.gov.uk/guidance/making-cosmetic-products-available-to-consumers-in-great-britain",
  },
  {
    code: "GB_COSMETICS_SAFETY_REPORT",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "Great Britain cosmetic product safety report",
    jurisdiction: "GB",
    market: "GB",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "Making cosmetic products available in Great Britain",
    sourceUrl:
      "https://www.gov.uk/guidance/making-cosmetic-products-available-to-consumers-in-great-britain",
  },
  {
    code: "GB_COSMETICS_PRODUCT_INFORMATION_FILE",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "Great Britain cosmetics product information file",
    jurisdiction: "GB",
    market: "GB",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "Making cosmetic products available in Great Britain",
    sourceUrl:
      "https://www.gov.uk/guidance/making-cosmetic-products-available-to-consumers-in-great-britain",
  },
  {
    code: "GB_COSMETICS_GMP",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "Great Britain cosmetics good manufacturing practice evidence",
    jurisdiction: "GB",
    market: "GB",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "Making cosmetic products available in Great Britain",
    sourceUrl:
      "https://www.gov.uk/guidance/making-cosmetic-products-available-to-consumers-in-great-britain",
  },
  {
    code: "GB_COSMETICS_NOTIFICATION",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "Great Britain cosmetic product notification",
    jurisdiction: "GB",
    market: "GB",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "ISSUER_VERIFIED",
    sourceTitle: "Submit a cosmetic product notification",
    sourceUrl:
      "https://www.gov.uk/guidance/submit-a-cosmetic-product-notification",
  },
  {
    code: "GB_COSMETICS_LABEL_REVIEW",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "Great Britain cosmetics label and claims review",
    jurisdiction: "GB",
    market: "GB",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "Making cosmetic products available in Great Britain",
    sourceUrl:
      "https://www.gov.uk/guidance/making-cosmetic-products-available-to-consumers-in-great-britain",
  },
  {
    code: "GB_COSMETICS_SERIOUS_UNDESIRABLE_EFFECT_PROCEDURE",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "Great Britain cosmetics serious undesirable effect procedure",
    jurisdiction: "GB",
    market: "GB",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "Making cosmetic products available in Great Britain",
    sourceUrl:
      "https://www.gov.uk/guidance/making-cosmetic-products-available-to-consumers-in-great-britain",
  },
  {
    code: "GB_COSMETICS_RECALL_TRACEABILITY_PROCEDURE",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "Great Britain cosmetics recall and traceability procedure",
    jurisdiction: "GB",
    market: "GB",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "Making cosmetic products available in Great Britain",
    sourceUrl:
      "https://www.gov.uk/guidance/making-cosmetic-products-available-to-consumers-in-great-britain",
  },
  {
    code: "US_COSMETICS_FACILITY_REGISTRATION",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "US MoCRA facility registration applicability and evidence",
    jurisdiction: "US",
    market: "US",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    allowNotApplicable: true,
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "FDA MoCRA registration and listing",
    sourceUrl:
      "https://www.fda.gov/cosmetics/registration-listing-cosmetic-product-facilities-and-products",
  },
  {
    code: "US_COSMETICS_PRODUCT_LISTING",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "US MoCRA product listing applicability and evidence",
    jurisdiction: "US",
    market: "US",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    allowNotApplicable: true,
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "FDA MoCRA registration and listing",
    sourceUrl:
      "https://www.fda.gov/cosmetics/registration-listing-cosmetic-product-facilities-and-products",
  },
  {
    code: "US_COSMETICS_GMP_APPLICABILITY",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "US MoCRA GMP applicability and readiness",
    jurisdiction: "US",
    market: "US",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    allowNotApplicable: true,
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "FDA Modernization of Cosmetics Regulation Act",
    sourceUrl:
      "https://www.fda.gov/cosmetics/cosmetics-laws-regulations/modernization-cosmetics-regulation-act-2022-mocra",
  },
  {
    code: "US_COSMETICS_SAFETY_SUBSTANTIATION",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "US cosmetics safety substantiation",
    jurisdiction: "US",
    market: "US",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "FDA Modernization of Cosmetics Regulation Act",
    sourceUrl:
      "https://www.fda.gov/cosmetics/cosmetics-laws-regulations/modernization-cosmetics-regulation-act-2022-mocra",
  },
  {
    code: "US_COSMETICS_SERIOUS_ADVERSE_EVENT_PROCEDURE",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "US cosmetics serious adverse event reporting procedure",
    jurisdiction: "US",
    market: "US",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "FDA Modernization of Cosmetics Regulation Act",
    sourceUrl:
      "https://www.fda.gov/cosmetics/cosmetics-laws-regulations/modernization-cosmetics-regulation-act-2022-mocra",
  },
  {
    code: "US_COSMETICS_RECALL_PROCEDURE",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "US cosmetics recall procedure",
    jurisdiction: "US",
    market: "US",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "FDA Modernization of Cosmetics Regulation Act",
    sourceUrl:
      "https://www.fda.gov/cosmetics/cosmetics-laws-regulations/modernization-cosmetics-regulation-act-2022-mocra",
  },
  {
    code: "US_COSMETICS_LABEL_CLAIMS_REVIEW",
    version: INTERNATIONAL_REQUIREMENT_VERSION,
    name: "US cosmetics label and claims review",
    jurisdiction: "US",
    market: "US",
    productCategory: "COSMETICS",
    severity: "BLOCKING",
    requiredVerificationLevel: "DOCUMENT_REVIEWED",
    sourceTitle: "FDA wrinkle treatments and anti-aging products",
    sourceUrl:
      "https://www.fda.gov/cosmetics/cosmetic-products/wrinkle-treatments-and-other-anti-aging-products",
  },
]);

const VERIFICATION_LEVELS = [
  "UNVERIFIED",
  "SELF_ATTESTED",
  "DOCUMENT_REVIEWED",
  "ISSUER_VERIFIED",
  "API_VERIFIED",
];

const COSMETICS_TOKENS = [
  "COSMETIC",
  "COSMETICS",
  "QUASI_DRUG",
  "BEAUTY",
  "SKINCARE",
  "SKIN CARE",
  "化粧品",
  "医薬部外品",
  "コスメ",
  "スキンケア",
  "化粧水",
  "乳液",
  "クリーム",
  "洗顔",
];

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeUpper(value) {
  return String(value ?? "").trim().toUpperCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isCurrent(entry, now) {
  return (
    (!entry?.reviewDueAt || new Date(entry.reviewDueAt).getTime() > now.getTime()) &&
    (!entry?.expiresAt || new Date(entry.expiresAt).getTime() > now.getTime()) &&
    !entry?.revokedAt
  );
}

function dateBoundaryIsCurrent(value, now, comparison) {
  if (!value) return true;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return false;
  return comparison(timestamp, now.getTime());
}

export function isInternationalRequirementCurrent(requirement, now = new Date()) {
  return (
    requirement?.isActive !== false &&
    normalizeUpper(requirement?.status || "ACTIVE") === "ACTIVE" &&
    dateBoundaryIsCurrent(
      requirement?.effectiveFrom,
      now,
      (timestamp, nowTimestamp) => timestamp <= nowTimestamp,
    ) &&
    dateBoundaryIsCurrent(
      requirement?.effectiveUntil,
      now,
      (timestamp, nowTimestamp) => timestamp > nowTimestamp,
    ) &&
    dateBoundaryIsCurrent(
      requirement?.reviewDueAt,
      now,
      (timestamp, nowTimestamp) => timestamp > nowTimestamp,
    )
  );
}

function verificationRank(value) {
  return VERIFICATION_LEVELS.indexOf(normalizeUpper(value));
}

export function getInternationalMarket(countryCode) {
  const country = normalizeCountryCode(countryCode);
  if (!country || country === "JP") return "DOMESTIC";
  if (EU_COUNTRY_CODES.has(country)) return "EU";
  if (country === "GB") return "GB";
  if (country === "US") return "US";
  return "OTHER";
}

export function isCosmeticsProduct(product) {
  const profile = product?.complianceProfile || {};
  const source = [
    profile.regulatoryCategory,
    product?.category,
    product?.productType,
    product?.name,
  ]
    .map((value) => String(value || ""))
    .join(" ")
    .toUpperCase();

  return COSMETICS_TOKENS.some((token) => source.includes(token.toUpperCase()));
}

export function getRequiredInternationalRequirements(product, countryCode) {
  const market = getInternationalMarket(countryCode);
  if (market === "DOMESTIC" || !isCosmeticsProduct(product)) return [];

  return INTERNATIONAL_COMPLIANCE_REQUIREMENTS.filter(
    (entry) => entry.market === "CROSS_BORDER" || entry.market === market,
  );
}

function requirementIdentityMatches(entry, requirement) {
  return (
    entry?.requirement?.code === requirement.code &&
    String(entry?.requirement?.version || "v1") === requirement.version
  );
}

function requirementMatches(entry, requirement, now) {
  return (
    requirementIdentityMatches(entry, requirement) &&
    isInternationalRequirementCurrent(entry?.requirement, now)
  );
}

export function evaluateInternationalMarketCompliance({
  product,
  destinationCountry,
  evaluatedAt = new Date(),
} = {}) {
  const countryCode = normalizeCountryCode(destinationCountry);
  const market = getInternationalMarket(countryCode);
  if (market === "DOMESTIC") {
    return { ready: true, reasons: [], market, requirements: [] };
  }

  const profile = product?.complianceProfile || null;
  const reasons = [];
  if (!profile || normalizeUpper(profile.approvalStatus) !== "APPROVED") {
    reasons.push("international_compliance_profile_not_approved");
  }
  if (!normalizeText(profile?.regulatoryCategory)) {
    reasons.push("international_regulatory_category_missing");
  }

  const cosmetics = isCosmeticsProduct(product);
  if (cosmetics && market === "OTHER") {
    reasons.push("international_cosmetics_market_not_configured");
  }

  const required = getRequiredInternationalRequirements(product, countryCode);
  const decisions = asArray(product?.complianceDecisions);
  const evidence = asArray(product?.complianceEvidence);
  const requirementResults = required.map((requirement) => {
    const matchingEntries = [...decisions, ...evidence].filter((entry) =>
      requirementIdentityMatches(entry, requirement),
    );
    const currentRequirementFound = matchingEntries.some((entry) =>
      isInternationalRequirementCurrent(entry?.requirement, evaluatedAt),
    );
    const currentDecision = decisions
      .filter(
        (entry) =>
          requirementMatches(entry, requirement, evaluatedAt) &&
          isCurrent(entry, evaluatedAt),
      )
      .sort(
        (left, right) =>
          new Date(right.decidedAt || 0).getTime() -
          new Date(left.decidedAt || 0).getTime(),
      )[0];
    const verifiedEvidence = evidence.filter(
      (entry) =>
        requirementMatches(entry, requirement, evaluatedAt) &&
        normalizeUpper(entry.status) === "VERIFIED" &&
        isCurrent(entry, evaluatedAt) &&
        verificationRank(entry.verificationLevel) >=
          verificationRank(requirement.requiredVerificationLevel),
    );
    const decision = normalizeUpper(currentDecision?.decision);
    const ready =
      (decision === "NOT_APPLICABLE" &&
        requirement.allowNotApplicable === true) ||
      (decision === "COMPLIANT" && verifiedEvidence.length > 0);

    if (matchingEntries.length > 0 && !currentRequirementFound) {
      reasons.push(`requirement_catalog_review_overdue:${requirement.code}`);
    } else if (!currentDecision) {
      reasons.push(`requirement_decision_missing:${requirement.code}`);
    } else if (decision === "BLOCKED") {
      reasons.push(`requirement_blocked:${requirement.code}`);
    } else if (decision === "COMPLIANT" && verifiedEvidence.length === 0) {
      reasons.push(`requirement_evidence_missing:${requirement.code}`);
    } else if (
      decision === "NOT_APPLICABLE" &&
      requirement.allowNotApplicable !== true
    ) {
      reasons.push(`requirement_not_applicable_not_allowed:${requirement.code}`);
    } else if (!ready) {
      reasons.push(`requirement_not_satisfied:${requirement.code}`);
    }

    return {
      code: requirement.code,
      version: requirement.version,
      ready,
      requirementCurrent: currentRequirementFound,
      decisionId: currentDecision?.id || null,
      verifiedEvidenceCount: verifiedEvidence.length,
    };
  });

  return {
    ready: reasons.length === 0,
    reasons: Array.from(new Set(reasons)),
    market,
    countryCode,
    isCosmetics: cosmetics,
    requirements: requirementResults,
  };
}

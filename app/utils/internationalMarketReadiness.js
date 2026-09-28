import { normalizeCountryCode } from "./deliveryEligibility.js";
import { getInternationalMarket } from "./internationalMarketCompliance.js";

export const INTERNATIONAL_MARKET_REQUIREMENT_VERSION = "2026-09-v1";
export const INTERNATIONAL_MARKET_EVIDENCE_SCOPE = "MARKET_COUNTRY";

const COMMON_REQUIREMENTS = [
  {
    code: "INTERNATIONAL_CARRIER_SERVICE_STATUS",
    label: "国別配送サービスの受付状況",
    validityDays: 7,
    sourceUrl: "https://www.post.japanpost.jp/int/information/overview.html",
    confirmations: ["officialStatusChecked", "countryServiceMatched"],
  },
  {
    code: "INTERNATIONAL_SHOPIFY_DELIVERY_ROUTE_AUDIT",
    label: "Shopify配送経路の迂回防止確認",
    validityDays: 30,
    sourceUrl: "https://help.shopify.com/en/manual/fulfillment/setup/shipping-rates/shipping-profiles",
    confirmations: [
      "deliveryProfileMatched",
      "manualRatesReviewed",
      "freeShippingReviewed",
      "alternateCarrierReviewed",
      "alternateProfilesReviewed",
    ],
  },
  {
    code: "INTERNATIONAL_SUPPORT_RETURN_COMPLAINT_ROUTE",
    label: "対象国向けサポート・返送・苦情受付経路",
    validityDays: 90,
    sourceUrl: "https://europa.eu/youreurope/citizens/consumers/shopping/guarantees-returns/index_en.htm",
    confirmations: [
      "supportLanguageReady",
      "returnAddressReady",
      "complaintsContactReady",
    ],
  },
  {
    code: "INTERNATIONAL_SHOPIFY_MARKETS_CONFIGURATION",
    label: "Shopify Marketsと購入可能地域の設定",
    validityDays: 30,
    sourceUrl: "https://help.shopify.com/en/manual/international/markets-new",
    confirmations: [
      "marketConfigurationReviewed",
      "currencyConfigurationReviewed",
      "checkoutAvailabilityReviewed",
    ],
  },
  {
    code: "INTERNATIONAL_TAX_CUSTOMS_INCOTERM_POLICY",
    label: "税関・関税・インコタームズ方針",
    validityDays: 90,
    sourceUrl: "https://help.shopify.com/en/manual/international/duties-and-import-taxes",
    confirmations: [
      "hsCodeReady",
      "countryOfOriginReady",
      "incotermConfirmed",
      "dutiesResponsibilityDisplayed",
    ],
  },
  {
    code: "INTERNATIONAL_PRIVACY_TRANSFER_REVIEW",
    label: "国外移転を含むプライバシー対応",
    validityDays: 90,
    sourceUrl: "https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection_en",
    confirmations: [
      "privacyNoticeReady",
      "processorsReviewed",
      "transferMechanismReviewed",
    ],
  },
];

const MARKET_REQUIREMENTS = {
  EU: [
    {
      code: "EU_WITHDRAWAL_OPERATION_READY",
      label: "EU撤回権の受付・確認通知運用",
      validityDays: 90,
      sourceUrl: "https://eur-lex.europa.eu/eli/dir/2023/2673/oj/eng",
      confirmations: [
        "withdrawalFunctionVisible",
        "withdrawalPeriodCovered",
        "acknowledgementEmailReady",
        "contentAndTimestampCaptured",
      ],
    },
    {
      code: "EU_LEGAL_GUARANTEE_REMEDIES_READY",
      label: "EU法定保証と救済手順",
      validityDays: 90,
      sourceUrl: "https://europa.eu/youreurope/citizens/consumers/shopping/guarantees-returns/index_en.htm",
      confirmations: [
        "twoYearGuaranteeDisplayed",
        "repairProcedureReady",
        "replacementProcedureReady",
        "priceReductionProcedureReady",
        "refundProcedureReady",
      ],
    },
    {
      code: "EU_VAT_IOSS_DDP_POLICY",
      label: "EU VAT・IOSS・DDP/DAP方針",
      validityDays: 90,
      sourceUrl: "https://vat-one-stop-shop.ec.europa.eu/one-stop-shop/ioss_en",
      confirmations: [
        "vatRegistrationReviewed",
        "iossDecisionRecorded",
        "ddpDapDecisionRecorded",
        "carrierDutySupportReviewed",
      ],
    },
    {
      code: "EU_PACKAGING_EPR_READY",
      label: "配送先国の包装EPR対応",
      validityDays: 90,
      sourceUrl: "https://eur-lex.europa.eu/eli/reg/2025/40/oj/eng",
      confirmations: [
        "registrationDecisionRecorded",
        "registrationNumberOrExemptionRecorded",
        "localRepresentativeDecisionRecorded",
        "packagingMaterialsRecorded",
        "reportingScheduleRecorded",
      ],
    },
    {
      code: "EU_CUSTOMS_LOW_VALUE_PID_READY",
      label: "EU低額貨物3ユーロ・PID対応",
      validityDays: 90,
      sourceUrl: "https://taxation-customs.ec.europa.eu/news/guidance-and-legal-text-temporary-flat-fee-low-value-imports-which-will-apply-until-1-july-2028-2026-06-08_en",
      confirmations: [
        "lowValueThresholdRecorded",
        "threeEuroItemRuleRecorded",
        "pidReadinessRecorded",
      ],
    },
  ],
  GB: [
    {
      code: "GB_CONSUMER_RIGHTS_OPERATION_READY",
      label: "英国向け取消・返品・法定救済手順",
      validityDays: 90,
      sourceUrl: "https://www.gov.uk/online-and-distance-selling-for-businesses",
      confirmations: [
        "cancellationProcedureReady",
        "returnsProcedureReady",
        "statutoryRemediesReady",
      ],
    },
  ],
  US: [],
  OTHER: [],
};

function freezeDefinition(definition, market) {
  return Object.freeze({
    ...definition,
    market,
    version: INTERNATIONAL_MARKET_REQUIREMENT_VERSION,
    confirmations: Object.freeze([...definition.confirmations]),
  });
}

export const INTERNATIONAL_MARKET_REQUIREMENTS = Object.freeze([
  ...COMMON_REQUIREMENTS.map((definition) =>
    freezeDefinition(definition, "CROSS_BORDER"),
  ),
  ...Object.entries(MARKET_REQUIREMENTS).flatMap(([market, definitions]) =>
    definitions.map((definition) => freezeDefinition(definition, market)),
  ),
]);

const REQUIREMENT_BY_CODE = new Map(
  INTERNATIONAL_MARKET_REQUIREMENTS.map((definition) => [
    definition.code,
    definition,
  ]),
);

function normalizeUpper(value) {
  return String(value ?? "").trim().toUpperCase();
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || "").trim());
}

function isHttpsUrl(value) {
  try {
    return new URL(String(value || "").trim()).protocol === "https:";
  } catch {
    return false;
  }
}

function validDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

export function getInternationalMarketRequirement(code) {
  return REQUIREMENT_BY_CODE.get(normalizeUpper(code)) || null;
}

export function getInternationalMarketRequirements(countryCode) {
  const country = normalizeCountryCode(countryCode);
  const market = getInternationalMarket(country);
  if (!country || market === "DOMESTIC") return [];

  return INTERNATIONAL_MARKET_REQUIREMENTS.filter(
    (definition) =>
      definition.market === "CROSS_BORDER" || definition.market === market,
  );
}

export function isNorthernIrelandDestination({
  countryCode,
  provinceCode,
  postalCode,
} = {}) {
  if (normalizeCountryCode(countryCode) !== "GB") return false;
  const province = normalizeUpper(provinceCode).replace(/^GB-/, "");
  const postal = normalizeUpper(postalCode).replace(/\s+/g, "");
  return province === "NIR" || province === "NI" || postal.startsWith("BT");
}

export function evaluateInternationalMarketEvidence(
  definition,
  attestation,
  { countryCode, now = new Date() } = {},
) {
  const reasons = [];
  const confirmedAt = validDate(attestation?.confirmedAt);
  const expiresAt = validDate(attestation?.expiresAt);
  const metadata = attestation?.metadataJson || {};
  const confirmations = metadata.confirmations || {};

  if (!attestation) reasons.push("market_evidence_missing");
  if (normalizeUpper(attestation?.status) !== "CONFIRMED") {
    reasons.push("market_evidence_not_confirmed");
  }
  if (!String(attestation?.evidenceReference || "").trim()) {
    reasons.push("market_evidence_reference_missing");
  }
  if (!isSha256(attestation?.evidenceHash)) {
    reasons.push("market_evidence_hash_invalid");
  }
  if (!String(attestation?.confirmedBy || "").trim()) {
    reasons.push("market_evidence_confirmer_missing");
  }
  if (!confirmedAt || confirmedAt.getTime() > now.getTime()) {
    reasons.push("market_evidence_confirmation_time_invalid");
  }
  if (!expiresAt || expiresAt.getTime() <= now.getTime()) {
    reasons.push("market_evidence_expired");
  }
  if (metadata.requirementVersion !== definition.version) {
    reasons.push("market_evidence_version_mismatch");
  }
  if (normalizeCountryCode(metadata.countryCode) !== normalizeCountryCode(countryCode)) {
    reasons.push("market_evidence_country_mismatch");
  }
  if (!isHttpsUrl(metadata.officialSourceUrl)) {
    reasons.push("market_evidence_source_invalid");
  }
  for (const confirmation of definition.confirmations) {
    if (confirmations[confirmation] !== true) {
      reasons.push(`market_confirmation_missing:${confirmation}`);
    }
  }

  return {
    code: definition.code,
    label: definition.label,
    ready: reasons.length === 0,
    reasons,
    confirmedAt,
    expiresAt,
  };
}

export function evaluateInternationalMarketReadiness({
  countryCode,
  provinceCode = null,
  postalCode = null,
  attestations = [],
  now = new Date(),
} = {}) {
  const country = normalizeCountryCode(countryCode);
  const market = getInternationalMarket(country);
  if (!country || market === "DOMESTIC") {
    return { ready: true, countryCode: country || null, market, reasons: [], requirements: [] };
  }
  if (isNorthernIrelandDestination({ countryCode: country, provinceCode, postalCode })) {
    return {
      ready: false,
      countryCode: country,
      market,
      reasons: ["northern_ireland_not_supported"],
      requirements: [],
    };
  }

  const records = new Map(
    (Array.isArray(attestations) ? attestations : []).map((attestation) => [
      normalizeUpper(attestation?.checkKey),
      attestation,
    ]),
  );
  const requirements = getInternationalMarketRequirements(country).map(
    (definition) =>
      evaluateInternationalMarketEvidence(
        definition,
        records.get(definition.code),
        { countryCode: country, now },
      ),
  );
  const reasons = requirements.flatMap((requirement) =>
    requirement.reasons.map((reason) => `${requirement.code}:${reason}`),
  );

  return {
    ready: reasons.length === 0,
    countryCode: country,
    market,
    reasons,
    requirements,
  };
}

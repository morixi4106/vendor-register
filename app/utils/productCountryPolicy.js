import {
  EU_COUNTRY_CODES,
  PUBLIC_COUNTRY_LABELS_JA,
  formatPublicCountryLabel,
  normalizeCountryCode,
  normalizeCountryList,
} from "./deliveryEligibility.js";

const PRIORITY_COUNTRY_CODES = ["JP", "US", "GB", "AU", "KR", "SG"];
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

function createCountryOption(code) {
  return {
    code,
    label: formatPublicCountryLabel(code) || code,
  };
}

function sortCountryOptions(countryCodes) {
  return Array.from(new Set(countryCodes.map(normalizeCountryCode).filter(Boolean)))
    .map(createCountryOption)
    .sort((left, right) => left.label.localeCompare(right.label, "ja-JP"));
}

const priorityCountryCodeSet = new Set(PRIORITY_COUNTRY_CODES);

export const DELIVERY_COUNTRY_GROUPS = [
  {
    key: "priority",
    label: "主要な配送先",
    options: PRIORITY_COUNTRY_CODES.map(createCountryOption),
  },
  {
    key: "eu",
    label: "EU",
    options: sortCountryOptions(Array.from(EU_COUNTRY_CODES)),
  },
  {
    key: "other",
    label: "その他",
    options: sortCountryOptions(
      Object.keys(PUBLIC_COUNTRY_LABELS_JA).filter(
        (code) => !priorityCountryCodeSet.has(code) && !EU_COUNTRY_CODES.has(code),
      ),
    ),
  },
];

export const DELIVERY_COUNTRY_OPTIONS = DELIVERY_COUNTRY_GROUPS.flatMap(
  (group) => group.options,
);

function splitCountryCodeInput(value) {
  return String(value || "")
    .split(/[\s,;、，]+/)
    .map(normalizeCountryCode)
    .filter(Boolean);
}

export function parseCountryCodeSelection(value) {
  const rawValues = Array.isArray(value) ? value : [value];
  const countryCodes = rawValues.flatMap(splitCountryCodeInput);

  return Array.from(
    new Set(countryCodes.filter((code) => COUNTRY_CODE_PATTERN.test(code))),
  ).sort();
}

export function parseProductCountryPolicyFormData(formData) {
  return {
    allowedCountries: parseCountryCodeSelection(formData.getAll("allowedCountries")),
    blockedCountries: parseCountryCodeSelection(formData.getAll("blockedCountries")),
    requiresWarningCountries: parseCountryCodeSelection(
      formData.getAll("requiresWarningCountries"),
    ),
  };
}

export function normalizeProductCountryPolicy(policy = {}) {
  return {
    allowedCountries: normalizeCountryList(policy?.allowedCountries),
    blockedCountries: normalizeCountryList(policy?.blockedCountries),
    requiresWarningCountries: normalizeCountryList(
      policy?.requiresWarningCountries,
    ),
  };
}

export function shouldPersistProductCountryPolicy(productEuStatus, policyInput = {}) {
  const normalized = normalizeProductCountryPolicy(policyInput);

  return (
    String(productEuStatus || "DISABLED").toUpperCase() !== "DISABLED" ||
    normalized.allowedCountries.length > 0 ||
    normalized.blockedCountries.length > 0 ||
    normalized.requiresWarningCountries.length > 0
  );
}

export function buildProductCountryPolicyData(productEuStatus, policyInput = {}) {
  const normalized = normalizeProductCountryPolicy(policyInput);

  return {
    euSaleStatus: String(productEuStatus || "DISABLED").toUpperCase(),
    allowedCountries: normalized.allowedCountries,
    blockedCountries: normalized.blockedCountries,
    requiresWarningCountries: normalized.requiresWarningCountries,
  };
}

export function formatCountryCodeSummary(countryCodes, { limit = 3 } = {}) {
  const countries = normalizeCountryList(countryCodes).map((code) => ({
    code,
    label: formatPublicCountryLabel(code) || code,
  }));

  if (countries.length === 0) {
    return "未設定";
  }

  const visibleLabels = countries.slice(0, limit).map((country) => country.label);
  const remainingCount = countries.length - visibleLabels.length;

  return remainingCount > 0
    ? `${visibleLabels.join("、")} ほか${remainingCount}件`
    : visibleLabels.join("、");
}

export function summarizeVendorDeliveryPolicy(product = {}) {
  const policy = normalizeProductCountryPolicy(product.countryPolicy);
  const productEuStatus = String(product.productEuStatus || "DISABLED").toUpperCase();

  if (policy.allowedCountries.length > 0) {
    return {
      label: "配送先限定",
      tone: "warning",
      detail: `配送できる国: ${formatCountryCodeSummary(policy.allowedCountries)}`,
    };
  }

  if (policy.blockedCountries.length > 0) {
    return {
      label: "販売不可あり",
      tone: "danger",
      detail: `購入できない国: ${formatCountryCodeSummary(policy.blockedCountries)}`,
    };
  }

  if (productEuStatus === "PENDING_REVIEW") {
    return {
      label: "EU審査中",
      tone: "warning",
      detail: "EU宛は管理者審査が完了するまで販売できません",
    };
  }

  if (productEuStatus === "APPROVED_LOW_RISK") {
    return {
      label: "EU販売可",
      tone: "success",
      detail: "EU宛は注意確認つきで販売できます",
    };
  }

  if (policy.requiresWarningCountries.length > 0) {
    return {
      label: "注意確認あり",
      tone: "warning",
      detail: `注意確認: ${formatCountryCodeSummary(policy.requiresWarningCountries)}`,
    };
  }

  return {
    label: "国別制限なし",
    tone: "neutral",
    detail: "配送先国の個別制限は設定されていません",
  };
}

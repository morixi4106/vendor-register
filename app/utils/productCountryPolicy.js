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

export const CATEGORY_DELIVERY_POLICY_TEMPLATES = [
  {
    key: "default-non-eu",
    label: "標準: EUなし / 個別制限なし",
    description: "まずは国別の配送制限を設定せず、EU向け販売は行わない標準テンプレートです。",
    productEuStatus: "DISABLED",
    allowedCountries: [],
    blockedCountries: [],
    requiresWarningCountries: [],
    keywords: [],
  },
  {
    key: "low-risk-eu",
    label: "低リスク一般商品: EU販売可",
    description: "アパレル、紙製品、雑貨、アートなど、低リスク商品向けです。EU向けは注意確認つきで販売します。",
    productEuStatus: "APPROVED_LOW_RISK",
    allowedCountries: [],
    blockedCountries: [],
    requiresWarningCountries: [],
    keywords: [
      "アパレル",
      "衣類",
      "服",
      "雑貨",
      "紙",
      "アート",
      "アクセサリー",
      "インテリア",
      "クラフト",
    ],
  },
  {
    key: "cosmetics-docs",
    label: "化粧品: EU追加資料待ち",
    description: "化粧品は EU Responsible Person / CPNP / CPSR 等の確認が終わるまでEU販売を止めます。",
    productEuStatus: "REQUIRES_ADDITIONAL_DOCS",
    allowedCountries: [],
    blockedCountries: [],
    requiresWarningCountries: [],
    keywords: ["化粧", "コスメ", "美容", "スキンケア", "ローション", "クリーム"],
  },
  {
    key: "cosmetics-eu-approved",
    label: "化粧品: EU書類確認済み",
    description: "EU向け化粧品の必要資料を管理者が確認済みの商品に使います。",
    productEuStatus: "APPROVED_LOW_RISK",
    allowedCountries: [],
    blockedCountries: [],
    requiresWarningCountries: [],
    keywords: [],
  },
  {
    key: "high-risk-eu-blocked",
    label: "高リスクカテゴリ: EU販売不可",
    description: "食品、サプリ、医療、玩具、電気/バッテリー等は初期設定ではEU販売不可にします。",
    productEuStatus: "REJECTED_HIGH_RISK",
    allowedCountries: [],
    blockedCountries: [],
    requiresWarningCountries: [],
    keywords: [
      "食品",
      "サプリ",
      "医薬",
      "医療",
      "健康",
      "子供",
      "玩具",
      "電子",
      "電気",
      "バッテリー",
      "PPE",
      "安全用品",
      "中古",
      "ブランド",
    ],
  },
  {
    key: "domestic-only",
    label: "日本国内のみ",
    description: "配送先を日本だけに限定します。",
    productEuStatus: "DISABLED",
    allowedCountries: ["JP"],
    blockedCountries: [],
    requiresWarningCountries: [],
    keywords: [],
  },
  {
    key: "major-non-eu",
    label: "主要な非EUのみ",
    description: "日本、米国、英国、豪州、韓国、シンガポールに限定します。",
    productEuStatus: "DISABLED",
    allowedCountries: ["JP", "US", "GB", "AU", "KR", "SG"],
    blockedCountries: [],
    requiresWarningCountries: [],
    keywords: [],
  },
];

export function getDeliveryPolicyTemplateByKey(templateKey) {
  return CATEGORY_DELIVERY_POLICY_TEMPLATES.find(
    (template) => template.key === templateKey,
  );
}

export function getRecommendedDeliveryPolicyTemplate(product = {}) {
  const searchText = [product?.category, product?.name]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const recommendationOrder = [
    "high-risk-eu-blocked",
    "cosmetics-docs",
    "low-risk-eu",
  ];

  const matchedTemplate = recommendationOrder
    .map(getDeliveryPolicyTemplateByKey)
    .find((template) =>
      template?.keywords.some((keyword) =>
        searchText.includes(String(keyword).toLowerCase()),
      ),
    );

  return matchedTemplate || getDeliveryPolicyTemplateByKey("default-non-eu");
}

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

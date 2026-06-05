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

function createDeliveryPolicyTemplate({
  key,
  name,
  description,
  productEuStatus,
  allowedCountries = [],
  blockedCountries = [],
  requiresWarningCountries = [],
  keywords = [],
}) {
  return {
    key,
    name,
    label: name,
    description,
    productEuStatus,
    allowedCountries,
    blockedCountries,
    requiresWarningCountries,
    keywords,
  };
}

function createLowRiskCategoryTemplate(key, name, keywords = [name]) {
  return createDeliveryPolicyTemplate({
    key,
    name,
    description:
      "低リスクカテゴリとして、管理者確認後にEUを含む配送先へ販売できます。EU向けは購入前の注意確認が入ります。",
    productEuStatus: "APPROVED_LOW_RISK",
    keywords,
  });
}

function createDomesticUntilApprovedTemplate({
  key,
  name,
  description,
  productEuStatus = "REQUIRES_ADDITIONAL_DOCS",
  keywords = [name],
}) {
  return createDeliveryPolicyTemplate({
    key,
    name,
    description:
      description ||
      "追加資料や販売先国の確認が必要なカテゴリです。初期テンプレートでは日本国内のみ配送可にします。",
    productEuStatus,
    allowedCountries: ["JP"],
    keywords,
  });
}

export const CATEGORY_DELIVERY_POLICY_TEMPLATES = [
  createDeliveryPolicyTemplate({
    key: "standard",
    name: "標準",
    description: "EU向け販売は行わず、国別の配送制限も設定しない標準テンプレートです。",
    productEuStatus: "DISABLED",
  }),
  createLowRiskCategoryTemplate("apparel", "アパレル", [
    "アパレル",
    "衣類",
    "服",
  ]),
  createLowRiskCategoryTemplate("art", "アート", ["アート", "絵", "版画"]),
  createLowRiskCategoryTemplate("paper-goods", "紙製品", [
    "紙製品",
    "紙",
    "ポスター",
    "カード",
  ]),
  createLowRiskCategoryTemplate("general-goods", "雑貨", ["雑貨"]),
  createLowRiskCategoryTemplate("accessories", "アクセサリー", [
    "アクセサリー",
    "ジュエリー",
  ]),
  createLowRiskCategoryTemplate("interior-small-goods", "インテリア小物", [
    "インテリア",
    "小物",
  ]),
  createLowRiskCategoryTemplate("craft-goods", "クラフト品", [
    "クラフト",
    "ハンドメイド",
  ]),
  createDomesticUntilApprovedTemplate({
    key: "cosmetics",
    name: "化粧品",
    description:
      "化粧品は販売先国ごとの追加確認が必要です。初期テンプレートでは日本国内のみ配送可にします。",
    keywords: ["化粧", "コスメ", "美容", "スキンケア", "ローション", "クリーム"],
  }),
  createDomesticUntilApprovedTemplate({
    key: "food",
    name: "食品",
    keywords: ["食品", "食べ物", "飲料"],
  }),
  createDomesticUntilApprovedTemplate({
    key: "supplements",
    name: "サプリ",
    keywords: ["サプリ", "健康食品"],
  }),
  createDomesticUntilApprovedTemplate({
    key: "children-goods",
    name: "子供用品",
    keywords: ["子供", "こども", "ベビー", "赤ちゃん"],
  }),
  createDomesticUntilApprovedTemplate({
    key: "toys",
    name: "玩具",
    keywords: ["玩具", "おもちゃ"],
  }),
  createDomesticUntilApprovedTemplate({
    key: "electronics",
    name: "電子機器",
    keywords: ["電子", "電気", "ガジェット"],
  }),
  createDomesticUntilApprovedTemplate({
    key: "battery-goods",
    name: "バッテリー入り商品",
    keywords: ["バッテリー", "電池", "リチウム"],
  }),
  createDomesticUntilApprovedTemplate({
    key: "used-goods",
    name: "中古品",
    keywords: ["中古", "古物"],
  }),
  createDomesticUntilApprovedTemplate({
    key: "brand-goods",
    name: "ブランド品",
    keywords: ["ブランド"],
  }),
  createDomesticUntilApprovedTemplate({
    key: "animal-plant-derived",
    name: "動植物由来商品",
    keywords: ["動植物", "植物", "動物", "革", "毛皮"],
  }),
  createDomesticUntilApprovedTemplate({
    key: "medicine",
    name: "医薬品",
    productEuStatus: "REJECTED_HIGH_RISK",
    keywords: ["医薬", "薬"],
  }),
  createDomesticUntilApprovedTemplate({
    key: "medical-goods",
    name: "医療系商品",
    productEuStatus: "REJECTED_HIGH_RISK",
    keywords: ["医療", "医療機器"],
  }),
  createDomesticUntilApprovedTemplate({
    key: "health-claims",
    name: "健康効果商品",
    productEuStatus: "REJECTED_HIGH_RISK",
    keywords: ["健康効果", "効能", "治療", "改善"],
  }),
  createDomesticUntilApprovedTemplate({
    key: "ppe-safety-goods",
    name: "PPE / 安全用品",
    productEuStatus: "REJECTED_HIGH_RISK",
    keywords: ["PPE", "安全用品", "保護具"],
  }),
  createDeliveryPolicyTemplate({
    key: "domestic-only",
    name: "日本国内のみ",
    description: "配送先を日本だけに限定します。",
    productEuStatus: "DISABLED",
    allowedCountries: ["JP"],
  }),
  createDeliveryPolicyTemplate({
    key: "major-non-eu",
    name: "主要な非EUのみ",
    description: "日本、米国、英国、豪州、韓国、シンガポールに限定します。",
    productEuStatus: "DISABLED",
    allowedCountries: ["JP", "US", "GB", "AU", "KR", "SG"],
  }),
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
    "medicine",
    "medical-goods",
    "health-claims",
    "ppe-safety-goods",
    "electronics",
    "battery-goods",
    "cosmetics",
    "food",
    "supplements",
    "children-goods",
    "toys",
    "used-goods",
    "brand-goods",
    "animal-plant-derived",
    "apparel",
    "art",
    "paper-goods",
    "general-goods",
    "accessories",
    "interior-small-goods",
    "craft-goods",
  ];

  const matchedTemplate = recommendationOrder
    .map(getDeliveryPolicyTemplateByKey)
    .find((template) =>
      template?.keywords.some((keyword) =>
        searchText.includes(String(keyword).toLowerCase()),
      ),
    );

  return matchedTemplate || getDeliveryPolicyTemplateByKey("standard");
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

import {
  EU_COUNTRY_CODES,
  PUBLIC_COUNTRY_LABELS_JA,
  formatPublicCountryLabel,
  normalizeCountryCode,
  normalizeCountryList,
} from "./deliveryEligibility.js";

const PRIORITY_COUNTRY_CODES = ["JP", "US", "GB", "AU", "KR", "SG"];
const EU_DELIVERY_COUNTRY_CODES = sortCountryOptions(Array.from(EU_COUNTRY_CODES)).map(
  (country) => country.code,
);
const STANDARD_DELIVERY_COUNTRY_CODES = [...PRIORITY_COUNTRY_CODES];
const LOW_RISK_DELIVERY_COUNTRY_CODES = [
  ...STANDARD_DELIVERY_COUNTRY_CODES,
  ...EU_DELIVERY_COUNTRY_CODES.filter(
    (code) => !STANDARD_DELIVERY_COUNTRY_CODES.includes(code),
  ),
];
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
    allowedCountries: LOW_RISK_DELIVERY_COUNTRY_CODES,
    requiresWarningCountries: EU_DELIVERY_COUNTRY_CODES,
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
    description: "EU向け販売は行わず、主要な非EU配送先だけに限定する標準テンプレートです。",
    productEuStatus: "DISABLED",
    allowedCountries: STANDARD_DELIVERY_COUNTRY_CODES,
  }),
  createDomesticUntilApprovedTemplate({
    key: "life",
    name: "生活",
    description:
      "生活カテゴリは商品範囲が広いため、初期テンプレートでは日本国内のみ配送可にします。管理者確認後に販売先国を追加してください。",
    keywords: ["生活"],
  }),
  createDomesticUntilApprovedTemplate({
    key: "beauty-health",
    name: "美容・健康",
    description:
      "美容・健康カテゴリは表示、成分、効能表現の確認が必要になりやすいため、初期テンプレートでは日本国内のみ配送可にします。",
    keywords: ["美容・健康", "美容", "健康"],
  }),
  createLowRiskCategoryTemplate("fashion", "ファッション", [
    "ファッション",
    "アパレル",
    "衣類",
    "服",
  ]),
  createDomesticUntilApprovedTemplate({
    key: "cosmetics-beauty",
    name: "コスメ・美容",
    description:
      "コスメ・美容カテゴリは販売先国ごとの成分・表示確認が必要になりやすいため、初期テンプレートでは日本国内のみ配送可にします。",
    keywords: ["コスメ・美容", "化粧", "コスメ", "スキンケア", "ローション", "クリーム"],
  }),
  createLowRiskCategoryTemplate("womens-clothing", "レディース服", [
    "レディース服",
    "婦人服",
  ]),
  createLowRiskCategoryTemplate("mens-clothing", "メンズ服", [
    "メンズ服",
    "紳士服",
  ]),
  createLowRiskCategoryTemplate("kimono-yukata", "着物・浴衣", [
    "着物・浴衣",
    "着物",
    "浴衣",
  ]),
  createLowRiskCategoryTemplate("shoes-bags", "靴・鞄", [
    "靴・鞄",
    "靴",
    "鞄",
    "バッグ",
  ]),
  createLowRiskCategoryTemplate("goods-small-items", "雑貨・小物", [
    "雑貨・小物",
    "雑貨",
    "小物",
  ]),
  createLowRiskCategoryTemplate("accessories", "アクセサリー", [
    "アクセサリー",
    "ジュエリー",
  ]),
  createLowRiskCategoryTemplate("handmade", "ハンドメイド", [
    "ハンドメイド",
    "クラフト",
  ]),
  createLowRiskCategoryTemplate(
    "subculture",
    "サブカルチャー(アニメ・マンガ・コスプレ類)",
    ["サブカルチャー", "アニメ", "マンガ", "漫画", "コスプレ"],
  ),
  createDomesticUntilApprovedTemplate({
    key: "food-drinks",
    name: "食料品・飲料品",
    description:
      "食料品・飲料品は販売先国ごとの輸入・表示確認が必要になりやすいため、初期テンプレートでは日本国内のみ配送可にします。",
    keywords: ["食料品・飲料品", "食品", "食べ物", "飲料"],
  }),
  createDomesticUntilApprovedTemplate({
    key: "electronics-office",
    name: "電子機器・オフィス用品",
    description:
      "電子機器・オフィス用品は安全規格、電池、通信機器等の確認が必要になりやすいため、初期テンプレートでは日本国内のみ配送可にします。",
    keywords: ["電子機器・オフィス用品", "電子", "電気", "ガジェット", "オフィス用品"],
  }),
  createDomesticUntilApprovedTemplate({
    key: "home-diy",
    name: "住まい・DIY",
    description:
      "住まい・DIYカテゴリは工具、化学品、電気用品等を含む可能性があるため、初期テンプレートでは日本国内のみ配送可にします。",
    keywords: ["住まい・DIY", "住まい", "DIY", "インテリア"],
  }),
  createDomesticUntilApprovedTemplate({
    key: "sports-travel-outdoor",
    name: "スポーツ・旅行・アウトドア",
    description:
      "スポーツ・旅行・アウトドアカテゴリは安全用品や規制対象品を含む可能性があるため、初期テンプレートでは日本国内のみ配送可にします。",
    keywords: ["スポーツ・旅行・アウトドア", "スポーツ", "旅行", "アウトドア"],
  }),
  createDomesticUntilApprovedTemplate({
    key: "diet-supplements",
    name: "ダイエット・サプリ",
    description:
      "ダイエット・サプリカテゴリは健康食品、成分、効能表現の確認が必要になりやすいため、初期テンプレートでは日本国内のみ配送可にします。",
    keywords: ["ダイエット・サプリ", "ダイエット", "サプリ", "健康食品"],
  }),
  createDomesticUntilApprovedTemplate({
    key: "toys-kids-baby",
    name: "玩具・キッズ・ベビー",
    description:
      "玩具・キッズ・ベビーカテゴリは年齢表示、安全規格、素材確認が必要になりやすいため、初期テンプレートでは日本国内のみ配送可にします。",
    keywords: ["玩具・キッズ・ベビー", "玩具", "おもちゃ", "キッズ", "ベビー", "子供"],
  }),
  createDomesticUntilApprovedTemplate({
    key: "car-bike",
    name: "車・バイク用品",
    description:
      "車・バイク用品は安全性や国別規格の確認が必要になりやすいため、初期テンプレートでは日本国内のみ配送可にします。",
    keywords: ["車・バイク用品", "車", "バイク", "自動車"],
  }),
  createLowRiskCategoryTemplate("cards-figures", "カード・フィギュア", [
    "カード・フィギュア",
    "カード",
    "フィギュア",
  ]),
  createDomesticUntilApprovedTemplate({
    key: "daily-goods",
    name: "日用品",
    description:
      "日用品カテゴリは衛生用品、化学品、肌に触れる商品を含む可能性があるため、初期テンプレートでは日本国内のみ配送可にします。",
    keywords: ["日用品"],
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
    allowedCountries: STANDARD_DELIVERY_COUNTRY_CODES,
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
    "cosmetics-beauty",
    "beauty-health",
    "food-drinks",
    "diet-supplements",
    "electronics-office",
    "home-diy",
    "sports-travel-outdoor",
    "toys-kids-baby",
    "car-bike",
    "life",
    "daily-goods",
    "womens-clothing",
    "mens-clothing",
    "kimono-yukata",
    "shoes-bags",
    "fashion",
    "goods-small-items",
    "accessories",
    "handmade",
    "subculture",
    "cards-figures",
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

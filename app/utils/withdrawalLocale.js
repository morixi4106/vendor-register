import { withdrawalEnGb } from "../locales/withdrawal/en-GB.js";
import { withdrawalJaJp } from "../locales/withdrawal/ja-JP.js";

export const WITHDRAWAL_LOCALES = ["ja-JP", "en-GB"];
export const DEFAULT_WITHDRAWAL_LOCALE = "en-GB";

const dictionaries = {
  "ja-JP": withdrawalJaJp,
  "en-GB": withdrawalEnGb,
};

export function normalizeWithdrawalLocale(value) {
  const normalized = String(value || "").trim().replace("_", "-").toLowerCase();
  if (!normalized) return null;
  if (normalized === "ja" || normalized === "ja-jp") return "ja-JP";
  if (normalized === "en" || normalized === "en-gb" || normalized === "en-us") {
    return "en-GB";
  }
  return null;
}

export function parseWithdrawalAcceptLanguage(value) {
  return String(value || "")
    .split(",")
    .map((entry, index) => {
      const [tag, ...parameters] = entry.trim().split(";");
      const qualityParameter = parameters.find((parameter) => parameter.trim().startsWith("q="));
      const quality = qualityParameter ? Number(qualityParameter.trim().slice(2)) : 1;
      return {
        locale: normalizeWithdrawalLocale(tag),
        quality: Number.isFinite(quality) ? quality : 0,
        index,
      };
    })
    .filter((entry) => entry.locale && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index)[0]?.locale || null;
}

export function resolveWithdrawalLocale({
  urlLocale,
  shopifyLocale,
  acceptLanguage,
  savedLocale,
  userSelected = false,
} = {}) {
  const fromUrl = normalizeWithdrawalLocale(urlLocale);
  if (fromUrl) {
    return { locale: fromUrl, source: userSelected ? "USER_SELECTED" : "URL_LANG" };
  }
  const fromSaved = normalizeWithdrawalLocale(savedLocale);
  if (fromSaved) return { locale: fromSaved, source: "SAVED_CORRESPONDENCE" };
  const fromShopify = normalizeWithdrawalLocale(shopifyLocale);
  if (fromShopify) return { locale: fromShopify, source: "SHOPIFY_LOCALE" };
  const fromHeader = parseWithdrawalAcceptLanguage(acceptLanguage);
  if (fromHeader) return { locale: fromHeader, source: "ACCEPT_LANGUAGE" };
  return { locale: DEFAULT_WITHDRAWAL_LOCALE, source: "DEFAULT" };
}

export function getWithdrawalDictionary(locale) {
  return dictionaries[normalizeWithdrawalLocale(locale) || DEFAULT_WITHDRAWAL_LOCALE];
}

export function appendWithdrawalLocale(urlValue, locale) {
  const url = new URL(urlValue, "https://withdrawal.invalid");
  url.searchParams.set("lang", normalizeWithdrawalLocale(locale) || DEFAULT_WITHDRAWAL_LOCALE);
  return url.origin === "https://withdrawal.invalid" ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}

export function formatWithdrawalDateTime(value, locale, timeZone = "UTC") {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(normalizeWithdrawalLocale(locale) || DEFAULT_WITHDRAWAL_LOCALE, {
    dateStyle: "medium",
    timeStyle: "long",
    timeZone,
  }).format(date);
}

export function formatWithdrawalCountry(code, locale) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return "-";
  try {
    return new Intl.DisplayNames([normalizeWithdrawalLocale(locale) || DEFAULT_WITHDRAWAL_LOCALE], {
      type: "region",
    }).of(normalized) || normalized;
  } catch {
    return normalized;
  }
}

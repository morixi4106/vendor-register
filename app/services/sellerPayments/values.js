import { DEFAULT_ORDER_CURRENCY } from "./constants.js";
const ZERO_DECIMAL_CURRENCIES = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
export function normalizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}
export function normalizeLowercase(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toLowerCase() : null;
}
export function normalizeUppercase(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toUpperCase() : null;
}
export function normalizeBooleanInput(value) {
  if (typeof value === "boolean") return value;
  if (value == null) return false;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}
export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function toPositiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  return numeric;
}
export function clampInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.round(numeric));
}
export function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}
export function subtractDays(date, days) {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}
export function clampBasisPoints(value, fallback = 0) {
  const numeric = clampInteger(value, fallback);
  return Math.min(10000, Math.max(0, numeric));
}
export function moneyAmountToMinorUnits(value, currencyCode = DEFAULT_ORDER_CURRENCY) {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) return 0;
  const numeric = Number(normalizedValue.replace(/,/g, ""));
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  const normalizedCurrency = normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;
  return ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency) ? Math.round(numeric) : Math.round(numeric * 100);
}
export function decimalAmountFromMinorUnits(amount, currencyCode = DEFAULT_ORDER_CURRENCY) {
  const normalizedAmount = clampInteger(amount, 0);
  const normalizedCurrency = normalizeLowercase(currencyCode) || DEFAULT_ORDER_CURRENCY;
  return ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency) ? normalizedAmount : Math.round(normalizedAmount) / 100;
}

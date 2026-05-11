export function normalizeCurrencyCode(currencyCode, fallback = "JPY") {
  const normalized = String(currencyCode || fallback).trim().toUpperCase();
  return normalized || fallback;
}

export function formatMoney(amount, currencyCode = "JPY") {
  const numericAmount = Number(amount || 0);
  const normalizedCurrency = normalizeCurrencyCode(currencyCode);

  try {
    return new Intl.NumberFormat("ja-JP", {
      style: "currency",
      currency: normalizedCurrency,
      maximumFractionDigits: 0,
    }).format(numericAmount);
  } catch {
    return `${Math.round(numericAmount).toLocaleString("ja-JP")} ${normalizedCurrency}`;
  }
}

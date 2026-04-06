export const DEFAULT_FX_RATES = {
  JPY: 1,
  USD: 150,
};

export function getFxRateToJpy(currency) {
  if (!currency) {
    throw new Error("currency is required");
  }

  const normalized = String(currency).trim().toUpperCase();
  const rate = DEFAULT_FX_RATES[normalized];

  if (!rate) {
    throw new Error(`Unsupported currency: ${normalized}`);
  }

  return rate;
}
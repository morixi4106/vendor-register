import prisma from "../db.server";

export const FALLBACK_FX_RATES = {
  JPY: 1,
  USD: 150,
};

export async function getFxRateToJpy(currency) {
  if (!currency) {
    throw new Error("currency is required");
  }

  const normalized = String(currency).trim().toUpperCase();

  if (normalized === "JPY") {
    return 1;
  }

  const fxRate = await prisma.fxRate.findUnique({
    where: {
      base_quote: {
        base: normalized,
        quote: "JPY",
      },
    },
  });

  if (fxRate?.rate && Number.isFinite(fxRate.rate) && fxRate.rate > 0) {
    return fxRate.rate;
  }

  const fallback = FALLBACK_FX_RATES[normalized];

  if (!fallback) {
    throw new Error(`Unsupported currency: ${normalized}`);
  }

  return fallback;
}

export async function upsertFxRate({ base, quote, rate }) {
  const normalizedBase = String(base || "").trim().toUpperCase();
  const normalizedQuote = String(quote || "").trim().toUpperCase();
  const normalizedRate = Number(rate);

  if (!normalizedBase || !normalizedQuote) {
    throw new Error("base and quote are required");
  }

  if (!Number.isFinite(normalizedRate) || normalizedRate <= 0) {
    throw new Error("rate must be a positive number");
  }

  return prisma.fxRate.upsert({
    where: {
      base_quote: {
        base: normalizedBase,
        quote: normalizedQuote,
      },
    },
    update: {
      rate: normalizedRate,
      fetchedAt: new Date(),
    },
    create: {
      base: normalizedBase,
      quote: normalizedQuote,
      rate: normalizedRate,
      fetchedAt: new Date(),
    },
  });
}
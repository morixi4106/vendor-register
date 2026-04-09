import prisma from "../db.server";

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

  if (!fxRate) {
    throw new Error(`FX rate not found: ${normalized}/JPY`);
  }

  const rate = Number(fxRate.rate);

  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Invalid FX rate: ${normalized}/JPY`);
  }

  return rate;
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
import { calculatePrice, calculatePriceBreakdown } from './priceCalculator.js';
import { getShopPricingSettings } from './shopPricingSettings.js';
import { getFxRateToJpy } from './fxRates.server.js';

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function getMetafieldValue(product, namespace, key) {
  if (!product?.metafields || !Array.isArray(product.metafields)) {
    return undefined;
  }

  const found = product.metafields.find(
    (item) => item.namespace === namespace && item.key === key
  );

  return found?.value;
}

export async function buildCalculatedPrice(product, options = {}) {
  const settings = options.settings || await getShopPricingSettings();

  const costAmount = toNumber(
    getMetafieldValue(product, 'pricing', 'cost_amount'),
    0
  );

  const costCurrency = String(
    getMetafieldValue(product, 'pricing', 'cost_currency') || 'JPY'
  )
    .trim()
    .toUpperCase();

  const dutyRate = toNumber(options.dutyRate, 0);

  const fxRate =
    options.fxRate != null
      ? Number(options.fxRate)
      : await getFxRateToJpy(costCurrency);

  if (!Number.isFinite(fxRate) || fxRate <= 0) {
    throw new Error(`Invalid fxRate for ${costCurrency}/JPY`);
  }

  const marginRate = toNumber(settings.defaultMarginRate, 0.1);
  const paymentFeeRate = toNumber(settings.paymentFeeRate, 0.04);
  const paymentFeeFixed = toNumber(settings.paymentFeeFixed, 50);
  const bufferRate = toNumber(settings.bufferRate, 0.1);

  const input = {
    costAmount,
    fxRate,
    dutyRate,
    marginRate,
    paymentFeeRate,
    paymentFeeFixed,
    bufferRate,
  };

  return {
    input: {
      ...input,
      costCurrency,
    },
    finalPrice: calculatePrice(input),
    breakdown: calculatePriceBreakdown(input),
  };
}
import { calculatePrice, calculatePriceBreakdown } from './priceCalculator.js';
import { getShopPricingSettings } from './shopPricingSettings.js';

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

  const dutyRate = toNumber(options.dutyRate, 0);
  const fxRate = toNumber(options.fxRate, 1);

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
    input,
    finalPrice: calculatePrice(input),
    breakdown: calculatePriceBreakdown(input),
  };
}
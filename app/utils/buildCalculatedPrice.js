import { calculatePrice, calculatePriceBreakdown } from './priceCalculator.js';
import { getShopPricingSettings } from './shopPricingSettings.js';
import { getFxRateToJpy } from './fxRates.server.js';
import {
  createPriceCalculationError,
  normalizePriceSyncFailure,
} from './priceSyncStatus.js';

const DEFAULT_PRICING_SETTINGS = {
  defaultMarginRate: 0.1,
  paymentFeeRate: 0.04,
  paymentFeeFixed: 50,
  bufferRate: 0.1,
};

const DUTY_RATE_MAP = {
  cosmetics: 0.2,
};

function toNumber(value, fallback = Number.NaN) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeCostCurrency(value) {
  const normalized = String(value || 'JPY').trim().toUpperCase();
  return normalized || 'JPY';
}

function normalizeDutyCategory(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizePricingSettings(settings = {}) {
  return {
    shopDomain: settings.shopDomain || null,
    defaultMarginRate: toNumber(
      settings.defaultMarginRate,
      DEFAULT_PRICING_SETTINGS.defaultMarginRate,
    ),
    paymentFeeRate: toNumber(
      settings.paymentFeeRate,
      DEFAULT_PRICING_SETTINGS.paymentFeeRate,
    ),
    paymentFeeFixed: toNumber(
      settings.paymentFeeFixed,
      DEFAULT_PRICING_SETTINGS.paymentFeeFixed,
    ),
    bufferRate: toNumber(settings.bufferRate, DEFAULT_PRICING_SETTINGS.bufferRate),
  };
}

function getMetafieldValue(product, namespace, key) {
  if (!product?.metafields || !Array.isArray(product.metafields)) {
    return undefined;
  }

  const found = product.metafields.find(
    (item) => item.namespace === namespace && item.key === key,
  );

  return found?.value;
}

export function resolveDutyRate(dutyCategory, overrideDutyRate) {
  if (overrideDutyRate != null) {
    const dutyRate = Number(overrideDutyRate);

    if (!Number.isFinite(dutyRate) || dutyRate < 0) {
      throw createPriceCalculationError('invalid_duty_rate', 'dutyRate must be 0 or greater');
    }

    return dutyRate;
  }

  return toNumber(DUTY_RATE_MAP[normalizeDutyCategory(dutyCategory)], 0);
}

export function validatePriceInputs(rawInput, options = {}) {
  const costAmount = Number(rawInput?.costAmount ?? 0);

  if (!Number.isFinite(costAmount)) {
    throw createPriceCalculationError(
      'invalid_cost_amount',
      'costAmount must be a valid number',
    );
  }

  if (options.requirePositiveCostAmount ? costAmount <= 0 : costAmount < 0) {
    throw createPriceCalculationError(
      options.requirePositiveCostAmount ? 'missing_cost_amount' : 'negative_cost_amount',
      options.requirePositiveCostAmount
        ? 'pricing.cost_amount is empty'
        : 'costAmount must be 0 or greater',
    );
  }

  return {
    costAmount,
    costCurrency: normalizeCostCurrency(rawInput?.costCurrency),
    dutyCategory: normalizeDutyCategory(rawInput?.dutyCategory),
    shopDomain: rawInput?.shopDomain || null,
  };
}

export async function calculateProductPrice(rawInput, options = {}) {
  const normalizedInput = validatePriceInputs(rawInput, {
    requirePositiveCostAmount: options.requirePositiveCostAmount,
  });

  const settings = normalizePricingSettings(
    options.settings ||
      (await getShopPricingSettings({
        shopDomain: options.shopDomain || normalizedInput.shopDomain,
        apiVersion: options.apiVersion,
      })),
  );

  const fxRate =
    options.fxRate != null
      ? Number(options.fxRate)
      : await getFxRateToJpy(normalizedInput.costCurrency);

  if (!Number.isFinite(fxRate) || fxRate <= 0) {
    throw createPriceCalculationError(
      'invalid_fx_rate',
      `Invalid fxRate for ${normalizedInput.costCurrency}/JPY`,
    );
  }

  const calculationInput = {
    costAmount: normalizedInput.costAmount,
    fxRate,
    dutyRate: resolveDutyRate(normalizedInput.dutyCategory, options.dutyRate),
    marginRate: settings.defaultMarginRate,
    paymentFeeRate: settings.paymentFeeRate,
    paymentFeeFixed: settings.paymentFeeFixed,
    bufferRate: settings.bufferRate,
  };

  return {
    shopDomain: settings.shopDomain || options.shopDomain || normalizedInput.shopDomain,
    settings,
    input: {
      ...calculationInput,
      costCurrency: normalizedInput.costCurrency,
      dutyCategory: normalizedInput.dutyCategory,
    },
    finalPrice: calculatePrice(calculationInput),
    breakdown: calculatePriceBreakdown(calculationInput),
  };
}

export async function buildCalculatedPrice(product, options = {}) {
  return calculateProductPrice(
    {
      costAmount: getMetafieldValue(product, 'pricing', 'cost_amount'),
      costCurrency: getMetafieldValue(product, 'pricing', 'cost_currency') || 'JPY',
      dutyCategory: getMetafieldValue(product, 'pricing', 'duty_category'),
      shopDomain: options.shopDomain || product?.shopDomain,
    },
    options,
  );
}

export async function calculateProductPriceResult(rawInput, options = {}) {
  try {
    return {
      ok: true,
      value: await calculateProductPrice(rawInput, options),
    };
  } catch (error) {
    return {
      ok: false,
      error: normalizePriceSyncFailure(error),
    };
  }
}

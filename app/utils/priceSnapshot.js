export const PRICE_FORMULA_VERSION = 'pricing-spec-v1';

function toIsoString(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const date = new Date(value || Date.now());

  if (Number.isNaN(date.getTime())) {
    throw new Error('calculatedAt must be a valid date');
  }

  return date.toISOString();
}

export function buildPriceSnapshot(priceResult, options = {}) {
  if (!priceResult?.input || !priceResult?.breakdown) {
    throw new Error('priceResult is required to build a price snapshot');
  }

  const calculatedAt = toIsoString(options.calculatedAt);

  return {
    snapshotType: options.snapshotType || 'applied',
    priceFormulaVersion: options.priceFormulaVersion || PRICE_FORMULA_VERSION,
    calculatedAt,
    shopDomain: options.shopDomain || priceResult.shopDomain || null,
    localProductId: options.localProductId || null,
    shopifyProductId: options.shopifyProductId || null,
    calculatedPrice: priceResult.finalPrice,
    usedFxRate: priceResult.input.fxRate,
    usedMargin: priceResult.input.marginRate,
    usedDutyRate: priceResult.input.dutyRate,
    usedFee: {
      paymentFeeRate: priceResult.input.paymentFeeRate,
      paymentFeeFixed: priceResult.input.paymentFeeFixed,
    },
    roundingResult: {
      method: 'Math.ceil',
      rawPrice: priceResult.breakdown.rawPrice,
      finalPrice: priceResult.breakdown.finalPrice,
    },
    source: {
      pricingInput: options.source?.pricingInput || null,
      shopSettings: options.source?.shopSettings || null,
      fxRate: options.source?.fxRate || null,
    },
    input: {
      costAmount: priceResult.input.costAmount,
      costCurrency: priceResult.input.costCurrency,
      dutyCategory: priceResult.input.dutyCategory,
      shopDomain: options.shopDomain || priceResult.shopDomain || null,
    },
    settings: {
      defaultMarginRate: priceResult.settings?.defaultMarginRate,
      paymentFeeRate: priceResult.settings?.paymentFeeRate,
      paymentFeeFixed: priceResult.settings?.paymentFeeFixed,
      bufferRate: priceResult.settings?.bufferRate,
    },
    breakdown: priceResult.breakdown,
  };
}

export function buildPriceSnapshotUpdate(snapshot) {
  return {
    calculatedPrice: snapshot.calculatedPrice,
    usedFxRate: snapshot.usedFxRate,
    usedMargin: snapshot.usedMargin,
    usedDutyRate: snapshot.usedDutyRate,
    usedFee: snapshot.usedFee,
    roundingResult: snapshot.roundingResult,
    calculatedAt: new Date(snapshot.calculatedAt),
    priceFormulaVersion: snapshot.priceFormulaVersion,
    priceSnapshotJson: snapshot,
  };
}

export function calculatePrice({
  costAmount,
  fxRate,
  dutyRate,
  marginRate,
  paymentFeeRate,
  paymentFeeFixed,
  bufferRate,
}) {
  const values = {
    costAmount,
    fxRate,
    dutyRate,
    marginRate,
    paymentFeeRate,
    paymentFeeFixed,
    bufferRate,
  };

  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      throw new Error(`${key} must be a valid number`);
    }
  }

  if (costAmount < 0) throw new Error("costAmount must be 0 or greater");
  if (fxRate <= 0) throw new Error("fxRate must be greater than 0");
  if (dutyRate < 0) throw new Error("dutyRate must be 0 or greater");
  if (marginRate < 0) throw new Error("marginRate must be 0 or greater");
  if (paymentFeeRate < 0 || paymentFeeRate >= 1) {
    throw new Error("paymentFeeRate must be between 0 and 1");
  }
  if (paymentFeeFixed < 0) throw new Error("paymentFeeFixed must be 0 or greater");
  if (bufferRate < 0) throw new Error("bufferRate must be 0 or greater");

  const costFx = costAmount * fxRate;
  const duty = costFx * dutyRate;
  const landed = costFx + duty;
  const safeCost = landed * (1 + bufferRate);
  const target = safeCost * (1 + marginRate);
  const rawPrice = (target + paymentFeeFixed) / (1 - paymentFeeRate);

  return Math.ceil(rawPrice);
}

export function calculatePriceBreakdown(input) {
  const {
    costAmount,
    fxRate,
    dutyRate,
    marginRate,
    paymentFeeRate,
    paymentFeeFixed,
    bufferRate,
  } = input;

  const costFx = costAmount * fxRate;
  const duty = costFx * dutyRate;
  const landed = costFx + duty;
  const safeCost = landed * (1 + bufferRate);
  const target = safeCost * (1 + marginRate);
  const rawPrice = (target + paymentFeeFixed) / (1 - paymentFeeRate);

  return {
    costFx,
    duty,
    landed,
    safeCost,
    target,
    rawPrice,
    finalPrice: Math.ceil(rawPrice),
  };
}
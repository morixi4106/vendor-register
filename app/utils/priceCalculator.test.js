import { calculatePrice, calculatePriceBreakdown } from './priceCalculator.js';

const sampleInput = {
  costAmount: 1000,
  fxRate: 1,
  dutyRate: 0.2,
  packagingFee: 100,
  marginRate: 0.1,
  paymentFeeRate: 0.04,
  paymentFeeFixed: 50,
  bufferRate: 0.1,
};

const finalPrice = calculatePrice(sampleInput);
const breakdown = calculatePriceBreakdown(sampleInput);

console.log('finalPrice =', finalPrice);
console.log('breakdown =', breakdown);

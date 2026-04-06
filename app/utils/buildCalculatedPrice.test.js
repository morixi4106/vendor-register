import { buildCalculatedPrice } from './buildCalculatedPrice.js';

const mockProduct = {
  metafields: [
    {
      namespace: 'pricing',
      key: 'cost_amount',
      value: '1000',
    },
    {
      namespace: 'pricing',
      key: 'packaging_fee',
      value: '100',
    },
  ],
};

const mockSettings = {
  defaultMarginRate: 0.1,
  paymentFeeRate: 0.04,
  paymentFeeFixed: 50,
  bufferRate: 0.1,
};

const result = await buildCalculatedPrice(mockProduct, {
  fxRate: 1,
  dutyRate: 0.2,
  settings: mockSettings,
});

console.log(JSON.stringify(result, null, 2));

import {
  createCarrierShippingRatesAction,
  createCarrierShippingRatesLoader,
} from '../services/carrierShippingRates.server.js';

export const action = createCarrierShippingRatesAction();

export const loader = createCarrierShippingRatesLoader();

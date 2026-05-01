import {
  createShippingQuoteAction,
  createShippingQuoteLoader,
} from '../services/shippingQuote.server.js';

export const loader = createShippingQuoteLoader();

export const action = createShippingQuoteAction();

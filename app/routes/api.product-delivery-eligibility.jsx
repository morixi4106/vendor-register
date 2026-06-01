import { createProductDeliveryEligibilityLoader } from '../services/productDeliveryEligibility.server.js';

export const loader = createProductDeliveryEligibilityLoader();
export const action = loader;

import { createApplyPriceAction } from '../services/api.apply-price.server.js';
import { requireShopifyAdmin } from '../utils/routeSecurity.server.js';

const applyPriceAction = createApplyPriceAction();

export const action = async (args) => {
  await requireShopifyAdmin(args.request);
  return applyPriceAction(args);
};

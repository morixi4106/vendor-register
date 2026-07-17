import { createRefreshFxAction } from '../services/api.refresh-fx.server.js';
import { requireShopifyAdmin } from '../utils/routeSecurity.server.js';

const refreshFxAction = createRefreshFxAction();

export const action = async (args) => {
  await requireShopifyAdmin(args.request);
  return refreshFxAction(args);
};

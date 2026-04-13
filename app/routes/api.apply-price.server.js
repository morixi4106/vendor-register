import { json } from '@remix-run/node';
import { applyProductPrice } from '../utils/applyProductPrice.server.js';

export function createApplyPriceAction({ applyProductPriceImpl = applyProductPrice } = {}) {
  return async function action({ request }) {
    try {
      const body = await request.json();
      const productId = body?.productId;
      const shopDomain = body?.shopDomain;

      if (!productId) {
        return json({ ok: false, error: 'productId is required' }, { status: 400 });
      }

      const result = await applyProductPriceImpl(productId, { shopDomain });
      return json(result);
    } catch (error) {
      const failure = error?.priceSyncFailure || null;

      return json(
        {
          ok: false,
          error: failure?.message || (error instanceof Error ? error.message : 'Unknown error'),
          priceSyncStatus: failure?.status || null,
          needsReconnect: Boolean(failure?.needsReconnect),
        },
        { status: 500 },
      );
    }
  };
}

import { json } from '@remix-run/node';
import { applyProductPrice } from '../utils/applyProductPrice.server';

export const action = async ({ request }) => {
  try {
    const body = await request.json();
    const productId = body?.productId;

    if (!productId) {
      return json({ ok: false, error: 'productId is required' }, { status: 400 });
    }

    const result = await applyProductPrice(productId);
    return json(result);
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
};

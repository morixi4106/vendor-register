import { json } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { backfillSellerOrderShadowChecks } from "../services/sellerPayments.server.js";

export const loader = async () => {
  return json(
    { ok: false, message: "Method not allowed." },
    { status: 405, headers: { Allow: "POST" } },
  );
};

export const action = async ({ request }) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const result = await backfillSellerOrderShadowChecks({
    days: formData.get("days") || 30,
    limit: formData.get("limit") || 100,
  });

  return json(result, { status: result.ok ? 200 : 400 });
};

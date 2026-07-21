import { json } from "@remix-run/node";

import { requireShopifyAdmin } from "../utils/routeSecurity.server.js";

const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store",
};

export const loader = async () =>
  json(
    {
      ok: false,
      reason: "method_not_allowed",
    },
    {
      status: 405,
      headers: {
        ...RESPONSE_HEADERS,
        Allow: "POST",
      },
    },
  );

export const action = async ({ request }) => {
  await requireShopifyAdmin(request);

  return json(
    {
      ok: false,
      reason: "legacy_product_create_retired",
      message:
        "商品登録画面から、梱包後重量と配送方法を含む配送プロフィールを登録してください。",
    },
    {
      status: 410,
      headers: RESPONSE_HEADERS,
    },
  );
};

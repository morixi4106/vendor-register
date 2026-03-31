import { json } from "@remix-run/node";

export const loader = async () => {
  const shop = process.env.SHOPIFY_SHOP;
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  const res = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({
      query: `
        query {
          shop {
            name
            myshopifyDomain
          }
        }
      `,
    }),
  });

  const text = await res.text();

  return json({
    status: res.status,
    ok: res.ok,
    shop,
    tokenExists: Boolean(token),
    body: text,
  });
};
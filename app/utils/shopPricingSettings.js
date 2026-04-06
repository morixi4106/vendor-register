import prisma from '../db.server.js';

const SHOPIFY_SHOP_DOMAIN = 'b30ize-1a.myshopify.com';
const SHOPIFY_API_VERSION = '2026-01';

async function getOfflineAccessToken() {
  const offlineSessionId = `offline_${SHOPIFY_SHOP_DOMAIN}`;

  const session = await prisma.session.findUnique({
    where: { id: offlineSessionId },
  });

  if (!session?.accessToken) {
    throw new Error(`Offline session not found for session id: ${offlineSessionId}`);
  }

  return session.accessToken;
}

async function shopifyGraphQL(query, variables = {}) {
  const accessToken = await getOfflineAccessToken();

  const res = await fetch(
    `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Shopify GraphQL request failed: ${res.status} ${JSON.stringify(data)}`);
  }

  if (data.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  return data.data;
}

function toNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export async function getShopPricingSettings() {
  const query = `
    query GetShopPricingSettings {
      shop {
        defaultMarginRate: metafield(namespace: \"global_pricing\", key: \"default_margin_rate\") {
          value
        }
        paymentFeeRate: metafield(namespace: \"global_pricing\", key: \"payment_fee_rate\") {
          value
        }
        paymentFeeFixed: metafield(namespace: \"global_pricing\", key: \"payment_fee_fixed\") {
          value
        }
        bufferRate: metafield(namespace: \"global_pricing\", key: \"buffer_rate\") {
          value
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query);
  const shop = data.shop;

  return {
    defaultMarginRate: toNumber(shop.defaultMarginRate?.value, 0.1),
    paymentFeeRate: toNumber(shop.paymentFeeRate?.value, 0.04),
    paymentFeeFixed: toNumber(shop.paymentFeeFixed?.value, 50),
    bufferRate: toNumber(shop.bufferRate?.value, 0.1),
  };
}

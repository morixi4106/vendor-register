import { shopifyGraphQLWithOfflineSession } from './shopifyAdmin.server.js';

const SHOPIFY_API_VERSION = '2026-01';

function toNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export async function getShopPricingSettings(options = {}) {
  const query = `
    query GetShopPricingSettings {
      shop {
        defaultMarginRate: metafield(namespace: "global_pricing", key: "default_margin_rate") {
          value
        }
        paymentFeeRate: metafield(namespace: "global_pricing", key: "payment_fee_rate") {
          value
        }
        paymentFeeFixed: metafield(namespace: "global_pricing", key: "payment_fee_fixed") {
          value
        }
        bufferRate: metafield(namespace: "global_pricing", key: "buffer_rate") {
          value
        }
      }
    }
  `;

  const { data, shopDomain } = await shopifyGraphQLWithOfflineSession({
    shopDomain: options.shopDomain,
    apiVersion: options.apiVersion || SHOPIFY_API_VERSION,
    query,
  });
  const shop = data.shop;

  return {
    shopDomain,
    defaultMarginRate: toNumber(shop.defaultMarginRate?.value, 0.1),
    paymentFeeRate: toNumber(shop.paymentFeeRate?.value, 0.04),
    paymentFeeFixed: toNumber(shop.paymentFeeFixed?.value, 50),
    bufferRate: toNumber(shop.bufferRate?.value, 0.1),
  };
}

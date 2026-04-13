const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

function loadEnvFile() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile();

const prisma = new PrismaClient();
const SHOP = String(process.env.SHOPIFY_SHOP_DOMAIN || '').trim();
const API_VERSION = '2026-01';

if (!SHOP) {
  throw new Error('SHOPIFY_SHOP_DOMAIN is required');
}

function calculatePrice({
  costAmount,
  fxRate,
  dutyRate,
  packagingFee,
  marginRate,
  paymentFeeRate,
  paymentFeeFixed,
  bufferRate,
}) {
  const costFx = costAmount * fxRate;
  const duty = costFx * dutyRate;
  const landed = costFx + duty + packagingFee;
  const safeCost = landed * (1 + bufferRate);
  const target = safeCost * (1 + marginRate);
  const rawPrice = (target + paymentFeeFixed) / (1 - paymentFeeRate);
  return Math.ceil(rawPrice);
}

function calculatePriceBreakdown({
  costAmount,
  fxRate,
  dutyRate,
  packagingFee,
  marginRate,
  paymentFeeRate,
  paymentFeeFixed,
  bufferRate,
}) {
  const costFx = costAmount * fxRate;
  const duty = costFx * dutyRate;
  const landed = costFx + duty + packagingFee;
  const safeCost = landed * (1 + bufferRate);
  const target = safeCost * (1 + marginRate);
  const rawPrice = (target + paymentFeeFixed) / (1 - paymentFeeRate);

  return {
    costFx,
    duty,
    landed,
    safeCost,
    target,
    rawPrice,
    finalPrice: Math.ceil(rawPrice),
  };
}

async function getOfflineAccessToken() {
  const sessionId = `offline_${SHOP}`;
  const session = await prisma.session.findUnique({ where: { id: sessionId } });

  if (!session || !session.accessToken) {
    throw new Error(`Offline session not found: ${sessionId}`);
  }

  return session.accessToken;
}

async function shopifyGraphQL(query, variables = {}) {
  const accessToken = await getOfflineAccessToken();

  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Shopify GraphQL request failed: ${res.status} ${JSON.stringify(data)}`);
  }

  if (data.errors && data.errors.length > 0) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  return data.data;
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

async function getShopPricingSettings() {
  const query = `
    query GetShopPricingSettings {
      shop {
        defaultMarginRate: metafield(namespace: \"global_pricing\", key: \"default_margin_rate\") { value }
        paymentFeeRate: metafield(namespace: \"global_pricing\", key: \"payment_fee_rate\") { value }
        paymentFeeFixed: metafield(namespace: \"global_pricing\", key: \"payment_fee_fixed\") { value }
        bufferRate: metafield(namespace: \"global_pricing\", key: \"buffer_rate\") { value }
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

async function getFirstProductWithShopifyId() {
  const product = await prisma.product.findFirst({
    where: {
      shopifyProductId: { not: null },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  if (!product || !product.shopifyProductId) {
    throw new Error('No product with shopifyProductId was found in the database.');
  }

  return product;
}

async function getShopifyProductPricingMetafields(productId) {
  const query = `
    query GetProductPricing($id: ID!) {
      product(id: $id) {
        id
        title
        costAmount: metafield(namespace: \"pricing\", key: \"cost_amount\") { value }
        costCurrency: metafield(namespace: \"pricing\", key: \"cost_currency\") { value }
        dutyCategory: metafield(namespace: \"pricing\", key: \"duty_category\") { value }
        packagingFee: metafield(namespace: \"pricing\", key: \"packaging_fee\") { value }
      }
    }
  `;

  const data = await shopifyGraphQL(query, { id: productId });
  return data.product;
}

async function main() {
  const dbProduct = await getFirstProductWithShopifyId();
  const shopSettings = await getShopPricingSettings();
  const product = await getShopifyProductPricingMetafields(dbProduct.shopifyProductId);

  const input = {
    costAmount: toNumber(product.costAmount?.value, 0),
    fxRate: 1,
    dutyRate: 0.2,
    packagingFee: toNumber(product.packagingFee?.value, 0),
    marginRate: shopSettings.defaultMarginRate,
    paymentFeeRate: shopSettings.paymentFeeRate,
    paymentFeeFixed: shopSettings.paymentFeeFixed,
    bufferRate: shopSettings.bufferRate,
  };

  const finalPrice = calculatePrice(input);
  const breakdown = calculatePriceBreakdown(input);

  console.log(JSON.stringify({
    dbProductId: dbProduct.id,
    shopifyProductId: dbProduct.shopifyProductId,
    title: product.title,
    costCurrency: product.costCurrency?.value || null,
    dutyCategory: product.dutyCategory?.value || null,
    input,
    finalPrice,
    breakdown,
  }, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

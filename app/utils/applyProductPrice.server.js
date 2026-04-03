import prisma from '../db.server';

const SHOP = 'b30ize-1a.myshopify.com';
const API_VERSION = '2026-04';
const DEFAULT_FX_RATE = 1;
const DUTY_RATE_MAP = {
  cosmetics: 0.2,
};

async function shopifyGraphQL(accessToken, query, variables) {
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

  if (data.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  return data.data;
}

function ceilYen(value) {
  return Math.ceil(Number(value || 0));
}

function calculateFinalPrice({
  costAmount,
  packagingFee,
  dutyRate,
  marginRate,
  paymentFeeRate,
  paymentFeeFixed,
  bufferRate,
  fxRate,
}) {
  const costFx = Number(costAmount) * Number(fxRate);
  const duty = costFx * Number(dutyRate);
  const landed = costFx + duty + Number(packagingFee);
  const safeCost = landed * (1 + Number(bufferRate));
  const target = safeCost * (1 + Number(marginRate));
  const rawPrice = (target + Number(paymentFeeFixed)) / (1 - Number(paymentFeeRate));
  const finalPrice = ceilYen(rawPrice);

  return {
    costFx: ceilYen(costFx),
    duty: ceilYen(duty),
    landed: ceilYen(landed),
    safeCost: ceilYen(safeCost),
    target: ceilYen(target),
    rawPrice,
    finalPrice,
  };
}

export async function applyProductPrice(productId, options = {}) {
  if (!productId) {
    throw new Error('productId is required');
  }

  const fxRate = Number(options.fxRate ?? DEFAULT_FX_RATE);

  const session = await prisma.session.findFirst({
    where: {
      shop: SHOP,
      isOnline: false,
    },
  });

  if (!session?.accessToken) {
    throw new Error('Offline session not found');
  }

  const readQuery = `
    query ReadProductAndShop($id: ID!) {
      product(id: $id) {
        id
        title
        costAmountMetafield: metafield(namespace: "pricing", key: "cost_amount") { value }
        costCurrencyMetafield: metafield(namespace: "pricing", key: "cost_currency") { value }
        dutyCategoryMetafield: metafield(namespace: "pricing", key: "duty_category") { value }
        packagingFeeMetafield: metafield(namespace: "pricing", key: "packaging_fee") { value }
        variants(first: 1) {
          nodes {
            id
            title
            price
          }
        }
      }
      shop {
        marginRate: metafield(namespace: "global_pricing", key: "default_margin_rate") { value }
        paymentFeeRate: metafield(namespace: "global_pricing", key: "payment_fee_rate") { value }
        paymentFeeFixed: metafield(namespace: "global_pricing", key: "payment_fee_fixed") { value }
        bufferRate: metafield(namespace: "global_pricing", key: "buffer_rate") { value }
      }
    }
  `;

  const readData = await shopifyGraphQL(session.accessToken, readQuery, { id: productId });
  const product = readData.product;

  if (!product) {
    throw new Error('Product not found on Shopify');
  }

  const variant = product.variants?.nodes?.[0];
  if (!variant) {
    throw new Error('Variant not found');
  }

  const costAmount = Number(product.costAmountMetafield?.value || 0);
  const costCurrency = product.costCurrencyMetafield?.value || null;
  const dutyCategory = product.dutyCategoryMetafield?.value || null;
  const packagingFee = Number(product.packagingFeeMetafield?.value || 0);

  if (!costAmount) {
    throw new Error('pricing.cost_amount is empty');
  }

  if (costCurrency !== 'JPY') {
    throw new Error(`Unsupported currency: ${costCurrency}`);
  }

  const marginRate = Number(readData.shop?.marginRate?.value ?? 0.1);
  const paymentFeeRate = Number(readData.shop?.paymentFeeRate?.value ?? 0.04);
  const paymentFeeFixed = Number(readData.shop?.paymentFeeFixed?.value ?? 50);
  const bufferRate = Number(readData.shop?.bufferRate?.value ?? 0.1);
  const dutyRate = Number(options.dutyRate ?? DUTY_RATE_MAP[dutyCategory] ?? 0);

  const breakdown = calculateFinalPrice({
    costAmount,
    packagingFee,
    dutyRate,
    marginRate,
    paymentFeeRate,
    paymentFeeFixed,
    bufferRate,
    fxRate,
  });

  const updateMutation = `
    mutation UpdateVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        product { id }
        productVariants { id price }
        userErrors { field message }
      }
    }
  `;

  const updateData = await shopifyGraphQL(session.accessToken, updateMutation, {
    productId: product.id,
    variants: [
      {
        id: variant.id,
        price: String(breakdown.finalPrice),
      },
    ],
  });

  const userErrors = updateData.productVariantsBulkUpdate?.userErrors || [];
  if (userErrors.length) {
    throw new Error(`productVariantsBulkUpdate failed: ${JSON.stringify(userErrors)}`);
  }

  return {
    ok: true,
    productId: product.id,
    title: product.title,
    variantId: variant.id,
    oldPrice: variant.price,
    newPrice: String(breakdown.finalPrice),
    inputs: {
      costAmount,
      costCurrency,
      dutyCategory,
      packagingFee,
      marginRate,
      paymentFeeRate,
      paymentFeeFixed,
      bufferRate,
      dutyRate,
      fxRate,
    },
    breakdown,
  };
}

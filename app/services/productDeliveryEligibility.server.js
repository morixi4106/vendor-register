import prisma from '../db.server.js';
import {
  buildDeliveryRestrictionSummary,
  evaluateProductDeliveryEligibility,
  normalizeCountryCode,
  normalizeText,
  serializePublicDeliveryEligibility,
} from '../utils/deliveryEligibility.js';

function normalizeShopifyProductGid(value) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('gid://shopify/Product/')) {
    return normalized;
  }

  if (/^\d+$/.test(normalized)) {
    return `gid://shopify/Product/${normalized}`;
  }

  return normalized;
}

function buildPublicHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    'Surrogate-Control': 'no-store',
  };
}

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: buildPublicHeaders(),
  });
}

export function createProductDeliveryEligibilityLoader({
  prismaClient = prisma,
} = {}) {
  return async function loader({ request }) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: buildPublicHeaders(),
      });
    }

    const url = new URL(request.url);
    const deliveryCountry = normalizeCountryCode(
      url.searchParams.get('deliveryCountry') || url.searchParams.get('country'),
    );
    const productId = normalizeText(url.searchParams.get('productId'));
    const shopifyProductIdRaw = normalizeText(
      url.searchParams.get('shopifyProductId') ||
        url.searchParams.get('shopifyProductGid'),
    );
    const shopifyProductId = normalizeShopifyProductGid(shopifyProductIdRaw);
    const vendorHandle = normalizeText(url.searchParams.get('vendorHandle'));

    if (!productId && !shopifyProductId) {
      return jsonResponse(
        {
          ok: false,
          error: 'productId or shopifyProductId is required.',
        },
        { status: 400 },
      );
    }

    const product = await prismaClient.product.findFirst({
      where: {
        ...(productId
          ? { id: productId }
          : {
              OR: Array.from(new Set([shopifyProductIdRaw, shopifyProductId]))
                .filter(Boolean)
                .map((value) => ({ shopifyProductId: value })),
            }),
        ...(vendorHandle
          ? {
              vendorStore: {
                is: {
                  vendorAuth: {
                    is: {
                      handle: vendorHandle,
                    },
                  },
                },
              },
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        shopifyProductId: true,
        approvalStatus: true,
        productEuStatus: true,
        countryPolicy: true,
        vendorStore: {
          select: {
            vendorAuth: {
              select: {
                handle: true,
                seller: {
                  select: {
                    euSellerStatus: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!product) {
      return jsonResponse(
        {
          ok: false,
          error: 'Product was not found.',
        },
        { status: 404 },
      );
    }

    const seller = product.vendorStore?.vendorAuth?.seller || null;
    const eligibility = evaluateProductDeliveryEligibility({
      product,
      seller,
      deliveryCountry,
    });

    return jsonResponse({
      ok: true,
      deliveryCountry,
      product: {
        id: product.id,
        name: product.name,
        shopifyProductId: product.shopifyProductId,
        vendorHandle: product.vendorStore?.vendorAuth?.handle || null,
      },
      deliveryEligibility: serializePublicDeliveryEligibility(eligibility),
      deliveryRestrictionSummary: buildDeliveryRestrictionSummary({
        product,
        seller,
      }),
    });
  };
}

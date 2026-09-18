import prisma from '../db.server.js';
import {
  buildDeliveryRestrictionSummary,
  evaluateProductDeliveryEligibility,
  normalizeCountryCode,
  normalizeText,
  serializePublicDeliveryEligibility,
} from '../utils/deliveryEligibility.js';
import { evaluateInternationalMarketCompliance } from '../utils/internationalMarketCompliance.js';
import {
  evaluateInternationalShippingAvailability,
  getInternationalShippingCountryAvailability,
} from './internationalShippingAvailability.server.js';

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
  getInternationalShippingCountryAvailabilityImpl =
    getInternationalShippingCountryAvailability,
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
        category: true,
        internationalShippingMethod: true,
        shippingWeightGrams: true,
        shippingLengthMm: true,
        shippingWidthMm: true,
        shippingHeightMm: true,
        shippingWeightConfirmedAt: true,
        shippingWeightSource: true,
        shopifyVariantCount: true,
        shopifyWeightSyncStatus: true,
        countryPolicy: true,
        complianceProfile: true,
        complianceEvidence: {
          include: { requirement: true },
          orderBy: { createdAt: 'desc' },
          take: 100,
        },
        complianceDecisions: {
          include: { requirement: true },
          orderBy: { decidedAt: 'desc' },
          take: 100,
        },
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
    let eligibility = evaluateProductDeliveryEligibility({
      product,
      seller,
      deliveryCountry,
    });
    if (eligibility.isAvailable && deliveryCountry && deliveryCountry !== 'JP') {
      const availability = await getInternationalShippingCountryAvailabilityImpl({
        countryCode: deliveryCountry,
        prismaClient,
      });
      const service = evaluateInternationalShippingAvailability(availability);
      if (!service.deliverable) {
        eligibility = {
          ...eligibility,
          status: 'UNAVAILABLE_INTERNATIONAL_SERVICE',
          reason: 'international_shipping_service_unavailable',
          isAvailable: false,
          requiresImportWarning: false,
          severity: 'block',
          warningVersion: null,
          publicMessage: 'This product cannot currently be shipped to the selected destination.',
        };
      }
    }
    if (eligibility.isAvailable && deliveryCountry && deliveryCountry !== 'JP') {
      const compliance = evaluateInternationalMarketCompliance({
        product,
        destinationCountry: deliveryCountry,
      });
      if (!compliance.ready) {
        eligibility = {
          ...eligibility,
          status: 'UNAVAILABLE_INTERNATIONAL_COMPLIANCE',
          reason: 'international_compliance_unavailable',
          isAvailable: false,
          requiresImportWarning: false,
          severity: 'block',
          warningVersion: null,
          publicMessage: 'この配送先には販売できません。',
        };
      }
    }

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

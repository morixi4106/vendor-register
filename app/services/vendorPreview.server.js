import { json } from "@remix-run/node";
import prisma from "../db.server";
import { serializePublicVendorStorefront } from "../utils/publicVendorStorefront";
const PREVIEW_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
  "Surrogate-Control": "no-store"
};
function normalizeHandle(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}
function normalizeCountry(value) {
  return String(value || "").trim().toUpperCase();
}
function buildApiUrl({
  origin,
  handle,
  deliveryCountry,
  filterEligible
}) {
  const apiUrl = new URL(`/api/public-vendors/${encodeURIComponent(handle)}`, origin);
  if (deliveryCountry) {
    apiUrl.searchParams.set("deliveryCountry", deliveryCountry);
  }
  if (filterEligible) {
    apiUrl.searchParams.set("filterEligible", "1");
  }
  return apiUrl.toString();
}
export const loadVendorPreview = async ({
  params,
  request
}) => {
  const handle = normalizeHandle(params.handle);
  const url = new URL(request.url);
  const deliveryCountry = normalizeCountry(url.searchParams.get("deliveryCountry"));
  const filterEligible = url.searchParams.get("filterEligible") === "1";
  if (!handle) {
    throw new Response("Vendor handle is required.", {
      status: 400
    });
  }
  const vendor = await prisma.vendor.findUnique({
    where: {
      handle
    },
    select: {
      id: true,
      handle: true,
      storeName: true,
      status: true,
      vendorStore: {
        select: {
          id: true,
          storeName: true,
          country: true,
          category: true,
          address: true,
          note: true
        }
      },
      seller: {
        select: {
          euSellerStatus: true
        }
      }
    }
  });
  if (!vendor || vendor.status !== "active" || !vendor.vendorStore) {
    throw new Response("Vendor was not found.", {
      status: 404
    });
  }
  const products = await prisma.product.findMany({
    where: {
      vendorStoreId: vendor.vendorStore.id,
      approvalStatus: "approved"
    },
    orderBy: {
      createdAt: "desc"
    },
    select: {
      id: true,
      name: true,
      description: true,
      imageUrl: true,
      category: true,
      price: true,
      calculatedPrice: true,
      inventoryQuantity: true,
      shopDomain: true,
      approvalStatus: true,
      productEuStatus: true,
      countryPolicy: true
    }
  });
  const storefront = serializePublicVendorStorefront({
    vendor,
    store: vendor.vendorStore,
    products,
    deliveryCountry,
    filterByDeliveryEligibility: false,
    draftOrderCheckoutEnabled: true
  });
  if (!storefront) {
    throw new Response("Vendor was not found.", {
      status: 404
    });
  }
  const visibleProducts = filterEligible && deliveryCountry ? storefront.products.filter(product => product.isPurchasable && product.deliveryEligibility?.isAvailable) : storefront.products;
  const unavailableProductCount = storefront.products.filter(product => !product.isPurchasable || !product.deliveryEligibility?.isAvailable).length;
  return json({
    ...storefront,
    products: visibleProducts,
    visibleProductCount: visibleProducts.length,
    hiddenProductCount: storefront.products.length - visibleProducts.length,
    unavailableProductCount,
    deliveryCountry,
    filterEligible,
    rawApiUrl: buildApiUrl({
      origin: url.origin,
      handle,
      deliveryCountry,
      filterEligible
    })
  }, {
    headers: PREVIEW_HEADERS
  });
};

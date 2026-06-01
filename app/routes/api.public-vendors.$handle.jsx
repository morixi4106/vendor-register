import prisma from "../db.server";
import { serializePublicVendorStorefront } from "../utils/publicVendorStorefront";

const PUBLIC_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
  "Surrogate-Control": "no-store",
};

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: PUBLIC_HEADERS,
  });
}

function normalizeHandle(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

export const loader = async ({ params, request }) => {
  const handle = normalizeHandle(params.handle);
  const url = new URL(request.url);
  const deliveryCountry = String(url.searchParams.get("deliveryCountry") || "").trim();
  const filterByDeliveryEligibility =
    url.searchParams.get("filterEligible") === "1" ||
    url.searchParams.get("filterByDeliveryEligibility") === "1";

  if (!handle) {
    return jsonResponse({ ok: false, error: "Vendor handle is required." }, { status: 400 });
  }

  const vendor = await prisma.vendor.findUnique({
    where: { handle },
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
          note: true,
        },
      },
      seller: {
        select: {
          euSellerStatus: true,
        },
      },
    },
  });

  if (!vendor || vendor.status !== "active" || !vendor.vendorStore) {
    return jsonResponse({ ok: false, error: "Vendor was not found." }, { status: 404 });
  }

  const products = await prisma.product.findMany({
    where: {
      vendorStoreId: vendor.vendorStore.id,
      approvalStatus: "approved",
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      description: true,
      imageUrl: true,
      category: true,
      price: true,
      calculatedPrice: true,
      shopDomain: true,
      approvalStatus: true,
      productEuStatus: true,
      countryPolicy: true,
    },
  });

  const storefront = serializePublicVendorStorefront({
    vendor,
    store: vendor.vendorStore,
    products,
    deliveryCountry,
    filterByDeliveryEligibility,
  });

  if (!storefront) {
    return jsonResponse({ ok: false, error: "Vendor was not found." }, { status: 404 });
  }

  return jsonResponse({
    ok: true,
    ...storefront,
  });
};

export const action = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: PUBLIC_HEADERS,
    });
  }

  return jsonResponse({ ok: false, error: "Method not allowed." }, { status: 405 });
};

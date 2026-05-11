import {
  buildVendorCollectionHandle,
  buildVendorCollectionUrl,
} from "./vendorCollectionHandles.js";

function normalizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeShopDomain(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toLowerCase() : null;
}

export function getPublicProductDisplayPrice(product) {
  const calculatedPrice = Number(product?.calculatedPrice);

  if (Number.isFinite(calculatedPrice) && calculatedPrice > 0) {
    return Math.round(calculatedPrice);
  }

  const basePrice = Number(product?.price);

  if (Number.isFinite(basePrice) && basePrice > 0) {
    return Math.round(basePrice);
  }

  return 0;
}

export function formatPublicJpyPrice(amount) {
  const numericAmount = Number(amount || 0);

  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(numericAmount);
}

export function serializePublicVendorStorefront({ vendor, store, products = [] }) {
  const handle = normalizeText(vendor?.handle);

  if (!handle || !store?.id) {
    return null;
  }

  return {
    vendor: {
      handle,
      storeName: vendor?.storeName || store?.storeName || "",
      collectionHandle: buildVendorCollectionHandle(handle),
      collectionUrl: buildVendorCollectionUrl(handle),
    },
    store: {
      id: store.id,
      handle,
      collectionHandle: buildVendorCollectionHandle(handle),
      collectionUrl: buildVendorCollectionUrl(handle),
      storeName: store.storeName || vendor?.storeName || "",
      country: store.country || null,
      category: store.category || null,
      address: store.address || null,
      note: store.note || null,
    },
    products: products.map((product) => {
      const price = getPublicProductDisplayPrice(product);
      const shopDomain = normalizeShopDomain(product.shopDomain);

      return {
        id: product.id,
        name: product.name,
        description: product.description || "",
        imageUrl: product.imageUrl || null,
        category: product.category || null,
        price,
        currency: "JPY",
        formattedPrice: formatPublicJpyPrice(price),
        isPurchasable: Boolean(shopDomain && price > 0),
      };
    }),
  };
}

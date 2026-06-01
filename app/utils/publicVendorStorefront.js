import {
  buildVendorCollectionHandle,
  buildVendorCollectionUrl,
} from "./vendorCollectionHandles.js";
import {
  buildDeliveryRestrictionSummary,
  evaluateProductDeliveryEligibility,
  normalizeCountryCode,
  serializePublicDeliveryEligibility,
} from "./deliveryEligibility.js";

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

export function serializePublicVendorStorefront({
  vendor,
  store,
  products = [],
  deliveryCountry = null,
  filterByDeliveryEligibility = false,
}) {
  const handle = normalizeText(vendor?.handle);

  if (!handle || !store?.id) {
    return null;
  }

  const countryCode = normalizeCountryCode(deliveryCountry);
  const seller = vendor?.seller || null;
  const serializedProducts = products
    .map((product) => {
      const price = getPublicProductDisplayPrice(product);
      const shopDomain = normalizeShopDomain(product.shopDomain);
      const basePurchasable = Boolean(shopDomain && price > 0);
      const deliveryEligibility = evaluateProductDeliveryEligibility({
        product,
        seller,
        deliveryCountry: countryCode,
      });
      const deliveryRestrictionSummary = buildDeliveryRestrictionSummary({
        product,
        seller,
      });
      const publicDeliveryEligibility =
        serializePublicDeliveryEligibility(deliveryEligibility);
      const isPurchasable =
        basePurchasable &&
        (!countryCode || publicDeliveryEligibility.isAvailable);

      return {
        id: product.id,
        name: product.name,
        description: product.description || "",
        imageUrl: product.imageUrl || null,
        category: product.category || null,
        price,
        currency: "JPY",
        formattedPrice: formatPublicJpyPrice(price),
        isPurchasable,
        basePurchasable,
        deliveryEligibility: publicDeliveryEligibility,
        deliveryRestrictionSummary,
      };
    });
  const visibleProducts =
    filterByDeliveryEligibility && countryCode
      ? serializedProducts.filter(
          (product) =>
            product.isPurchasable && product.deliveryEligibility.isAvailable,
        )
      : serializedProducts;

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
    deliveryCountry: countryCode,
    deliveryCountrySelected: Boolean(countryCode),
    productCount: serializedProducts.length,
    visibleProductCount: visibleProducts.length,
    hiddenProductCount: serializedProducts.length - visibleProducts.length,
    products: visibleProducts,
  };
}

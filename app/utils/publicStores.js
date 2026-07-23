import {
  buildVendorCollectionHandle,
  buildVendorCollectionUrl,
  buildVendorProxyStorefrontUrl,
} from "./vendorCollectionHandles.js";

export function buildPublicStoresWhereInput({
  draftOrderCheckoutEnabled = false,
} = {}) {
  return {
    isTestStore: false,
    ...(draftOrderCheckoutEnabled ? {} : { isPlatformStore: true }),
    vendorAuth: {
      is: {
        status: "active",
      },
    },
  };
}

export function serializePublicStore(store) {
  const handle = String(store?.vendorAuth?.handle || "").trim();

  if (!handle) return null;

  const collectionHandle = buildVendorCollectionHandle(handle);
  const isPlatformStore = store?.isPlatformStore === true;

  return {
    id: store.id,
    handle,
    isPlatformStore,
    collectionHandle,
    collectionUrl: isPlatformStore
      ? buildVendorCollectionUrl(handle)
      : buildVendorProxyStorefrontUrl(handle),
    storeName: store.storeName,
    category: store.category,
    country: store.country,
    address: store.address,
    note: store.note,
  };
}

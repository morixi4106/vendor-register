import {
  buildVendorCollectionHandle,
  buildVendorProxyStorefrontUrl,
} from "./vendorCollectionHandles.js";

export function serializePublicStore(store) {
  const handle = String(store?.vendorAuth?.handle || "").trim();

  if (!handle) return null;

  const collectionHandle = buildVendorCollectionHandle(handle);

  return {
    id: store.id,
    handle,
    collectionHandle,
    collectionUrl: buildVendorProxyStorefrontUrl(handle),
    storeName: store.storeName,
    category: store.category,
    country: store.country,
    address: store.address,
    note: store.note,
  };
}

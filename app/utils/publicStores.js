import {
  buildVendorCollectionHandle,
  buildVendorCollectionUrl,
} from "./vendorCollectionHandles.js";

export function serializePublicStore(store) {
  const handle = String(store?.vendorAuth?.handle || "").trim();

  if (!handle) return null;

  const collectionHandle = buildVendorCollectionHandle(handle);

  return {
    id: store.id,
    handle,
    collectionHandle,
    collectionUrl: buildVendorCollectionUrl(handle),
    storeName: store.storeName,
    category: store.category,
    country: store.country,
    address: store.address,
    note: store.note,
  };
}

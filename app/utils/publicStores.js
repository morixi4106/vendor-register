export function serializePublicStore(store) {
  const handle = String(store?.vendorAuth?.handle || "").trim();

  if (!handle) return null;

  return {
    id: store.id,
    handle,
    storeName: store.storeName,
    category: store.category,
    country: store.country,
    address: store.address,
    note: store.note,
  };
}

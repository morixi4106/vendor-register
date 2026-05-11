export function normalizeVendorCollectionSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildVendorCollectionHandle(vendorHandle) {
  const slug = normalizeVendorCollectionSlug(vendorHandle);

  return slug ? `vendor-${slug}` : null;
}

export function buildVendorCollectionUrl(vendorHandle) {
  const handle = buildVendorCollectionHandle(vendorHandle);

  return handle ? `/collections/${handle}` : null;
}

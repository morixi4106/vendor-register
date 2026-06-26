import { useMatches } from "@remix-run/react";

export function appendVendorIdToPath(to, vendorId) {
  const normalizedVendorId = String(vendorId || "").trim();
  const target = String(to || "").trim();

  if (!normalizedVendorId || !target || target.startsWith("//")) {
    return target;
  }

  if (!target.startsWith("/")) {
    return target;
  }

  try {
    const url = new URL(target, "https://vendor.local");
    url.searchParams.set("vendorId", normalizedVendorId);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch (_) {
    return target;
  }
}

export function getVendorIdFromMatches(matches) {
  const matched = [...(matches || [])]
    .reverse()
    .find((match) => match?.data?.vendor?.id);

  return String(matched?.data?.vendor?.id || "").trim();
}

export function useVendorIdFromMatches() {
  return getVendorIdFromMatches(useMatches());
}

export function useVendorScopedPath(to) {
  return appendVendorIdToPath(to, useVendorIdFromMatches());
}

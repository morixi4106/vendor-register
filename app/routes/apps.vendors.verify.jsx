import { redirect } from "@remix-run/node";

import { getAppBaseUrl } from "../utils/appUrl.server.js";

function getVendorId(url) {
  const vendorId = String(url.searchParams.get("vendorId") || "").trim();

  if (vendorId) return vendorId;

  const returnTo = url.searchParams.get("returnTo");

  if (!returnTo) return "";

  try {
    const returnToUrl = returnTo.startsWith("/")
      ? new URL(returnTo, url.origin)
      : new URL(returnTo);

    return String(returnToUrl.searchParams.get("vendorId") || "").trim();
  } catch (_) {
    return "";
  }
}

function getVendorVerifyUrl(request) {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") || "/vendor/dashboard";
  const vendorId = getVendorId(url);
  const verifyUrl = new URL("/vendor/verify", getAppBaseUrl(request));

  verifyUrl.searchParams.set("returnTo", returnTo);

  if (vendorId) {
    verifyUrl.searchParams.set("vendorId", vendorId);
  }

  return verifyUrl.toString();
}

export const loader = async ({ request }) => {
  throw redirect(getVendorVerifyUrl(request), 302);
};

export const action = async ({ request }) => {
  throw redirect(getVendorVerifyUrl(request), 302);
};

export default function LegacyVendorVerifyRedirect() {
  return null;
}

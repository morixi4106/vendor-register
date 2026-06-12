import { redirect } from "@remix-run/node";

import { getAppBaseUrl } from "../utils/appUrl.server.js";

function getVendorVerifyUrl(request) {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") || "/vendor/dashboard";
  const verifyUrl = new URL("/vendor/verify", getAppBaseUrl(request));

  verifyUrl.searchParams.set("returnTo", returnTo);

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

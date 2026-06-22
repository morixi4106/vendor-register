import { redirect } from "@remix-run/node";

import { vendorRegistrationTargetCookie } from "../services/vendorManagement.server.js";
import { getAppBaseUrl } from "../utils/appUrl.server.js";

export const loader = async ({ request }) => {
  const cookieHeader = request.headers.get("Cookie");
  const targetVendorId = await vendorRegistrationTargetCookie.parse(cookieHeader);
  const headers = new Headers();

  if (targetVendorId) {
    headers.append(
      "Set-Cookie",
      await vendorRegistrationTargetCookie.serialize("", { maxAge: 0 }),
    );

    const verifyUrl = new URL("/vendor/verify", getAppBaseUrl(request));
    verifyUrl.searchParams.set("vendorId", targetVendorId);
    verifyUrl.searchParams.set("returnTo", "/vendor/dashboard");

    throw redirect(verifyUrl.toString(), { status: 302, headers });
  }

  throw redirect(`${getAppBaseUrl(request)}/vendor/dashboard`, 302);
};

export default function LegacyVendorDashboardRedirect() {
  return null;
}

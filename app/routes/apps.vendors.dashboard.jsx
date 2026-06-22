import { json, redirect } from "@remix-run/node";
import { useEffect } from "react";
import { useLoaderData } from "@remix-run/react";

import { vendorRegistrationTargetCookie } from "../services/vendorManagement.server.js";
import { getAppBaseUrl } from "../utils/appUrl.server.js";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const cookieHeader = request.headers.get("Cookie");
  const cookieTargetVendorId =
    await vendorRegistrationTargetCookie.parse(cookieHeader);
  const targetVendorId =
    String(url.searchParams.get("vendorId") || "").trim() ||
    String(cookieTargetVendorId || "").trim();
  const headers = new Headers();

  if (targetVendorId) {
    if (cookieTargetVendorId) {
      headers.append(
        "Set-Cookie",
        await vendorRegistrationTargetCookie.serialize("", { maxAge: 0 }),
      );
    }

    const verifyUrl = new URL("/vendor/verify", getAppBaseUrl(request));
    verifyUrl.searchParams.set("vendorId", targetVendorId);
    verifyUrl.searchParams.set("returnTo", "/vendor/dashboard");

    throw redirect(verifyUrl.toString(), { status: 302, headers });
  }

  return json({ appBaseUrl: getAppBaseUrl(request) });
};

export default function VendorDashboardEntry() {
  const { appBaseUrl } = useLoaderData();

  useEffect(() => {
    let targetVendorId = "";

    try {
      targetVendorId =
        window.localStorage.getItem("vendor_registration_target") || "";

      if (targetVendorId) {
        window.localStorage.removeItem("vendor_registration_target");
      }
    } catch (_) {
      targetVendorId = "";
    }

    if (targetVendorId) {
      const verifyUrl = new URL("/vendor/verify", appBaseUrl);
      verifyUrl.searchParams.set("vendorId", targetVendorId);
      verifyUrl.searchParams.set("returnTo", "/vendor/dashboard");
      window.location.replace(verifyUrl.toString());
      return;
    }

    window.location.replace(`${appBaseUrl}/vendor/dashboard`);
  }, [appBaseUrl]);

  return (
    <main style={{ padding: "48px", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ margin: 0, fontSize: "24px" }}>Redirecting...</h1>
    </main>
  );
}

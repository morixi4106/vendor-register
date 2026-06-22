import { json, redirect } from "@remix-run/node";
import { useEffect } from "react";
import { useLoaderData } from "@remix-run/react";

import prisma from "../db.server.js";
import {
  vendorAdminSessionCookie,
  vendorRegistrationTargetCookie,
} from "../services/vendorManagement.server.js";
import { getAppBaseUrl } from "../utils/appUrl.server.js";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const appBaseUrl = getAppBaseUrl(request);
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

    const verifyUrl = new URL("/vendor/verify", appBaseUrl);
    verifyUrl.searchParams.set("vendorId", targetVendorId);
    verifyUrl.searchParams.set("returnTo", "/vendor/dashboard");

    throw redirect(verifyUrl.toString(), { status: 302, headers });
  }

  const sessionToken = await vendorAdminSessionCookie.parse(cookieHeader);

  if (sessionToken) {
    const session = await prisma.vendorAdminSession.findUnique({
      where: { sessionToken },
      include: { vendor: true },
    });

    if (session?.vendor && session.expiresAt > new Date()) {
      const vendors = await prisma.vendor.findMany({
        where: {
          managementEmail: session.vendor.managementEmail,
          status: "active",
        },
        include: { vendorStore: true },
        orderBy: { createdAt: "desc" },
      });

      return json({
        appBaseUrl,
        mode: "select",
        currentVendorId: session.vendorId,
        vendors: vendors.map((vendor) => ({
          id: vendor.id,
          storeName: vendor.storeName || vendor.vendorStore?.storeName || "店舗",
          email: vendor.managementEmail,
          createdAt: vendor.createdAt,
        })),
      });
    }
  }

  return json({ appBaseUrl, mode: "redirect" });
};

export default function VendorDashboardEntry() {
  const { appBaseUrl, currentVendorId, mode, vendors = [] } = useLoaderData();

  useEffect(() => {
    if (mode === "select") return;

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

    const verifyUrl = new URL("/vendor/verify", appBaseUrl);
    verifyUrl.searchParams.set("returnTo", "/vendor/dashboard");
    window.location.replace(verifyUrl.toString());
  }, [appBaseUrl, mode]);

  if (mode === "select") {
    return (
      <main
        style={{
          minHeight: "100vh",
          background: "#f4f5f7",
          color: "#071225",
          fontFamily: "system-ui, sans-serif",
          padding: "48px 20px",
        }}
      >
        <section
          style={{
            maxWidth: "720px",
            margin: "0 auto",
            background: "#fff",
            border: "1px solid #dfe3e8",
            borderRadius: "16px",
            padding: "32px",
          }}
        >
          <p style={{ margin: "0 0 8px", color: "#5f6b7a", fontWeight: 700 }}>
            店舗を選択
          </p>
          <h1 style={{ margin: "0 0 12px", fontSize: "28px" }}>
            管理する店舗を選んでください
          </h1>
          <p style={{ margin: "0 0 24px", color: "#5f6b7a" }}>
            開きたい店舗を選ぶか、別の店舗を認証してください。
          </p>
          <div style={{ display: "grid", gap: "12px" }}>
            {vendors.map((vendor) => {
              const verifyUrl = new URL("/vendor/verify", appBaseUrl);
              verifyUrl.searchParams.set("vendorId", vendor.id);
              verifyUrl.searchParams.set("returnTo", "/vendor/dashboard");

              return (
                <a
                  key={vendor.id}
                  href={verifyUrl.toString()}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "16px",
                    alignItems: "center",
                    minHeight: "64px",
                    padding: "16px 18px",
                    border: "1px solid #d0d7de",
                    borderRadius: "12px",
                    color: "#071225",
                    textDecoration: "none",
                    fontWeight: 800,
                  }}
                >
                  <span>{vendor.storeName}</span>
                  <span style={{ color: "#5f6b7a", fontSize: "13px" }}>
                    {vendor.id === currentVendorId ? "現在の店舗" : "認証して開く"}
                  </span>
                </a>
              );
            })}
            <a
              href={(() => {
                const verifyUrl = new URL("/vendor/verify", appBaseUrl);
                verifyUrl.searchParams.set("returnTo", "/vendor/dashboard");
                verifyUrl.searchParams.set("force", "1");
                return verifyUrl.toString();
              })()}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: "16px",
                alignItems: "center",
                minHeight: "64px",
                padding: "16px 18px",
                border: "1px dashed #9aa4b2",
                borderRadius: "12px",
                color: "#071225",
                textDecoration: "none",
                fontWeight: 800,
              }}
            >
              <span>別の店舗を認証する</span>
              <span style={{ color: "#5f6b7a", fontSize: "13px" }}>
                メール確認へ
              </span>
            </a>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main style={{ padding: "48px", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ margin: 0, fontSize: "24px" }}>Redirecting...</h1>
    </main>
  );
}

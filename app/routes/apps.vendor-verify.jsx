import { json, redirect, createCookie } from "@remix-run/node";
import { useLoaderData, Link } from "@remix-run/react";
import prisma from "../db.server";

const vendorAdminCookie = createCookie("vendor_admin_session", {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 8,
});

export const loader = async ({ request, url }) => {
  const cookieHeader = request.headers.get("Cookie");
  const sessionToken = await vendorAdminCookie.parse(cookieHeader);

  if (!sessionToken) {
    throw redirect("/apps/vendors/verify");
  }

  const session = await prisma.vendorAdminSession.findUnique({
    where: { sessionToken },
    include: {
      vendor: {
        include: {
          vendorStore: true,
        },
      },
    },
  });

  if (!session || session.expiresAt <= new Date()) {
    throw redirect("/apps/vendors/verify", {
      headers: {
        "Set-Cookie": await vendorAdminCookie.serialize("", {
          maxAge: 0,
        }),
      },
    });
  }

  return json({
    ok: true,
    vendorId: session.vendorId,
    vendor: session.vendor,
    store: session.vendor?.vendorStore || null,
  });
};

export default function VendorDashboardPage() {
  const data = useLoaderData();

  return (
    <div
      style={{
        maxWidth: "960px",
        margin: "40px auto",
        padding: "24px",
        fontFamily: "sans-serif",
      }}
    >
      <h1 style={{ fontSize: "28px", fontWeight: "700", marginBottom: "24px" }}>
        ベンダーダッシュボード
      </h1>

      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: "12px",
          padding: "20px",
          marginBottom: "20px",
        }}
      >
        <h2 style={{ fontSize: "20px", marginBottom: "12px" }}>店舗情報</h2>
        <p><strong>vendorId:</strong> {data.vendorId}</p>
        <p><strong>店舗名:</strong> {data.store?.storeName || data.vendor?.storeName || "-"}</p>
        <p><strong>管理メール:</strong> {data.vendor?.managementEmail || "-"}</p>
        <p><strong>ステータス:</strong> {data.vendor?.status || "-"}</p>
      </div>

      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: "12px",
          padding: "20px",
        }}
      >
        <h2 style={{ fontSize: "20px", marginBottom: "12px" }}>メニュー</h2>
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          <a
            href={`/apps/vendors/dashboard?vendor=${data.vendorId}`}
            style={{
              display: "inline-block",
              padding: "10px 16px",
              border: "1px solid #ccc",
              borderRadius: "8px",
              textDecoration: "none",
              color: "inherit",
            }}
          >
            ダッシュボード
          </a>

          <a
            href={`/apps/vendors/products/new?vendor=${data.vendorId}`}
            style={{
              display: "inline-block",
              padding: "10px 16px",
              border: "1px solid #ccc",
              borderRadius: "8px",
              textDecoration: "none",
              color: "inherit",
            }}
          >
            新規商品登録
          </a>
        </div>
      </div>
    </div>
  );
}
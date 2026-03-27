import { json, redirect, createCookie } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import prisma from "../db.server";

const vendorAdminCookie = createCookie("vendor_admin_session", {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 8,
});

export const loader = async ({ request }) => {
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
    vendor: {
      id: session.vendor.id,
      storeName: session.vendor.storeName,
      managementEmail: session.vendor.managementEmail,
    },
    store: session.vendor.vendorStore
      ? {
          id: session.vendor.vendorStore.id,
          storeName: session.vendor.vendorStore.storeName,
          category: session.vendor.vendorStore.category || "",
        }
      : null,
  });
};

export default function AppsVendorsDashboardPage() {
  const { vendor, store } = useLoaderData();

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>店舗管理ダッシュボード</h1>

        <div style={styles.section}>
          <div style={styles.label}>店舗名</div>
          <div style={styles.value}>{store?.storeName || vendor.storeName}</div>
        </div>

        <div style={styles.section}>
          <div style={styles.label}>管理用メールアドレス</div>
          <div style={styles.value}>{vendor.managementEmail}</div>
        </div>

        <div style={styles.section}>
          <div style={styles.label}>店舗ID</div>
          <div style={styles.value}>{vendor.id}</div>
        </div>

        <div style={styles.actions}>
          <a href="/apps/vendors/dashboard" style={styles.buttonSecondary}>
            ダッシュボード再読込
          </a>

          <a href="/apps/vendors/verify" style={styles.buttonPrimary}>
            認証ページへ戻る
          </a>
        </div>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#f6f6f6",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
  },
  card: {
    width: "100%",
    maxWidth: "760px",
    background: "#ffffff",
    border: "1px solid #d9d9d9",
    borderRadius: "20px",
    padding: "32px",
    boxSizing: "border-box",
  },
  title: {
    margin: "0 0 24px",
    fontSize: "32px",
    fontWeight: 700,
    color: "#111111",
  },
  section: {
    padding: "16px 0",
    borderBottom: "1px solid #eeeeee",
  },
  label: {
    fontSize: "14px",
    color: "#666666",
    marginBottom: "8px",
  },
  value: {
    fontSize: "20px",
    fontWeight: 600,
    color: "#111111",
    wordBreak: "break-word",
  },
  actions: {
    display: "flex",
    gap: "12px",
    flexWrap: "wrap",
    marginTop: "28px",
  },
  buttonPrimary: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "220px",
    height: "52px",
    padding: "0 20px",
    borderRadius: "999px",
    background: "#111111",
    color: "#ffffff",
    textDecoration: "none",
    fontWeight: 700,
  },
  buttonSecondary: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "220px",
    height: "52px",
    padding: "0 20px",
    borderRadius: "999px",
    background: "#f3f3f3",
    color: "#111111",
    textDecoration: "none",
    fontWeight: 700,
    border: "1px solid #d9d9d9",
  },
};
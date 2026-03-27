import { createCookie, json, redirect } from "@remix-run/node";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import prisma from "../db.server";

const vendorAdminSessionCookie = createCookie("vendor_admin_session", {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
});

async function getVendorFromSession(request) {
  const cookieHeader = request.headers.get("Cookie");
  const sessionToken = await vendorAdminSessionCookie.parse(cookieHeader);

  if (!sessionToken) {
    throw redirect("/apps/vendors/verify");
  }

  const vendorSession = await prisma.vendorAdminSession.findUnique({
    where: { sessionToken },
    include: {
      vendor: {
        include: {
          vendorStore: true,
        },
      },
    },
  });

  if (!vendorSession || vendorSession.expiresAt < new Date()) {
    throw redirect("/apps/vendors/verify", {
      headers: {
        "Set-Cookie": await vendorAdminSessionCookie.serialize("", {
          maxAge: 0,
        }),
      },
    });
  }

  const vendor = vendorSession.vendor;
  const store = vendor?.vendorStore;

  if (!vendor || !store) {
    throw new Response("店舗情報が見つかりません。", { status: 404 });
  }

  return { vendor, store };
}

export const loader = async ({ request }) => {
  const { vendor, store } = await getVendorFromSession(request);

  return json({
    vendor: {
      id: vendor.id,
      storeName: vendor.storeName,
      managementEmail: vendor.managementEmail,
    },
    store: {
      id: store.id,
      storeName: store.storeName,
    },
  });
};

export const action = async ({ request }) => {
  const { vendor, store } = await getVendorFromSession(request);

  const formData = await request.formData();

  const title = String(formData.get("title") || "").trim();
  const price = String(formData.get("price") || "").trim();

  if (!title) {
    return json({ ok: false, error: "商品名は必須です。" }, { status: 400 });
  }

  if (!price || Number.isNaN(Number(price))) {
    return json({ ok: false, error: "価格を正しく入力してください。" }, { status: 400 });
  }

  return json({
    ok: true,
    message: "（テスト）認証を外した状態で通過成功",
  });
};

export default function VendorProductsNewPage() {
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div style={{ maxWidth: "900px", margin: "0 auto", padding: "24px" }}>
      <h1 style={{ fontSize: "28px", fontWeight: 700, marginBottom: "20px" }}>
        商品登録
      </h1>

      <Form method="post">
        <input name="title" placeholder="商品名" />
        <input name="price" placeholder="価格" />

        {actionData?.message && <div>{actionData.message}</div>}
        {actionData?.error && <div>{actionData.error}</div>}

        <button type="submit" disabled={isSubmitting}>
          送信
        </button>
      </Form>
    </div>
  );
}
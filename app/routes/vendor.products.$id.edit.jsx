import { createCookie, json, redirect } from "@remix-run/node";
import { Form, useLoaderData, useActionData, useNavigation } from "@remix-run/react";
import prisma from "../db.server";

const vendorAdminSessionCookie = createCookie("vendor_admin_session", {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 8,
});

async function getVendorSession(request) {
  const cookieHeader = request.headers.get("Cookie");
  const sessionToken = await vendorAdminSessionCookie.parse(cookieHeader);

  if (!sessionToken) {
    throw redirect("https://vendor-register-pbjl.onrender.com/vendor/verify");
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
    throw redirect("https://vendor-register-pbjl.onrender.com/vendor/verify");
  }

  return vendorSession;
}

export const loader = async ({ request, params }) => {
  const vendorSession = await getVendorSession(request);
  const store = vendorSession.vendor.vendorStore;

  const product = await prisma.product.findUnique({
    where: { id: params.id },
  });

  if (!product || product.vendorStoreId !== store.id) {
    throw new Response("商品が見つかりません", { status: 404 });
  }

  return json({
    product,
  });
};

export const action = async ({ request, params }) => {
  const vendorSession = await getVendorSession(request);
  const store = vendorSession.vendor.vendorStore;

  const formData = await request.formData();
  const name = String(formData.get("name") || "").trim();
  const priceRaw = String(formData.get("price") || "").trim();

  if (!name || !priceRaw) {
    return json({ error: "入力不足" }, { status: 400 });
  }

  const price = Number(priceRaw);

  const product = await prisma.product.findUnique({
    where: { id: params.id },
  });

  if (!product || product.vendorStoreId !== store.id) {
    throw new Response("不正アクセス", { status: 403 });
  }

  await prisma.product.update({
    where: { id: params.id },
    data: {
      name,
      price,
    },
  });

  return redirect("https://vendor-register-pbjl.onrender.com/vendor/dashboard");
};

export default function EditPage() {
  const { product } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();

  return (
    <div style={{ padding: 40 }}>
      <h1>商品編集</h1>

      {actionData?.error && (
        <p style={{ color: "red" }}>{actionData.error}</p>
      )}

      <Form method="post">
        <div>
          <label>商品名</label>
          <input
            name="name"
            defaultValue={product.name}
            required
          />
        </div>

        <div>
          <label>価格</label>
          <input
            name="price"
            type="number"
            defaultValue={product.price}
            required
          />
        </div>

        <button disabled={navigation.state === "submitting"}>
          更新する
        </button>
      </Form>
    </div>
  );
}
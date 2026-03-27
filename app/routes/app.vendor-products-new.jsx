import { createCookie, json, redirect } from "@remix-run/node";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

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
    throw redirect("/apps/vendor-verify");
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
    throw redirect("/apps/vendor-verify", {
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
  await authenticate.admin(request);
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
  const { admin } = await authenticate.admin(request);
  const { vendor, store } = await getVendorFromSession(request);

  const formData = await request.formData();

  const title = String(formData.get("title") || "").trim();
  const description = String(formData.get("description") || "").trim();
  const price = String(formData.get("price") || "").trim();
  const sku = String(formData.get("sku") || "").trim();

  if (!title) {
    return json({ ok: false, error: "商品名は必須です。" }, { status: 400 });
  }

  if (!price || Number.isNaN(Number(price))) {
    return json({ ok: false, error: "価格を正しく入力してください。" }, { status: 400 });
  }

  const mutation = `
    mutation CreateVendorProduct($input: ProductInput!) {
      productCreate(input: $input) {
        product {
          id
          title
          vendor
          status
          variants(first: 10) {
            nodes {
              id
              sku
              price
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    input: {
      title,
      descriptionHtml: description || undefined,
      vendor: store.storeName,
      productType: store.category || undefined,
      variants: [
        {
          price,
          sku: sku || undefined,
        },
      ],
      metafields: [
        {
          namespace: "custom",
          key: "approval_status",
          type: "single_line_text_field",
          value: "pending",
        },
      ],
      status: "DRAFT",
    },
  };

  const response = await admin.graphql(mutation, { variables });
  const result = await response.json();

  const userErrors = result?.data?.productCreate?.userErrors || [];
  const product = result?.data?.productCreate?.product;

  if (result?.errors || userErrors.length > 0 || !product) {
    return json(
      {
        ok: false,
        error:
          userErrors[0]?.message ||
          result?.errors?.[0]?.message ||
          "商品作成に失敗しました。",
      },
      { status: 400 }
    );
  }

  const firstVariant = product?.variants?.nodes?.[0];

  try {
    await prisma.product.create({
      data: {
        name: product.title,
        price: Math.round(Number(price)),
        vendorStoreId: store.id,
      },
    });
  } catch (e) {
    console.error("local product save error:", e);
  }

  return redirect("/app/vendor-dashboard");
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

      <div
        style={{
          background: "#fff",
          border: "1px solid #ddd",
          borderRadius: "12px",
          padding: "20px",
        }}
      >
        <Form method="post">
          <div style={{ display: "grid", gap: "16px" }}>
            <div>
              <label style={{ display: "block", fontWeight: 700, marginBottom: "8px" }}>
                商品名
              </label>
              <input
                type="text"
                name="title"
                required
                style={{
                  width: "100%",
                  height: "44px",
                  padding: "0 12px",
                  border: "1px solid #ccc",
                  borderRadius: "8px",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div>
              <label style={{ display: "block", fontWeight: 700, marginBottom: "8px" }}>
                説明
              </label>
              <textarea
                name="description"
                rows={6}
                style={{
                  width: "100%",
                  padding: "12px",
                  border: "1px solid #ccc",
                  borderRadius: "8px",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div>
              <label style={{ display: "block", fontWeight: 700, marginBottom: "8px" }}>
                価格
              </label>
              <input
                type="text"
                name="price"
                required
                style={{
                  width: "100%",
                  height: "44px",
                  padding: "0 12px",
                  border: "1px solid #ccc",
                  borderRadius: "8px",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div>
              <label style={{ display: "block", fontWeight: 700, marginBottom: "8px" }}>
                SKU
              </label>
              <input
                type="text"
                name="sku"
                style={{
                  width: "100%",
                  height: "44px",
                  padding: "0 12px",
                  border: "1px solid #ccc",
                  borderRadius: "8px",
                  boxSizing: "border-box",
                }}
              />
            </div>

            {actionData?.error ? (
              <div
                style={{
                  background: "#fff1f2",
                  color: "#b91c1c",
                  border: "1px solid #fecdd3",
                  borderRadius: "8px",
                  padding: "12px",
                }}
              >
                {actionData.error}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={isSubmitting}
              style={{
                height: "46px",
                border: "none",
                borderRadius: "8px",
                background: "#111827",
                color: "#fff",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {isSubmitting ? "登録中..." : "商品を登録"}
            </button>
          </div>
        </Form>
      </div>
    </div>
  );
}
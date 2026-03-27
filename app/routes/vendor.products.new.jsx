import { createCookie, json, redirect } from "@remix-run/node";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import prisma from "../db.server";

const vendorAdminSessionCookie = createCookie("vendor_admin_session", {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 8,
});

async function getVendorFromRequest(request) {
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
    throw redirect("https://vendor-register-pbjl.onrender.com/vendor/verify", {
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
  const { vendor, store } = await getVendorFromRequest(request);

  return json({
    ok: true,
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
  const { store } = await getVendorFromRequest(request);
  const formData = await request.formData();

  const name = String(formData.get("name") || "").trim();
  const priceRaw = String(formData.get("price") || "").trim();

  if (!name) {
    return json(
      {
        ok: false,
        error: "商品名を入力してください。",
        values: { name, price: priceRaw },
      },
      { status: 400 }
    );
  }

  if (!priceRaw) {
    return json(
      {
        ok: false,
        error: "価格を入力してください。",
        values: { name, price: priceRaw },
      },
      { status: 400 }
    );
  }

  const price = Number(priceRaw);

  if (!Number.isInteger(price) || price < 0) {
    return json(
      {
        ok: false,
        error: "価格は0以上の整数で入力してください。",
        values: { name, price: priceRaw },
      },
      { status: 400 }
    );
  }

  await prisma.product.create({
    data: {
      name,
      price,
      vendorStoreId: store.id,
    },
  });

  return redirect("https://vendor-register-pbjl.onrender.com/vendor/dashboard");
};

export default function VendorProductsNewPage() {
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const values = actionData?.values || {
    name: "",
    price: "",
  };

  return (
    <div className="vendor-product-new-page">
      <style>{`
        .vendor-product-new-page{
          min-height:100vh;
          background:#f3f4f6;
          padding:32px 16px;
          box-sizing:border-box;
          font-family:Arial, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
          color:#111827;
        }
        .vendor-product-new-wrap{
          max-width:760px;
          margin:0 auto;
        }
        .vendor-product-new-card{
          background:#ffffff;
          border:1px solid #e5e7eb;
          border-radius:18px;
          padding:28px;
          box-sizing:border-box;
        }
        .vendor-product-new-sub{
          font-size:12px;
          color:#6b7280;
          margin:0 0 6px;
        }
        .vendor-product-new-title{
          font-size:32px;
          line-height:1.3;
          font-weight:700;
          margin:0 0 10px;
        }
        .vendor-product-new-lead{
          font-size:14px;
          color:#6b7280;
          margin:0 0 24px;
          line-height:1.8;
        }
        .vendor-product-new-error{
          margin-bottom:18px;
          border:1px solid #fecaca;
          background:#fef2f2;
          color:#b91c1c;
          border-radius:12px;
          padding:14px 16px;
          font-size:14px;
        }
        .vendor-product-new-form{
          display:grid;
          gap:18px;
        }
        .vendor-product-new-label{
          display:grid;
          gap:10px;
          font-size:14px;
          font-weight:700;
        }
        .vendor-product-new-input{
          width:100%;
          height:52px;
          border:1px solid #d1d5db;
          border-radius:12px;
          padding:0 16px;
          font-size:16px;
          box-sizing:border-box;
          background:#fff;
        }
        .vendor-product-new-note{
          font-size:12px;
          color:#6b7280;
          margin-top:2px;
          line-height:1.6;
        }
        .vendor-product-new-actions{
          display:flex;
          gap:12px;
          flex-wrap:wrap;
          margin-top:8px;
        }
        .vendor-product-new-btn{
          min-width:180px;
          height:52px;
          border-radius:12px;
          border:1px solid #d1d5db;
          background:#fff;
          color:#111827;
          font-size:15px;
          font-weight:700;
          text-decoration:none;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          box-sizing:border-box;
          cursor:pointer;
        }
        .vendor-product-new-btn-primary{
          background:#111827;
          color:#fff;
          border-color:#111827;
        }
        .vendor-product-new-btn:disabled{
          opacity:0.6;
          cursor:not-allowed;
        }

        @media (max-width: 640px){
          .vendor-product-new-page{
            padding:20px 12px;
          }
          .vendor-product-new-card{
            padding:20px;
          }
          .vendor-product-new-title{
            font-size:26px;
          }
          .vendor-product-new-actions{
            display:grid;
          }
          .vendor-product-new-btn{
            width:100%;
          }
        }
      `}</style>

      <div className="vendor-product-new-wrap">
        <div className="vendor-product-new-card">
          <p className="vendor-product-new-sub">店舗管理 / 商品登録</p>
          <h1 className="vendor-product-new-title">新規商品登録</h1>
          <p className="vendor-product-new-lead">
            まずは商品名と価格だけ登録します。
            <br />
            登録後、ダッシュボードの商品一覧に反映されます。
          </p>

          {actionData?.error ? (
            <div className="vendor-product-new-error">{actionData.error}</div>
          ) : null}

          <Form method="post" className="vendor-product-new-form">
            <label className="vendor-product-new-label">
              商品名
              <input
                className="vendor-product-new-input"
                type="text"
                name="name"
                defaultValue={values.name}
                placeholder="例: 薬用リンクルケアアイシート"
                required
              />
            </label>

            <label className="vendor-product-new-label">
              価格
              <input
                className="vendor-product-new-input"
                type="number"
                name="price"
                defaultValue={values.price}
                placeholder="例: 2980"
                min="0"
                step="1"
                required
              />
              <div className="vendor-product-new-note">
                半角数字、税込の想定で入力。
              </div>
            </label>

            <div className="vendor-product-new-actions">
              <a
                className="vendor-product-new-btn"
                href="https://vendor-register-pbjl.onrender.com/vendor/dashboard"
              >
                ダッシュボードへ戻る
              </a>

              <button
                className="vendor-product-new-btn vendor-product-new-btn-primary"
                type="submit"
                disabled={isSubmitting}
              >
                {isSubmitting ? "登録中..." : "商品を登録する"}
              </button>
            </div>
          </Form>
        </div>
      </div>
    </div>
  );
}
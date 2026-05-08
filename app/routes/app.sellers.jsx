import { json } from "@remix-run/node";
import {
  Form,
  Link,
  Outlet,
  useActionData,
  useLoaderData,
  useLocation,
  useNavigation,
} from "@remix-run/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const { listAdminSellerRows } = await import("../services/sellerPayments.server.js");

  return json({
    sellers: await listAdminSellerRows(),
  });
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const { ensureSellerForVendor } = await import("../services/sellerPayments.server.js");

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const vendorId = String(formData.get("vendorId") || "");

  if (intent !== "initialize_seller" || !vendorId) {
    return json(
      {
        ok: false,
        message: "不正なリクエストです。",
      },
      { status: 400 },
    );
  }

  try {
    const result = await ensureSellerForVendor(vendorId, {
      defaultStatus: "pending",
      changedBy: "admin",
      reason: "admin_initialize",
    });

    return json({
      ok: true,
      message: result.created ? "出店者決済レコードを作成しました。" : "出店者決済レコードは作成済みです。",
    });
  } catch (error) {
    console.error("seller initialize error:", error);
    return json(
      {
        ok: false,
        message: "出店者決済レコードの作成に失敗しました。",
      },
      { status: 500 },
    );
  }
};

function badgeClassName(status) {
  switch (status) {
    case "active":
      return "seller-admin__badge seller-admin__badge--success";
    case "restricted":
    case "banned":
      return "seller-admin__badge seller-admin__badge--danger";
    case "pending":
    case "review":
      return "seller-admin__badge seller-admin__badge--warning";
    default:
      return "seller-admin__badge";
  }
}

export default function AdminSellersPage() {
  const { sellers } = useLoaderData();
  const actionData = useActionData();
  const location = useLocation();
  const navigation = useNavigation();
  const isDetailRoute = location.pathname.startsWith("/app/sellers/");
  const submittingVendorId =
    navigation.formData?.get("intent") === "initialize_seller"
      ? String(navigation.formData?.get("vendorId") || "")
      : "";

  if (isDetailRoute) {
    return <Outlet />;
  }

  return (
    <div style={{ padding: "24px" }}>
      <style>{`
        .seller-admin__page{
          display:grid;
          gap:24px;
        }
        .seller-admin__card{
          background:#fff;
          border:1px solid #e5e7eb;
          border-radius:16px;
          padding:20px;
        }
        .seller-admin__title{
          margin:0 0 8px;
          font-size:24px;
          font-weight:700;
          color:#111827;
        }
        .seller-admin__subtitle{
          margin:0 0 18px;
          color:#6b7280;
          line-height:1.7;
          font-size:14px;
        }
        .seller-admin__badge{
          display:inline-flex;
          align-items:center;
          padding:5px 10px;
          border-radius:999px;
          background:#f3f4f6;
          color:#374151;
          border:1px solid #d1d5db;
          font-size:12px;
          font-weight:700;
        }
        .seller-admin__badge--success{
          background:#ecfdf5;
          color:#047857;
          border-color:#a7f3d0;
        }
        .seller-admin__badge--warning{
          background:#fffbeb;
          color:#92400e;
          border-color:#fde68a;
        }
        .seller-admin__badge--danger{
          background:#fef2f2;
          color:#b91c1c;
          border-color:#fecaca;
        }
        .seller-admin__button{
          display:inline-flex;
          align-items:center;
          justify-content:center;
          min-height:40px;
          padding:0 14px;
          border-radius:999px;
          border:1px solid #111827;
          background:#111827;
          color:#fff;
          font-size:13px;
          font-weight:700;
          cursor:pointer;
          text-decoration:none;
        }
        .seller-admin__button:disabled{
          cursor:not-allowed;
          opacity:0.6;
        }
        .seller-admin__button--secondary{
          border-color:#d1d5db;
          background:#fff;
          color:#111827;
        }
        .seller-admin__notice{
          border:1px solid #d1d5db;
          background:#f9fafb;
          color:#374151;
          border-radius:12px;
          padding:12px 14px;
          font-size:14px;
        }
      `}</style>

      <div className="seller-admin__page">
        <section className="seller-admin__card">
          <h1 className="seller-admin__title">出店者決済</h1>
          <p className="seller-admin__subtitle">
            既存の出店者に対して、Stripe連携アカウントの作成、決済可否の管理、
            売上台帳の確認、出金処理を行います。
          </p>
          {actionData?.message ? (
            <div className="seller-admin__notice">{actionData.message}</div>
          ) : null}
        </section>

        <section className="seller-admin__card">
          {sellers.length === 0 ? (
            <p style={{ margin: 0 }}>出店者がまだありません。</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={thStyle}>店舗名</th>
                    <th style={thStyle}>ハンドル</th>
                    <th style={thStyle}>メール</th>
                    <th style={thStyle}>決済状態</th>
                    <th style={thStyle}>Stripe</th>
                    <th style={thStyle}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sellers.map((seller) => {
                    const isInitializing = submittingVendorId === seller.vendorId;

                    return (
                      <tr key={seller.vendorId}>
                        <td style={tdStyle}>{seller.vendorStoreName}</td>
                        <td style={tdStyle}>{seller.vendorHandle}</td>
                        <td style={tdStyle}>{seller.managementEmail}</td>
                        <td style={tdStyle}>
                          {seller.sellerId ? (
                            <span className={badgeClassName(seller.sellerStatus)}>
                              {seller.sellerStatusLabel}
                            </span>
                          ) : (
                            <span className={badgeClassName("pending")}>未作成</span>
                          )}
                        </td>
                        <td style={tdStyle}>
                          {seller.stripeAccount?.stripeAccountId || "-"}
                        </td>
                        <td style={tdStyle}>
                          {seller.sellerId ? (
                            <Link
                              className="seller-admin__button seller-admin__button--secondary"
                              to={`/app/sellers/${seller.sellerId}`}
                            >
                              詳細
                            </Link>
                          ) : (
                            <Form method="post">
                              <input type="hidden" name="intent" value="initialize_seller" />
                              <input type="hidden" name="vendorId" value={seller.vendorId} />
                              <button
                                type="submit"
                                className="seller-admin__button"
                                disabled={isInitializing}
                              >
                                {isInitializing ? "作成中..." : "決済レコード作成"}
                              </button>
                            </Form>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const thStyle = {
  textAlign: "left",
  padding: "12px",
  borderBottom: "1px solid #e5e7eb",
  color: "#6b7280",
  whiteSpace: "nowrap",
};

const tdStyle = {
  padding: "14px 12px",
  borderBottom: "1px solid #f1f5f9",
  verticalAlign: "top",
  whiteSpace: "nowrap",
};

import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import VendorManagementShell from "../components/vendor/VendorManagementShell";

function createOrdersPageContent(accessState, orderCount) {
  switch (accessState.status) {
    case "ready":
      if (orderCount > 0) {
        return {
          tone: "success",
          title: "注文があります",
          message: "お客様から入った注文を新しい順に表示しています。",
        };
      }

      return {
        tone: "success",
        title: "まだ注文はありません",
        message: "注文が入ると、このページに注文番号・金額・配送状態が表示されます。",
      };
    case "missing_scope":
      return {
        tone: "warning",
        title: "注文管理を準備中です",
        message: "注文一覧を表示するための設定を運営側で確認しています。準備が完了すると、ここに注文が表示されます。",
      };
    case "missing_shop":
      return {
        tone: "warning",
        title: "注文管理を準備中です",
        message: "この店舗の注文を表示するための接続情報を運営側で確認しています。",
      };
    case "ambiguous_shop":
      return {
        tone: "danger",
        title: "注文管理を確認中です",
        message: "注文を正しく表示するため、運営側で店舗情報を確認しています。完了までしばらくお待ちください。",
      };
    case "missing_connection":
      return {
        tone: "danger",
        title: "注文管理を確認中です",
        message: "注文一覧を表示するための接続状態を運営側で確認しています。完了までしばらくお待ちください。",
      };
    default:
      return {
        tone: "danger",
        title: "注文一覧の取得に失敗しました",
        message:
          "時間をおいて再度お試しください。解消しない場合はサポートに連絡してください。",
      };
  }
}

function noticeClassName(tone) {
  if (tone === "danger") {
    return "vendor-note vendor-note--danger";
  }

  if (tone === "success") {
    return "vendor-orders__notice vendor-orders__notice--success";
  }

  return "vendor-orders__notice vendor-orders__notice--warning";
}

function badgeClassName(tone = "neutral") {
  return `vendor-shell__badge vendor-shell__badge--${tone}`;
}

export const loader = async ({ request }) => {
  const {
    getVendorOrdersPageData,
    getVendorPublicContext,
    requireVendorContext,
  } = await import("../services/vendorManagement.server");
  const { vendor, store } = await requireVendorContext(request);
  const { accessState, orders } = await getVendorOrdersPageData({
    storeId: store.id,
    vendorHandle: vendor.handle,
  });

  return json({
    ...getVendorPublicContext(vendor, store),
    ordersAccess: {
      status: accessState.status,
    },
    orders,
  });
};

export default function VendorOrdersPage() {
  const { store, ordersAccess, orders } = useLoaderData();
  const pageContent = createOrdersPageContent(ordersAccess, orders.length);
  const isReady = ordersAccess.status === "ready";

  return (
    <VendorManagementShell
      activeItem="orders"
      storeName={store.storeName}
      title="注文管理"
    >
      <style>{`
        .vendor-orders__notice{
          border:1px solid #fcd34d;
          background:#fffbeb;
          color:#92400e;
          border-radius:12px;
          padding:14px 16px;
          font-size:14px;
          line-height:1.7;
        }
        .vendor-orders__notice--success{
          border-color:#a7f3d0;
          background:#ecfdf5;
          color:#047857;
        }
        .vendor-orders__empty{
          margin-top:18px;
        }
      `}</style>

      <section className="vendor-card">
        <h2 className="vendor-section-title">注文管理</h2>
        <p className="vendor-section-subtitle">
          お客様から入った注文をここで確認できます。注文が入ると、新しいものから順に表示されます。
        </p>

        <div className={noticeClassName(pageContent.tone)}>
          <strong style={{ display: "block", marginBottom: "6px" }}>
            {pageContent.title}
          </strong>
          <div>{pageContent.message}</div>
        </div>

        <div className="vendor-description-list" style={{ marginTop: "18px" }}>
          <div className="vendor-description-row">
            <div className="vendor-description-term">表示件数</div>
            <div className="vendor-description-value">{orders.length}</div>
          </div>
        </div>
      </section>

      <section className="vendor-card">
        <h2 className="vendor-section-title">注文一覧</h2>
        <p className="vendor-section-subtitle">
          注文番号、購入者、金額、支払い状態、配送状態を確認できます。
        </p>

        {!isReady ? (
          <div className="vendor-placeholder vendor-orders__empty">
            注文一覧を表示する準備を進めています。準備が完了すると、ここに注文が表示されます。
          </div>
        ) : orders.length === 0 ? (
          <div className="vendor-placeholder vendor-orders__empty">
            まだ注文はありません。注文が入ると、ここに表示されます。
          </div>
        ) : (
          <div className="vendor-table-wrap">
            <table className="vendor-table">
              <thead>
                <tr>
                  <th>注文日</th>
                  <th>注文番号</th>
                  <th>顧客名</th>
                  <th>メール</th>
                  <th>合計金額</th>
                  <th>支払い状態</th>
                  <th>配送状態</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td>{order.createdAtLabel}</td>
                    <td className="vendor-table__name">{order.shopifyOrderNumber}</td>
                    <td>{order.customerName}</td>
                    <td>{order.email}</td>
                    <td>{order.totalLabel}</td>
                    <td>
                      <span className={badgeClassName(order.financialStatusTone)}>
                        {order.financialStatusLabel}
                      </span>
                    </td>
                    <td>
                      <span className={badgeClassName(order.fulfillmentStatusTone)}>
                        {order.fulfillmentStatusLabel}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </VendorManagementShell>
  );
}

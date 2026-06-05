import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import VendorManagementShell from "../components/vendor/VendorManagementShell";

function createOrdersPageContent(accessState, orderCount) {
  switch (accessState.status) {
    case "ready":
      if (orderCount > 0) {
        return {
          tone: "success",
          title: "注文一覧を表示しています",
          message:
            "注文参照権限があるため、完了済みの注文データを参照して表示しています。",
        };
      }

      return {
        tone: "success",
        title: "注文一覧の準備ができています",
        message:
          "read_draft_orders 権限は確認済みです。現在の条件に一致する completed Draft Order はまだありません。",
      };
    case "missing_scope":
      return {
        tone: "warning",
        title: "注文管理を有効化するには追加権限が必要です",
        message:
          "この店舗では注文参照権限がまだ付与されていないため、注文一覧は表示していません。ストア管理者による追加権限の承認後に、注文一覧を有効化します。",
      };
    case "missing_shop":
      return {
        tone: "warning",
        title: "公開ストアの店舗情報がまだ見つかりません",
        message:
          "注文一覧の準備状況を確認するには、現在の店舗に紐づく公開ストア識別子を一意に特定する必要があります。まずは商品連携を確認してください。",
      };
    case "ambiguous_shop":
      return {
        tone: "danger",
        title: "複数の公開ストア候補が見つかっています",
        message:
          "この店舗には複数の接続情報が関連付いているため、安全に注文一覧を表示できません。サポート側で連携状態を確認してください。",
      };
    case "missing_connection":
      return {
        tone: "danger",
        title: "公開ストアとの接続確認が必要です",
        message:
          "公開ストアの認証状態を確認できませんでした。管理画面でアプリの連携状態を確認してください。",
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
    READ_DRAFT_ORDERS_SCOPE,
    VENDOR_DRAFT_ORDERS_PAGE_SIZE,
    getVendorOrdersPageData,
    getVendorPublicContext,
    requireVendorContext,
  } = await import("../services/vendorManagement.server");
  const { vendor, store } = await requireVendorContext(request);
  const { accessState, orders, queryString, pageSize } = await getVendorOrdersPageData({
    storeId: store.id,
    vendorHandle: vendor.handle,
  });

  return json({
    ...getVendorPublicContext(vendor, store),
    ordersAccess: {
      ...accessState,
      requiredScope: READ_DRAFT_ORDERS_SCOPE,
      queryString,
      pageSize: pageSize || VENDOR_DRAFT_ORDERS_PAGE_SIZE,
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
        .vendor-orders__query{
          display:block;
          margin-top:4px;
          font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size:12px;
          color:#4b5563;
          word-break:break-word;
        }
        .vendor-orders__order-id{
          display:grid;
          gap:4px;
        }
        .vendor-orders__empty{
          margin-top:18px;
        }
      `}</style>

      <section className="vendor-card">
        <h2 className="vendor-section-title">注文管理</h2>
        <p className="vendor-section-subtitle">
          vendor portal では、自分の vendor handle に紐づく completed Draft Order から
          注文データを read-only で参照します。表示対象は直近 {ordersAccess.pageSize} 件までで、条件に使うのは
          `tag:vendor-storefront`、`tag:vendor:&lt;handle&gt;`、`status:completed`
          です。
        </p>

        <div className={noticeClassName(pageContent.tone)}>
          <strong style={{ display: "block", marginBottom: "6px" }}>
            {pageContent.title}
          </strong>
          <div>{pageContent.message}</div>
        </div>

        <div className="vendor-description-list" style={{ marginTop: "18px" }}>
          <div className="vendor-description-row">
            <div className="vendor-description-term">必要な追加権限</div>
            <div className="vendor-description-value">{ordersAccess.requiredScope}</div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">現在の状態</div>
            <div className="vendor-description-value">{ordersAccess.status}</div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">公開ストア識別子</div>
            <div className="vendor-description-value">
              {ordersAccess.shopDomain ? "設定済み" : "-"}
            </div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">取得条件</div>
            <div className="vendor-description-value">
              {ordersAccess.queryString || "-"}
            </div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">表示件数</div>
            <div className="vendor-description-value">{orders.length}</div>
          </div>
        </div>

        <div className="vendor-actions-row" style={{ marginTop: "16px" }}>
          <Link className="vendor-shell__button" to="/vendor/settings">
            注文管理の設定を確認する
          </Link>
        </div>
      </section>

      <section className="vendor-card">
        <h2 className="vendor-section-title">注文一覧</h2>
        <p className="vendor-section-subtitle">
          表示するのは DraftOrder.order から取り出した read-only 情報だけです。vendor 側で
          注文データを編集したり、ローカル DB に保存したりはまだ行いません。直近
          {ordersAccess.pageSize} 件までを新しい順に表示します。
        </p>

        {!isReady ? (
          <div className="vendor-placeholder vendor-orders__empty">
            追加権限と公開ストア連携がそろった店舗だけ、ここに注文一覧を表示します。
          </div>
        ) : orders.length === 0 ? (
          <div className="vendor-placeholder vendor-orders__empty">
            条件に一致する注文はまだありません。
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
                  <th>注文ID / 注文名</th>
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
                    <td>
                      <div className="vendor-orders__order-id">
                        <span className="vendor-table__name">{order.orderName}</span>
                        <span className="vendor-table__meta">
                          {order.publicOrderIdLabel || "-"}
                        </span>
                      </div>
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

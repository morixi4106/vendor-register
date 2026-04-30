import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import VendorManagementShell from "../components/vendor/VendorManagementShell";

function createOrdersPageContent(accessState) {
  switch (accessState.status) {
    case "ready":
      return {
        tone: "success",
        title: "追加権限を確認できました",
        message:
          "read_draft_orders 権限は確認済みです。Phase 7.1 で draftOrders を参照する read-only 注文一覧を表示します。",
      };
    case "missing_scope":
      return {
        tone: "warning",
        title: "注文管理を有効化するには追加権限が必要です",
        message:
          "この店舗では read_draft_orders がまだ付与されていないため、注文一覧は表示していません。Shopify 管理者による追加権限の承認後に、draftOrders ベースの注文一覧を有効化します。",
      };
    case "missing_shop":
      return {
        tone: "warning",
        title: "Shopify 連携済みの商品がまだ見つかりません",
        message:
          "注文一覧の準備状況を確認するには、現在の店舗に紐づく Shopify shopDomain を一意に特定する必要があります。まずは商品連携を確認してください。",
      };
    case "ambiguous_shop":
      return {
        tone: "danger",
        title: "複数の Shopify 店舗が紐づいています",
        message:
          "この vendorStore には複数の shopDomain が関連付いているため、安全に注文一覧を表示できません。サポート側で連携状態を確認してください。",
      };
    case "missing_connection":
      return {
        tone: "danger",
        title: "Shopify との接続確認が必要です",
        message:
          "Shopify の offline session もしくは認証状態を確認できませんでした。Shopify 管理画面でアプリの接続状態を確認してください。",
      };
    default:
      return {
        tone: "danger",
        title: "注文一覧の準備状況を確認できませんでした",
        message:
          "時間をおいて再度お試しください。問題が続く場合はサポートに連絡してください。",
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

export const loader = async ({ request }) => {
  const {
    READ_DRAFT_ORDERS_SCOPE,
    getVendorOrdersAccessState,
    getVendorPublicContext,
    requireVendorContext,
  } = await import("../services/vendorManagement.server");
  const { vendor, store } = await requireVendorContext(request);
  const accessState = await getVendorOrdersAccessState({ storeId: store.id });

  return json({
    ...getVendorPublicContext(vendor, store),
    ordersAccess: {
      ...accessState,
      requiredScope: READ_DRAFT_ORDERS_SCOPE,
    },
  });
};

export default function VendorOrdersPage() {
  const { store, ordersAccess } = useLoaderData();
  const pageContent = createOrdersPageContent(ordersAccess);

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
      `}</style>

      <section className="vendor-card">
        <h2 className="vendor-section-title">注文管理</h2>
        <p className="vendor-section-subtitle">
          Phase 7 では、Shopify の draftOrders 参照に必要な追加権限があるかを先に確認します。
          read_draft_orders が付与されている店舗だけ、次の Phase 7.1 で read-only
          注文一覧を表示する想定です。
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
            <div className="vendor-description-term">判定結果</div>
            <div className="vendor-description-value">{ordersAccess.status}</div>
          </div>
          <div className="vendor-description-row">
            <div className="vendor-description-term">Shopify shopDomain</div>
            <div className="vendor-description-value">
              {ordersAccess.shopDomain || "-"}
            </div>
          </div>
        </div>

        <div className="vendor-actions-row" style={{ marginTop: "16px" }}>
          <Link className="vendor-shell__button" to="/vendor/settings">
            Shopify 連携設定を確認する
          </Link>
        </div>
      </section>

      <section className="vendor-card">
        <h2 className="vendor-section-title">Phase 7.1 で表示する予定の項目</h2>
        <ul className="vendor-list">
          <li>注文日</li>
          <li>Shopify注文番号</li>
          <li>顧客名</li>
          <li>メール</li>
          <li>合計金額</li>
          <li>支払い状態</li>
          <li>配送状態</li>
          <li>Shopify order id / name</li>
        </ul>
      </section>
    </VendorManagementShell>
  );
}

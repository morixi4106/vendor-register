import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
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

export const action = async ({ request }) => {
  const {
    createVendorOrderFulfillment,
    parseShipmentRegistrationInput,
    requireVendorContext,
  } = await import("../services/vendorManagement.server");
  const { vendor, store } = await requireVendorContext(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent !== "register-shipment") {
    return json(
      {
        shipmentResult: {
          ok: false,
          error: "処理内容が不正です。",
        },
      },
      { status: 400 },
    );
  }

  const shipment = parseShipmentRegistrationInput(formData);

  if (!shipment.ok) {
    return json(
      {
        shipmentResult: {
          ok: false,
          error: shipment.error,
        },
      },
      { status: shipment.status || 400 },
    );
  }

  const result = await createVendorOrderFulfillment({
    storeId: store.id,
    vendorHandle: vendor.handle,
    shipment,
  });

  return json(
    {
      shipmentResult: result.ok
        ? {
            ok: true,
            message: result.message,
          }
        : {
            ok: false,
            error: result.error,
          },
    },
    { status: result.ok ? 200 : result.status || 400 },
  );
};

export default function VendorOrdersPage() {
  const { store, ordersAccess, orders } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const pageContent = createOrdersPageContent(ordersAccess, orders.length);
  const isReady = ordersAccess.status === "ready";
  const isSubmitting = navigation.state !== "idle";

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
        .vendor-orders__action-form{
          display:grid;
          grid-template-columns:minmax(120px, 1fr) minmax(110px, .8fr) auto;
          gap:8px;
          align-items:center;
          min-width:420px;
        }
        .vendor-orders__action-form input{
          width:100%;
          border:1px solid #d1d5db;
          border-radius:10px;
          padding:10px 12px;
          font-size:14px;
          box-sizing:border-box;
          background:#fff;
        }
        .vendor-orders__ship-button{
          border:none;
          border-radius:10px;
          background:#111827;
          color:#fff;
          font-weight:700;
          padding:10px 14px;
          cursor:pointer;
          white-space:nowrap;
        }
        .vendor-orders__ship-button:disabled{
          opacity:.55;
          cursor:not-allowed;
        }
        .vendor-orders__notify{
          grid-column:1 / -1;
          display:flex;
          align-items:center;
          gap:8px;
          color:#4b5563;
          font-size:13px;
        }
        .vendor-orders__notify input{
          width:auto;
        }
        .vendor-orders__muted{
          color:#6b7280;
          font-size:13px;
          line-height:1.6;
        }
        @media (max-width: 900px){
          .vendor-orders__action-form{
            min-width:280px;
            grid-template-columns:1fr;
          }
          .vendor-orders__notify{
            grid-column:auto;
          }
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

        {actionData?.shipmentResult ? (
          <div
            className={
              actionData.shipmentResult.ok
                ? "vendor-orders__notice vendor-orders__notice--success"
                : "vendor-note vendor-note--danger"
            }
            style={{ marginTop: "18px" }}
          >
            {actionData.shipmentResult.ok
              ? actionData.shipmentResult.message
              : actionData.shipmentResult.error}
          </div>
        ) : null}
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
                  <th>配送先</th>
                  <th>合計金額</th>
                  <th>支払い状態</th>
                  <th>配送状態</th>
                  <th>追跡番号</th>
                  <th>発送登録</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td>{order.createdAtLabel}</td>
                    <td className="vendor-table__name">{order.shopifyOrderNumber}</td>
                    <td>{order.customerName}</td>
                    <td>{order.shippingAddressLabel}</td>
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
                      {order.trackingUrl ? (
                        <a href={order.trackingUrl} target="_blank" rel="noreferrer">
                          {order.trackingLabel}
                        </a>
                      ) : (
                        order.trackingLabel
                      )}
                    </td>
                    <td>
                      {order.canRegisterShipment ? (
                        <Form method="post" className="vendor-orders__action-form">
                          <input type="hidden" name="intent" value="register-shipment" />
                          <input type="hidden" name="orderId" value={order.orderId} />
                          <input
                            name="trackingNumber"
                            aria-label={`${order.shopifyOrderNumber}の追跡番号`}
                            placeholder="追跡番号"
                            required
                          />
                          <input
                            name="trackingCompany"
                            aria-label={`${order.shopifyOrderNumber}の配送会社`}
                            placeholder="配送会社"
                            list="vendor-shipping-carriers"
                          />
                          <input
                            name="trackingUrl"
                            aria-label={`${order.shopifyOrderNumber}の追跡URL`}
                            placeholder="追跡URL 任意"
                            type="url"
                            style={{ gridColumn: "1 / -2" }}
                          />
                          <button
                            type="submit"
                            className="vendor-orders__ship-button"
                            disabled={isSubmitting}
                          >
                            発送済みにする
                          </button>
                          <label className="vendor-orders__notify">
                            <input
                              type="checkbox"
                              name="notifyCustomer"
                              defaultChecked
                            />
                            購入者へ通知
                          </label>
                        </Form>
                      ) : (
                        <span className="vendor-orders__muted">
                          {order.fulfillmentStatus === "FULFILLED"
                            ? "発送済み"
                            : "発送登録できません"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <datalist id="vendor-shipping-carriers">
              <option value="日本郵便" />
              <option value="ヤマト運輸" />
              <option value="佐川急便" />
              <option value="EMS" />
              <option value="DHL" />
              <option value="FedEx" />
              <option value="UPS" />
            </datalist>
          </div>
        )}
      </section>
    </VendorManagementShell>
  );
}

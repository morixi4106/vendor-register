import { json } from "@remix-run/node";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";
import { useState } from "react";
import VendorManagementShell from "../components/vendor/VendorManagementShell";
import {
  appendVendorIdToPath,
  useVendorIdFromMatches,
  useVendorScopedPath,
} from "../components/vendor/vendorNavigation";
import { listShippingCarriersForCountry } from "../utils/shippingCarriers";

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
        message:
          "注文が入ると、このページに注文番号・金額・配送状態が表示されます。",
      };
    case "missing_scope":
      return {
        tone: "warning",
        title: "注文管理の準備中です",
        message:
          "注文一覧を表示するための権限を運営側で確認しています。準備が完了すると注文が表示されます。",
      };
    case "missing_shop":
      return {
        tone: "warning",
        title: "注文管理の準備中です",
        message:
          "この店舗の注文を表示するための接続情報を運営側で確認しています。",
      };
    case "ambiguous_shop":
      return {
        tone: "danger",
        title: "注文管理を確認中です",
        message:
          "注文を正しく表示するため、運営側で店舗情報を確認しています。完了までしばらくお待ちください。",
      };
    case "missing_connection":
      return {
        tone: "danger",
        title: "注文管理を確認中です",
        message:
          "注文一覧を表示するための接続状態を運営側で確認しています。完了までしばらくお待ちください。",
      };
    default:
      return {
        tone: "danger",
        title: "注文一覧の取得に失敗しました",
        message:
          "時間を置いて再度お試しください。解消しない場合はサポートに連絡してください。",
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
  const vendorId = useVendorIdFromMatches();
  const ordersActionPath = useVendorScopedPath("/vendor/orders");
  const [selectedAddressOrder, setSelectedAddressOrder] = useState(null);
  const pageContent = createOrdersPageContent(ordersAccess, orders.length);
  const isReady = ordersAccess.status === "ready";
  const isSubmitting = navigation.state !== "idle";

  return (
    <VendorManagementShell
      activeItem="orders"
      storeName={store.storeName}
      title="注文管理"
    >
      <style>{pageStyles}</style>

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
                  <th>撤回申請</th>
                  <th>追跡番号</th>
                  <th>発送登録</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => {
                  const carrierOptions = listShippingCarriersForCountry(
                    order.shippingCountryCode,
                  );

                  return (
                    <tr key={order.id}>
                      <td>{order.createdAtLabel}</td>
                      <td className="vendor-table__name">{order.shopifyOrderNumber}</td>
                      <td>{order.customerName}</td>
                      <td className="vendor-orders__address-cell">
                        <button
                          type="button"
                          className="vendor-orders__address-button"
                          onClick={() => setSelectedAddressOrder(order)}
                        >
                          配送先を見る
                        </button>
                        <div className="vendor-orders__address-summary">
                          {order.shippingAddressSummary}
                        </div>
                      </td>
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
                        <WithdrawalCell
                          order={order}
                          vendorId={vendorId}
                        />
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
                          <ShipmentForm
                            order={order}
                            vendorId={vendorId}
                            actionPath={ordersActionPath}
                            carrierOptions={carrierOptions}
                            isSubmitting={isSubmitting}
                          />
                        ) : (
                          <span className="vendor-orders__muted">
                            {order.fulfillmentStatus === "FULFILLED"
                              ? "発送済み"
                              : "発送登録できません"}
                          </span>
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

      {selectedAddressOrder ? (
        <AddressModal
          order={selectedAddressOrder}
          onClose={() => setSelectedAddressOrder(null)}
        />
      ) : null}
    </VendorManagementShell>
  );
}

function WithdrawalCell({ order, vendorId }) {
  const summary = order.withdrawalSummary || {};
  const latest = summary.latest || order.withdrawals?.[0] || null;

  if (!latest) {
    return <span className="vendor-orders__muted">-</span>;
  }

  const href = appendVendorIdToPath(`/vendor/withdrawals/${latest.id}`, vendorId);

  return (
    <div className="vendor-orders__withdrawal-cell">
      <Link
        className={badgeClassName(latest.needsVendorAction ? "warning" : latest.statusTone)}
        to={href}
      >
        {latest.needsVendorAction ? "要確認" : latest.statusLabel}
      </Link>
      <span className="vendor-orders__withdrawal-meta">
        {summary.openCount > 1
          ? `対応中 ${summary.openCount}件`
          : latest.vendorActionLabel}
      </span>
    </div>
  );
}

function ShipmentForm({
  order,
  vendorId,
  actionPath,
  carrierOptions,
  isSubmitting,
}) {
  return (
    <Form method="post" action={actionPath} className="vendor-orders__action-form">
      <input type="hidden" name="intent" value="register-shipment" />
      {vendorId ? <input type="hidden" name="vendorId" value={vendorId} /> : null}
      <input type="hidden" name="orderId" value={order.orderId} />
      {order.sellerOrderId ? (
        <input type="hidden" name="sellerOrderId" value={order.sellerOrderId} />
      ) : null}
      <input
        name="trackingNumber"
        aria-label={`${order.shopifyOrderNumber}の追跡番号`}
        placeholder="追跡番号"
        required
      />
      <select
        name="trackingCarrierId"
        aria-label={`${order.shopifyOrderNumber}の配送会社`}
        required
        defaultValue=""
      >
        <option value="" disabled>
          配送会社
        </option>
        {carrierOptions.map((carrier) => (
          <option key={carrier.id} value={carrier.id}>
            {carrier.label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="vendor-orders__ship-button"
        disabled={isSubmitting}
      >
        発送済みにする
      </button>
      <div className="vendor-orders__tracking-hint">
        追跡URLは配送会社と追跡番号から自動で設定されます。
      </div>
      <label className="vendor-orders__notify">
        <input type="checkbox" name="notifyCustomer" defaultChecked />
        購入者へ通知
      </label>
    </Form>
  );
}

function AddressModal({ order, onClose }) {
  const addressLines = order.shippingAddressLines?.length
    ? order.shippingAddressLines
    : ["未設定"];

  return (
    <div className="vendor-orders__modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="vendor-orders__modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vendor-orders-address-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="vendor-orders__modal-header">
          <div>
            <div className="vendor-orders__modal-eyebrow">{order.shopifyOrderNumber}</div>
            <h3 id="vendor-orders-address-title">配送先</h3>
          </div>
          <button
            type="button"
            className="vendor-orders__modal-close"
            aria-label="閉じる"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="vendor-orders__modal-print-title">配送用の表記</div>
        <div className="vendor-orders__modal-lines">
          {addressLines.map((line, index) => (
            <div key={`${line}-${index}`}>{line}</div>
          ))}
        </div>
        {order.shippingAddressRows?.length ? (
          <div className="vendor-orders__modal-details">
            {order.shippingAddressRows.map((row) => (
              <div className="vendor-orders__modal-detail-row" key={row.label}>
                <div className="vendor-orders__modal-detail-label">{row.label}</div>
                <div className="vendor-orders__modal-detail-value">{row.value}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const pageStyles = `
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
  .vendor-orders__action-form input,
  .vendor-orders__action-form select{
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
  .vendor-orders__withdrawal-cell{
    display:grid;
    gap:6px;
    min-width:120px;
  }
  .vendor-orders__withdrawal-cell a{
    width:max-content;
    text-decoration:none;
  }
  .vendor-orders__withdrawal-meta{
    color:#6b7280;
    font-size:12px;
    line-height:1.5;
  }
  .vendor-orders__tracking-hint{
    grid-column:1 / -1;
    color:#6b7280;
    font-size:12px;
    line-height:1.5;
  }
  .vendor-orders__address-cell{
    min-width:128px;
  }
  .vendor-orders__address-button{
    border:1px solid #d1d5db;
    border-radius:999px;
    background:#fff;
    color:#111827;
    font-weight:700;
    padding:7px 12px;
    cursor:pointer;
    white-space:nowrap;
  }
  .vendor-orders__address-button:hover{
    border-color:#9ca3af;
    background:#f9fafb;
  }
  .vendor-orders__address-summary{
    margin-top:6px;
    color:#6b7280;
    font-size:12px;
    white-space:nowrap;
  }
  .vendor-orders__modal-backdrop{
    position:fixed;
    inset:0;
    z-index:50;
    display:flex;
    align-items:center;
    justify-content:center;
    padding:24px;
    background:rgba(17, 24, 39, .42);
  }
  .vendor-orders__modal{
    width:min(520px, 100%);
    border-radius:18px;
    background:#fff;
    box-shadow:0 24px 60px rgba(15, 23, 42, .24);
    padding:24px;
  }
  .vendor-orders__modal-header{
    display:flex;
    align-items:flex-start;
    justify-content:space-between;
    gap:16px;
    margin-bottom:18px;
  }
  .vendor-orders__modal-eyebrow{
    color:#6b7280;
    font-size:13px;
    font-weight:700;
  }
  .vendor-orders__modal h3{
    margin:4px 0 0;
    font-size:24px;
    line-height:1.25;
  }
  .vendor-orders__modal-close{
    width:40px;
    height:40px;
    border:1px solid #d1d5db;
    border-radius:12px;
    background:#fff;
    color:#111827;
    font-size:24px;
    font-weight:700;
    line-height:1;
    cursor:pointer;
  }
  .vendor-orders__modal-print-title{
    margin:0 0 8px;
    color:#4b5563;
    font-size:13px;
    font-weight:700;
  }
  .vendor-orders__modal-lines{
    display:grid;
    gap:8px;
    border:1px solid #e5e7eb;
    border-radius:14px;
    padding:16px;
    color:#111827;
    font-size:16px;
    line-height:1.6;
  }
  .vendor-orders__modal-details{
    display:grid;
    gap:0;
    margin-top:16px;
    border:1px solid #e5e7eb;
    border-radius:14px;
    overflow:hidden;
  }
  .vendor-orders__modal-detail-row{
    display:grid;
    grid-template-columns:120px minmax(0, 1fr);
    gap:12px;
    padding:11px 14px;
    border-top:1px solid #e5e7eb;
    line-height:1.5;
  }
  .vendor-orders__modal-detail-row:first-child{
    border-top:none;
  }
  .vendor-orders__modal-detail-label{
    color:#6b7280;
    font-size:13px;
    font-weight:700;
  }
  .vendor-orders__modal-detail-value{
    color:#111827;
    overflow-wrap:anywhere;
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
`;

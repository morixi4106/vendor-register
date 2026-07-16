import { json } from "@remix-run/node";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";
import VendorManagementShell from "../components/vendor/VendorManagementShell";
import {
  appendVendorIdToPath,
  useVendorIdFromMatches,
  useVendorScopedPath,
} from "../components/vendor/vendorNavigation";

const EVIDENCE_OPTIONS = [
  ["NOT_SUBMITTED", "未提出"],
  ["SUBMITTED", "提出済み"],
  ["ACCEPTED", "確認済み"],
  ["REJECTED", "要再提出"],
];
const RECEIPT_OPTIONS = [
  ["NOT_RECEIVED", "未到着"],
  ["PARTIALLY_RECEIVED", "一部到着"],
  ["RECEIVED", "到着済み"],
];
const INSPECTION_OPTIONS = [
  ["NOT_INSPECTED", "未検品"],
  ["IN_PROGRESS", "検品中"],
  ["INSPECTED", "検品済み"],
  ["VALUE_REDUCTION_REVIEW", "減額確認が必要"],
];
const CONDITION_OPTIONS = [
  ["UNDECIDED", "未確認"],
  ["UNUSED_OK", "未使用・問題なし"],
  ["OPENED_OK", "開封・確認範囲内"],
  ["USED_REVIEW", "使用感あり"],
  ["DIRTY_REVIEW", "汚れあり"],
  ["DAMAGED_REVIEW", "破損あり"],
  ["EXEMPT_REVIEW", "撤回対象外の可能性"],
];

export const loader = async ({ request, params }) => {
  const {
    getVendorPublicContext,
    getVendorWithdrawalRequestDetail,
    requireVendorContext,
  } = await import("../services/vendorManagement.server");
  const { vendor, store } = await requireVendorContext(request);
  const detail = await getVendorWithdrawalRequestDetail({
    storeId: store.id,
    withdrawalRequestId: params.id,
  });
  if (!detail) throw new Response("Not Found", { status: 404 });

  return json({
    ...getVendorPublicContext(vendor, store),
    ...detail,
  });
};

export const action = async ({ request, params }) => {
  const { requireVendorContext, updateVendorWithdrawalReturnInfo } = await import(
    "../services/vendorManagement.server"
  );
  const { store } = await requireVendorContext(request);
  const formData = await request.formData();
  if (String(formData.get("intent") || "") !== "update-return-info") {
    return json({ ok: false, message: "操作内容が正しくありません。" }, { status: 400 });
  }
  const result = await updateVendorWithdrawalReturnInfo({
    storeId: store.id,
    withdrawalRequestId: params.id,
    formData,
  });
  return json(
    { ok: result.ok, message: result.ok ? result.message : result.error },
    { status: result.ok ? 200 : result.status || 400 },
  );
};

export default function VendorWithdrawalDetailPage() {
  const { store, withdrawalRequest, returnGroup, sellerOrders = [] } =
    useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const vendorId = useVendorIdFromMatches();
  const actionPath = appendVendorIdToPath(
    `/vendor/withdrawals/${withdrawalRequest.id}`,
    vendorId,
  );

  return (
    <VendorManagementShell
      activeItem="withdrawals"
      storeName={store.storeName}
      title="撤回・返品対応"
      actions={
        <Link className="vendor-shell__button" to={useVendorScopedPath("/vendor/withdrawals")}>
          一覧へ戻る
        </Link>
      }
    >
      <style>{pageStyles}</style>
      <section className="vendor-card detail-header">
        <div>
          <p className="eyebrow">{withdrawalRequest.shopifyOrderName}</p>
          <h2 className="vendor-section-title">返送内容の確認</h2>
          <p className="vendor-section-subtitle">
            到着した商品と状態を記録してください。返金額と最終判断は運営が行います。
          </p>
        </div>
        <span
          className={`vendor-shell__badge vendor-shell__badge--${
            returnGroup?.statusTone || withdrawalRequest.statusTone
          }`}
        >
          {returnGroup?.statusLabel || withdrawalRequest.statusLabel}
        </span>
      </section>

      {actionData?.message ? (
        <section className={`notice ${actionData.ok ? "success" : "error"}`}>
          {actionData.message}
        </section>
      ) : null}

      {Number(withdrawalRequest.workflowVersion) === 2 && returnGroup ? (
        <V2Detail
          group={returnGroup}
          actionPath={actionPath}
          submitting={navigation.state !== "idle"}
        />
      ) : (
        <LegacyDetail
          request={withdrawalRequest}
          sellerOrders={sellerOrders}
          actionPath={actionPath}
          submitting={navigation.state !== "idle"}
        />
      )}
    </VendorManagementShell>
  );
}

function V2Detail({ group, actionPath, submitting }) {
  return (
    <>
      <section className="vendor-card">
        <h2 className="vendor-section-title">返送荷物</h2>
        {(group.shipments || []).length === 0 ? (
          <div className="vendor-placeholder">返送証明はまだ提出されていません。</div>
        ) : (
          <div className="shipment-list">
            {group.shipments.map((shipment) => (
              <div key={shipment.id}>
                <strong>荷物 {shipment.packageNumber}</strong>
                <span>{shipment.trackingCompany || "配送会社未入力"}</span>
                <span>{shipment.trackingNumber || shipment.trackingUrl || "追跡情報なし"}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="vendor-card">
        <h2 className="vendor-section-title">到着・検品の記録</h2>
        <Form method="post" action={actionPath} className="review-form">
          <input type="hidden" name="intent" value="update-return-info" />
          <div className="status-grid">
            <SelectField name="evidenceStatus" label="返送証明" value={group.evidenceStatus} options={EVIDENCE_OPTIONS} />
            <SelectField name="receiptStatus" label="到着状況" value={group.receiptStatus} options={RECEIPT_OPTIONS} />
            <SelectField name="inspectionStatus" label="検品状況" value={group.inspectionStatus} options={INSPECTION_OPTIONS} />
          </div>

          <div className="vendor-table-wrap">
            <table className="vendor-table">
              <thead>
                <tr><th>商品</th><th>案内数</th><th>到着数</th><th>状態</th><th>メモ</th></tr>
              </thead>
              <tbody>
                {group.lines.map((line) => (
                  <tr key={line.id}>
                    <td className="vendor-table__name">{line.title}</td>
                    <td>{line.instructedQuantity}</td>
                    <td>
                      <input
                        className="quantity-input"
                        type="number"
                        min="0"
                        max={line.instructedQuantity}
                        name={`receivedQuantity_${line.id}`}
                        defaultValue={line.receivedQuantity}
                      />
                    </td>
                    <td>
                      <select name={`conditionStatus_${line.id}`} defaultValue={line.conditionStatus}>
                        {CONDITION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </td>
                    <td>
                      <input name={`conditionNotes_${line.id}`} defaultValue={line.conditionNotes} placeholder="状態を記録" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="field">
            <span>店舗メモ</span>
            <textarea name="reviewNotes" rows="4" placeholder="運営へ共有する内容" />
          </label>
          <button className="vendor-shell__button vendor-shell__button--primary" disabled={submitting}>
            到着・検品情報を保存
          </button>
        </Form>
      </section>
    </>
  );
}

function LegacyDetail({ request, sellerOrders, actionPath, submitting }) {
  return (
    <>
      <section className="vendor-card">
        <h2 className="vendor-section-title">返送情報</h2>
        <Form method="post" action={actionPath} className="review-form">
          <input type="hidden" name="intent" value="update-return-info" />
          <div className="status-grid">
            <label className="field"><span>追跡番号</span><input name="returnTrackingNumber" defaultValue={request.returnTrackingNumber} /></label>
            <label className="field"><span>配送会社</span><input name="returnTrackingCompany" defaultValue={request.returnTrackingCompany} /></label>
            <label className="field"><span>到着日</span><input type="date" name="returnReceivedAt" defaultValue={formatDateInput(request.returnReceivedAt)} /></label>
          </div>
          <label className="field"><span>商品状態</span><textarea name="returnConditionNotes" rows="4" defaultValue={request.returnConditionNotes} /></label>
          <button className="vendor-shell__button vendor-shell__button--primary" disabled={submitting}>返送情報を保存</button>
        </Form>
      </section>
      <section className="vendor-card">
        <h2 className="vendor-section-title">対象商品</h2>
        <ul>{sellerOrders.flatMap((order) => order.lines || []).map((line) => <li key={line.id}>{line.title} × {line.quantity}</li>)}</ul>
      </section>
    </>
  );
}

function SelectField({ name, label, value, options }) {
  return <label className="field"><span>{label}</span><select name={name} defaultValue={value}>{options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>;
}

function formatDateInput(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

const pageStyles = `
  .detail-header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;}
  .eyebrow{margin:0 0 6px;color:#6b7280;font-size:13px;font-weight:800;}
  .notice{border:1px solid;padding:14px 16px;border-radius:8px;font-weight:700;}
  .notice.success{border-color:#a7f3d0;background:#ecfdf5;color:#047857;}
  .notice.error{border-color:#fecaca;background:#fef2f2;color:#b91c1c;}
  .shipment-list{display:grid;gap:10px;}
  .shipment-list>div{display:grid;grid-template-columns:120px 180px minmax(0,1fr);gap:12px;padding:12px 0;border-bottom:1px solid #e5e7eb;}
  .review-form{display:grid;gap:18px;}
  .status-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;}
  .field{display:grid;gap:6px;font-size:13px;font-weight:800;color:#374151;}
  .field input,.field select,.field textarea,.vendor-table input,.vendor-table select{width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:8px;padding:10px 12px;background:#fff;}
  .quantity-input{min-width:84px;}
  @media(max-width:800px){.status-grid{grid-template-columns:1fr}.shipment-list>div{grid-template-columns:1fr}.detail-header{display:grid}}
`;

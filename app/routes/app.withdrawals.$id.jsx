import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";

import prisma from "../db.server.js";
import { authenticate } from "../shopify.server";
import {
  sendWithdrawalAcknowledgementEmail,
  sendWithdrawalStatusEmail,
  updateWithdrawalStatus,
} from "../services/withdrawals.server.js";
import {
  WITHDRAWAL_STATUSES,
  getWithdrawalEligibilityLabel,
  getWithdrawalEligibilityTone,
  getWithdrawalStatusLabel,
  getWithdrawalStatusTone,
} from "../utils/withdrawalStatus.js";

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);

  const withdrawalRequest = await prisma.withdrawalRequest.findUnique({
    where: { id: params.id },
    include: {
      statusHistory: { orderBy: { createdAt: "desc" } },
      emailLogs: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!withdrawalRequest) {
    throw new Response("Not Found", { status: 404 });
  }

  return json({
    withdrawalRequest: serializeWithdrawalRequest(withdrawalRequest),
    shopifyWriteActionsEnabled:
      String(process.env.WITHDRAWAL_ENABLE_SHOPIFY_WRITE_ACTIONS || "")
        .toLowerCase()
        .trim() === "true",
  });
};

export const action = async ({ request, params }) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "resend_acknowledgement") {
    const result = await sendWithdrawalAcknowledgementEmail({
      withdrawalRequestId: params.id,
    });

    return json({
      ok: result.ok,
      message: result.ok
        ? "受付確認メールを送信しました。"
        : `受付確認メールを送信できませんでした: ${result.error || "unknown"}`,
    });
  }

  if (intent === "send_status_email") {
    const result = await sendWithdrawalStatusEmail({
      withdrawalRequestId: params.id,
    });

    return json({
      ok: result.ok,
      message: result.ok
        ? "ステータス通知メールを送信しました。"
        : `ステータス通知メールを送信できませんでした: ${result.error || "unknown"}`,
    });
  }

  if (intent === "add_admin_note") {
    const adminNotes = String(formData.get("adminNotes") || "").trim();
    await prisma.withdrawalRequest.update({
      where: { id: params.id },
      data: { adminNotes },
    });

    return redirect(`/app/withdrawals/${params.id}`);
  }

  if (intent === "update_status") {
    const toStatus = String(formData.get("toStatus") || "");
    const reason = String(formData.get("reason") || "").trim() || null;
    const rejectionReason =
      String(formData.get("rejectionReason") || "").trim() || null;

    const result = await updateWithdrawalStatus({
      id: params.id,
      toStatus,
      changedBy: "admin",
      reason,
      rejectionReason,
      metadataJson: {
        source: "admin_detail",
      },
    });

    return json({
      ok: result.ok,
      message: result.ok
        ? "ステータスを更新しました。"
        : `ステータスを更新できませんでした: ${result.error || "unknown"}`,
    });
  }

  if (intent === "execute_shopify_cancel" || intent === "execute_shopify_refund") {
    if (
      String(process.env.WITHDRAWAL_ENABLE_SHOPIFY_WRITE_ACTIONS || "")
        .toLowerCase()
        .trim() !== "true"
    ) {
      return json({
        ok: false,
        message:
          "Shopify書き込み処理は無効です。必要な確認後に WITHDRAWAL_ENABLE_SHOPIFY_WRITE_ACTIONS=true を設定してください。",
      });
    }

    return json({
      ok: false,
      message:
        "Shopifyキャンセル/返金の自動実行口は保護中です。まずは手動処理後にステータスを更新してください。",
    });
  }

  return json({ ok: false, message: "不明な操作です。" }, { status: 400 });
};

export default function WithdrawalDetailPage() {
  const { withdrawalRequest, shopifyWriteActionsEnabled } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  return (
    <main className="withdrawal-detail">
      <style>{detailStyles}</style>
      <section className="withdrawal-detail__card withdrawal-detail__header">
        <div>
          <Link to="/app/withdrawals" className="withdrawal-detail__back">
            一覧へ戻る
          </Link>
          <h1>{withdrawalRequest.shopifyOrderName || withdrawalRequest.id}</h1>
          <p>
            {withdrawalRequest.customerName} / {withdrawalRequest.customerEmail}
          </p>
          <div className="withdrawal-detail__badges">
            <Badge tone={withdrawalRequest.statusTone}>
              {withdrawalRequest.statusLabel}
            </Badge>
            <Badge tone={withdrawalRequest.eligibilityTone}>
              {withdrawalRequest.eligibilityLabel}
            </Badge>
          </div>
        </div>
      </section>

      {actionData?.message ? (
        <div
          className={`withdrawal-detail__notice ${
            actionData.ok ? "withdrawal-detail__notice--ok" : "withdrawal-detail__notice--error"
          }`}
        >
          {actionData.message}
        </div>
      ) : null}

      <section className="withdrawal-detail__grid">
        <div className="withdrawal-detail__card">
          <h2>申請内容</h2>
          <DescriptionList
            rows={[
              ["受付番号", withdrawalRequest.id],
              ["注文番号", withdrawalRequest.shopifyOrderName || "-"],
              ["注文ID", withdrawalRequest.shopifyOrderId || "-"],
              ["氏名", withdrawalRequest.customerName],
              ["メール", withdrawalRequest.customerEmail],
              ["電話", withdrawalRequest.customerPhone || "-"],
              ["国", withdrawalRequest.countryLabel || withdrawalRequest.countryCode || "-"],
              ["受領日", withdrawalRequest.receivedDateLabel],
              ["期限", withdrawalRequest.deadlineAtLabel],
              [
                "撤回対象",
                withdrawalRequest.withdrawalScope === "PARTIAL"
                  ? "一部の商品"
                  : "注文全体",
              ],
              ["商品状態", withdrawalRequest.itemCondition || "-"],
              ["理由", withdrawalRequest.reason || "-"],
            ]}
          />
        </div>

        <div className="withdrawal-detail__card">
          <h2>管理操作</h2>
          <Form method="post" className="withdrawal-detail__form">
            <input type="hidden" name="intent" value="update_status" />
            <label>
              <span>次の状態</span>
              <select name="toStatus" defaultValue={withdrawalRequest.status}>
                {Object.values(WITHDRAWAL_STATUSES).map((status) => (
                  <option key={status} value={status}>
                    {getWithdrawalStatusLabel(status)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>理由 / メモ</span>
              <textarea name="reason" rows="3" />
            </label>
            <label>
              <span>却下理由 任意</span>
              <textarea name="rejectionReason" rows="2" />
            </label>
            <button type="submit" disabled={isSubmitting}>
              ステータスを更新
            </button>
          </Form>

          <div className="withdrawal-detail__button-row">
            <Form method="post">
              <input type="hidden" name="intent" value="resend_acknowledgement" />
              <button type="submit" disabled={isSubmitting}>
                受付メール再送
              </button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="send_status_email" />
              <button type="submit" disabled={isSubmitting}>
                状況メール送信
              </button>
            </Form>
          </div>

          <div className="withdrawal-detail__guard">
            <strong>Shopify自動処理</strong>
            <p>
              {shopifyWriteActionsEnabled
                ? "書き込みフラグはONですが、自動キャンセル/返金はまだ保護中です。"
                : "書き込みフラグがOFFのため、Shopifyキャンセル/返金mutationは呼びません。"}
            </p>
            <div className="withdrawal-detail__button-row">
              <Form method="post">
                <input type="hidden" name="intent" value="execute_shopify_cancel" />
                <button type="submit" disabled={isSubmitting}>
                  キャンセル実行口
                </button>
              </Form>
              <Form method="post">
                <input type="hidden" name="intent" value="execute_shopify_refund" />
                <button type="submit" disabled={isSubmitting}>
                  返金実行口
                </button>
              </Form>
            </div>
          </div>
        </div>
      </section>

      <section className="withdrawal-detail__grid">
        <div className="withdrawal-detail__card">
          <h2>対象商品</h2>
          <pre className="withdrawal-detail__pre">
            {JSON.stringify(withdrawalRequest.selectedLineItemsJson, null, 2)}
          </pre>
        </div>
        <div className="withdrawal-detail__card">
          <h2>判定情報</h2>
          <pre className="withdrawal-detail__pre">
            {JSON.stringify(withdrawalRequest.eligibilityJson, null, 2)}
          </pre>
        </div>
      </section>

      <section className="withdrawal-detail__card">
        <h2>管理メモ</h2>
        <Form method="post" className="withdrawal-detail__form">
          <input type="hidden" name="intent" value="add_admin_note" />
          <textarea
            name="adminNotes"
            rows="5"
            defaultValue={withdrawalRequest.adminNotes || ""}
          />
          <button type="submit" disabled={isSubmitting}>
            メモを保存
          </button>
        </Form>
      </section>

      <section className="withdrawal-detail__grid">
        <TimelineCard title="ステータス履歴" rows={withdrawalRequest.statusHistory} />
        <EmailLogCard rows={withdrawalRequest.emailLogs} />
      </section>
    </main>
  );
}

function DescriptionList({ rows }) {
  return (
    <dl className="withdrawal-detail__dl">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function TimelineCard({ title, rows }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <div className="withdrawal-detail__empty">履歴はありません。</div>
      ) : (
        <div className="withdrawal-detail__timeline">
          {rows.map((row) => (
            <div key={row.id}>
              <strong>{row.toStatusLabel}</strong>
              <span>{row.createdAtLabel}</span>
              <p>{row.reason || "-"}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function EmailLogCard({ rows }) {
  return (
    <section className="withdrawal-detail__card">
      <h2>メールログ</h2>
      {rows.length === 0 ? (
        <div className="withdrawal-detail__empty">メールログはありません。</div>
      ) : (
        <div className="withdrawal-detail__timeline">
          {rows.map((row) => (
            <div key={row.id}>
              <strong>{row.emailType} / {row.status}</strong>
              <span>{row.createdAtLabel}</span>
              <p>{row.subject}</p>
              {row.errorMessage ? <p className="withdrawal-detail__error">{row.errorMessage}</p> : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Badge({ tone, children }) {
  return <span className={`withdrawal-detail__badge withdrawal-detail__badge--${tone}`}>{children}</span>;
}

function serializeWithdrawalRequest(request) {
  return {
    id: request.id,
    shopDomain: request.shopDomain,
    shopifyOrderId: request.shopifyOrderId,
    shopifyOrderName: request.shopifyOrderName,
    shopifyOrderNumber: request.shopifyOrderNumber,
    customerName: request.customerName,
    customerEmail: request.customerEmail,
    customerPhone: request.customerPhone,
    countryCode: request.countryCode,
    countryLabel: request.countryLabel,
    receivedDateLabel: formatDate(request.receivedDate),
    withdrawalScope: request.withdrawalScope,
    itemCondition: request.itemCondition,
    reason: request.reason,
    status: request.status,
    statusLabel: getWithdrawalStatusLabel(request.status),
    statusTone: getWithdrawalStatusTone(request.status),
    eligibilityStatus: request.eligibilityStatus,
    eligibilityLabel: getWithdrawalEligibilityLabel(request.eligibilityStatus),
    eligibilityTone: getWithdrawalEligibilityTone(request.eligibilityStatus),
    deadlineAtLabel: formatDate(request.deadlineAt),
    selectedLineItemsJson: request.selectedLineItemsJson || {},
    eligibilityJson: request.eligibilityJson || {},
    submittedPayloadJson: request.submittedPayloadJson || {},
    orderSnapshotJson: request.orderSnapshotJson || {},
    adminNotes: request.adminNotes || "",
    statusHistory: request.statusHistory.map((row) => ({
      id: row.id,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      toStatusLabel: getWithdrawalStatusLabel(row.toStatus),
      reason: row.reason,
      changedBy: row.changedBy,
      metadataJson: row.metadataJson,
      createdAtLabel: formatDate(row.createdAt),
    })),
    emailLogs: request.emailLogs.map((row) => ({
      id: row.id,
      emailType: row.emailType,
      status: row.status,
      subject: row.subject,
      errorMessage: row.errorMessage,
      createdAtLabel: formatDate(row.createdAt),
    })),
  };
}

function formatDate(value) {
  if (!value) return "-";
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch (_error) {
    return String(value);
  }
}

const detailStyles = `
  .withdrawal-detail{
    display:grid;
    gap:24px;
    padding:24px;
    min-height:100%;
    background:#f3f4f6;
    color:#111827;
  }
  .withdrawal-detail__card{
    background:#fff;
    border:1px solid #e5e7eb;
    border-radius:16px;
    padding:22px;
  }
  .withdrawal-detail__header h1{
    margin:12px 0 8px;
    font-size:30px;
  }
  .withdrawal-detail__header p{
    margin:0;
    color:#4b5563;
  }
  .withdrawal-detail__back{
    color:#1d4ed8;
    font-weight:800;
    text-decoration:none;
  }
  .withdrawal-detail__badges,
  .withdrawal-detail__button-row{
    display:flex;
    flex-wrap:wrap;
    gap:10px;
    margin-top:16px;
  }
  .withdrawal-detail__grid{
    display:grid;
    grid-template-columns:repeat(auto-fit, minmax(320px, 1fr));
    gap:24px;
  }
  .withdrawal-detail h2{
    margin:0 0 16px;
    font-size:22px;
  }
  .withdrawal-detail__dl{
    display:grid;
    gap:0;
    border:1px solid #e5e7eb;
    border-radius:14px;
    overflow:hidden;
  }
  .withdrawal-detail__dl div{
    display:grid;
    grid-template-columns:150px minmax(0, 1fr);
    border-top:1px solid #e5e7eb;
  }
  .withdrawal-detail__dl div:first-child{
    border-top:none;
  }
  .withdrawal-detail__dl dt,
  .withdrawal-detail__dl dd{
    margin:0;
    padding:12px 14px;
    line-height:1.6;
  }
  .withdrawal-detail__dl dt{
    background:#f9fafb;
    color:#4b5563;
    font-weight:800;
  }
  .withdrawal-detail__dl dd{
    overflow-wrap:anywhere;
  }
  .withdrawal-detail__badge{
    display:inline-flex;
    border:1px solid #d1d5db;
    border-radius:999px;
    padding:5px 10px;
    font-size:12px;
    font-weight:800;
  }
  .withdrawal-detail__badge--success{
    border-color:#a7f3d0;
    background:#ecfdf5;
    color:#047857;
  }
  .withdrawal-detail__badge--warning{
    border-color:#fde68a;
    background:#fffbeb;
    color:#92400e;
  }
  .withdrawal-detail__badge--danger{
    border-color:#fecaca;
    background:#fef2f2;
    color:#b91c1c;
  }
  .withdrawal-detail__badge--info,
  .withdrawal-detail__badge--neutral{
    border-color:#bfdbfe;
    background:#eff6ff;
    color:#1d4ed8;
  }
  .withdrawal-detail__form{
    display:grid;
    gap:12px;
  }
  .withdrawal-detail__form label{
    display:grid;
    gap:6px;
    color:#4b5563;
    font-size:13px;
    font-weight:800;
  }
  .withdrawal-detail__form select,
  .withdrawal-detail__form textarea{
    width:100%;
    box-sizing:border-box;
    border:1px solid #d1d5db;
    border-radius:12px;
    padding:12px;
    font:inherit;
  }
  .withdrawal-detail button{
    min-height:42px;
    border:1px solid #111827;
    border-radius:999px;
    padding:0 16px;
    background:#111827;
    color:#fff;
    font-weight:800;
    cursor:pointer;
  }
  .withdrawal-detail__guard{
    margin-top:18px;
    padding:16px;
    border:1px solid #fde68a;
    border-radius:14px;
    background:#fffbeb;
    color:#92400e;
    line-height:1.7;
  }
  .withdrawal-detail__pre{
    max-height:360px;
    overflow:auto;
    border:1px solid #e5e7eb;
    border-radius:14px;
    background:#f9fafb;
    padding:14px;
    white-space:pre-wrap;
    word-break:break-word;
  }
  .withdrawal-detail__timeline{
    display:grid;
    gap:12px;
  }
  .withdrawal-detail__timeline div{
    border:1px solid #e5e7eb;
    border-radius:14px;
    padding:14px;
    background:#f9fafb;
  }
  .withdrawal-detail__timeline strong{
    display:block;
    margin-bottom:4px;
  }
  .withdrawal-detail__timeline span{
    color:#6b7280;
    font-size:12px;
  }
  .withdrawal-detail__timeline p{
    margin:8px 0 0;
    color:#4b5563;
  }
  .withdrawal-detail__empty{
    border:1px dashed #cbd5e1;
    border-radius:14px;
    padding:16px;
    color:#64748b;
  }
  .withdrawal-detail__notice{
    border:1px solid #d1d5db;
    border-radius:14px;
    padding:14px 16px;
    background:#f9fafb;
    color:#374151;
    font-weight:700;
  }
  .withdrawal-detail__notice--ok{
    border-color:#a7f3d0;
    background:#ecfdf5;
    color:#047857;
  }
  .withdrawal-detail__notice--error{
    border-color:#fecaca;
    background:#fef2f2;
    color:#b91c1c;
  }
  .withdrawal-detail__error{
    color:#b91c1c !important;
  }
`;

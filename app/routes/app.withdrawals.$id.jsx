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
    const shouldSendStatusEmail = formData.get("sendStatusEmail") === "1";

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

    if (result.ok && shouldSendStatusEmail) {
      const emailResult = await sendWithdrawalStatusEmail({
        withdrawalRequestId: params.id,
      });

      return json({
        ok: emailResult.ok,
        message: emailResult.ok
          ? "ステータスを更新し、状況メールを送信しました。"
          : `ステータスは更新しましたが、状況メールを送信できませんでした: ${
              emailResult.error || "unknown"
            }`,
      });
    }

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

      <section className="withdrawal-detail__card withdrawal-detail__next">
        <h2>次にやること</h2>
        <strong>{withdrawalRequest.nextAction.title}</strong>
        <p>{withdrawalRequest.nextAction.description}</p>
        {withdrawalRequest.nextAction.items.length > 0 ? (
          <ol>
            {withdrawalRequest.nextAction.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
        ) : null}
      </section>

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
          <h2>注文照合</h2>
          <DescriptionList rows={withdrawalRequest.orderSummaryRows} />
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
            <label className="withdrawal-detail__checkbox">
              <input type="checkbox" name="sendStatusEmail" value="1" />
              <span>更新後に購入者へ状況メールを送る</span>
            </label>
            <button type="submit" disabled={isSubmitting}>
              ステータスを更新
            </button>
          </Form>

          {withdrawalRequest.quickActions.length > 0 ? (
            <div className="withdrawal-detail__quick-actions">
              <strong>よく使う更新</strong>
              <div className="withdrawal-detail__button-row">
                {withdrawalRequest.quickActions.map((action) => (
                  <Form method="post" key={action.status}>
                    <input type="hidden" name="intent" value="update_status" />
                    <input type="hidden" name="toStatus" value={action.status} />
                    <input type="hidden" name="reason" value={action.reason} />
                    <button type="submit" disabled={isSubmitting}>
                      {action.label}
                    </button>
                  </Form>
                ))}
              </div>
            </div>
          ) : null}

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
  const orderSummaryRows = buildOrderSummaryRows(request);

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
    orderSummaryRows,
    nextAction: buildNextAction(request),
    quickActions: buildQuickActions(request.status),
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

function buildNextAction(request) {
  if (request.eligibilityStatus === "ORDER_NOT_FOUND_REVIEW") {
    return {
      title: "注文番号とメールを確認",
      description: "注文を自動照合できていません。Shopify注文管理で注文番号と購入者メールを確認してください。",
      items: [
        "注文が見つかれば申請内容を管理メモに残す",
        "対象外や入力ミスなら購入者へ確認連絡する",
      ],
    };
  }

  if (request.eligibilityStatus === "EMAIL_MISMATCH_REVIEW") {
    return {
      title: "購入者メールの照合",
      description: "入力メールと注文メールが一致していません。本人確認が取れるまで返金判断を保留してください。",
      items: ["注文者本人か確認する", "確認後に確認中または却下へ進める"],
    };
  }

  if (request.eligibilityStatus === "DEADLINE_EXPIRED") {
    return {
      title: "期限超過の確認",
      description: "14日を超えている可能性があります。配送完了日や購入者申告日を確認してください。",
      items: ["期限内なら確認中へ進める", "期限外なら却下理由を残して却下する"],
    };
  }

  switch (request.status) {
    case WITHDRAWAL_STATUSES.REQUESTED:
    case WITHDRAWAL_STATUSES.ACKNOWLEDGED:
      return {
        title: "申請内容を確認",
        description: "注文内容、配送状況、撤回対象、商品状態を確認してください。",
        items: [
          "未発送ならキャンセル可否を確認",
          "発送済みなら返送案内へ進める",
          "例外商品や減額要素があれば管理メモに残す",
        ],
      };
    case WITHDRAWAL_STATUSES.UNDER_REVIEW:
      return {
        title: "承認または返送待ちへ進める",
        description: "撤回対象として扱えるかを判断し、次の状態に更新します。",
        items: ["未発送なら承認済みまたはキャンセル済みにする", "発送済みなら返送待ちにする"],
      };
    case WITHDRAWAL_STATUSES.APPROVED:
      return {
        title: "返送または返金準備",
        description: "承認済みの申請です。発送状況に応じて返送待ちまたは返金準備へ進めます。",
        items: ["返送が必要なら返送待ち", "返送不要または未発送なら返金準備中"],
      };
    case WITHDRAWAL_STATUSES.RETURN_REQUESTED:
      return {
        title: "返送到着を待つ",
        description: "返送または返送証明を確認したら、返送確認済みに更新してください。",
        items: ["追跡番号や返送証明を管理メモに残す", "商品状態に減額要素がないか確認する"],
      };
    case WITHDRAWAL_STATUSES.RETURN_RECEIVED:
      return {
        title: "返金額を確定",
        description: "商品状態を確認し、返金対象額を確定してください。",
        items: ["通常配送分の初回送料を返金対象として確認", "減額がある場合は理由を管理メモに残す"],
      };
    case WITHDRAWAL_STATUSES.REFUND_PENDING:
      return {
        title: "Shopifyで返金処理",
        description: "管理者がShopify側で返金を実行し、完了後に返金済みに更新します。",
        items: ["返金実行後、返金IDや金額を管理メモに残す", "購入者へ状況メールを送る"],
      };
    case WITHDRAWAL_STATUSES.REFUNDED:
    case WITHDRAWAL_STATUSES.CANCELLED:
      return {
        title: "処理完了",
        description: "この申請は完了状態です。必要に応じて履歴とメールログを確認してください。",
        items: [],
      };
    case WITHDRAWAL_STATUSES.REJECTED:
    case WITHDRAWAL_STATUSES.EXPIRED:
      return {
        title: "対象外処理済み",
        description: "却下または期限切れとして処理されています。理由が残っているか確認してください。",
        items: [],
      };
    default:
      return {
        title: "内容を確認",
        description: "申請内容とステータス履歴を確認してください。",
        items: [],
      };
  }
}

function buildQuickActions(status) {
  const actionsByStatus = {
    [WITHDRAWAL_STATUSES.REQUESTED]: [
      {
        status: WITHDRAWAL_STATUSES.UNDER_REVIEW,
        label: "確認中にする",
        reason: "admin_started_review",
      },
      {
        status: WITHDRAWAL_STATUSES.RETURN_REQUESTED,
        label: "返送待ちにする",
        reason: "return_required",
      },
    ],
    [WITHDRAWAL_STATUSES.ACKNOWLEDGED]: [
      {
        status: WITHDRAWAL_STATUSES.UNDER_REVIEW,
        label: "確認中にする",
        reason: "admin_started_review",
      },
      {
        status: WITHDRAWAL_STATUSES.RETURN_REQUESTED,
        label: "返送待ちにする",
        reason: "return_required",
      },
    ],
    [WITHDRAWAL_STATUSES.UNDER_REVIEW]: [
      {
        status: WITHDRAWAL_STATUSES.APPROVED,
        label: "承認済みにする",
        reason: "approved_after_review",
      },
      {
        status: WITHDRAWAL_STATUSES.RETURN_REQUESTED,
        label: "返送待ちにする",
        reason: "return_required",
      },
    ],
    [WITHDRAWAL_STATUSES.APPROVED]: [
      {
        status: WITHDRAWAL_STATUSES.RETURN_REQUESTED,
        label: "返送待ちにする",
        reason: "return_required",
      },
      {
        status: WITHDRAWAL_STATUSES.REFUND_PENDING,
        label: "返金準備中にする",
        reason: "ready_for_refund",
      },
    ],
    [WITHDRAWAL_STATUSES.RETURN_REQUESTED]: [
      {
        status: WITHDRAWAL_STATUSES.RETURN_RECEIVED,
        label: "返送確認済みにする",
        reason: "return_received",
      },
    ],
    [WITHDRAWAL_STATUSES.RETURN_RECEIVED]: [
      {
        status: WITHDRAWAL_STATUSES.REFUND_PENDING,
        label: "返金準備中にする",
        reason: "ready_for_refund",
      },
    ],
    [WITHDRAWAL_STATUSES.REFUND_PENDING]: [
      {
        status: WITHDRAWAL_STATUSES.REFUNDED,
        label: "返金済みにする",
        reason: "refund_completed_manually",
      },
    ],
  };

  return actionsByStatus[status] || [];
}

function buildOrderSummaryRows(request) {
  const snapshot =
    request.orderSnapshotJson && typeof request.orderSnapshotJson === "object"
      ? request.orderSnapshotJson
      : null;

  if (!snapshot) {
    return [
      ["照合状態", "注文を自動照合できていません"],
      ["注文番号", request.shopifyOrderName || request.shopifyOrderNumber || "-"],
    ];
  }

  return [
    ["照合状態", "照合済み"],
    ["注文番号", snapshot.shopifyOrderName || request.shopifyOrderName || "-"],
    ["購入者メール", snapshot.buyerEmail || "-"],
    ["支払い状態", snapshot.financialStatus || "-"],
    ["配送状態", snapshot.fulfillmentStatus || "-"],
    ["商品小計", formatAmount(snapshot.subtotalAmount, snapshot.currencyCode)],
    ["初回送料", formatAmount(snapshot.shippingAmount, snapshot.currencyCode)],
    ["税", formatAmount(snapshot.taxAmount, snapshot.currencyCode)],
    ["合計", formatAmount(snapshot.totalAmount, snapshot.currencyCode)],
    ["配送先国", snapshot.shippingCountryCode || "-"],
    ["注文日時", formatDate(snapshot.processedAt || snapshot.createdAt)],
  ];
}

function formatAmount(amount, currencyCode) {
  if (amount === null || amount === undefined || amount === "") return "-";
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return String(amount);
  const currency = String(currencyCode || "").toUpperCase();
  return currency
    ? `${numeric.toLocaleString("ja-JP")} ${currency}`
    : numeric.toLocaleString("ja-JP");
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
  .withdrawal-detail__next{
    border-color:#bfdbfe;
    background:#eff6ff;
  }
  .withdrawal-detail__next strong{
    display:block;
    margin-bottom:6px;
    font-size:18px;
  }
  .withdrawal-detail__next p{
    margin:0 0 10px;
    color:#1f2937;
    line-height:1.7;
  }
  .withdrawal-detail__next ol{
    margin:0;
    padding-left:22px;
    color:#374151;
    line-height:1.7;
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
  .withdrawal-detail__checkbox{
    display:flex !important;
    grid-template-columns:none !important;
    align-items:center;
    gap:8px;
    color:#374151 !important;
    font-size:14px !important;
  }
  .withdrawal-detail__checkbox input{
    width:16px;
    height:16px;
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
  .withdrawal-detail__quick-actions{
    margin-top:18px;
    padding:16px;
    border:1px solid #e5e7eb;
    border-radius:14px;
    background:#f9fafb;
  }
  .withdrawal-detail__quick-actions > strong{
    display:block;
    margin-bottom:10px;
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

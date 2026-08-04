import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { WITHDRAWAL_ELIGIBILITY_STATUSES, WITHDRAWAL_STATUSES, getWithdrawalEligibilityLabel, getWithdrawalStatusLabel } from "../../utils/withdrawalStatus.js";
import { DEFAULT_LIMIT, MAX_LIMIT, URGENT_DEADLINE_DAYS } from "../../services/withdrawalAdminList.js";
const QUEUE_DEFINITIONS = {
  all: {
    label: "すべて"
  },
  awaiting_review: {
    label: "要確認"
  },
  deadline_expired: {
    label: "期限超過"
  },
  deadline_soon: {
    label: "期限間近"
  },
  return_waiting: {
    label: "返送待ち"
  },
  return_instruction_missing: {
    label: "返送案内未送信"
  },
  refund_waiting: {
    label: "返金判断待ち"
  },
  shopify_processing: {
    label: "Shopify処理待ち"
  },
  completion_notification: {
    label: "完了通知待ち"
  },
  email_failed: {
    label: "メール失敗"
  },
  processing_issue: {
    label: "処理不整合"
  },
  open: {
    label: "未完了"
  }
};
export default function WithdrawalsPage() {
  const {
    available,
    status,
    eligibilityStatus,
    search,
    queue,
    limit,
    dashboardCounts,
    summary,
    requests,
    errorMessage
  } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
  const isSubmitting = navigation.state === "submitting";
  return <main className="withdrawals-admin">
      <style>{adminStyles}</style>
      <section className="withdrawals-admin__card">
        <div className="withdrawals-admin__header">
          <div>
            <h1>撤回申請</h1>
            <p>
              EU撤回権フォームから届いた申請を確認します。申請受付は自動、返金やキャンセルは管理者確認後に行います。
            </p>
          </div>
          <Form method="get" className="withdrawals-admin__filters">
            <input type="hidden" name="queue" value={queue} />
            <label>
              <span>状態</span>
              <select name="status" defaultValue={status}>
                <option value="all">すべて</option>
                {Object.values(WITHDRAWAL_STATUSES).map(value => <option key={value} value={value}>
                    {getWithdrawalStatusLabel(value)}
                  </option>)}
              </select>
            </label>
            <label>
              <span>判定</span>
              <select name="eligibilityStatus" defaultValue={eligibilityStatus}>
                <option value="all">すべて</option>
                {Object.values(WITHDRAWAL_ELIGIBILITY_STATUSES).map(value => <option key={value} value={value}>
                    {getWithdrawalEligibilityLabel(value)}
                  </option>)}
              </select>
            </label>
            <label>
              <span>検索</span>
              <input name="search" defaultValue={search} placeholder="注文番号 / メール" />
            </label>
            <label>
              <span>件数</span>
              <input name="limit" type="number" min="1" max={MAX_LIMIT} defaultValue={limit} />
            </label>
            <button type="submit" disabled={isLoading}>
              更新
            </button>
          </Form>
        </div>
        {actionData?.message ? <div className={`withdrawals-admin__notice ${actionData.ok ? "withdrawals-admin__notice--success" : "withdrawals-admin__notice--error"}`}>
            {actionData.message}
          </div> : null}
      </section>

      {!available ? <section className="withdrawals-admin__card">
          <div className="withdrawals-admin__empty">{errorMessage}</div>
        </section> : <>
          <section className="withdrawals-admin__ops-grid">
            <OperationStat label="要対応" count={dashboardCounts.attention} detail="期限・メール・確認待ち" tone={dashboardCounts.attention > 0 ? "warning" : "neutral"} />
            <OperationStat label="期限超過" count={dashboardCounts.deadlineExpired} detail="先に処理方針を確認" tone={dashboardCounts.deadlineExpired > 0 ? "danger" : "neutral"} />
            <OperationStat label="期限近い" count={dashboardCounts.deadlineSoon} detail={`${URGENT_DEADLINE_DAYS}日以内`} tone={dashboardCounts.deadlineSoon > 0 ? "warning" : "neutral"} />
            <OperationStat label="メール失敗" count={dashboardCounts.emailFailed} detail="再送または宛先確認" tone={dashboardCounts.emailFailed > 0 ? "danger" : "neutral"} />
            <OperationStat label="処理不整合" count={dashboardCounts.processingIssue} detail="返金・完了記録を確認" tone={dashboardCounts.processingIssue > 0 ? "danger" : "neutral"} />
          </section>

          <section className="withdrawals-admin__quick-links">
            <QuickFilterLink label={QUEUE_DEFINITIONS.all.label} count={dashboardCounts.total} active={queue === "all"} to={buildListUrl({
          queue: "all",
          status: "all",
          eligibilityStatus,
          search,
          limit
        })} />
            <QuickFilterLink label={QUEUE_DEFINITIONS.awaiting_review.label} count={dashboardCounts.awaitingReview} active={queue === "awaiting_review"} to={buildListUrl({
          queue: "awaiting_review",
          status: "all",
          eligibilityStatus,
          search,
          limit
        })} />
            <QuickFilterLink label={QUEUE_DEFINITIONS.deadline_expired.label} count={dashboardCounts.deadlineExpiredQueue} active={queue === "deadline_expired"} to={buildListUrl({
          queue: "deadline_expired",
          status: "all",
          eligibilityStatus,
          search,
          limit
        })} />
            <QuickFilterLink label={QUEUE_DEFINITIONS.deadline_soon.label} count={dashboardCounts.deadlineSoonQueue} active={queue === "deadline_soon"} to={buildListUrl({
          queue: "deadline_soon",
          status: "all",
          eligibilityStatus,
          search,
          limit
        })} />
            <QuickFilterLink label={QUEUE_DEFINITIONS.return_waiting.label} count={dashboardCounts.returnWaiting} active={queue === "return_waiting"} to={buildListUrl({
          queue: "return_waiting",
          status: "all",
          eligibilityStatus,
          search,
          limit
        })} />
            <QuickFilterLink label={QUEUE_DEFINITIONS.return_instruction_missing.label} count={dashboardCounts.returnInstructionMissing} active={queue === "return_instruction_missing"} to={buildListUrl({
          queue: "return_instruction_missing",
          status: "all",
          eligibilityStatus,
          search,
          limit
        })} />
            <QuickFilterLink label={QUEUE_DEFINITIONS.refund_waiting.label} count={dashboardCounts.refundWaiting} active={queue === "refund_waiting"} to={buildListUrl({
          queue: "refund_waiting",
          status: "all",
          eligibilityStatus,
          search,
          limit
        })} />
            <QuickFilterLink label={QUEUE_DEFINITIONS.shopify_processing.label} count={dashboardCounts.shopifyProcessing} active={queue === "shopify_processing"} to={buildListUrl({
          queue: "shopify_processing",
          status: "all",
          eligibilityStatus,
          search,
          limit
        })} />
            <QuickFilterLink label={QUEUE_DEFINITIONS.completion_notification.label} count={dashboardCounts.completionNotification} active={queue === "completion_notification"} to={buildListUrl({
          queue: "completion_notification",
          status: "all",
          eligibilityStatus,
          search,
          limit
        })} />
            <QuickFilterLink label={QUEUE_DEFINITIONS.email_failed.label} count={dashboardCounts.emailFailed} active={queue === "email_failed"} to={buildListUrl({
          queue: "email_failed",
          status: "all",
          eligibilityStatus,
          search,
          limit
        })} />
            <QuickFilterLink label={QUEUE_DEFINITIONS.processing_issue.label} count={dashboardCounts.processingIssue} active={queue === "processing_issue"} to={buildListUrl({
          queue: "processing_issue",
          status: "all",
          eligibilityStatus,
          search,
          limit
        })} />
            <QuickFilterLink label={QUEUE_DEFINITIONS.open.label} count={dashboardCounts.open} active={queue === "open"} to={buildListUrl({
          queue: "open",
          status: "all",
          eligibilityStatus,
          search,
          limit
        })} />
          </section>

          <section className="withdrawals-admin__card withdrawals-admin__summary">
            {summary.length === 0 ? <div className="withdrawals-admin__empty">
                まだ申請はありません。
              </div> : summary.map(item => <div className="withdrawals-admin__summary-item" key={item.status}>
                  <span>{item.label}</span>
                  <strong>{item.count}</strong>
                </div>)}
          </section>

          <section className="withdrawals-admin__card">
            <div className="withdrawals-admin__table-wrap">
              <table className="withdrawals-admin__table">
                <thead>
                  <tr>
                    <th>受付日</th>
                    <th>優先</th>
                    <th>注文</th>
                    <th>購入者</th>
                    <th>国</th>
                    <th>状態</th>
                    <th>判定</th>
                    <th>期限</th>
                    <th>返送/返金</th>
                    <th>受付メール</th>
                    <th>次にやること</th>
                    <th>メール</th>
                    <th>詳細</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.length === 0 ? <tr>
                      <td colSpan="13">
                        <div className="withdrawals-admin__empty">
                          条件に合う申請はありません。
                        </div>
                      </td>
                    </tr> : requests.map(request => <tr key={request.id}>
                        <td>{request.createdAtLabel}</td>
                        <td>
                          <div className="withdrawals-admin__cell-stack">
                            <Badge tone={request.priorityTone}>
                              {request.priorityLabel}
                            </Badge>
                            <span className="withdrawals-admin__muted">
                              {request.priorityDetail}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="withdrawals-admin__strong">
                            {request.shopifyOrderName || request.shopifyOrderNumber || "-"}
                          </div>
                          <div className="withdrawals-admin__muted">
                            {request.id}
                          </div>
                        </td>
                        <td>
                          <div>{request.customerName}</div>
                          <div className="withdrawals-admin__muted">
                            {request.customerEmail}
                          </div>
                        </td>
                        <td>{request.countryLabel || request.countryCode || "-"}</td>
                        <td>
                          <Badge tone={request.statusTone}>
                            {request.statusLabel}
                          </Badge>
                        </td>
                        <td>
                          <Badge tone={request.eligibilityTone}>
                            {request.eligibilityLabel}
                          </Badge>
                        </td>
                        <td>
                          <div className="withdrawals-admin__cell-stack">
                            <span>{request.deadlineAtLabel}</span>
                            {request.deadlineUrgencyLabel ? <Badge tone={request.deadlineTone}>
                                {request.deadlineUrgencyLabel}
                              </Badge> : null}
                          </div>
                        </td>
                        <td>
                          <div className="withdrawals-admin__cell-stack">
                            <span>返送: {request.returnStatusLabel}</span>
                            <span>返金: {request.refundDecisionLabel}</span>
                            {request.processingIssueLabel ? <Badge tone="danger">
                                {request.processingIssueLabel}
                              </Badge> : null}
                          </div>
                        </td>
                        <td>
                          <Badge tone={request.latestEmailStatusTone}>
                            {request.latestEmailStatusLabel}
                          </Badge>
                        </td>
                        <td>
                          <div className="withdrawals-admin__cell-stack">
                            <Badge tone={request.nextActionTone}>
                              {request.nextActionLabel}
                            </Badge>
                            <span className="withdrawals-admin__muted">
                              {request.nextActionDetail}
                            </span>
                          </div>
                        </td>
                        <td>
                          {request.emailActions.length > 0 ? <div className="withdrawals-admin__mini-actions">
                              {request.emailActions.map(action => <Form key={action.intent} method="post" className="withdrawals-admin__mini-form">
                                  <input type="hidden" name="withdrawalRequestId" value={request.id} />
                                  <input type="hidden" name="intent" value={action.intent} />
                                  <button type="submit" className={`withdrawals-admin__mini-button withdrawals-admin__mini-button--${action.tone}`} disabled={isSubmitting} title={action.detail}>
                                    {action.label}
                                  </button>
                                </Form>)}
                            </div> : <span className="withdrawals-admin__muted">-</span>}
                        </td>
                        <td>
                          <Link className="withdrawals-admin__link" to={`/app/withdrawals/${request.id}`}>
                            開く
                          </Link>
                        </td>
                      </tr>)}
                </tbody>
              </table>
            </div>
          </section>
        </>}
    </main>;
}
function QuickFilterLink({
  label,
  count,
  active,
  to
}) {
  return <Link className={`withdrawals-admin__quick-link ${active ? "withdrawals-admin__quick-link--active" : ""}`} to={to}>
      <span>{label}</span>
      <strong>{count}</strong>
    </Link>;
}
function OperationStat({
  label,
  count,
  detail,
  tone = "neutral"
}) {
  return <div className={`withdrawals-admin__ops-card withdrawals-admin__ops-card--${tone}`}>
      <span>{label}</span>
      <strong>{count}</strong>
      <small>{detail}</small>
    </div>;
}
function Badge({
  tone,
  children
}) {
  return <span className={`withdrawals-admin__badge withdrawals-admin__badge--${tone}`}>
      {children}
    </span>;
}
function buildListUrl({
  queue,
  status,
  eligibilityStatus,
  search,
  limit
}) {
  const params = new URLSearchParams();
  if (queue && queue !== "all") params.set("queue", queue);
  if (status && status !== "all") params.set("status", status);
  if (eligibilityStatus && eligibilityStatus !== "all") {
    params.set("eligibilityStatus", eligibilityStatus);
  }
  if (search) params.set("search", search);
  if (limit && Number(limit) !== DEFAULT_LIMIT) {
    params.set("limit", String(limit));
  }
  const query = params.toString();
  return query ? `/app/withdrawals?${query}` : "/app/withdrawals";
}
const adminStyles = `
  .withdrawals-admin{
    display:grid;
    gap:24px;
    padding:24px;
    min-height:100%;
    background:#f3f4f6;
    color:#111827;
  }
  .withdrawals-admin__card{
    background:#fff;
    border:1px solid #e5e7eb;
    border-radius:16px;
    padding:22px;
  }
  .withdrawals-admin__notice{
    margin-top:16px;
    border-radius:12px;
    padding:12px 14px;
    font-weight:800;
    line-height:1.7;
  }
  .withdrawals-admin__notice--success{
    border:1px solid #a7f3d0;
    background:#ecfdf5;
    color:#047857;
  }
  .withdrawals-admin__notice--error{
    border:1px solid #fecaca;
    background:#fef2f2;
    color:#b91c1c;
  }
  .withdrawals-admin__quick-links{
    display:grid;
    grid-template-columns:repeat(auto-fit, minmax(160px, 1fr));
    gap:12px;
  }
  .withdrawals-admin__ops-grid{
    display:grid;
    grid-template-columns:repeat(auto-fit, minmax(190px, 1fr));
    gap:12px;
  }
  .withdrawals-admin__ops-card{
    display:grid;
    gap:6px;
    border:1px solid #e5e7eb;
    border-radius:16px;
    padding:18px;
    background:#fff;
  }
  .withdrawals-admin__ops-card span,
  .withdrawals-admin__ops-card small{
    color:#4b5563;
    font-weight:800;
  }
  .withdrawals-admin__ops-card strong{
    color:#111827;
    font-size:32px;
    line-height:1;
  }
  .withdrawals-admin__ops-card--warning{
    border-color:#fde68a;
    background:#fffbeb;
  }
  .withdrawals-admin__ops-card--danger{
    border-color:#fecaca;
    background:#fef2f2;
  }
  .withdrawals-admin__ops-card--success{
    border-color:#a7f3d0;
    background:#ecfdf5;
  }
  .withdrawals-admin__quick-link{
    display:grid;
    gap:8px;
    border:1px solid #e5e7eb;
    border-radius:16px;
    padding:18px;
    background:#fff;
    color:#111827;
    text-decoration:none;
  }
  .withdrawals-admin__quick-link--active{
    border-color:#111827;
    box-shadow:inset 0 0 0 1px #111827;
  }
  .withdrawals-admin__quick-link span{
    color:#4b5563;
    font-weight:800;
  }
  .withdrawals-admin__quick-link strong{
    font-size:30px;
  }
  .withdrawals-admin__header{
    display:flex;
    justify-content:space-between;
    gap:20px;
    align-items:flex-start;
    flex-wrap:wrap;
  }
  .withdrawals-admin h1{
    margin:0 0 8px;
    font-size:30px;
  }
  .withdrawals-admin p{
    margin:0;
    color:#4b5563;
    line-height:1.8;
  }
  .withdrawals-admin__filters{
    display:flex;
    align-items:flex-end;
    gap:10px;
    flex-wrap:wrap;
  }
  .withdrawals-admin__filters label{
    display:grid;
    gap:6px;
    color:#4b5563;
    font-size:12px;
    font-weight:800;
  }
  .withdrawals-admin__filters input,
  .withdrawals-admin__filters select{
    min-height:40px;
    border:1px solid #d1d5db;
    border-radius:10px;
    padding:0 12px;
    background:#fff;
    color:#111827;
  }
  .withdrawals-admin__filters button,
  .withdrawals-admin__link{
    min-height:40px;
    display:inline-flex;
    align-items:center;
    border:1px solid #111827;
    border-radius:999px;
    padding:0 16px;
    background:#111827;
    color:#fff;
    font-weight:800;
    text-decoration:none;
  }
  .withdrawals-admin__summary{
    display:grid;
    grid-template-columns:repeat(auto-fit, minmax(160px, 1fr));
    gap:12px;
  }
  .withdrawals-admin__summary-item{
    display:grid;
    gap:8px;
    border:1px solid #e5e7eb;
    border-radius:14px;
    padding:15px;
    background:#f9fafb;
  }
  .withdrawals-admin__summary-item span{
    color:#4b5563;
    font-weight:800;
  }
  .withdrawals-admin__summary-item strong{
    font-size:28px;
  }
  .withdrawals-admin__table-wrap{
    overflow:auto;
  }
  .withdrawals-admin__table{
    width:100%;
    border-collapse:collapse;
    min-width:1510px;
  }
  .withdrawals-admin__table th,
  .withdrawals-admin__table td{
    padding:13px 10px;
    border-bottom:1px solid #e5e7eb;
    text-align:left;
    vertical-align:top;
  }
  .withdrawals-admin__table th{
    color:#4b5563;
    font-size:12px;
    white-space:nowrap;
  }
  .withdrawals-admin__strong{
    font-weight:800;
  }
  .withdrawals-admin__muted{
    color:#6b7280;
    font-size:12px;
    overflow-wrap:anywhere;
  }
  .withdrawals-admin__cell-stack{
    display:grid;
    gap:6px;
    align-items:start;
  }
  .withdrawals-admin__mini-actions{
    display:flex;
    flex-wrap:wrap;
    gap:6px;
    min-width:140px;
  }
  .withdrawals-admin__mini-form{
    margin:0;
  }
  .withdrawals-admin__mini-button{
    min-height:30px;
    border:1px solid #d1d5db;
    border-radius:999px;
    padding:0 10px;
    background:#fff;
    color:#111827;
    font-size:12px;
    font-weight:900;
    cursor:pointer;
    white-space:nowrap;
  }
  .withdrawals-admin__mini-button:disabled{
    cursor:wait;
    opacity:.65;
  }
  .withdrawals-admin__mini-button--danger{
    border-color:#fecaca;
    background:#fef2f2;
    color:#b91c1c;
  }
  .withdrawals-admin__mini-button--warning{
    border-color:#fde68a;
    background:#fffbeb;
    color:#92400e;
  }
  .withdrawals-admin__mini-button--neutral{
    border-color:#d1d5db;
    background:#f9fafb;
    color:#374151;
  }
  .withdrawals-admin__badge{
    display:inline-flex;
    border:1px solid #d1d5db;
    border-radius:999px;
    padding:5px 10px;
    font-size:12px;
    font-weight:800;
    white-space:nowrap;
  }
  .withdrawals-admin__badge--success{
    border-color:#a7f3d0;
    background:#ecfdf5;
    color:#047857;
  }
  .withdrawals-admin__badge--warning{
    border-color:#fde68a;
    background:#fffbeb;
    color:#92400e;
  }
  .withdrawals-admin__badge--danger{
    border-color:#fecaca;
    background:#fef2f2;
    color:#b91c1c;
  }
  .withdrawals-admin__badge--info,
  .withdrawals-admin__badge--neutral{
    border-color:#bfdbfe;
    background:#eff6ff;
    color:#1d4ed8;
  }
  .withdrawals-admin__empty{
    border:1px dashed #cbd5e1;
    border-radius:14px;
    padding:18px;
    color:#64748b;
  }
`;

import { json } from "@remix-run/node";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";

import prisma from "../db.server.js";
import { authenticate } from "../shopify.server";
import {
  WITHDRAWAL_ELIGIBILITY_STATUSES,
  WITHDRAWAL_STATUSES,
  getWithdrawalEligibilityLabel,
  getWithdrawalEligibilityTone,
  getWithdrawalStatusLabel,
  getWithdrawalStatusTone,
} from "../utils/withdrawalStatus.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;
const URGENT_DEADLINE_DAYS = 3;
const CLOSED_STATUSES = [
  WITHDRAWAL_STATUSES.REFUNDED,
  WITHDRAWAL_STATUSES.CANCELLED,
  WITHDRAWAL_STATUSES.REJECTED,
  WITHDRAWAL_STATUSES.EXPIRED,
];
const OPEN_STATUSES = Object.values(WITHDRAWAL_STATUSES).filter(
  (status) => !CLOSED_STATUSES.includes(status),
);
const REVIEW_QUEUE_STATUSES = [
  WITHDRAWAL_STATUSES.REQUESTED,
  WITHDRAWAL_STATUSES.ACKNOWLEDGED,
  WITHDRAWAL_STATUSES.UNDER_REVIEW,
  WITHDRAWAL_STATUSES.ERROR,
];
const RETURN_WAITING_ORDER_STATUSES = [
  WITHDRAWAL_STATUSES.APPROVED,
  WITHDRAWAL_STATUSES.RETURN_REQUESTED,
];
const RETURN_WAITING_REQUIREMENT_STATUSES = [
  "REQUIRED",
  "WAITING",
  "IN_TRANSIT",
];
const REFUND_WAITING_ORDER_STATUSES = [
  WITHDRAWAL_STATUSES.RETURN_RECEIVED,
  WITHDRAWAL_STATUSES.REFUND_PENDING,
];
const REFUND_READY_RETURN_STATUSES = [
  "NOT_REQUIRED",
  "RECEIVED",
  "CONDITION_CHECKED",
];

const QUEUE_DEFINITIONS = {
  all: { label: "すべて" },
  awaiting_review: { label: "要確認" },
  deadline_expired: { label: "期限超過" },
  deadline_soon: { label: "期限間近" },
  return_waiting: { label: "返送待ち" },
  return_instruction_missing: { label: "返送案内未送信" },
  refund_waiting: { label: "返金判断待ち" },
  shopify_processing: { label: "Shopify処理待ち" },
  completion_notification: { label: "完了通知待ち" },
  email_failed: { label: "メール失敗" },
  processing_issue: { label: "処理不整合" },
  open: { label: "未完了" },
};

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const status = String(url.searchParams.get("status") || "all");
  const eligibilityStatus = String(
    url.searchParams.get("eligibilityStatus") || "all",
  );
  const search = String(url.searchParams.get("search") || "").trim();
  const queue = String(url.searchParams.get("queue") || "all");
  const limit = clampLimit(url.searchParams.get("limit"));
  const now = new Date();
  const urgentDeadline = new Date(
    now.getTime() + URGENT_DEADLINE_DAYS * 24 * 60 * 60 * 1000,
  );

  const where = { AND: [] };

  if (status !== "all") where.status = status;
  if (eligibilityStatus !== "all") where.eligibilityStatus = eligibilityStatus;
  const queueWhere = getQueueWhere(queue, { now, urgentDeadline });
  if (queueWhere) where.AND.push(queueWhere);
  if (search) {
    where.AND.push({
      OR: [
        { shopifyOrderName: { contains: search, mode: "insensitive" } },
        { shopifyOrderNumber: { contains: search, mode: "insensitive" } },
        { customerEmail: { contains: search, mode: "insensitive" } },
        { customerName: { contains: search, mode: "insensitive" } },
        { id: { contains: search, mode: "insensitive" } },
      ],
    });
  }
  if (where.AND.length === 0) delete where.AND;

  try {
    const [
      requests,
      summary,
      totalCount,
      openCount,
      awaitingReviewCount,
      deadlineExpiredQueueCount,
      deadlineSoonQueueCount,
      returnWaitingCount,
      returnInstructionMissingCount,
      refundWaitingCount,
      shopifyProcessingCount,
      completionNotificationCount,
      emailFailedCount,
      deadlineExpiredCount,
      deadlineSoonCount,
      processingIssueCount,
      attentionCount,
    ] = await Promise.all([
        prisma.withdrawalRequest.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: limit,
          include: {
            emailLogs: {
              orderBy: { createdAt: "desc" },
              take: 10,
            },
          },
        }),
        prisma.withdrawalRequest.groupBy({
          by: ["status"],
          _count: { _all: true },
        }),
        prisma.withdrawalRequest.count(),
        prisma.withdrawalRequest.count({
          where: {
            status: { in: OPEN_STATUSES },
          },
        }),
        prisma.withdrawalRequest.count({
          where: getQueueWhere("awaiting_review", { now, urgentDeadline }),
        }),
        prisma.withdrawalRequest.count({
          where: getQueueWhere("deadline_expired", { now, urgentDeadline }),
        }),
        prisma.withdrawalRequest.count({
          where: getQueueWhere("deadline_soon", { now, urgentDeadline }),
        }),
        prisma.withdrawalRequest.count({
          where: getQueueWhere("return_waiting", { now, urgentDeadline }),
        }),
        prisma.withdrawalRequest.count({
          where: getQueueWhere("return_instruction_missing", {
            now,
            urgentDeadline,
          }),
        }),
        prisma.withdrawalRequest.count({
          where: getQueueWhere("refund_waiting", { now, urgentDeadline }),
        }),
        prisma.withdrawalRequest.count({
          where: getQueueWhere("shopify_processing", { now, urgentDeadline }),
        }),
        prisma.withdrawalRequest.count({
          where: getQueueWhere("completion_notification", {
            now,
            urgentDeadline,
          }),
        }),
        prisma.withdrawalRequest.count({
          where: {
            emailLogs: { some: { status: "failed" } },
          },
        }),
        prisma.withdrawalRequest.count({
          where: {
            status: { in: OPEN_STATUSES },
            deadlineAt: { lt: now },
          },
        }),
        prisma.withdrawalRequest.count({
          where: {
            status: { in: OPEN_STATUSES },
            deadlineAt: { gte: now, lte: urgentDeadline },
          },
        }),
        prisma.withdrawalRequest.count({
          where: getProcessingIssueWhere(),
        }),
        prisma.withdrawalRequest.count({
          where: {
            OR: [
              getQueueWhere("awaiting_review"),
              getQueueWhere("refund_waiting"),
              getQueueWhere("shopify_processing"),
              getQueueWhere("completion_notification"),
              getProcessingIssueWhere(),
              { emailLogs: { some: { status: "failed" } } },
              {
                status: { in: OPEN_STATUSES },
                deadlineAt: { lte: urgentDeadline },
              },
            ],
          },
        }),
      ]);
    const serializedRequests = requests
      .map(serializeWithdrawalRequest)
      .sort(sortWithdrawalRequestsForOperations);

    return json({
      available: true,
      status,
      eligibilityStatus,
      search,
      queue,
      limit,
      dashboardCounts: {
        total: totalCount,
        open: openCount,
        awaitingReview: awaitingReviewCount,
        deadlineExpiredQueue: deadlineExpiredQueueCount,
        deadlineSoonQueue: deadlineSoonQueueCount,
        returnWaiting: returnWaitingCount,
        returnInstructionMissing: returnInstructionMissingCount,
        refundWaiting: refundWaitingCount,
        shopifyProcessing: shopifyProcessingCount,
        completionNotification: completionNotificationCount,
        emailFailed: emailFailedCount,
        deadlineExpired: deadlineExpiredCount,
        deadlineSoon: deadlineSoonCount,
        processingIssue: processingIssueCount,
        attention: attentionCount,
      },
      summary: summary.map((row) => ({
        status: row.status,
        label: getWithdrawalStatusLabel(row.status),
        count: row._count?._all || 0,
      })),
      requests: serializedRequests,
    });
  } catch (error) {
    console.error("withdrawals list load error:", error);
  return json({
    available: false,
      status,
      eligibilityStatus,
      search,
      queue,
      limit,
      dashboardCounts: {
        total: 0,
        open: 0,
        awaitingReview: 0,
        deadlineExpiredQueue: 0,
        deadlineSoonQueue: 0,
        returnWaiting: 0,
        returnInstructionMissing: 0,
        refundWaiting: 0,
        shopifyProcessing: 0,
        completionNotification: 0,
        emailFailed: 0,
        deadlineExpired: 0,
        deadlineSoon: 0,
        processingIssue: 0,
        attention: 0,
      },
      summary: [],
      requests: [],
      errorMessage:
        error?.code === "P2021"
          ? "撤回申請テーブルがまだ作成されていません。migrationを適用してください。"
          : "撤回申請を読み込めませんでした。",
    });
  }
};

export const action = async ({ request }) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const withdrawalRequestId = String(
    formData.get("withdrawalRequestId") || "",
  ).trim();

  if (!withdrawalRequestId) {
    return json(
      {
        ok: false,
        message: "撤回申請IDが見つかりません。",
      },
      { status: 400 },
    );
  }

  const emailServices = await import("../services/withdrawals.server.js");
  const result = await runWithdrawalListEmailAction({
    intent,
    withdrawalRequestId,
    request,
    prismaClient: prisma,
    emailServices,
  });

  return json(
    {
      ok: result.ok,
      message: result.message,
    },
    { status: result.status || 200 },
  );
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
    errorMessage,
  } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
  const isSubmitting = navigation.state === "submitting";

  return (
    <main className="withdrawals-admin">
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
                {Object.values(WITHDRAWAL_STATUSES).map((value) => (
                  <option key={value} value={value}>
                    {getWithdrawalStatusLabel(value)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>判定</span>
              <select name="eligibilityStatus" defaultValue={eligibilityStatus}>
                <option value="all">すべて</option>
                {Object.values(WITHDRAWAL_ELIGIBILITY_STATUSES).map((value) => (
                  <option key={value} value={value}>
                    {getWithdrawalEligibilityLabel(value)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>検索</span>
              <input
                name="search"
                defaultValue={search}
                placeholder="注文番号 / メール"
              />
            </label>
            <label>
              <span>件数</span>
              <input
                name="limit"
                type="number"
                min="1"
                max={MAX_LIMIT}
                defaultValue={limit}
              />
            </label>
            <button type="submit" disabled={isLoading}>
              更新
            </button>
          </Form>
        </div>
        {actionData?.message ? (
          <div
            className={`withdrawals-admin__notice ${
              actionData.ok
                ? "withdrawals-admin__notice--success"
                : "withdrawals-admin__notice--error"
            }`}
          >
            {actionData.message}
          </div>
        ) : null}
      </section>

      {!available ? (
        <section className="withdrawals-admin__card">
          <div className="withdrawals-admin__empty">{errorMessage}</div>
        </section>
      ) : (
        <>
          <section className="withdrawals-admin__ops-grid">
            <OperationStat
              label="要対応"
              count={dashboardCounts.attention}
              detail="期限・メール・確認待ち"
              tone={dashboardCounts.attention > 0 ? "warning" : "neutral"}
            />
            <OperationStat
              label="期限超過"
              count={dashboardCounts.deadlineExpired}
              detail="先に処理方針を確認"
              tone={dashboardCounts.deadlineExpired > 0 ? "danger" : "neutral"}
            />
            <OperationStat
              label="期限近い"
              count={dashboardCounts.deadlineSoon}
              detail={`${URGENT_DEADLINE_DAYS}日以内`}
              tone={dashboardCounts.deadlineSoon > 0 ? "warning" : "neutral"}
            />
            <OperationStat
              label="メール失敗"
              count={dashboardCounts.emailFailed}
              detail="再送または宛先確認"
              tone={dashboardCounts.emailFailed > 0 ? "danger" : "neutral"}
            />
            <OperationStat
              label="処理不整合"
              count={dashboardCounts.processingIssue}
              detail="返金・完了記録を確認"
              tone={dashboardCounts.processingIssue > 0 ? "danger" : "neutral"}
            />
          </section>

          <section className="withdrawals-admin__quick-links">
            <QuickFilterLink
              label={QUEUE_DEFINITIONS.all.label}
              count={dashboardCounts.total}
              active={queue === "all"}
              to={buildListUrl({
                queue: "all",
                status: "all",
                eligibilityStatus,
                search,
                limit,
              })}
            />
            <QuickFilterLink
              label={QUEUE_DEFINITIONS.awaiting_review.label}
              count={dashboardCounts.awaitingReview}
              active={queue === "awaiting_review"}
              to={buildListUrl({
                queue: "awaiting_review",
                status: "all",
                eligibilityStatus,
                search,
                limit,
              })}
            />
            <QuickFilterLink
              label={QUEUE_DEFINITIONS.deadline_expired.label}
              count={dashboardCounts.deadlineExpiredQueue}
              active={queue === "deadline_expired"}
              to={buildListUrl({
                queue: "deadline_expired",
                status: "all",
                eligibilityStatus,
                search,
                limit,
              })}
            />
            <QuickFilterLink
              label={QUEUE_DEFINITIONS.deadline_soon.label}
              count={dashboardCounts.deadlineSoonQueue}
              active={queue === "deadline_soon"}
              to={buildListUrl({
                queue: "deadline_soon",
                status: "all",
                eligibilityStatus,
                search,
                limit,
              })}
            />
            <QuickFilterLink
              label={QUEUE_DEFINITIONS.return_waiting.label}
              count={dashboardCounts.returnWaiting}
              active={queue === "return_waiting"}
              to={buildListUrl({
                queue: "return_waiting",
                status: "all",
                eligibilityStatus,
                search,
                limit,
              })}
            />
            <QuickFilterLink
              label={QUEUE_DEFINITIONS.return_instruction_missing.label}
              count={dashboardCounts.returnInstructionMissing}
              active={queue === "return_instruction_missing"}
              to={buildListUrl({
                queue: "return_instruction_missing",
                status: "all",
                eligibilityStatus,
                search,
                limit,
              })}
            />
            <QuickFilterLink
              label={QUEUE_DEFINITIONS.refund_waiting.label}
              count={dashboardCounts.refundWaiting}
              active={queue === "refund_waiting"}
              to={buildListUrl({
                queue: "refund_waiting",
                status: "all",
                eligibilityStatus,
                search,
                limit,
              })}
            />
            <QuickFilterLink
              label={QUEUE_DEFINITIONS.shopify_processing.label}
              count={dashboardCounts.shopifyProcessing}
              active={queue === "shopify_processing"}
              to={buildListUrl({
                queue: "shopify_processing",
                status: "all",
                eligibilityStatus,
                search,
                limit,
              })}
            />
            <QuickFilterLink
              label={QUEUE_DEFINITIONS.completion_notification.label}
              count={dashboardCounts.completionNotification}
              active={queue === "completion_notification"}
              to={buildListUrl({
                queue: "completion_notification",
                status: "all",
                eligibilityStatus,
                search,
                limit,
              })}
            />
            <QuickFilterLink
              label={QUEUE_DEFINITIONS.email_failed.label}
              count={dashboardCounts.emailFailed}
              active={queue === "email_failed"}
              to={buildListUrl({
                queue: "email_failed",
                status: "all",
                eligibilityStatus,
                search,
                limit,
              })}
            />
            <QuickFilterLink
              label={QUEUE_DEFINITIONS.processing_issue.label}
              count={dashboardCounts.processingIssue}
              active={queue === "processing_issue"}
              to={buildListUrl({
                queue: "processing_issue",
                status: "all",
                eligibilityStatus,
                search,
                limit,
              })}
            />
            <QuickFilterLink
              label={QUEUE_DEFINITIONS.open.label}
              count={dashboardCounts.open}
              active={queue === "open"}
              to={buildListUrl({
                queue: "open",
                status: "all",
                eligibilityStatus,
                search,
                limit,
              })}
            />
          </section>

          <section className="withdrawals-admin__card withdrawals-admin__summary">
            {summary.length === 0 ? (
              <div className="withdrawals-admin__empty">
                まだ申請はありません。
              </div>
            ) : (
              summary.map((item) => (
                <div
                  className="withdrawals-admin__summary-item"
                  key={item.status}
                >
                  <span>{item.label}</span>
                  <strong>{item.count}</strong>
                </div>
              ))
            )}
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
                  {requests.length === 0 ? (
                    <tr>
                      <td colSpan="13">
                        <div className="withdrawals-admin__empty">
                          条件に合う申請はありません。
                        </div>
                      </td>
                    </tr>
                  ) : (
                    requests.map((request) => (
                      <tr key={request.id}>
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
                            {request.shopifyOrderName ||
                              request.shopifyOrderNumber ||
                              "-"}
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
                            {request.deadlineUrgencyLabel ? (
                              <Badge tone={request.deadlineTone}>
                                {request.deadlineUrgencyLabel}
                              </Badge>
                            ) : null}
                          </div>
                        </td>
                        <td>
                          <div className="withdrawals-admin__cell-stack">
                            <span>返送: {request.returnStatusLabel}</span>
                            <span>返金: {request.refundDecisionLabel}</span>
                            {request.processingIssueLabel ? (
                              <Badge tone="danger">
                                {request.processingIssueLabel}
                              </Badge>
                            ) : null}
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
                          {request.emailActions.length > 0 ? (
                            <div className="withdrawals-admin__mini-actions">
                              {request.emailActions.map((action) => (
                                <Form
                                  key={action.intent}
                                  method="post"
                                  className="withdrawals-admin__mini-form"
                                >
                                  <input
                                    type="hidden"
                                    name="withdrawalRequestId"
                                    value={request.id}
                                  />
                                  <input
                                    type="hidden"
                                    name="intent"
                                    value={action.intent}
                                  />
                                  <button
                                    type="submit"
                                    className={`withdrawals-admin__mini-button withdrawals-admin__mini-button--${action.tone}`}
                                    disabled={isSubmitting}
                                    title={action.detail}
                                  >
                                    {action.label}
                                  </button>
                                </Form>
                              ))}
                            </div>
                          ) : (
                            <span className="withdrawals-admin__muted">-</span>
                          )}
                        </td>
                        <td>
                          <Link
                            className="withdrawals-admin__link"
                            to={`/app/withdrawals/${request.id}`}
                          >
                            開く
                          </Link>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}

function serializeWithdrawalRequest(request) {
  const latestEmail = request.emailLogs?.[0] || null;
  const deadlineInfo = getDeadlineInfo(request.deadlineAt);
  const latestEmailInfo = getLatestEmailInfo(latestEmail);
  const emailActions = getEmailActionsForRequest(request, {
    latestEmailInfo,
  });
  const nextAction = getNextActionForRequest(request, {
    deadlineInfo,
    latestEmailInfo,
  });
  const priority = getPriorityInfo(request, {
    deadlineInfo,
    latestEmailInfo,
    nextAction,
  });
  const returnInfo = getReturnInfo(request.returnRequirementStatus);
  const refundInfo = getRefundInfo(request.refundDecisionStatus);
  const processingIssues = getProcessingIssues(request);

  return {
    id: request.id,
    shopifyOrderName: request.shopifyOrderName,
    shopifyOrderNumber: request.shopifyOrderNumber,
    customerName: request.customerName,
    customerEmail: request.customerEmail,
    countryCode: request.countryCode,
    countryLabel: request.countryLabel,
    status: request.status,
    statusLabel: getWithdrawalStatusLabel(request.status),
    statusTone: getWithdrawalStatusTone(request.status),
    eligibilityStatus: request.eligibilityStatus,
    eligibilityLabel: getWithdrawalEligibilityLabel(request.eligibilityStatus),
    eligibilityTone: getWithdrawalEligibilityTone(request.eligibilityStatus),
    deadlineAtLabel: deadlineInfo.label,
    deadlineUrgencyLabel: deadlineInfo.urgencyLabel,
    deadlineTone: deadlineInfo.tone,
    latestEmailStatusLabel: latestEmailInfo.label,
    latestEmailStatusTone: latestEmailInfo.tone,
    nextActionLabel: nextAction.label,
    nextActionDetail: nextAction.detail,
    nextActionTone: nextAction.tone,
    priorityLabel: priority.label,
    priorityDetail: priority.detail,
    priorityTone: priority.tone,
    priorityRank: priority.rank,
    returnStatusLabel: returnInfo.label,
    refundDecisionLabel: refundInfo.label,
    processingIssueCount: processingIssues.length,
    processingIssueLabel:
      processingIssues.length > 0 ? `要確認 ${processingIssues.length}` : null,
    processingIssueDetail: processingIssues.join(" / "),
    emailActions,
    createdAtLabel: formatDate(request.createdAt),
    createdAtValue: request.createdAt ? new Date(request.createdAt).getTime() : 0,
  };
}

function sortWithdrawalRequestsForOperations(a, b) {
  if (a.priorityRank !== b.priorityRank) {
    return a.priorityRank - b.priorityRank;
  }
  return Number(b.createdAtValue || 0) - Number(a.createdAtValue || 0);
}

async function runWithdrawalListEmailAction({
  intent,
  withdrawalRequestId,
  request,
  prismaClient,
  emailServices,
}) {
  let result;

  switch (intent) {
    case "resend_acknowledgement":
      result = await emailServices.sendWithdrawalAcknowledgementEmail({
        withdrawalRequestId,
      });
      return buildListEmailActionResult({
        result,
        successMessage: "受付確認メールを送信しました。",
        failurePrefix: "受付確認メールを送信できませんでした",
      });

    case "send_return_instructions":
      result = await emailServices.sendWithdrawalReturnInstructionsEmail({
        withdrawalRequestId,
        request,
      });
      return buildListEmailActionResult({
        result,
        successMessage: "返送案内メールを送信しました。",
        failurePrefix: "返送案内メールを送信できませんでした",
      });

    case "send_completion_email":
      result = await emailServices.sendWithdrawalCompletionEmail({
        withdrawalRequestId,
      });
      return buildListEmailActionResult({
        result,
        successMessage: "完了通知メールを送信しました。",
        failurePrefix: "完了通知メールを送信できませんでした",
      });

    case "send_status_email":
      result = await emailServices.sendWithdrawalStatusEmail({
        withdrawalRequestId,
      });
      return buildListEmailActionResult({
        result,
        successMessage: "状況通知メールを送信しました。",
        failurePrefix: "状況通知メールを送信できませんでした",
      });

    case "retry_latest_failed_email":
      return retryLatestFailedWithdrawalEmail({
        withdrawalRequestId,
        request,
        prismaClient,
        emailServices,
      });

    default:
      return {
        ok: false,
        status: 400,
        message: "実行できない操作です。",
      };
  }
}

async function retryLatestFailedWithdrawalEmail({
  withdrawalRequestId,
  request,
  prismaClient,
  emailServices,
}) {
  const withdrawalRequest = await prismaClient.withdrawalRequest.findUnique({
    where: { id: withdrawalRequestId },
    include: {
      emailLogs: {
        where: { status: "failed" },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  if (!withdrawalRequest) {
    return {
      ok: false,
      status: 404,
      message: "撤回申請が見つかりません。",
    };
  }

  const failedEmailType = withdrawalRequest.emailLogs?.[0]?.emailType || "";

  if (!failedEmailType) {
    return {
      ok: false,
      status: 400,
      message: "再送対象の失敗メールがありません。",
    };
  }

  if (failedEmailType === "acknowledgement") {
    if (CLOSED_STATUSES.includes(withdrawalRequest.status)) {
      return {
        ok: false,
        status: 400,
        message: "完了済みの申請では受付確認メールを再送できません。",
      };
    }

    return runWithdrawalListEmailAction({
      intent: "resend_acknowledgement",
      withdrawalRequestId,
      request,
      prismaClient,
      emailServices,
    });
  }

  if (failedEmailType === "return_instructions") {
    return runWithdrawalListEmailAction({
      intent: "send_return_instructions",
      withdrawalRequestId,
      request,
      prismaClient,
      emailServices,
    });
  }

  if (failedEmailType === "completion") {
    return runWithdrawalListEmailAction({
      intent: "send_completion_email",
      withdrawalRequestId,
      request,
      prismaClient,
      emailServices,
    });
  }

  const result = await emailServices.sendWithdrawalStatusEmail({
    withdrawalRequestId,
    emailType: failedEmailType,
  });

  return buildListEmailActionResult({
    result,
    successMessage: "失敗していたメールを再送しました。",
    failurePrefix: "失敗メールを再送できませんでした",
  });
}

function buildListEmailActionResult({ result, successMessage, failurePrefix }) {
  if (result?.ok) {
    return {
      ok: true,
      status: 200,
      message: successMessage,
    };
  }

  return {
    ok: false,
    status: result?.status || 400,
    message: `${failurePrefix}: ${result?.error || "unknown"}`,
  };
}

function getPriorityInfo(request, { deadlineInfo, latestEmailInfo, nextAction }) {
  if (latestEmailInfo.status === "failed") {
    return {
      label: "メール失敗",
      detail: "購入者への通知を確認",
      tone: "danger",
      rank: 10,
    };
  }
  const processingIssues = getProcessingIssues(request);
  if (processingIssues.length > 0) {
    return {
      label: "処理不整合",
      detail: processingIssues[0],
      tone: "danger",
      rank: 15,
    };
  }
  if (deadlineInfo.status === "expired") {
    return {
      label: "期限超過",
      detail: "処理方針を先に確認",
      tone: "danger",
      rank: 20,
    };
  }
  if (deadlineInfo.status === "soon") {
    return {
      label: "期限近い",
      detail: "3日以内に期限",
      tone: "warning",
      rank: 30,
    };
  }
  if (REVIEW_QUEUE_STATUSES.includes(request.status)) {
    return {
      label: "受付確認",
      detail: "注文と対象商品を確認",
      tone: "warning",
      rank: 40,
    };
  }
  if (
    RETURN_WAITING_ORDER_STATUSES.includes(request.status) ||
    RETURN_WAITING_REQUIREMENT_STATUSES.includes(
      String(request.returnRequirementStatus || ""),
    )
  ) {
    return {
      label: "返送待ち",
      detail: "返送状況を確認",
      tone: "warning",
      rank: 50,
    };
  }
  if (nextAction.label === "返金判断") {
    return {
      label: "返金判断",
      detail: "商品状態と減額を確認",
      tone: "warning",
      rank: 60,
    };
  }
  if (isShopifyProcessingPending(request)) {
    return {
      label: "Shopify処理",
      detail: "手動返金またはキャンセル後に完了記録",
      tone: "warning",
      rank: 65,
    };
  }
  if (isCompletionNotificationPending(request)) {
    return {
      label: "完了通知",
      detail: "購入者へ完了通知を送信",
      tone: "warning",
      rank: 70,
    };
  }
  if (CLOSED_STATUSES.includes(request.status)) {
    return {
      label: "完了",
      detail: "追加対応なし",
      tone: "success",
      rank: 100,
    };
  }
  return {
    label: "通常",
    detail: nextAction.label,
    tone: "neutral",
    rank: 90,
  };
}

function getEmailActionsForRequest(request, { latestEmailInfo }) {
  const emailLogs = Array.isArray(request.emailLogs) ? request.emailLogs : [];
  const actions = [];
  const hasAcknowledgementSent = emailLogs.some(
    (log) =>
      log.emailType === "acknowledgement" &&
      String(log.status || "").toLowerCase() === "sent",
  );
  const hasReturnInstructionsSent = emailLogs.some(
    (log) =>
      log.emailType === "return_instructions" &&
      String(log.status || "").toLowerCase() === "sent",
  );
  const isClosed = CLOSED_STATUSES.includes(request.status);

  if (latestEmailInfo.status === "failed") {
    actions.push({
      intent: "retry_latest_failed_email",
      label: "失敗再送",
      detail: "直近の失敗メールを同じ種類で再送します。",
      tone: "danger",
    });
  }

  if (!isClosed && !hasAcknowledgementSent) {
    actions.push({
      intent: "resend_acknowledgement",
      label: "受付送信",
      detail: "受付確認メールを送信します。",
      tone: "neutral",
    });
  }

  if (
    request.status === WITHDRAWAL_STATUSES.RETURN_REQUESTED &&
    !hasReturnInstructionsSent
  ) {
    actions.push({
      intent: "send_return_instructions",
      label: "返送案内",
      detail: "返送証明リンクを発行して案内します。",
      tone: "warning",
    });
  }

  if (isCompletionNotificationPending(request)) {
    actions.push({
      intent: "send_completion_email",
      label: "完了通知",
      detail: "完了記録をもとに購入者へ通知します。",
      tone: "warning",
    });
  }

  return dedupeEmailActions(actions).slice(0, 3);
}

function dedupeEmailActions(actions) {
  const seen = new Set();

  return actions.filter((action) => {
    if (seen.has(action.intent)) return false;
    seen.add(action.intent);
    return true;
  });
}

function getReturnInfo(value) {
  switch (String(value || "UNKNOWN")) {
    case "NOT_REQUIRED":
      return { label: "不要" };
    case "REQUIRED":
      return { label: "必要" };
    case "WAITING":
      return { label: "待ち" };
    case "IN_TRANSIT":
      return { label: "返送中" };
    case "RECEIVED":
      return { label: "到着済み" };
    case "CONDITION_CHECKED":
      return { label: "状態確認済み" };
    default:
      return { label: "未設定" };
  }
}

function getRefundInfo(value) {
  switch (String(value || "UNDECIDED")) {
    case "FULL_REFUND":
      return { label: "全額" };
    case "PARTIAL_REFUND":
      return { label: "減額" };
    case "NO_REFUND":
      return { label: "返金なし" };
    case "UNDECIDED":
      return { label: "未判断" };
    default:
      return { label: String(value || "未判断") };
  }
}

function getProcessingIssues(request) {
  const issues = [];
  const status = String(request.status || "");
  const refundDecisionStatus = String(
    request.refundDecisionStatus || "UNDECIDED",
  );
  const completionStatus = String(request.completionStatus || "UNDECIDED");

  if (
    ["APPROVED", "REFUND_PENDING"].includes(status) &&
    refundDecisionStatus === "UNDECIDED"
  ) {
    issues.push("返金判断が未設定");
  }

  if (
    ["REFUNDED", "PARTIALLY_REFUNDED"].includes(completionStatus) &&
    request.completionRefundedAmount == null
  ) {
    issues.push("返金完了額が未記録");
  }

  if (
    ["REFUNDED", "PARTIALLY_REFUNDED"].includes(completionStatus) &&
    !request.completionShopifyRefundId
  ) {
    issues.push("Shopify返金IDが未記録");
  }

  if (completionStatus === "CANCELLED" && !request.completionShopifyCancelId) {
    issues.push("ShopifyキャンセルIDが未記録");
  }

  if (
    ["REFUNDED", "CANCELLED"].includes(status) &&
    completionStatus === "UNDECIDED"
  ) {
    issues.push("完了ステータスと完了記録が不一致");
  }

  if (
    ["NO_REFUND_CLOSED", "REJECTED_CLOSED"].includes(completionStatus) &&
    !request.completionAction &&
    !request.completionNotes
  ) {
    issues.push("返金なし/対象外完了の理由が未記録");
  }

  const hasReturnInstructionsSent = (request.emailLogs || []).some(
    (log) =>
      log.emailType === "return_instructions" &&
      String(log.status || "").toLowerCase() === "sent",
  );
  if (status === "RETURN_REQUESTED" && !hasReturnInstructionsSent) {
    issues.push("返送案内メールが未送信");
  }

  if (
    request.completedAt &&
    completionStatus !== "UNDECIDED" &&
    !request.completionNotifiedAt
  ) {
    issues.push("完了通知メールが未送信");
  }

  if (status === WITHDRAWAL_STATUSES.REJECTED && !request.rejectionReason) {
    issues.push("却下理由が未記録");
  }

  return issues;
}

function isShopifyProcessingPending(request) {
  const completionStatus = String(request.completionStatus || "UNDECIDED");
  const refundDecisionStatus = String(
    request.refundDecisionStatus || "UNDECIDED",
  );

  return (
    OPEN_STATUSES.includes(request.status) &&
    completionStatus === "UNDECIDED" &&
    (request.status === WITHDRAWAL_STATUSES.REFUND_PENDING ||
      ["FULL_REFUND", "PARTIAL_REFUND", "NO_REFUND"].includes(
        refundDecisionStatus,
      ))
  );
}

function isCompletionNotificationPending(request) {
  return (
    request.completedAt &&
    String(request.completionStatus || "UNDECIDED") !== "UNDECIDED" &&
    !request.completionNotifiedAt
  );
}

function getQueueWhere(queue, { now = new Date(), urgentDeadline = null } = {}) {
  const dueSoonAt =
    urgentDeadline ||
    new Date(now.getTime() + URGENT_DEADLINE_DAYS * 24 * 60 * 60 * 1000);
  switch (queue) {
    case "open":
      return { status: { in: OPEN_STATUSES } };
    case "deadline_expired":
      return {
        status: { in: OPEN_STATUSES },
        deadlineAt: { lt: now },
      };
    case "deadline_soon":
      return {
        status: { in: OPEN_STATUSES },
        deadlineAt: { gte: now, lte: dueSoonAt },
      };
    case "awaiting_review":
      return {
        OR: [
          { status: { in: REVIEW_QUEUE_STATUSES } },
          {
            eligibilityStatus: {
              in: [
                WITHDRAWAL_ELIGIBILITY_STATUSES.PENDING_REVIEW,
                WITHDRAWAL_ELIGIBILITY_STATUSES.NON_EU_REVIEW,
                WITHDRAWAL_ELIGIBILITY_STATUSES.DEADLINE_REVIEW,
                WITHDRAWAL_ELIGIBILITY_STATUSES.ORDER_NOT_FOUND_REVIEW,
                WITHDRAWAL_ELIGIBILITY_STATUSES.EMAIL_MISMATCH_REVIEW,
                WITHDRAWAL_ELIGIBILITY_STATUSES.EXEMPTION_REVIEW,
                WITHDRAWAL_ELIGIBILITY_STATUSES.VALUE_REDUCTION_REVIEW,
              ],
            },
          },
        ],
      };
    case "return_waiting":
      return {
        OR: [
          { status: { in: RETURN_WAITING_ORDER_STATUSES } },
          {
            returnRequirementStatus: {
              in: RETURN_WAITING_REQUIREMENT_STATUSES,
            },
          },
        ],
      };
    case "return_instruction_missing":
      return {
        status: WITHDRAWAL_STATUSES.RETURN_REQUESTED,
        emailLogs: {
          none: {
            emailType: "return_instructions",
            status: "sent",
          },
        },
      };
    case "refund_waiting":
      return {
        OR: [
          { status: { in: REFUND_WAITING_ORDER_STATUSES } },
          {
            refundDecisionStatus: "UNDECIDED",
            returnRequirementStatus: { in: REFUND_READY_RETURN_STATUSES },
            status: { in: OPEN_STATUSES },
          },
        ],
      };
    case "shopify_processing":
      return {
        status: { in: OPEN_STATUSES },
        completionStatus: "UNDECIDED",
        OR: [
          { status: WITHDRAWAL_STATUSES.REFUND_PENDING },
          {
            refundDecisionStatus: {
              in: ["FULL_REFUND", "PARTIAL_REFUND", "NO_REFUND"],
            },
          },
        ],
      };
    case "completion_notification":
      return {
        completedAt: { not: null },
        completionStatus: { not: "UNDECIDED" },
        completionNotifiedAt: null,
      };
    case "email_failed":
      return { emailLogs: { some: { status: "failed" } } };
    case "processing_issue":
      return getProcessingIssueWhere();
    default:
      return null;
  }
}

function getProcessingIssueWhere() {
  return {
    OR: [
      {
        status: { in: ["APPROVED", "REFUND_PENDING"] },
        refundDecisionStatus: "UNDECIDED",
      },
      {
        completionStatus: { in: ["REFUNDED", "PARTIALLY_REFUNDED"] },
        completionRefundedAmount: null,
      },
      {
        completionStatus: { in: ["REFUNDED", "PARTIALLY_REFUNDED"] },
        completionShopifyRefundId: null,
      },
      {
        completionStatus: "CANCELLED",
        completionShopifyCancelId: null,
      },
      {
        status: { in: ["REFUNDED", "CANCELLED"] },
        completionStatus: "UNDECIDED",
      },
      {
        completionStatus: { in: ["NO_REFUND_CLOSED", "REJECTED_CLOSED"] },
        completionAction: null,
        completionNotes: null,
      },
      {
        status: "RETURN_REQUESTED",
        emailLogs: {
          none: {
            emailType: "return_instructions",
            status: "sent",
          },
        },
      },
      {
        completedAt: { not: null },
        completionStatus: { not: "UNDECIDED" },
        completionNotifiedAt: null,
      },
      {
        status: WITHDRAWAL_STATUSES.REJECTED,
        rejectionReason: null,
      },
    ],
  };
}

function getNextActionForRequest(request, { deadlineInfo, latestEmailInfo }) {
  if (latestEmailInfo.status === "failed") {
    return {
      label: "メール再送",
      detail: "受付・通知メールの失敗を確認",
      tone: "danger",
    };
  }
  if (CLOSED_STATUSES.includes(request.status)) {
    return {
      label: "完了",
      detail: "追加対応は不要",
      tone: "success",
    };
  }
  if (deadlineInfo.status === "expired") {
    return {
      label: "期限確認",
      detail: "期限超過として扱うか確認",
      tone: "danger",
    };
  }
  if (REVIEW_QUEUE_STATUSES.includes(request.status)) {
    return {
      label: "受付確認",
      detail: "注文・メール・対象商品を確認",
      tone: "warning",
    };
  }
  if (
    request.eligibilityStatus &&
    request.eligibilityStatus !== WITHDRAWAL_ELIGIBILITY_STATUSES.ELIGIBLE
  ) {
    return {
      label: "判定確認",
      detail: getWithdrawalEligibilityLabel(request.eligibilityStatus),
      tone: getWithdrawalEligibilityTone(request.eligibilityStatus),
    };
  }
  if (
    request.status === WITHDRAWAL_STATUSES.APPROVED ||
    request.status === WITHDRAWAL_STATUSES.RETURN_REQUESTED ||
    RETURN_WAITING_REQUIREMENT_STATUSES.includes(
      String(request.returnRequirementStatus || ""),
    )
  ) {
    return {
      label: "返送確認",
      detail: "返送要否・追跡番号・到着状況を確認",
      tone: "warning",
    };
  }
  if (isShopifyProcessingPending(request)) {
    return {
      label: "Shopify処理",
      detail: "Shopifyで返金またはキャンセルし、完了記録を残す",
      tone: "warning",
    };
  }
  if (isCompletionNotificationPending(request)) {
    return {
      label: "完了通知",
      detail: "購入者へ完了通知メールを送信",
      tone: "warning",
    };
  }
  if (
    request.status === WITHDRAWAL_STATUSES.RETURN_RECEIVED ||
    request.status === WITHDRAWAL_STATUSES.REFUND_PENDING ||
    (String(request.refundDecisionStatus || "UNDECIDED") === "UNDECIDED" &&
      REFUND_READY_RETURN_STATUSES.includes(
        String(request.returnRequirementStatus || ""),
      ))
  ) {
    return {
      label: "返金判断",
      detail: "商品状態と減額有無を確認",
      tone: "warning",
    };
  }
  return {
    label: "詳細確認",
    detail: "申請内容を確認",
    tone: "neutral",
  };
}

function getDeadlineInfo(value) {
  if (!value) {
    return {
      label: "-",
      urgencyLabel: "要確認",
      tone: "warning",
      status: "unknown",
    };
  }

  const deadline = new Date(value);
  const now = new Date();
  const diffMs = deadline.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (!Number.isFinite(diffMs)) {
    return {
      label: String(value),
      urgencyLabel: "要確認",
      tone: "warning",
      status: "unknown",
    };
  }
  if (diffMs < 0) {
    return {
      label: formatDate(value),
      urgencyLabel: "期限超過",
      tone: "danger",
      status: "expired",
    };
  }
  if (diffDays <= 3) {
    return {
      label: formatDate(value),
      urgencyLabel: "期限近い",
      tone: "warning",
      status: "soon",
    };
  }
  return {
    label: formatDate(value),
    urgencyLabel: "",
    tone: "neutral",
    status: "ok",
  };
}

function getLatestEmailInfo(latestEmail) {
  if (!latestEmail) {
    return {
      label: "未送信",
      tone: "warning",
      status: "missing",
    };
  }
  if (latestEmail.status === "sent") {
    return {
      label: "送信済み",
      tone: "success",
      status: "sent",
    };
  }
  if (latestEmail.status === "failed") {
    return {
      label: "失敗",
      tone: "danger",
      status: "failed",
    };
  }
  return {
    label: latestEmail.status || "不明",
    tone: "neutral",
    status: latestEmail.status || "unknown",
  };
}

function QuickFilterLink({ label, count, active, to }) {
  return (
    <Link
      className={`withdrawals-admin__quick-link ${
        active ? "withdrawals-admin__quick-link--active" : ""
      }`}
      to={to}
    >
      <span>{label}</span>
      <strong>{count}</strong>
    </Link>
  );
}

function OperationStat({ label, count, detail, tone = "neutral" }) {
  return (
    <div
      className={`withdrawals-admin__ops-card withdrawals-admin__ops-card--${tone}`}
    >
      <span>{label}</span>
      <strong>{count}</strong>
      <small>{detail}</small>
    </div>
  );
}

function Badge({ tone, children }) {
  return (
    <span
      className={`withdrawals-admin__badge withdrawals-admin__badge--${tone}`}
    >
      {children}
    </span>
  );
}

function buildListUrl({ queue, status, eligibilityStatus, search, limit }) {
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

function clampLimit(rawValue) {
  const parsed = Number(rawValue || DEFAULT_LIMIT);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
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

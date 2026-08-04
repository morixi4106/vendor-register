import { WITHDRAWAL_ELIGIBILITY_STATUSES, WITHDRAWAL_STATUSES, getWithdrawalEligibilityLabel, getWithdrawalEligibilityTone, getWithdrawalStatusLabel, getWithdrawalStatusTone } from "../utils/withdrawalStatus.js";
import { DEFAULT_LIMIT, MAX_LIMIT, URGENT_DEADLINE_DAYS } from "./withdrawalAdminList.js";
const CLOSED_STATUSES = [WITHDRAWAL_STATUSES.REFUNDED, WITHDRAWAL_STATUSES.CANCELLED, WITHDRAWAL_STATUSES.REJECTED, WITHDRAWAL_STATUSES.EXPIRED];
export const OPEN_STATUSES = Object.values(WITHDRAWAL_STATUSES).filter(status => !CLOSED_STATUSES.includes(status));
const REVIEW_QUEUE_STATUSES = [WITHDRAWAL_STATUSES.REQUESTED, WITHDRAWAL_STATUSES.ACKNOWLEDGED, WITHDRAWAL_STATUSES.UNDER_REVIEW, WITHDRAWAL_STATUSES.ERROR];
const RETURN_WAITING_ORDER_STATUSES = [WITHDRAWAL_STATUSES.APPROVED, WITHDRAWAL_STATUSES.RETURN_REQUESTED];
const RETURN_WAITING_REQUIREMENT_STATUSES = ["REQUIRED", "WAITING", "IN_TRANSIT"];
const REFUND_WAITING_ORDER_STATUSES = [WITHDRAWAL_STATUSES.RETURN_RECEIVED, WITHDRAWAL_STATUSES.REFUND_PENDING];
const REFUND_READY_RETURN_STATUSES = ["NOT_REQUIRED", "RECEIVED", "CONDITION_CHECKED"];
export function serializeWithdrawalRequest(request) {
  const latestEmail = request.emailLogs?.[0] || null;
  const deadlineInfo = getDeadlineInfo(request.deadlineAt);
  const latestEmailInfo = getLatestEmailInfo(latestEmail);
  const emailActions = getEmailActionsForRequest(request, {
    latestEmailInfo
  });
  const nextAction = getNextActionForRequest(request, {
    deadlineInfo,
    latestEmailInfo
  });
  const priority = getPriorityInfo(request, {
    deadlineInfo,
    latestEmailInfo,
    nextAction
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
    processingIssueLabel: processingIssues.length > 0 ? `要確認 ${processingIssues.length}` : null,
    processingIssueDetail: processingIssues.join(" / "),
    emailActions,
    createdAtLabel: formatDate(request.createdAt),
    createdAtValue: request.createdAt ? new Date(request.createdAt).getTime() : 0
  };
}
export function sortWithdrawalRequestsForOperations(a, b) {
  if (a.priorityRank !== b.priorityRank) {
    return a.priorityRank - b.priorityRank;
  }
  return Number(b.createdAtValue || 0) - Number(a.createdAtValue || 0);
}
export async function runWithdrawalListEmailAction({
  intent,
  withdrawalRequestId,
  request,
  prismaClient,
  emailServices
}) {
  let result;
  switch (intent) {
    case "resend_acknowledgement":
      result = await emailServices.sendWithdrawalAcknowledgementEmail({
        withdrawalRequestId
      });
      return buildListEmailActionResult({
        result,
        successMessage: "受付確認メールを送信しました。",
        failurePrefix: "受付確認メールを送信できませんでした"
      });
    case "send_return_instructions":
      result = await emailServices.sendWithdrawalReturnInstructionsEmail({
        withdrawalRequestId,
        request
      });
      return buildListEmailActionResult({
        result,
        successMessage: "返送案内メールを送信しました。",
        failurePrefix: "返送案内メールを送信できませんでした"
      });
    case "send_completion_email":
      result = await emailServices.sendWithdrawalCompletionEmail({
        withdrawalRequestId
      });
      return buildListEmailActionResult({
        result,
        successMessage: "完了通知メールを送信しました。",
        failurePrefix: "完了通知メールを送信できませんでした"
      });
    case "send_status_email":
      result = await emailServices.sendWithdrawalStatusEmail({
        withdrawalRequestId
      });
      return buildListEmailActionResult({
        result,
        successMessage: "状況通知メールを送信しました。",
        failurePrefix: "状況通知メールを送信できませんでした"
      });
    case "retry_latest_failed_email":
      return retryLatestFailedWithdrawalEmail({
        withdrawalRequestId,
        request,
        prismaClient,
        emailServices
      });
    default:
      return {
        ok: false,
        status: 400,
        message: "実行できない操作です。"
      };
  }
}
async function retryLatestFailedWithdrawalEmail({
  withdrawalRequestId,
  request,
  prismaClient,
  emailServices
}) {
  const withdrawalRequest = await prismaClient.withdrawalRequest.findUnique({
    where: {
      id: withdrawalRequestId
    },
    include: {
      emailLogs: {
        where: {
          status: "failed"
        },
        orderBy: {
          createdAt: "desc"
        },
        take: 1
      }
    }
  });
  if (!withdrawalRequest) {
    return {
      ok: false,
      status: 404,
      message: "撤回申請が見つかりません。"
    };
  }
  const failedEmailType = withdrawalRequest.emailLogs?.[0]?.emailType || "";
  if (!failedEmailType) {
    return {
      ok: false,
      status: 400,
      message: "再送対象の失敗メールがありません。"
    };
  }
  if (failedEmailType === "acknowledgement") {
    if (CLOSED_STATUSES.includes(withdrawalRequest.status)) {
      return {
        ok: false,
        status: 400,
        message: "完了済みの申請では受付確認メールを再送できません。"
      };
    }
    return runWithdrawalListEmailAction({
      intent: "resend_acknowledgement",
      withdrawalRequestId,
      request,
      prismaClient,
      emailServices
    });
  }
  if (failedEmailType === "return_instructions") {
    return runWithdrawalListEmailAction({
      intent: "send_return_instructions",
      withdrawalRequestId,
      request,
      prismaClient,
      emailServices
    });
  }
  if (failedEmailType === "completion") {
    return runWithdrawalListEmailAction({
      intent: "send_completion_email",
      withdrawalRequestId,
      request,
      prismaClient,
      emailServices
    });
  }
  const result = await emailServices.sendWithdrawalStatusEmail({
    withdrawalRequestId,
    emailType: failedEmailType
  });
  return buildListEmailActionResult({
    result,
    successMessage: "失敗していたメールを再送しました。",
    failurePrefix: "失敗メールを再送できませんでした"
  });
}
function buildListEmailActionResult({
  result,
  successMessage,
  failurePrefix
}) {
  if (result?.ok) {
    return {
      ok: true,
      status: 200,
      message: successMessage
    };
  }
  return {
    ok: false,
    status: result?.status || 400,
    message: `${failurePrefix}: ${result?.error || "unknown"}`
  };
}
function getPriorityInfo(request, {
  deadlineInfo,
  latestEmailInfo,
  nextAction
}) {
  if (latestEmailInfo.status === "failed") {
    return {
      label: "メール失敗",
      detail: "購入者への通知を確認",
      tone: "danger",
      rank: 10
    };
  }
  const processingIssues = getProcessingIssues(request);
  if (processingIssues.length > 0) {
    return {
      label: "処理不整合",
      detail: processingIssues[0],
      tone: "danger",
      rank: 15
    };
  }
  if (deadlineInfo.status === "expired") {
    return {
      label: "期限超過",
      detail: "処理方針を先に確認",
      tone: "danger",
      rank: 20
    };
  }
  if (deadlineInfo.status === "soon") {
    return {
      label: "期限近い",
      detail: "3日以内に期限",
      tone: "warning",
      rank: 30
    };
  }
  if (REVIEW_QUEUE_STATUSES.includes(request.status)) {
    return {
      label: "受付確認",
      detail: "注文と対象商品を確認",
      tone: "warning",
      rank: 40
    };
  }
  if (RETURN_WAITING_ORDER_STATUSES.includes(request.status) || RETURN_WAITING_REQUIREMENT_STATUSES.includes(String(request.returnRequirementStatus || ""))) {
    return {
      label: "返送待ち",
      detail: "返送状況を確認",
      tone: "warning",
      rank: 50
    };
  }
  if (nextAction.label === "返金判断") {
    return {
      label: "返金判断",
      detail: "商品状態と減額を確認",
      tone: "warning",
      rank: 60
    };
  }
  if (isShopifyProcessingPending(request)) {
    return {
      label: "Shopify処理",
      detail: "手動返金またはキャンセル後に完了記録",
      tone: "warning",
      rank: 65
    };
  }
  if (isCompletionNotificationPending(request)) {
    return {
      label: "完了通知",
      detail: "購入者へ完了通知を送信",
      tone: "warning",
      rank: 70
    };
  }
  if (CLOSED_STATUSES.includes(request.status)) {
    return {
      label: "完了",
      detail: "追加対応なし",
      tone: "success",
      rank: 100
    };
  }
  return {
    label: "通常",
    detail: nextAction.label,
    tone: "neutral",
    rank: 90
  };
}
function getEmailActionsForRequest(request, {
  latestEmailInfo
}) {
  const emailLogs = Array.isArray(request.emailLogs) ? request.emailLogs : [];
  const actions = [];
  const hasAcknowledgementSent = emailLogs.some(log => log.emailType === "acknowledgement" && String(log.status || "").toLowerCase() === "sent");
  const hasReturnInstructionsSent = emailLogs.some(log => log.emailType === "return_instructions" && String(log.status || "").toLowerCase() === "sent");
  const isClosed = CLOSED_STATUSES.includes(request.status);
  if (latestEmailInfo.status === "failed") {
    actions.push({
      intent: "retry_latest_failed_email",
      label: "失敗再送",
      detail: "直近の失敗メールを同じ種類で再送します。",
      tone: "danger"
    });
  }
  if (!isClosed && !hasAcknowledgementSent) {
    actions.push({
      intent: "resend_acknowledgement",
      label: "受付送信",
      detail: "受付確認メールを送信します。",
      tone: "neutral"
    });
  }
  if (request.status === WITHDRAWAL_STATUSES.RETURN_REQUESTED && !hasReturnInstructionsSent) {
    actions.push({
      intent: "send_return_instructions",
      label: "返送案内",
      detail: "返送証明リンクを発行して案内します。",
      tone: "warning"
    });
  }
  if (isCompletionNotificationPending(request)) {
    actions.push({
      intent: "send_completion_email",
      label: "完了通知",
      detail: "完了記録をもとに購入者へ通知します。",
      tone: "warning"
    });
  }
  return dedupeEmailActions(actions).slice(0, 3);
}
function dedupeEmailActions(actions) {
  const seen = new Set();
  return actions.filter(action => {
    if (seen.has(action.intent)) return false;
    seen.add(action.intent);
    return true;
  });
}
function getReturnInfo(value) {
  switch (String(value || "UNKNOWN")) {
    case "NOT_REQUIRED":
      return {
        label: "不要"
      };
    case "REQUIRED":
      return {
        label: "必要"
      };
    case "WAITING":
      return {
        label: "待ち"
      };
    case "IN_TRANSIT":
      return {
        label: "返送中"
      };
    case "RECEIVED":
      return {
        label: "到着済み"
      };
    case "CONDITION_CHECKED":
      return {
        label: "状態確認済み"
      };
    default:
      return {
        label: "未設定"
      };
  }
}
function getRefundInfo(value) {
  switch (String(value || "UNDECIDED")) {
    case "FULL_REFUND":
      return {
        label: "全額"
      };
    case "PARTIAL_REFUND":
      return {
        label: "減額"
      };
    case "NO_REFUND":
      return {
        label: "返金なし"
      };
    case "UNDECIDED":
      return {
        label: "未判断"
      };
    default:
      return {
        label: String(value || "未判断")
      };
  }
}
function getProcessingIssues(request) {
  const issues = [];
  const status = String(request.status || "");
  const refundDecisionStatus = String(request.refundDecisionStatus || "UNDECIDED");
  const completionStatus = String(request.completionStatus || "UNDECIDED");
  if (["APPROVED", "REFUND_PENDING"].includes(status) && refundDecisionStatus === "UNDECIDED") {
    issues.push("返金判断が未設定");
  }
  if (["REFUNDED", "PARTIALLY_REFUNDED"].includes(completionStatus) && request.completionRefundedAmount == null) {
    issues.push("返金完了額が未記録");
  }
  if (["REFUNDED", "PARTIALLY_REFUNDED"].includes(completionStatus) && !request.completionShopifyRefundId) {
    issues.push("Shopify返金IDが未記録");
  }
  if (completionStatus === "CANCELLED" && !request.completionShopifyCancelId) {
    issues.push("ShopifyキャンセルIDが未記録");
  }
  if (["REFUNDED", "CANCELLED"].includes(status) && completionStatus === "UNDECIDED") {
    issues.push("完了ステータスと完了記録が不一致");
  }
  if (["NO_REFUND_CLOSED", "REJECTED_CLOSED"].includes(completionStatus) && !request.completionAction && !request.completionNotes) {
    issues.push("返金なし/対象外完了の理由が未記録");
  }
  const hasReturnInstructionsSent = (request.emailLogs || []).some(log => log.emailType === "return_instructions" && String(log.status || "").toLowerCase() === "sent");
  if (status === "RETURN_REQUESTED" && !hasReturnInstructionsSent) {
    issues.push("返送案内メールが未送信");
  }
  if (request.completedAt && completionStatus !== "UNDECIDED" && !request.completionNotifiedAt) {
    issues.push("完了通知メールが未送信");
  }
  if (status === WITHDRAWAL_STATUSES.REJECTED && !request.rejectionReason) {
    issues.push("却下理由が未記録");
  }
  return issues;
}
function isShopifyProcessingPending(request) {
  const completionStatus = String(request.completionStatus || "UNDECIDED");
  const refundDecisionStatus = String(request.refundDecisionStatus || "UNDECIDED");
  return OPEN_STATUSES.includes(request.status) && completionStatus === "UNDECIDED" && (request.status === WITHDRAWAL_STATUSES.REFUND_PENDING || ["FULL_REFUND", "PARTIAL_REFUND", "NO_REFUND"].includes(refundDecisionStatus));
}
function isCompletionNotificationPending(request) {
  return request.completedAt && String(request.completionStatus || "UNDECIDED") !== "UNDECIDED" && !request.completionNotifiedAt;
}
export function getQueueWhere(queue, {
  now = new Date(),
  urgentDeadline = null
} = {}) {
  const dueSoonAt = urgentDeadline || new Date(now.getTime() + URGENT_DEADLINE_DAYS * 24 * 60 * 60 * 1000);
  switch (queue) {
    case "open":
      return {
        status: {
          in: OPEN_STATUSES
        }
      };
    case "deadline_expired":
      return {
        status: {
          in: OPEN_STATUSES
        },
        deadlineAt: {
          lt: now
        }
      };
    case "deadline_soon":
      return {
        status: {
          in: OPEN_STATUSES
        },
        deadlineAt: {
          gte: now,
          lte: dueSoonAt
        }
      };
    case "awaiting_review":
      return {
        OR: [{
          status: {
            in: REVIEW_QUEUE_STATUSES
          }
        }, {
          eligibilityStatus: {
            in: [WITHDRAWAL_ELIGIBILITY_STATUSES.PENDING_REVIEW, WITHDRAWAL_ELIGIBILITY_STATUSES.NON_EU_REVIEW, WITHDRAWAL_ELIGIBILITY_STATUSES.DEADLINE_REVIEW, WITHDRAWAL_ELIGIBILITY_STATUSES.ORDER_NOT_FOUND_REVIEW, WITHDRAWAL_ELIGIBILITY_STATUSES.EMAIL_MISMATCH_REVIEW, WITHDRAWAL_ELIGIBILITY_STATUSES.EXEMPTION_REVIEW, WITHDRAWAL_ELIGIBILITY_STATUSES.VALUE_REDUCTION_REVIEW]
          }
        }]
      };
    case "return_waiting":
      return {
        OR: [{
          status: {
            in: RETURN_WAITING_ORDER_STATUSES
          }
        }, {
          returnRequirementStatus: {
            in: RETURN_WAITING_REQUIREMENT_STATUSES
          }
        }]
      };
    case "return_instruction_missing":
      return {
        status: WITHDRAWAL_STATUSES.RETURN_REQUESTED,
        emailLogs: {
          none: {
            emailType: "return_instructions",
            status: "sent"
          }
        }
      };
    case "refund_waiting":
      return {
        OR: [{
          status: {
            in: REFUND_WAITING_ORDER_STATUSES
          }
        }, {
          refundDecisionStatus: "UNDECIDED",
          returnRequirementStatus: {
            in: REFUND_READY_RETURN_STATUSES
          },
          status: {
            in: OPEN_STATUSES
          }
        }]
      };
    case "shopify_processing":
      return {
        status: {
          in: OPEN_STATUSES
        },
        completionStatus: "UNDECIDED",
        OR: [{
          status: WITHDRAWAL_STATUSES.REFUND_PENDING
        }, {
          refundDecisionStatus: {
            in: ["FULL_REFUND", "PARTIAL_REFUND", "NO_REFUND"]
          }
        }]
      };
    case "completion_notification":
      return {
        completedAt: {
          not: null
        },
        completionStatus: {
          not: "UNDECIDED"
        },
        completionNotifiedAt: null
      };
    case "email_failed":
      return {
        emailLogs: {
          some: {
            status: "failed"
          }
        }
      };
    case "processing_issue":
      return getProcessingIssueWhere();
    default:
      return null;
  }
}
export function getProcessingIssueWhere() {
  return {
    OR: [{
      status: {
        in: ["APPROVED", "REFUND_PENDING"]
      },
      refundDecisionStatus: "UNDECIDED"
    }, {
      completionStatus: {
        in: ["REFUNDED", "PARTIALLY_REFUNDED"]
      },
      completionRefundedAmount: null
    }, {
      completionStatus: {
        in: ["REFUNDED", "PARTIALLY_REFUNDED"]
      },
      completionShopifyRefundId: null
    }, {
      completionStatus: "CANCELLED",
      completionShopifyCancelId: null
    }, {
      status: {
        in: ["REFUNDED", "CANCELLED"]
      },
      completionStatus: "UNDECIDED"
    }, {
      completionStatus: {
        in: ["NO_REFUND_CLOSED", "REJECTED_CLOSED"]
      },
      completionAction: null,
      completionNotes: null
    }, {
      status: "RETURN_REQUESTED",
      emailLogs: {
        none: {
          emailType: "return_instructions",
          status: "sent"
        }
      }
    }, {
      completedAt: {
        not: null
      },
      completionStatus: {
        not: "UNDECIDED"
      },
      completionNotifiedAt: null
    }, {
      status: WITHDRAWAL_STATUSES.REJECTED,
      rejectionReason: null
    }]
  };
}
function getNextActionForRequest(request, {
  deadlineInfo,
  latestEmailInfo
}) {
  if (latestEmailInfo.status === "failed") {
    return {
      label: "メール再送",
      detail: "受付・通知メールの失敗を確認",
      tone: "danger"
    };
  }
  if (CLOSED_STATUSES.includes(request.status)) {
    return {
      label: "完了",
      detail: "追加対応は不要",
      tone: "success"
    };
  }
  if (deadlineInfo.status === "expired") {
    return {
      label: "期限確認",
      detail: "期限超過として扱うか確認",
      tone: "danger"
    };
  }
  if (REVIEW_QUEUE_STATUSES.includes(request.status)) {
    return {
      label: "受付確認",
      detail: "注文・メール・対象商品を確認",
      tone: "warning"
    };
  }
  if (request.eligibilityStatus && request.eligibilityStatus !== WITHDRAWAL_ELIGIBILITY_STATUSES.ELIGIBLE) {
    return {
      label: "判定確認",
      detail: getWithdrawalEligibilityLabel(request.eligibilityStatus),
      tone: getWithdrawalEligibilityTone(request.eligibilityStatus)
    };
  }
  if (request.status === WITHDRAWAL_STATUSES.APPROVED || request.status === WITHDRAWAL_STATUSES.RETURN_REQUESTED || RETURN_WAITING_REQUIREMENT_STATUSES.includes(String(request.returnRequirementStatus || ""))) {
    return {
      label: "返送確認",
      detail: "返送要否・追跡番号・到着状況を確認",
      tone: "warning"
    };
  }
  if (isShopifyProcessingPending(request)) {
    return {
      label: "Shopify処理",
      detail: "Shopifyで返金またはキャンセルし、完了記録を残す",
      tone: "warning"
    };
  }
  if (isCompletionNotificationPending(request)) {
    return {
      label: "完了通知",
      detail: "購入者へ完了通知メールを送信",
      tone: "warning"
    };
  }
  if (request.status === WITHDRAWAL_STATUSES.RETURN_RECEIVED || request.status === WITHDRAWAL_STATUSES.REFUND_PENDING || String(request.refundDecisionStatus || "UNDECIDED") === "UNDECIDED" && REFUND_READY_RETURN_STATUSES.includes(String(request.returnRequirementStatus || ""))) {
    return {
      label: "返金判断",
      detail: "商品状態と減額有無を確認",
      tone: "warning"
    };
  }
  return {
    label: "詳細確認",
    detail: "申請内容を確認",
    tone: "neutral"
  };
}
function getDeadlineInfo(value) {
  if (!value) {
    return {
      label: "-",
      urgencyLabel: "要確認",
      tone: "warning",
      status: "unknown"
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
      status: "unknown"
    };
  }
  if (diffMs < 0) {
    return {
      label: formatDate(value),
      urgencyLabel: "期限超過",
      tone: "danger",
      status: "expired"
    };
  }
  if (diffDays <= 3) {
    return {
      label: formatDate(value),
      urgencyLabel: "期限近い",
      tone: "warning",
      status: "soon"
    };
  }
  return {
    label: formatDate(value),
    urgencyLabel: "",
    tone: "neutral",
    status: "ok"
  };
}
function getLatestEmailInfo(latestEmail) {
  if (!latestEmail) {
    return {
      label: "未送信",
      tone: "warning",
      status: "missing"
    };
  }
  if (latestEmail.status === "sent") {
    return {
      label: "送信済み",
      tone: "success",
      status: "sent"
    };
  }
  if (latestEmail.status === "failed") {
    return {
      label: "失敗",
      tone: "danger",
      status: "failed"
    };
  }
  return {
    label: latestEmail.status || "不明",
    tone: "neutral",
    status: latestEmail.status || "unknown"
  };
}
export function clampLimit(rawValue) {
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
      minute: "2-digit"
    }).format(new Date(value));
  } catch (_error) {
    return String(value);
  }
}

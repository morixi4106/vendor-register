import { json } from "@remix-run/node";
import prisma from "../db.server.js";
import { authenticate } from "../shopify.server";
import { getWithdrawalStatusLabel } from "../utils/withdrawalStatus.js";
import { URGENT_DEADLINE_DAYS } from "../services/withdrawalAdminList.js";
import { OPEN_STATUSES, clampLimit, getProcessingIssueWhere, getQueueWhere, runWithdrawalListEmailAction, serializeWithdrawalRequest, sortWithdrawalRequestsForOperations } from "../services/withdrawalAdminList.server.js";
export const loader = async ({
  request
}) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const status = String(url.searchParams.get("status") || "all");
  const eligibilityStatus = String(url.searchParams.get("eligibilityStatus") || "all");
  const search = String(url.searchParams.get("search") || "").trim();
  const queue = String(url.searchParams.get("queue") || "all");
  const limit = clampLimit(url.searchParams.get("limit"));
  const now = new Date();
  const urgentDeadline = new Date(now.getTime() + URGENT_DEADLINE_DAYS * 24 * 60 * 60 * 1000);
  const where = {
    AND: []
  };
  if (status !== "all") where.status = status;
  if (eligibilityStatus !== "all") where.eligibilityStatus = eligibilityStatus;
  const queueWhere = getQueueWhere(queue, {
    now,
    urgentDeadline
  });
  if (queueWhere) where.AND.push(queueWhere);
  if (search) {
    where.AND.push({
      OR: [{
        shopifyOrderName: {
          contains: search,
          mode: "insensitive"
        }
      }, {
        shopifyOrderNumber: {
          contains: search,
          mode: "insensitive"
        }
      }, {
        customerEmail: {
          contains: search,
          mode: "insensitive"
        }
      }, {
        customerName: {
          contains: search,
          mode: "insensitive"
        }
      }, {
        id: {
          contains: search,
          mode: "insensitive"
        }
      }]
    });
  }
  if (where.AND.length === 0) delete where.AND;
  try {
    const [requests, summary, totalCount, openCount, awaitingReviewCount, deadlineExpiredQueueCount, deadlineSoonQueueCount, returnWaitingCount, returnInstructionMissingCount, refundWaitingCount, shopifyProcessingCount, completionNotificationCount, emailFailedCount, deadlineExpiredCount, deadlineSoonCount, processingIssueCount, attentionCount] = await Promise.all([prisma.withdrawalRequest.findMany({
      where,
      orderBy: {
        createdAt: "desc"
      },
      take: limit,
      include: {
        emailLogs: {
          orderBy: {
            createdAt: "desc"
          },
          take: 10
        }
      }
    }), prisma.withdrawalRequest.groupBy({
      by: ["status"],
      _count: {
        _all: true
      }
    }), prisma.withdrawalRequest.count(), prisma.withdrawalRequest.count({
      where: {
        status: {
          in: OPEN_STATUSES
        }
      }
    }), prisma.withdrawalRequest.count({
      where: getQueueWhere("awaiting_review", {
        now,
        urgentDeadline
      })
    }), prisma.withdrawalRequest.count({
      where: getQueueWhere("deadline_expired", {
        now,
        urgentDeadline
      })
    }), prisma.withdrawalRequest.count({
      where: getQueueWhere("deadline_soon", {
        now,
        urgentDeadline
      })
    }), prisma.withdrawalRequest.count({
      where: getQueueWhere("return_waiting", {
        now,
        urgentDeadline
      })
    }), prisma.withdrawalRequest.count({
      where: getQueueWhere("return_instruction_missing", {
        now,
        urgentDeadline
      })
    }), prisma.withdrawalRequest.count({
      where: getQueueWhere("refund_waiting", {
        now,
        urgentDeadline
      })
    }), prisma.withdrawalRequest.count({
      where: getQueueWhere("shopify_processing", {
        now,
        urgentDeadline
      })
    }), prisma.withdrawalRequest.count({
      where: getQueueWhere("completion_notification", {
        now,
        urgentDeadline
      })
    }), prisma.withdrawalRequest.count({
      where: {
        emailLogs: {
          some: {
            status: "failed"
          }
        }
      }
    }), prisma.withdrawalRequest.count({
      where: {
        status: {
          in: OPEN_STATUSES
        },
        deadlineAt: {
          lt: now
        }
      }
    }), prisma.withdrawalRequest.count({
      where: {
        status: {
          in: OPEN_STATUSES
        },
        deadlineAt: {
          gte: now,
          lte: urgentDeadline
        }
      }
    }), prisma.withdrawalRequest.count({
      where: getProcessingIssueWhere()
    }), prisma.withdrawalRequest.count({
      where: {
        OR: [getQueueWhere("awaiting_review"), getQueueWhere("refund_waiting"), getQueueWhere("shopify_processing"), getQueueWhere("completion_notification"), getProcessingIssueWhere(), {
          emailLogs: {
            some: {
              status: "failed"
            }
          }
        }, {
          status: {
            in: OPEN_STATUSES
          },
          deadlineAt: {
            lte: urgentDeadline
          }
        }]
      }
    })]);
    const serializedRequests = requests.map(serializeWithdrawalRequest).sort(sortWithdrawalRequestsForOperations);
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
        attention: attentionCount
      },
      summary: summary.map(row => ({
        status: row.status,
        label: getWithdrawalStatusLabel(row.status),
        count: row._count?._all || 0
      })),
      requests: serializedRequests
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
        attention: 0
      },
      summary: [],
      requests: [],
      errorMessage: error?.code === "P2021" ? "撤回申請テーブルがまだ作成されていません。migrationを適用してください。" : "撤回申請を読み込めませんでした。"
    });
  }
};
export const action = async ({
  request
}) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const withdrawalRequestId = String(formData.get("withdrawalRequestId") || "").trim();
  if (!withdrawalRequestId) {
    return json({
      ok: false,
      message: "撤回申請IDが見つかりません。"
    }, {
      status: 400
    });
  }
  const emailServices = await import("../services/withdrawals.server.js");
  const result = await runWithdrawalListEmailAction({
    intent,
    withdrawalRequestId,
    request,
    prismaClient: prisma,
    emailServices
  });
  return json({
    ok: result.ok,
    message: result.message
  }, {
    status: result.status || 200
  });
};
export { default } from "../components/withdrawals/WithdrawalListPage.jsx";

import prisma from "../../db.server.js";
import { EU_PRODUCT_ALLOWED_STATUSES, EU_SELLER_ALLOWED_STATUSES } from "../../utils/deliveryEligibility.js";
import { createCheck } from "./common.js";
const WITHDRAWAL_OPEN_STATUSES = ["REQUESTED", "ACKNOWLEDGED", "UNDER_REVIEW", "APPROVED", "RETURN_REQUESTED", "RETURN_RECEIVED", "REFUND_PENDING", "ERROR"];
const URGENT_WITHDRAWAL_DEADLINE_DAYS = 3;
export async function inspectWithdrawalOperations({
  prismaClient = prisma,
  now = new Date(),
  updatedSince = null
} = {}) {
  if (!prismaClient.withdrawalRequest || !prismaClient.withdrawalEmailLog) {
    return {
      available: false,
      openCount: 0,
      deadlineExpiredCount: 0,
      deadlineSoonCount: 0,
      emailFailedCount: 0,
      processingIssueCount: 0,
      refundDecisionMissingCount: 0,
      refundCompletionMismatchCount: 0,
      returnInstructionMissingCount: 0,
      vendorNotificationMissingCount: 0,
      completionNotificationMissingCount: 0,
      rejectedWithoutReasonCount: 0,
      shopifyExternalRecordMissingCount: 0,
      outboxPendingCount: 0,
      outboxDeadLetterCount: 0,
      outboxFailedDueCount: 0,
      outboxStaleProcessingCount: 0,
      recentErrorCount: 0,
      legacyLocaleMissingCount: 0,
      publishedLegalBundleCount: 0,
      error: "withdrawal_tables_unavailable"
    };
  }
  const soon = new Date(now.getTime() + URGENT_WITHDRAWAL_DEADLINE_DAYS * 24 * 60 * 60 * 1000);
  try {
    const [openCount, deadlineExpiredCount, deadlineSoonCount, emailFailedCount, refundDecisionMissingCount, refundCompletionMismatchCount, returnInstructionMissingCount, vendorNotificationMissingCount, completionNotificationMissingCount, rejectedWithoutReasonCount, shopifyExternalRecordMissingCount, outboxPendingCount, outboxDeadLetterCount, outboxFailedDueCount, outboxStaleProcessingCount, recentErrorCount, legacyLocaleMissingCount, publishedLegalBundleCount] = await Promise.all([prismaClient.withdrawalRequest.count({
      where: {
        status: {
          in: WITHDRAWAL_OPEN_STATUSES
        }
      }
    }), prismaClient.withdrawalRequest.count({
      where: {
        status: {
          in: WITHDRAWAL_OPEN_STATUSES
        },
        deadlineAt: {
          lt: now
        }
      }
    }), prismaClient.withdrawalRequest.count({
      where: {
        status: {
          in: WITHDRAWAL_OPEN_STATUSES
        },
        deadlineAt: {
          gte: now,
          lte: soon
        }
      }
    }), prismaClient.withdrawalEmailLog.count({
      where: {
        status: "failed"
      }
    }), prismaClient.withdrawalRequest.count({
      where: {
        status: {
          in: ["APPROVED", "REFUND_PENDING"]
        },
        refundDecisionStatus: "UNDECIDED"
      }
    }), prismaClient.withdrawalRequest.count({
      where: {
        OR: [{
          completionStatus: {
            in: ["REFUNDED", "PARTIALLY_REFUNDED"]
          },
          completionRefundedAmount: null
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
        }]
      }
    }), prismaClient.withdrawalRequest.count({
      where: {
        status: "RETURN_REQUESTED",
        emailLogs: {
          none: {
            emailType: "return_instructions",
            status: "sent"
          }
        }
      }
    }), prismaClient.withdrawalRequest.count({
      where: {
        status: {
          notIn: ["REJECTED", "EXPIRED"]
        },
        emailLogs: {
          none: {
            emailType: "vendor_notification",
            status: "sent"
          }
        }
      }
    }), prismaClient.withdrawalRequest.count({
      where: {
        completedAt: {
          not: null
        },
        completionStatus: {
          not: "UNDECIDED"
        },
        completionNotifiedAt: null
      }
    }), prismaClient.withdrawalRequest.count({
      where: {
        status: "REJECTED",
        rejectionReason: null
      }
    }), prismaClient.withdrawalRequest.count({
      where: {
        OR: [{
          completionStatus: {
            in: ["REFUNDED", "PARTIALLY_REFUNDED"]
          },
          completionShopifyRefundId: null
        }, {
          completionStatus: "CANCELLED",
          completionShopifyCancelId: null
        }]
      }
    }), prismaClient.withdrawalEmailOutbox?.count ? prismaClient.withdrawalEmailOutbox.count({
      where: {
        status: {
          in: ["PENDING", "PROCESSING", "FAILED"]
        }
      }
    }) : Promise.resolve(0), prismaClient.withdrawalEmailOutbox?.count ? prismaClient.withdrawalEmailOutbox.count({
      where: {
        status: "DEAD_LETTER"
      }
    }) : Promise.resolve(0), prismaClient.withdrawalEmailOutbox?.count ? prismaClient.withdrawalEmailOutbox.count({
      where: {
        status: "FAILED",
        nextAttemptAt: {
          lte: now
        }
      }
    }) : Promise.resolve(0), prismaClient.withdrawalEmailOutbox?.count ? prismaClient.withdrawalEmailOutbox.count({
      where: {
        status: "PROCESSING",
        lockedUntil: {
          lt: now
        }
      }
    }) : Promise.resolve(0), updatedSince ? prismaClient.withdrawalRequest.count({
      where: {
        status: "ERROR",
        updatedAt: {
          gte: updatedSince
        }
      }
    }) : Promise.resolve(0), prismaClient.withdrawalRequest.count({
      where: {
        OR: [{
          submittedAt: null
        }, {
          submittedViewLocale: null
        }, {
          correspondenceLocale: null
        }]
      }
    }), prismaClient.withdrawalLegalBundle?.count ? prismaClient.withdrawalLegalBundle.count({
      where: {
        status: "PUBLISHED"
      }
    }) : Promise.resolve(0)]);
    const processingIssueCount = refundDecisionMissingCount + refundCompletionMismatchCount + returnInstructionMissingCount + vendorNotificationMissingCount + completionNotificationMissingCount + rejectedWithoutReasonCount + shopifyExternalRecordMissingCount;
    return {
      available: true,
      openCount,
      deadlineExpiredCount,
      deadlineSoonCount,
      emailFailedCount,
      processingIssueCount,
      refundDecisionMissingCount,
      refundCompletionMismatchCount,
      returnInstructionMissingCount,
      vendorNotificationMissingCount,
      completionNotificationMissingCount,
      rejectedWithoutReasonCount,
      shopifyExternalRecordMissingCount,
      outboxPendingCount,
      outboxDeadLetterCount,
      outboxFailedDueCount,
      outboxStaleProcessingCount,
      recentErrorCount,
      legacyLocaleMissingCount,
      publishedLegalBundleCount,
      error: null
    };
  } catch (error) {
    console.error("withdrawal readiness inspect error:", error);
    return {
      available: false,
      openCount: 0,
      deadlineExpiredCount: 0,
      deadlineSoonCount: 0,
      emailFailedCount: 0,
      processingIssueCount: 0,
      refundDecisionMissingCount: 0,
      refundCompletionMismatchCount: 0,
      returnInstructionMissingCount: 0,
      vendorNotificationMissingCount: 0,
      completionNotificationMissingCount: 0,
      rejectedWithoutReasonCount: 0,
      shopifyExternalRecordMissingCount: 0,
      outboxPendingCount: 0,
      outboxDeadLetterCount: 0,
      outboxFailedDueCount: 0,
      outboxStaleProcessingCount: 0,
      recentErrorCount: 0,
      legacyLocaleMissingCount: 0,
      publishedLegalBundleCount: 0,
      error: error?.code || "withdrawal_readiness_failed"
    };
  }
}
export async function inspectDirectReturnReadiness({
  prismaClient = prisma
} = {}) {
  if (!prismaClient?.withdrawalWorkflowPolicy?.findFirst || !prismaClient?.vendorStore?.findMany) {
    return {
      available: false,
      activePolicy: null,
      relevantStoreCount: 0,
      missingAddressStores: [],
      error: "direct_return_tables_unavailable"
    };
  }
  try {
    const [activePolicy, relevantStores] = await Promise.all([prismaClient.withdrawalWorkflowPolicy.findFirst({
      where: {
        active: true,
        directReturnEnabled: true
      },
      orderBy: [{
        version: "desc"
      }]
    }), prismaClient.vendorStore.findMany({
      where: {
        isTestStore: false,
        seller: {
          euSellerStatus: {
            in: [...EU_SELLER_ALLOWED_STATUSES]
          }
        },
        products: {
          some: {
            OR: [{
              productEuStatus: {
                in: [...EU_PRODUCT_ALLOWED_STATUSES]
              }
            }, {
              euSaleRequested: true
            }]
          }
        }
      },
      select: {
        id: true,
        storeName: true,
        returnAddresses: {
          where: {
            status: "ACTIVE"
          },
          select: {
            id: true,
            countryCode: true,
            internationalRecipientName: true,
            internationalAddressLines: true,
            locales: {
              where: {
                locale: "en-GB"
              },
              select: {
                id: true
              }
            }
          },
          take: 1
        }
      }
    })]);
    return {
      available: true,
      activePolicy,
      relevantStoreCount: relevantStores.length,
      missingAddressStores: relevantStores.filter(store => store.returnAddresses.length === 0).map(store => ({
        id: store.id,
        storeName: store.storeName
      })),
      incompleteInternationalAddressStores: relevantStores.filter(store => {
        const address = store.returnAddresses[0];
        if (!address) return false;
        const lines = Array.isArray(address.internationalAddressLines) ? address.internationalAddressLines.filter(Boolean) : [];
        return !address.internationalRecipientName || lines.length === 0 || address.locales.length === 0;
      }).map(store => ({
        id: store.id,
        storeName: store.storeName
      })),
      error: null
    };
  } catch (error) {
    return {
      available: false,
      activePolicy: null,
      relevantStoreCount: 0,
      missingAddressStores: [],
      incompleteInternationalAddressStores: [],
      error: error?.code || "direct_return_readiness_failed"
    };
  }
}
export function buildDirectReturnChecks({
  directReturns
}) {
  if (!directReturns.available) {
    return [createCheck({
      id: "withdrawal_direct_return_tables",
      category: "app",
      status: "warning",
      title: "店舗別返送のデータベース",
      detail: `店舗別返送の準備状況を取得できません: ${directReturns.error}.`,
      action: "Prisma migrationを適用してから再確認してください。"
    })];
  }
  const missing = directReturns.missingAddressStores;
  const incompleteInternational = directReturns.incompleteInternationalAddressStores || [];
  return [createCheck({
    id: "withdrawal_direct_return_policy",
    category: "app",
    status: directReturns.activePolicy ? "pass" : "warning",
    title: "店舗別返送の運用方針",
    detail: directReturns.activePolicy ? `方針v${directReturns.activePolicy.version} / 規約版 ${directReturns.activePolicy.termsVersion} を新規申請に適用中です。` : "店舗別返送V2の有効な方針はありません。既存のV1運用は継続します。",
    action: directReturns.activePolicy ? "" : "/app/withdrawal-settings で契約形態と規約版を確認してから有効化してください。"
  }), createCheck({
    id: "withdrawal_direct_return_addresses",
    category: "app",
    status: missing.length > 0 ? "warning" : "pass",
    title: "EU販売店舗の返送先",
    detail: missing.length > 0 ? `${directReturns.relevantStoreCount}店舗中${missing.length}店舗に有効な返送先がありません: ${missing.map(store => store.storeName).join("、")}` : `${directReturns.relevantStoreCount}件のEU販売対象店舗に有効な返送先があります。`,
    action: missing.length > 0 ? "各店舗の「返送先設定」で、実際に返品を受領できる住所を確認して有効化してください。" : ""
  }), createCheck({
    id: "withdrawal_direct_return_international_addresses",
    category: "app",
    status: incompleteInternational.length > 0 ? "warning" : "pass",
    title: "海外購入者向け返送先表記",
    detail: incompleteInternational.length > 0 ? `${incompleteInternational.length}店舗で英字の宛名・住所・案内が不足しています: ${incompleteInternational.map(store => store.storeName).join("、")}` : "EU販売対象店舗の有効な返送先に英字表記があります。",
    action: incompleteInternational.length > 0 ? "各店舗の「返品受取先」で海外から返送できる英字表記を登録し、返送先を再度有効化してください。" : ""
  })];
}
export function buildWithdrawalOperationChecks({
  withdrawalOperations
}) {
  const checks = [];
  checks.push(createCheck({
    id: "withdrawal_operations_available",
    category: "app",
    status: withdrawalOperations.available ? "pass" : "warning",
    title: "Withdrawal request operation data",
    detail: withdrawalOperations.available ? "Withdrawal request tables are available for operational readiness checks." : `Withdrawal request operation data could not be loaded: ${withdrawalOperations.error}.`,
    action: withdrawalOperations.available ? "" : "Apply Prisma migrations and reload this page before relying on withdrawal request counts."
  }));
  checks.push(createCheck({
    id: "withdrawal_open_requests",
    category: "app",
    status: withdrawalOperations.available && withdrawalOperations.openCount > 0 ? "manual" : "pass",
    title: "Open withdrawal requests",
    detail: withdrawalOperations.available ? `${withdrawalOperations.openCount} open withdrawal request(s) need normal operation review.` : "Skipped because withdrawal request tables are unavailable.",
    action: withdrawalOperations.available && withdrawalOperations.openCount > 0 ? "Review /app/withdrawals and keep each request moving through return, refund, or closure." : ""
  }));
  checks.push(createCheck({
    id: "withdrawal_deadlines",
    category: "app",
    status: withdrawalOperations.deadlineExpiredCount > 0 ? "warning" : withdrawalOperations.deadlineSoonCount > 0 ? "manual" : "pass",
    title: "Withdrawal request deadlines",
    detail: withdrawalOperations.available ? `${withdrawalOperations.deadlineExpiredCount} expired, ${withdrawalOperations.deadlineSoonCount} due within ${URGENT_WITHDRAWAL_DEADLINE_DAYS} days.` : "Skipped because withdrawal request tables are unavailable.",
    action: withdrawalOperations.deadlineExpiredCount > 0 ? "Open /app/withdrawals and handle expired withdrawal requests first." : withdrawalOperations.deadlineSoonCount > 0 ? "Review requests approaching their deadline from /app/withdrawals." : ""
  }));
  checks.push(createCheck({
    id: "withdrawal_email_failures",
    category: "app",
    status: withdrawalOperations.emailFailedCount > 0 ? "warning" : "pass",
    title: "Withdrawal email failures",
    detail: withdrawalOperations.available ? `${withdrawalOperations.emailFailedCount} withdrawal email failure(s) are recorded.` : "Skipped because withdrawal email logs are unavailable.",
    action: withdrawalOperations.emailFailedCount > 0 ? "Open /app/withdrawals, filter by email failures, and resend or confirm the customer address." : ""
  }));
  checks.push(createCheck({
    id: "withdrawal_email_outbox",
    category: "app",
    status: withdrawalOperations.outboxDeadLetterCount > 0 || withdrawalOperations.outboxStaleProcessingCount > 0 ? "fail" : withdrawalOperations.outboxFailedDueCount > 0 || withdrawalOperations.outboxPendingCount > 0 ? "manual" : "pass",
    title: "撤回メール送信キュー",
    detail: withdrawalOperations.available ? `送信待ち ${withdrawalOperations.outboxPendingCount}件、再送期限超過 ${withdrawalOperations.outboxFailedDueCount}件、処理停止の疑い ${withdrawalOperations.outboxStaleProcessingCount}件、手動確認が必要 ${withdrawalOperations.outboxDeadLetterCount}件です。` : "撤回メール送信キューを確認できませんでした。",
    action: withdrawalOperations.outboxDeadLetterCount > 0 ? "失敗理由と宛先を確認し、修正後に再送してください。" : withdrawalOperations.outboxStaleProcessingCount > 0 ? "期限切れのPROCESSINGを回収できるワーカーが稼働しているか確認してください。" : withdrawalOperations.outboxFailedDueCount > 0 ? "撤回メールワーカーと再送予定時刻を確認してください。" : withdrawalOperations.outboxPendingCount > 0 ? "内部メールワーカーが定期実行されていることを確認してください。" : ""
  }));
  checks.push(createCheck({
    id: "withdrawal_locale_and_legal_snapshots",
    category: "app",
    status: withdrawalOperations.legacyLocaleMissingCount > 0 ? "warning" : withdrawalOperations.publishedLegalBundleCount === 0 ? "manual" : "pass",
    title: "撤回申請の言語・法務スナップショット",
    detail: withdrawalOperations.available ? `言語または受付日時が不足する既存申請 ${withdrawalOperations.legacyLocaleMissingCount}件、公開済み法務文面 ${withdrawalOperations.publishedLegalBundleCount}件です。` : "撤回申請の言語・法務スナップショットを確認できませんでした。",
    action: withdrawalOperations.legacyLocaleMissingCount > 0 ? "既存申請は互換表示できますが、必要に応じてバックフィルしてください。新規申請は受付時の値を固定保存します。" : withdrawalOperations.publishedLegalBundleCount === 0 ? "国別法務文面が未公開の間は中立的な受付文面を使い、個別判断を管理者確認にしてください。" : ""
  }));
  checks.push(createCheck({
    id: "withdrawal_processing_integrity",
    category: "app",
    status: withdrawalOperations.processingIssueCount > 0 ? "warning" : "pass",
    title: "Withdrawal processing integrity",
    detail: withdrawalOperations.available ? [`${withdrawalOperations.processingIssueCount} processing issue(s) detected.`, `refund decision missing: ${withdrawalOperations.refundDecisionMissingCount}`, `completion mismatch: ${withdrawalOperations.refundCompletionMismatchCount}`, `return instruction missing: ${withdrawalOperations.returnInstructionMissingCount}`, `vendor notification missing: ${withdrawalOperations.vendorNotificationMissingCount}`, `completion email missing: ${withdrawalOperations.completionNotificationMissingCount}`, `rejected without reason: ${withdrawalOperations.rejectedWithoutReasonCount}`, `Shopify external record missing: ${withdrawalOperations.shopifyExternalRecordMissingCount}`].join(" ") : "Skipped because withdrawal request tables are unavailable.",
    action: withdrawalOperations.processingIssueCount > 0 ? "Open /app/withdrawals and resolve the flagged request state before treating withdrawal operations as complete." : ""
  }));
  return checks;
}

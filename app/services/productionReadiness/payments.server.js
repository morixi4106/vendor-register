import { inspectPaymentOperations } from "../paymentOperations.server.js";
import { createCheck } from "./common.js";

function count(value) {
  return Math.max(0, Number(value || 0));
}

function statusForCount(value, { required, warningOnly = false } = {}) {
  if (count(value) === 0) return "pass";
  if (warningOnly || !required) return "warning";
  return "fail";
}

export async function inspectPaymentOperationReadiness({
  prismaClient,
  now = new Date(),
} = {}) {
  return inspectPaymentOperations({ prismaClient, now });
}

export function buildPaymentOperationChecks({
  inspection,
  operationEnv,
} = {}) {
  const required = Boolean(operationEnv?.komojuEnabled);
  if (!inspection?.available) {
    if (!required) return [];
    return [
      createCheck({
        id: "payment_operations_available",
        category: "payout",
        status: required ? "fail" : "warning",
        title: "決済運用データ",
        detail: "決済試行・返金・入金照合のテーブルを確認できません。",
        action: required
          ? "最新migrationを適用してからKOMOJUを有効化してください。"
          : "KOMOJUを利用する前に最新migrationを適用してください。",
      }),
    ];
  }

  const checks = [
    createCheck({
      id: "payment_operations_available",
      category: "payout",
      status: "pass",
      title: "決済運用データ",
      detail: "決済試行・返金・入金照合のテーブルを確認できます。",
    }),
    createCheck({
      id: "payment_attempts_pending_expired",
      category: "payout",
      status: statusForCount(inspection.pendingExpiredCount, { required }),
      title: "期限切れの支払い待ち",
      detail: `${count(inspection.pendingExpiredCount)}件あります。`,
      action: count(inspection.pendingExpiredCount) > 0
        ? "決済運用画面でShopifyの注文状態と決済試行を確認してください。"
        : "",
    }),
    createCheck({
      id: "payment_attempts_review",
      category: "payout",
      status: statusForCount(inspection.attemptReviewCount, { required }),
      title: "要確認の決済試行",
      detail: `${count(inspection.attemptReviewCount)}件あります。`,
      action: count(inspection.attemptReviewCount) > 0
        ? "不明な決済手段または複数決済を確認してください。"
        : "",
    }),
    createCheck({
      id: "payment_refunds_review",
      category: "payout",
      status: statusForCount(inspection.refundReviewCount, {
        required,
        warningOnly: true,
      }),
      title: "確認待ちの返金",
      detail: `${count(inspection.refundReviewCount)}件あります。`,
      action: count(inspection.refundReviewCount) > 0
        ? "KOMOJU等の管理画面で返金成功を確認し、証跡を登録してください。"
        : "",
    }),
    createCheck({
      id: "payment_refunds_failed",
      category: "payout",
      status: statusForCount(inspection.refundFailedCount, { required }),
      title: "失敗した返金反映",
      detail: `${count(inspection.refundFailedCount)}件あります。`,
      action: count(inspection.refundFailedCount) > 0
        ? "決済会社の返金状態と台帳反映エラーを確認してください。"
        : "",
    }),
    createCheck({
      id: "payment_settlements_unmatched",
      category: "payout",
      status: statusForCount(inspection.unmatchedSettlementCount, { required }),
      title: "未照合の入金明細",
      detail: `${count(inspection.unmatchedSettlementCount)}件あります。`,
      action: count(inspection.unmatchedSettlementCount) > 0
        ? "KOMOJUの振込明細と注文・返金記録を照合してください。"
        : "",
    }),
  ];
  return checks;
}

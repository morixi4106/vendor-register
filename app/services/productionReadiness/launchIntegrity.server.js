import prisma from "../../db.server.js";
import { isMarketplaceSeller } from "../../utils/sellerRoles.js";
import { WITHDRAWAL_EMAIL_OUTBOX_HEARTBEAT_KEY } from ".././operationalHealth.server.js";
import { listSellerLedgerRepairCandidates } from ".././sellerPayments.server.js";
import { MULTI_SELLER_STOREFRONT_CHECKOUT_FLAG } from "./environment.server.js";
import { OPEN_PAYOUT_RUN_STATUSES, createCheck, isEnabledEnvFlag, normalizeText } from "./common.js";
const WITHDRAWAL_OUTBOX_HEARTBEAT_STALE_MINUTES = 30;
const UNRESOLVED_SELLER_ORDER_SHADOW_STATUSES = new Set(["failed", "amount_mismatch", "seller_mismatch"]);
export async function inspectLaunchIntegrity({
  prismaClient = prisma,
  sellerRows = [],
  now = new Date(),
  ledgerRepairLoader = listSellerLedgerRepairCandidates
} = {}) {
  const heartbeatResult = await inspectWithdrawalWorkerHeartbeat({
    prismaClient,
    now
  });
  let shadowChecks = null;
  let shadowError = null;
  if (prismaClient?.sellerOrderShadowCheck?.findMany) {
    try {
      const rows = await prismaClient.sellerOrderShadowCheck.findMany({
        orderBy: [{
          checkedAt: "desc"
        }],
        take: 500,
        select: {
          id: true,
          shopDomain: true,
          shopifyOrderId: true,
          shopifyOrderName: true,
          status: true,
          errorMessage: true,
          checkedAt: true
        }
      });
      const latestByOrder = new Map();
      for (const row of rows) {
        const key = `${row.shopDomain}:${row.shopifyOrderId}`;
        if (!latestByOrder.has(key)) latestByOrder.set(key, row);
      }
      shadowChecks = [...latestByOrder.values()].filter(row => UNRESOLVED_SELLER_ORDER_SHADOW_STATUSES.has(row.status));
    } catch (error) {
      shadowError = error?.code || "seller_order_shadow_read_failed";
    }
  } else {
    shadowError = "seller_order_shadow_table_unavailable";
  }
  let ledgerRepairCandidates = null;
  let ledgerRepairError = null;
  if (prismaClient?.ledgerEntry?.findMany && prismaClient?.seller?.findMany) {
    try {
      ledgerRepairCandidates = await ledgerRepairLoader({
        currencyCode: "jpy"
      }, {
        prismaClient
      });
    } catch (error) {
      ledgerRepairError = error?.code || "ledger_repair_inspection_failed";
    }
  } else {
    ledgerRepairError = "ledger_models_unavailable";
  }
  const productionLedgerRepairs = (ledgerRepairCandidates || []).filter(candidate => !candidate.isTestStore);
  const testLedgerRepairs = (ledgerRepairCandidates || []).filter(candidate => candidate.isTestStore);
  const testStoreRows = sellerRows.filter(seller => Boolean(seller.vendor?.vendorStore?.isTestStore));
  const pendingTestPayoutRuns = testStoreRows.flatMap(seller => (seller.payoutRuns || []).map(run => ({
    ...run,
    sellerId: seller.id,
    storeName: seller.vendor?.vendorStore?.storeName || seller.vendor?.storeName || "-"
  })));
  return {
    heartbeat: {
      ...heartbeatResult
    },
    sellerOrderShadow: {
      available: !shadowError,
      error: shadowError,
      unresolvedCount: shadowChecks?.length || 0,
      unresolved: shadowChecks || []
    },
    ledgerRepairs: {
      available: !ledgerRepairError,
      error: ledgerRepairError,
      productionCount: productionLedgerRepairs.length,
      testCount: testLedgerRepairs.length,
      production: productionLedgerRepairs,
      test: testLedgerRepairs
    },
    testStores: {
      count: testStoreRows.length,
      pendingPayoutRunCount: pendingTestPayoutRuns.length,
      pendingPayoutRuns: pendingTestPayoutRuns
    }
  };
}
export async function inspectWithdrawalWorkerHeartbeat({
  prismaClient = prisma,
  now = new Date()
} = {}) {
  let row = null;
  let error = null;
  if (prismaClient?.operationalHeartbeat?.findUnique) {
    try {
      row = await prismaClient.operationalHeartbeat.findUnique({
        where: {
          key: WITHDRAWAL_EMAIL_OUTBOX_HEARTBEAT_KEY
        }
      });
    } catch (readError) {
      error = readError?.code || "heartbeat_read_failed";
    }
  } else {
    error = "operational_heartbeat_table_unavailable";
  }
  const lastSucceededAt = row?.lastSucceededAt ? new Date(row.lastSucceededAt) : null;
  const lastFailedAt = row?.lastFailedAt ? new Date(row.lastFailedAt) : null;
  const minutesSinceSuccess = lastSucceededAt ? Math.max(0, Math.floor((now.getTime() - lastSucceededAt.getTime()) / 60000)) : null;
  return {
    available: !error,
    row,
    error,
    minutesSinceSuccess,
    stale: minutesSinceSuccess !== null && minutesSinceSuccess > WITHDRAWAL_OUTBOX_HEARTBEAT_STALE_MINUTES,
    failureUnresolved: Boolean(lastFailedAt && (!lastSucceededAt || lastFailedAt > lastSucceededAt))
  };
}
export async function loadLaunchIntegritySellerRows({
  prismaClient = prisma
} = {}) {
  if (!prismaClient?.seller?.findMany) return [];
  const rows = await prismaClient.seller.findMany({
    include: {
      vendor: {
        include: {
          vendorStore: true
        }
      },
      payoutRuns: {
        where: {
          status: {
            in: OPEN_PAYOUT_RUN_STATUSES
          }
        },
        select: {
          id: true,
          status: true,
          amount: true,
          currencyCode: true,
          createdAt: true
        }
      }
    }
  });
  return rows.filter(isMarketplaceSeller);
}
export function buildLaunchIntegrityChecks({
  launchIntegrity,
  env
}) {
  const checks = [];
  checks.push(buildWithdrawalWorkerHeartbeatCheck({
    heartbeat: launchIntegrity.heartbeat,
    env
  }));
  const shadow = launchIntegrity.sellerOrderShadow;
  const multiSellerCheckoutEnabled = isEnabledEnvFlag(env, MULTI_SELLER_STOREFRONT_CHECKOUT_FLAG);
  checks.push(createCheck({
    id: "seller_order_unresolved_shadow_checks",
    category: "app",
    status: !shadow.available ? "manual" : shadow.unresolvedCount === 0 ? "pass" : multiSellerCheckoutEnabled ? "fail" : "warning",
    title: "出店者別注文の未解決差分",
    detail: shadow.available ? `最新の検証結果に未解決差分が${shadow.unresolvedCount}件あります。` : `出店者別注文の検証結果を確認できません: ${shadow.error}.`,
    action: shadow.available && shadow.unresolvedCount > 0 ? "SellerOrder検証画面で金額または出店者の差分を解消してください。" : ""
  }));
  const repairs = launchIntegrity.ledgerRepairs;
  checks.push(createCheck({
    id: "seller_ledger_repair_candidates",
    category: "payout",
    status: !repairs.available ? "manual" : repairs.productionCount > 0 ? "fail" : repairs.testCount > 0 ? "warning" : "pass",
    title: "売上台帳の補正待ち",
    detail: repairs.available ? `本番店舗 ${repairs.productionCount}件、テスト店舗 ${repairs.testCount}件の補正候補があります。` : `売上台帳の補正候補を確認できません: ${repairs.error}.`,
    action: repairs.available && (repairs.productionCount > 0 || repairs.testCount > 0) ? "出金管理で候補の根拠を確認し、必要な補正を実行してください。" : ""
  }));
  const testStores = launchIntegrity.testStores;
  checks.push(createCheck({
    id: "test_store_pending_payout_runs",
    category: "payout",
    status: testStores.pendingPayoutRunCount > 0 ? "fail" : "pass",
    title: "テスト店舗の出金予定",
    detail: `${testStores.count}件のテスト店舗に、未完了の出金予定が${testStores.pendingPayoutRunCount}件あります。`,
    action: testStores.pendingPayoutRunCount > 0 ? "テスト店舗の出金予定を取り消し、実送金しないでください。" : ""
  }));
  return checks;
}
export function buildWithdrawalWorkerHeartbeatCheck({
  heartbeat,
  env
}) {
  const workerExpected = Boolean(normalizeText(env.WITHDRAWAL_OUTBOX_WORKER_TOKEN));
  let heartbeatStatus = "pass";
  let heartbeatDetail = "撤回メールの定期処理は正常に稼働しています。";
  let heartbeatAction = "";
  if (!heartbeat.available) {
    heartbeatStatus = "manual";
    heartbeatDetail = `定期処理の稼働記録を確認できません: ${heartbeat.error}.`;
    heartbeatAction = "migration適用後、定期処理を1回実行して再確認してください。";
  } else if (heartbeat.failureUnresolved) {
    heartbeatStatus = "fail";
    heartbeatDetail = `撤回メールの定期処理が失敗したままです: ${heartbeat.row?.lastErrorCode || "原因不明"}.`;
    heartbeatAction = "RenderのCron Jobログと撤回メール送信キューを確認してください。";
  } else if (heartbeat.stale) {
    heartbeatStatus = "fail";
    heartbeatDetail = `撤回メールの定期処理が${heartbeat.minutesSinceSuccess}分間成功していません。`;
    heartbeatAction = "RenderのCron Jobが10分間隔で稼働しているか確認してください。";
  } else if (!heartbeat.row?.lastSucceededAt) {
    heartbeatStatus = workerExpected ? "fail" : "warning";
    heartbeatDetail = "撤回メールの定期処理がまだ成功していません。";
    heartbeatAction = workerExpected ? "RenderのCron Jobを実行し、成功記録を確認してください。" : "ワーカートークンとCron Jobを設定してください。";
  } else {
    heartbeatDetail = `最終成功は${heartbeat.minutesSinceSuccess}分前です。`;
  }
  return createCheck({
    id: "withdrawal_email_worker_heartbeat",
    category: "app",
    status: heartbeatStatus,
    title: "撤回メール定期処理",
    detail: heartbeatDetail,
    action: heartbeatAction
  });
}

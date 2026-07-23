import crypto from "node:crypto";

import { Resend } from "resend";

import prisma from "../db.server.js";
import {
  buildLaunchIntegrityChecks,
  buildWithdrawalOperationChecks,
  buildWithdrawalWorkerHeartbeatCheck,
  inspectLaunchIntegrity,
  inspectWithdrawalOperations,
  inspectWithdrawalWorkerHeartbeat,
  loadLaunchIntegritySellerRows,
} from "./productionReadiness.server.js";
import { getMarketplaceCheckoutGateStatus } from "./marketplaceCheckoutGate.server.js";
import {
  buildMarketplaceCheckoutValidationReadinessCheck,
  inspectMarketplaceCheckoutValidation,
} from "./shopifyCheckoutValidation.server.js";
import {
  OPERATIONAL_TIMING_DEFAULTS,
  resolveOperationalTimingPolicy,
} from "./operationalTimingPolicy.js";
import { SHOPIFY_PRODUCT_CATALOG_SYNC_HEARTBEAT_KEY } from "./operationalHealth.server.js";
import {
  OPERATIONAL_READINESS_DEFINITIONS,
  buildOperationalReadinessChecks,
  getPlatformOperationalControl,
  inspectOperationalReadiness,
} from "./operationalReadiness.server.js";

export const LAUNCH_MONITOR_HEARTBEAT_KEY = "production_integrity_monitor";
export const LAUNCH_MONITOR_SCHEMA_VERSION = 1;

const DEFAULT_DURATION_HOURS = 72;
const HEAVY_CHECK_INTERVAL_MINUTES =
  OPERATIONAL_TIMING_DEFAULTS.catalogSyncIntervalMinutes;
const CRITICAL_REMINDER_MINUTES = 30;
const WARNING_REMINDER_MINUTES = 120;
const CRITICAL_SEVERITY = "critical";
const WARNING_SEVERITY = "warning";
const HEALTHY_STATUS = "healthy";
const READINESS_LIGHT_CHECK_IDS = new Set([
  "withdrawal_operations_available",
  "withdrawal_email_outbox",
  "withdrawal_processing_integrity",
]);
const READINESS_HEAVY_CHECK_IDS = new Set([
  "marketplace_checkout_publication_boundary",
  "marketplace_checkout_server_validation",
  "seller_order_unresolved_shadow_checks",
  "seller_ledger_repair_candidates",
  "test_store_pending_payout_runs",
  "launch_integrity",
  "platform_checkout_emergency_hold",
  "platform_automated_email_hold",
  ...OPERATIONAL_READINESS_DEFINITIONS.map(
    (definition) =>
      `operational_attestation_${definition.key.toLowerCase()}`,
  ),
]);

export async function runLaunchMonitor({
  renderSnapshot = {},
  prismaClient = prisma,
  env = process.env,
  now = new Date(),
  sendEmailImpl = sendLaunchMonitorEmail,
} = {}) {
  if (!isEnabled(env.LAUNCH_MONITOR_ENABLED)) {
    return { ok: true, active: false, reason: "launch_monitor_disabled" };
  }

  const previous = await readMonitorHeartbeat(prismaClient);
  const storedMetadata = asObject(previous?.metadataJson);
  const durationHours = boundedNumber(
    env.LAUNCH_MONITOR_DURATION_HOURS,
    DEFAULT_DURATION_HOURS,
    1,
    24 * 14,
  );
  const { campaignId, previousMetadata, startedAt } =
    resolveLaunchMonitorCampaign({
      storedMetadata,
      configuredStart: env.LAUNCH_MONITOR_STARTED_AT,
      now,
      durationHours,
    });
  const endsAt = new Date(startedAt.getTime() + durationHours * 60 * 60 * 1000);

  const concentratedMonitoringComplete = now >= endsAt;
  let completionSentAt = parseDate(previousMetadata.completionSentAt);
  if (concentratedMonitoringComplete && !completionSentAt) {
    const previousReport = asObject(previousMetadata.lastReport);
    await sendEmailImpl({
      kind: "completed",
      report: previousReport,
      state: { startedAt, endsAt, now },
      env,
    });
    completionSentAt = now;
  }

  const lastHeavyCheckedAt = parseDate(previousMetadata.lastHeavyCheckedAt);
  const runHeavyChecks =
    !lastHeavyCheckedAt ||
    now.getTime() - lastHeavyCheckedAt.getTime() >=
      HEAVY_CHECK_INTERVAL_MINUTES * 60 * 1000;
  const report = await collectLaunchMonitorReport({
    renderSnapshot,
    prismaClient,
    env,
    now,
    startedAt,
    runHeavyChecks,
    previousHeavyChecks: previousMetadata.lastHeavyChecks,
  });
  const incidentFingerprint = fingerprintReport(report);
  const resultHash = hashReportResult(report);
  const previousStatus = String(previousMetadata.lastOverallStatus || "");
  const previousFingerprint = String(
    previousMetadata.lastIncidentFingerprint || "",
  );
  const notificationKind = resolveNotificationKind({
    report,
    previousStatus,
    previousFingerprint,
    currentFingerprint: incidentFingerprint,
    lastNotifiedAt: previousMetadata.lastNotifiedAt,
    now,
  });

  if (notificationKind) {
    await sendEmailImpl({
      kind: notificationKind,
      report,
      state: { startedAt, endsAt, now },
      env,
    });
  }

  const runCount = Number(previousMetadata.runCount || 0) + 1;
  const metadataJson = {
    ...previousMetadata,
    schemaVersion: LAUNCH_MONITOR_SCHEMA_VERSION,
    campaignId,
    active: true,
    concentratedMonitoringComplete,
    startedAt: startedAt.toISOString(),
    endsAt: endsAt.toISOString(),
    completedAt: concentratedMonitoringComplete
      ? previousMetadata.completedAt || endsAt.toISOString()
      : null,
    completionSentAt: completionSentAt?.toISOString() || null,
    lastCheckedAt: now.toISOString(),
    lastHeavyCheckedAt: runHeavyChecks && report.heavyCheckCompleted
      ? now.toISOString()
      : previousMetadata.lastHeavyCheckedAt || null,
    lastHeavyChecks: runHeavyChecks
      ? asCheckArray(report.heavyChecks)
      : asCheckArray(previousMetadata.lastHeavyChecks),
    lastOverallStatus: report.overallStatus,
    lastIncidentFingerprint: incidentFingerprint,
    currentStatus: report.overallStatus,
    incidentKey:
      report.overallStatus === HEALTHY_STATUS ? null : incidentFingerprint,
    firstDetectedAt:
      report.overallStatus === HEALTHY_STATUS
        ? null
        : previousStatus === HEALTHY_STATUS ||
            incidentFingerprint !== previousFingerprint
          ? now.toISOString()
          : previousMetadata.firstDetectedAt || now.toISOString(),
    lastDetectedAt:
      report.overallStatus === HEALTHY_STATUS ? null : now.toISOString(),
    lastNotifiedAt:
      notificationKind === "alert"
        ? now.toISOString()
        : previousMetadata.lastNotifiedAt || null,
    startNotificationSentAt:
      notificationKind === "started"
        ? now.toISOString()
        : previousMetadata.startNotificationSentAt || null,
    recoveredAt:
      notificationKind === "recovered"
        ? now.toISOString()
        : report.overallStatus === HEALTHY_STATUS
          ? previousMetadata.recoveredAt || null
          : null,
    consecutiveCount:
      report.overallStatus === previousStatus
        ? Number(previousMetadata.consecutiveCount || 0) + 1
        : 1,
    lastResultHash: resultHash,
    runCount,
    criticalRunCount:
      Number(previousMetadata.criticalRunCount || 0) +
      (report.overallStatus === CRITICAL_SEVERITY ? 1 : 0),
    warningRunCount:
      Number(previousMetadata.warningRunCount || 0) +
      (report.overallStatus === WARNING_SEVERITY ? 1 : 0),
    lastReport: report,
  };

  await writeMonitorHeartbeat({
    prismaClient,
    now,
    status: report.overallStatus === CRITICAL_SEVERITY ? "failed" : "succeeded",
    errorCode:
      report.overallStatus === CRITICAL_SEVERITY
        ? report.checks.find((check) => check.severity === CRITICAL_SEVERITY)
            ?.id || "launch_monitor_critical"
        : null,
    metadataJson,
  });

  return {
    ok: true,
    active: true,
    completed: false,
    concentratedMonitoringComplete,
    startedAt,
    endsAt,
    notificationKind,
    report,
  };
}

export async function collectLaunchMonitorReport({
  renderSnapshot = {},
  prismaClient = prisma,
  env = process.env,
  now = new Date(),
  startedAt = now,
  runHeavyChecks = true,
  previousHeavyChecks = [],
  dependencies = {},
} = {}) {
  const inspectWithdrawalOperationsImpl =
    dependencies.inspectWithdrawalOperations || inspectWithdrawalOperations;
  const inspectWithdrawalWorkerHeartbeatImpl =
    dependencies.inspectWithdrawalWorkerHeartbeat ||
    inspectWithdrawalWorkerHeartbeat;
  const loadLaunchIntegritySellerRowsImpl =
    dependencies.loadLaunchIntegritySellerRows || loadLaunchIntegritySellerRows;
  const inspectLaunchIntegrityImpl =
    dependencies.inspectLaunchIntegrity || inspectLaunchIntegrity;
  const getMarketplaceCheckoutGateStatusImpl =
    dependencies.getMarketplaceCheckoutGateStatus ||
    getMarketplaceCheckoutGateStatus;
  const inspectMarketplaceCheckoutValidationImpl =
    dependencies.inspectMarketplaceCheckoutValidation ||
    inspectMarketplaceCheckoutValidation;
  const inspectShopifyProductCatalogSyncHeartbeatImpl =
    dependencies.inspectShopifyProductCatalogSyncHeartbeat ||
    inspectShopifyProductCatalogSyncHeartbeat;
  const inspectOperationalReadinessImpl =
    dependencies.inspectOperationalReadiness || inspectOperationalReadiness;
  const getPlatformOperationalControlImpl =
    dependencies.getPlatformOperationalControl ||
    getPlatformOperationalControl;
  const checks = [
    ...evaluateRenderSnapshot(renderSnapshot),
    ...evaluateExternalPublicSnapshot(renderSnapshot.publicEndpoints),
    buildPublicDraftOrderCheckoutSafetyCheck(env),
  ];
  const windowStartedAt =
    parseDate(renderSnapshot.windowStartedAt) ||
    new Date(now.getTime() - 12 * 60 * 1000);
  let heavyCheckCompleted = runHeavyChecks ? false : null;
  let heavyChecks = [];

  try {
    await prismaClient.$queryRaw`SELECT 1`;
    checks.push(okCheck("database_connection", "本番DBへ接続できます。"));
  } catch (error) {
    checks.push(
      issueCheck(
        "database_connection",
        CRITICAL_SEVERITY,
        "本番DBへ接続できません。",
        safeErrorCode(error),
      ),
    );
  }

  try {
    const withdrawalOperations = await inspectWithdrawalOperationsImpl({
      prismaClient,
      now,
      updatedSince: startedAt,
    });
    checks.push(
      ...buildWithdrawalOperationChecks({ withdrawalOperations })
        .filter((check) => READINESS_LIGHT_CHECK_IDS.has(check.id))
        .map(readinessCheckToMonitorCheck),
    );
  } catch (error) {
    checks.push(
      issueCheck(
        "withdrawal_operations",
        CRITICAL_SEVERITY,
        "撤回申請とメールキューを確認できません。",
        safeErrorCode(error),
      ),
    );
  }

  try {
    const heartbeat = await inspectWithdrawalWorkerHeartbeatImpl({
      prismaClient,
      now,
    });
    checks.push(
      readinessCheckToMonitorCheck(
        buildWithdrawalWorkerHeartbeatCheck({ heartbeat, env }),
      ),
    );
  } catch (error) {
    checks.push(
      issueCheck(
        "withdrawal_email_worker_heartbeat",
        CRITICAL_SEVERITY,
        "撤回メールワーカーの稼働確認に失敗しました。",
        safeErrorCode(error),
      ),
    );
  }

  try {
    const heartbeat = await inspectShopifyProductCatalogSyncHeartbeatImpl({
      prismaClient,
      now,
    });
    checks.push(
      buildShopifyProductCatalogSyncHeartbeatCheck({
        heartbeat,
        env,
      }),
    );
  } catch (error) {
    checks.push(
      issueCheck(
        "shopify_product_catalog_sync_freshness",
        CRITICAL_SEVERITY,
        "Shopify商品カタログ同期の稼働状況を確認できません。",
        safeErrorCode(error),
      ),
    );
  }

  try {
    const recentContacts = await prismaClient.contactInquiry.count({
      where: { createdAt: { gte: windowStartedAt } },
    });
    checks.push(
      recentContacts >= 10
        ? issueCheck(
            "contact_inquiry_spike",
          recentContacts >= 30 ? CRITICAL_SEVERITY : WARNING_SEVERITY,
          `直近の監視区間で問い合わせが${recentContacts}件あります。`,
          null,
          recentContacts,
          )
        : okCheck(
            "contact_inquiry_spike",
            `直近の問い合わせは${recentContacts}件です。`,
          ),
    );
  } catch (error) {
    checks.push(
      issueCheck(
        "contact_inquiry_spike",
        WARNING_SEVERITY,
        "問い合わせ件数を確認できません。",
        safeErrorCode(error),
      ),
    );
  }

  if (runHeavyChecks) {
    let checkoutBoundaryCompleted = false;
    let checkoutValidationCompleted = false;
    let launchIntegrityCompleted = false;
    let operationalReadinessCompleted = false;

    try {
      const shopDomain = String(
        env?.SHOPIFY_PRIMARY_SHOP_DOMAIN || env?.SHOPIFY_SHOP || "",
      ).trim();
      if (!shopDomain) {
        throw new Error("shopify_primary_shop_domain_missing");
      }
      const checkoutGate = await getMarketplaceCheckoutGateStatusImpl(
        shopDomain,
        { prismaClient, env },
      );
      const checkoutBoundaryCheck =
        buildMarketplaceCheckoutPublicationBoundaryMonitorCheck(checkoutGate);
      heavyChecks.push(checkoutBoundaryCheck);
      checks.push(checkoutBoundaryCheck);
      checkoutBoundaryCompleted = true;
    } catch (error) {
      const failure = issueCheck(
        "marketplace_checkout_publication_boundary",
        CRITICAL_SEVERITY,
        "Shopify販売チャネルの公開境界を確認できません。",
        safeErrorCode(error),
      );
      heavyChecks.push(failure);
      checks.push(failure);
    }

    try {
      const shopDomain = String(
        env?.SHOPIFY_PRIMARY_SHOP_DOMAIN || env?.SHOPIFY_SHOP || "",
      ).trim();
      if (!shopDomain) {
        throw new Error("shopify_primary_shop_domain_missing");
      }
      const validationStatus =
        await inspectMarketplaceCheckoutValidationImpl(shopDomain);
      const validationCheck = readinessCheckToMonitorCheck(
        buildMarketplaceCheckoutValidationReadinessCheck(validationStatus),
      );
      heavyChecks.push(validationCheck);
      checks.push(validationCheck);
      checkoutValidationCompleted = true;
    } catch (error) {
      const failure = issueCheck(
        "marketplace_checkout_server_validation",
        CRITICAL_SEVERITY,
        "Shopifyサーバー側の購入制御を確認できません。",
        safeErrorCode(error),
      );
      heavyChecks.push(failure);
      checks.push(failure);
    }

    try {
      const sellerRows = await loadLaunchIntegritySellerRowsImpl({
        prismaClient,
      });
      const integrity = await inspectLaunchIntegrityImpl({
        prismaClient,
        sellerRows,
        now,
      });
      const integrityChecks = buildLaunchIntegrityChecks({
        launchIntegrity: integrity,
        env,
      })
        .filter((check) => READINESS_HEAVY_CHECK_IDS.has(check.id))
        .map(readinessCheckToMonitorCheck);
      heavyChecks.push(...integrityChecks);
      checks.push(...integrityChecks);
      launchIntegrityCompleted = true;
    } catch (error) {
      const failure = issueCheck(
        "launch_integrity",
        CRITICAL_SEVERITY,
        "台帳と出店者別注文の整合性確認に失敗しました。5分後に再試行します。",
        safeErrorCode(error),
      );
      heavyChecks.push(failure);
      checks.push(failure);
    }
    try {
      const [operationalReadiness, platformOperationalControl] =
        await Promise.all([
          inspectOperationalReadinessImpl({ prismaClient, now }),
          getPlatformOperationalControlImpl({ prismaClient }),
        ]);
      const operationalChecks = buildOperationalReadinessChecks({
        inspection: operationalReadiness,
        control: platformOperationalControl,
      })
        .filter((check) => READINESS_HEAVY_CHECK_IDS.has(check.id))
        .map(readinessCheckToMonitorCheck);
      heavyChecks.push(...operationalChecks);
      checks.push(...operationalChecks);
      operationalReadinessCompleted = true;
    } catch (error) {
      const failure = issueCheck(
        "operational_readiness",
        CRITICAL_SEVERITY,
        "実地確認証跡と販売緊急停止の状態を確認できません。",
        safeErrorCode(error),
      );
      heavyChecks.push(failure);
      checks.push(failure);
    }
    heavyCheckCompleted =
      checkoutBoundaryCompleted &&
      checkoutValidationCompleted &&
      launchIntegrityCompleted &&
      operationalReadinessCompleted;
  } else {
    const cachedHeavyChecks = asCheckArray(previousHeavyChecks).filter(
      (check) => READINESS_HEAVY_CHECK_IDS.has(check.id),
    );
    checks.push(
      ...(cachedHeavyChecks.length > 0
        ? cachedHeavyChecks
        : [
            issueCheck(
              "heavy_checks_not_initialized",
              WARNING_SEVERITY,
              "重い整合性検査は次の15分区間で初回実行されます。",
            ),
          ]),
    );
  }

  return {
    ...buildReport({
      checks,
      now,
      renderSnapshot,
      checkMode: runHeavyChecks ? "full" : "light",
    }),
    heavyCheckCompleted,
    heavyChecks:
      runHeavyChecks
        ? heavyChecks
        : asCheckArray(previousHeavyChecks).filter((check) =>
            READINESS_HEAVY_CHECK_IDS.has(check.id),
          ),
  };
}

export async function inspectShopifyProductCatalogSyncHeartbeat({
  prismaClient = prisma,
  now = new Date(),
} = {}) {
  if (!prismaClient?.operationalHeartbeat?.findUnique) {
    return {
      available: false,
      row: null,
      minutesSinceSuccess: null,
      stale: true,
      failureUnresolved: false,
    };
  }

  const row = await prismaClient.operationalHeartbeat.findUnique({
    where: { key: SHOPIFY_PRODUCT_CATALOG_SYNC_HEARTBEAT_KEY },
  });
  const lastSucceededAt = parseDate(row?.lastSucceededAt);
  const lastFailedAt = parseDate(row?.lastFailedAt);
  const minutesSinceSuccess = lastSucceededAt
    ? Math.max(
        0,
        Math.floor(
          (now.getTime() - lastSucceededAt.getTime()) / (60 * 1000),
        ),
      )
    : null;

  return {
    available: true,
    row,
    minutesSinceSuccess,
    stale: !lastSucceededAt,
    failureUnresolved: Boolean(
      lastFailedAt &&
        (!lastSucceededAt || lastFailedAt.getTime() > lastSucceededAt.getTime()),
    ),
  };
}

export function buildShopifyProductCatalogSyncHeartbeatCheck({
  heartbeat,
  env = process.env,
}) {
  const timing = resolveOperationalTimingPolicy(env);
  if (!timing.valid) {
    return issueCheck(
      "shopify_product_catalog_sync_freshness",
      CRITICAL_SEVERITY,
      `商品同期と投影期限の設定順が不正です: ${timing.invariant}`,
      "catalog_sync_timing_invalid",
    );
  }
  const warningMinutes = timing.catalogSyncWarningMinutes;
  const criticalMinutes = timing.catalogSyncCriticalMinutes;
  const age = Number(heartbeat?.minutesSinceSuccess);

  if (heartbeat?.available !== true || !heartbeat?.row) {
    return issueCheck(
      "shopify_product_catalog_sync_freshness",
      CRITICAL_SEVERITY,
      "Shopify商品カタログ同期の成功記録がありません。",
      "heartbeat_missing",
    );
  }
  if (heartbeat?.failureUnresolved) {
    return issueCheck(
      "shopify_product_catalog_sync_freshness",
      CRITICAL_SEVERITY,
      "Shopify商品カタログ同期の直近実行が失敗しています。",
      "latest_run_failed",
    );
  }
  if (!Number.isFinite(age)) {
    return issueCheck(
      "shopify_product_catalog_sync_freshness",
      CRITICAL_SEVERITY,
      "Shopify商品カタログ同期の最終成功時刻を確認できません。",
      "last_success_missing",
    );
  }
  if (age >= criticalMinutes) {
    return issueCheck(
      "shopify_product_catalog_sync_freshness",
      CRITICAL_SEVERITY,
      `Shopify商品カタログ同期が${age}分成功していません。`,
      "catalog_sync_critical",
      age,
    );
  }
  if (age >= warningMinutes) {
    return issueCheck(
      "shopify_product_catalog_sync_freshness",
      WARNING_SEVERITY,
      `Shopify商品カタログ同期の最終成功から${age}分経過しています。`,
      "catalog_sync_stale",
      age,
    );
  }
  return okCheck(
    "shopify_product_catalog_sync_freshness",
    `Shopify商品カタログ同期は${age}分以内に成功しています。`,
  );
}

export function buildMarketplaceCheckoutPublicationBoundaryMonitorCheck(
  checkoutGate,
) {
  const configured =
    checkoutGate?.publicationConfigurationReady !== false;
  const exposedProductCount = boundedCount(
    checkoutGate?.exposedProductCount,
  );
  const failedProductCount = boundedCount(checkoutGate?.failedProductCount);
  const ready =
    checkoutGate?.active === true &&
    configured &&
    exposedProductCount === 0 &&
    failedProductCount === 0;

  return ready
    ? okCheck(
        "marketplace_checkout_publication_boundary",
        "第三者商品と未解決商品はShopifyの購入可能Publicationから除外されています。",
      )
    : issueCheck(
        "marketplace_checkout_publication_boundary",
        CRITICAL_SEVERITY,
        "Shopify販売チャネルの公開境界に不整合があります。",
        !configured
          ? "publication_configuration_missing"
          : exposedProductCount > 0
            ? "governed_product_exposed"
            : failedProductCount > 0
              ? "publication_check_failed"
              : "publication_boundary_inactive",
        exposedProductCount + failedProductCount,
      );
}

export function buildPublicDraftOrderCheckoutSafetyCheck(env = {}) {
  return isEnabled(env.PUBLIC_DRAFT_ORDER_CHECKOUT_ENABLED)
    ? issueCheck(
        "public_draft_order_checkout_disabled",
        CRITICAL_SEVERITY,
        "The public Draft Order checkout endpoint is enabled.",
        "public_draft_order_checkout_enabled",
        1,
      )
    : okCheck(
        "public_draft_order_checkout_disabled",
        "The public Draft Order checkout endpoint is disabled.",
      );
}

export function evaluateRenderSnapshot(snapshot = {}) {
  const checks = [];
  const requests = asObject(snapshot.requests);
  const serverErrors = boundedCount(requests.serverErrors);
  const unauthorized = boundedCount(requests.unauthorized);
  const forbidden = boundedCount(requests.forbidden);
  const rateLimited = boundedCount(requests.rateLimited);
  const appErrors = boundedCount(snapshot.appErrors);
  const queryErrors = Array.isArray(snapshot.queryErrors)
    ? snapshot.queryErrors.filter(Boolean).length
    : 0;

  checks.push(
    serverErrors > 0
      ? issueCheck(
          "render_http_5xx",
          CRITICAL_SEVERITY,
          `Renderで5xxが${serverErrors}件検出されました。`,
          null,
          serverErrors,
        )
      : okCheck("render_http_5xx", "Renderの5xxは検出されていません。"),
    appErrors > 0
      ? issueCheck(
          "render_app_errors",
          CRITICAL_SEVERITY,
          `Renderのアプリエラーログが${appErrors}件あります。`,
          null,
          appErrors,
        )
      : okCheck("render_app_errors", "Renderのアプリエラーログはありません。"),
  );

  const authRejected = unauthorized + forbidden;
  checks.push(
    authRejected >= 20
      ? issueCheck(
          "render_auth_rejections",
          authRejected >= 100 ? CRITICAL_SEVERITY : WARNING_SEVERITY,
          `Renderで401/403が${authRejected}件検出されました。`,
          null,
          authRejected,
        )
      : okCheck(
          "render_auth_rejections",
          `Renderの401/403は${authRejected}件です。`,
        ),
    rateLimited >= 5
      ? issueCheck(
          "render_rate_limits",
          rateLimited >= 25 ? CRITICAL_SEVERITY : WARNING_SEVERITY,
          `Renderで429が${rateLimited}件検出されました。`,
          null,
          rateLimited,
        )
      : okCheck("render_rate_limits", `Renderの429は${rateLimited}件です。`),
    queryErrors > 0
      ? issueCheck(
          "render_log_collection",
          WARNING_SEVERITY,
          `Renderログの取得に${queryErrors}件失敗しました。`,
          null,
          queryErrors,
        )
      : okCheck("render_log_collection", "Renderログを取得できました。"),
  );
  return checks;
}

export function buildReport({
  checks = [],
  now = new Date(),
  renderSnapshot = {},
  checkMode = "full",
}) {
  const criticalCount = checks.filter(
    (check) => check.severity === CRITICAL_SEVERITY,
  ).length;
  const warningCount = checks.filter(
    (check) => check.severity === WARNING_SEVERITY,
  ).length;
  const overallStatus = criticalCount
    ? CRITICAL_SEVERITY
    : warningCount
      ? WARNING_SEVERITY
      : HEALTHY_STATUS;
  return {
    checkedAt: now.toISOString(),
    windowStartedAt:
      parseDate(renderSnapshot.windowStartedAt)?.toISOString() || null,
    windowEndedAt:
      parseDate(renderSnapshot.windowEndedAt)?.toISOString() || null,
    overallStatus,
    criticalCount,
    warningCount,
    checkMode,
    checks,
  };
}

export function evaluateExternalPublicSnapshot(publicEndpoints = {}) {
  const snapshot = asObject(publicEndpoints);
  const appRoot = asObject(snapshot.appRoot);
  const storefront = asObject(snapshot.storefront);

  return [
    appRoot.ok === true
      ? okCheck(
          "public_root_redirect",
          "公開ルートは正式ストアへ転送されます。",
        )
      : issueCheck(
          "public_root_redirect",
          CRITICAL_SEVERITY,
          "外部から確認した公開ルートの転送が想定外です。",
          stableProbeCode(appRoot.code, "root_probe_failed"),
          1,
        ),
    storefront.ok === true
      ? okCheck(
          "official_storefront",
          "正式ストアは外部から正常に表示できます。",
        )
      : issueCheck(
          "official_storefront",
          CRITICAL_SEVERITY,
          "正式ストアの表示、パスワード状態、またはブランド確認に失敗しました。",
          stableProbeCode(storefront.code, "storefront_probe_failed"),
          1,
        ),
  ];
}

export function resolveNotificationKind({
  report,
  previousStatus = "",
  previousFingerprint = "",
  currentFingerprint = "",
  lastNotifiedAt = null,
  now = new Date(),
}) {
  const status = String(report?.overallStatus || HEALTHY_STATUS);
  if (!previousStatus) return "started";
  if (status === HEALTHY_STATUS) {
    return previousStatus === HEALTHY_STATUS ? null : "recovered";
  }

  const changed = currentFingerprint !== previousFingerprint;
  const escalated =
    status === CRITICAL_SEVERITY && previousStatus !== CRITICAL_SEVERITY;
  if (changed || previousStatus === HEALTHY_STATUS || escalated) return "alert";

  const last = parseDate(lastNotifiedAt);
  const reminderMinutes =
    status === CRITICAL_SEVERITY
      ? CRITICAL_REMINDER_MINUTES
      : WARNING_REMINDER_MINUTES;
  if (!last || now.getTime() - last.getTime() >= reminderMinutes * 60 * 1000) {
    return "alert";
  }
  return null;
}

export function sanitizeLaunchMonitorResult(
  result,
  { env = process.env, durationMs = 0 } = {},
) {
  const report = asObject(result?.report);
  const checkedAt =
    parseDate(report.checkedAt)?.toISOString() || new Date().toISOString();
  const status = result?.completed
    ? "completed"
    : report.overallStatus ||
      (result?.active === false ? "disabled" : "unknown");
  return {
    schemaVersion: LAUNCH_MONITOR_SCHEMA_VERSION,
    ok: result?.ok === true,
    active: result?.active === true,
    completed: result?.completed === true,
    status,
    checkedAt,
    commit: stableCommit(env),
    durationMs: boundedCount(durationMs),
    notificationKind: normalizeNotificationKind(result?.notificationKind),
    checks: asCheckArray(report.checks).map((check) => ({
      id: check.id,
      status: check.severity === "ok" ? HEALTHY_STATUS : check.severity,
      code: stableProbeCode(check.errorCode, check.id),
      count: boundedCount(check.count),
    })),
  };
}

export async function readLaunchMonitorDeadmanState({
  prismaClient = prisma,
  now = new Date(),
  staleMinutes = 15,
} = {}) {
  const row = await readMonitorHeartbeat(prismaClient);
  const metadata = asObject(row?.metadataJson);
  const lastCheckedAt = parseDate(metadata.lastCheckedAt);
  const ageMinutes = lastCheckedAt
    ? Math.max(0, Math.floor((now.getTime() - lastCheckedAt.getTime()) / 60000))
    : null;
  return {
    schemaVersion: LAUNCH_MONITOR_SCHEMA_VERSION,
    ok: ageMinutes !== null && ageMinutes <= staleMinutes,
    status:
      ageMinutes === null
        ? "not_started"
        : ageMinutes > staleMinutes
          ? "stale"
          : "healthy",
    completed: false,
    ageMinutes,
    checkedAt: now.toISOString(),
  };
}

export async function acquireLaunchMonitorRunLock({
  prismaClient = prisma,
  now = new Date(),
  ttlMinutes = 4,
} = {}) {
  const key = `${LAUNCH_MONITOR_HEARTBEAT_KEY}_lock`;
  const owner = crypto.randomUUID();
  const releasedAt = new Date(0);
  await prismaClient.operationalHeartbeat.upsert({
    where: { key },
    create: {
      key,
      lastStartedAt: releasedAt,
      metadataJson: { schemaVersion: LAUNCH_MONITOR_SCHEMA_VERSION },
    },
    update: {},
  });
  const cutoff = new Date(now.getTime() - ttlMinutes * 60 * 1000);
  const result = await prismaClient.operationalHeartbeat.updateMany({
    where: {
      key,
      OR: [{ lastStartedAt: null }, { lastStartedAt: { lt: cutoff } }],
    },
    data: { lastStartedAt: now },
  });
  if (result.count !== 1) return null;
  const ownership = await prismaClient.operationalHeartbeat.updateMany({
    where: { key, lastStartedAt: now },
    data: {
      metadataJson: {
        schemaVersion: LAUNCH_MONITOR_SCHEMA_VERSION,
        owner,
      },
    },
  });
  return ownership.count === 1 ? owner : null;
}

export async function releaseLaunchMonitorRunLock({
  prismaClient = prisma,
  now = new Date(),
  owner,
} = {}) {
  const normalizedOwner = String(owner || "").trim();
  if (!normalizedOwner) return false;
  const key = `${LAUNCH_MONITOR_HEARTBEAT_KEY}_lock`;
  const result = await prismaClient.operationalHeartbeat.updateMany({
    where: {
      key,
      metadataJson: { path: ["owner"], equals: normalizedOwner },
    },
    data: {
      lastStartedAt: new Date(0),
      lastSucceededAt: now,
      metadataJson: {
        schemaVersion: LAUNCH_MONITOR_SCHEMA_VERSION,
        owner: null,
      },
    },
  });
  return result.count === 1;
}

export async function sendLaunchMonitorEmail({ kind, report, state, env }) {
  const apiKey = String(env.RESEND_API_KEY || "").trim();
  const from = String(
    env.LAUNCH_MONITOR_FROM_EMAIL ||
      env.MAIL_FROM ||
      env.WITHDRAWAL_FROM_EMAIL ||
      "",
  ).trim();
  const to = String(
    env.LAUNCH_MONITOR_ALERT_EMAIL || env.ADMIN_EMAIL || "",
  ).trim();
  if (!apiKey || !from || !to) {
    throw new Error("launch_monitor_email_not_configured");
  }

  const title =
    kind === "completed"
      ? "公開後72時間監視が完了しました"
      : kind === "started"
        ? "公開後72時間監視を開始しました"
        : kind === "recovered"
          ? "公開監視: 復旧を確認しました"
          : report.overallStatus === CRITICAL_SEVERITY
            ? "公開監視: 重大な異常を検出しました"
            : "公開監視: 注意が必要です";
  const lines = [
    title,
    "",
    `監視開始: ${formatJst(state.startedAt)}`,
    `監視終了予定: ${formatJst(state.endsAt)}`,
    `確認時刻: ${formatJst(state.now)}`,
    `状態: ${report.overallStatus || "completed"}`,
    "",
  ];
  const issues = Array.isArray(report.checks)
    ? report.checks.filter((check) => check.severity !== "ok")
    : [];
  if (issues.length === 0) {
    lines.push("現在、通知対象の異常はありません。");
  } else {
    lines.push("検出内容:");
    for (const issue of issues) {
      lines.push(`- [${issue.severity}] ${issue.detail}`);
    }
  }
  lines.push("", "確認先: Shopify管理画面 > アプリ > 本番確認 / 公開監視");

  const idempotencyKey = `launch-monitor-${kind}-${crypto
    .createHash("sha256")
    .update(`${kind}:${fingerprintReport(report)}:${hourBucket(state.now)}`)
    .digest("hex")
    .slice(0, 40)}`;
  const response = await new Resend(apiKey).emails.send(
    { from, to, subject: title, text: lines.join("\n") },
    { idempotencyKey },
  );
  if (response?.error) {
    throw new Error(response.error.message || "launch_monitor_email_failed");
  }
  return { ok: true, providerMessageId: response?.data?.id || null };
}

async function readMonitorHeartbeat(prismaClient) {
  return prismaClient.operationalHeartbeat.findUnique({
    where: { key: LAUNCH_MONITOR_HEARTBEAT_KEY },
  });
}

async function writeMonitorHeartbeat({
  prismaClient,
  now,
  status,
  errorCode = null,
  metadataJson,
}) {
  const data = {
    lastStartedAt: now,
    lastSucceededAt: status === "succeeded" ? now : undefined,
    lastFailedAt: status === "failed" ? now : undefined,
    lastErrorCode: status === "failed" ? errorCode : null,
    metadataJson,
  };
  return prismaClient.operationalHeartbeat.upsert({
    where: { key: LAUNCH_MONITOR_HEARTBEAT_KEY },
    create: { key: LAUNCH_MONITOR_HEARTBEAT_KEY, ...data },
    update: data,
  });
}

export function fingerprintReport(report = {}) {
  const active = (Array.isArray(report.checks) ? report.checks : [])
    .filter(
      (check) =>
        check.severity === CRITICAL_SEVERITY ||
        check.severity === WARNING_SEVERITY,
    )
    .map((check) => `${check.severity}:${check.id}:${check.errorCode || ""}`)
    .sort();
  return crypto
    .createHash("sha256")
    .update(active.join("|"))
    .digest("hex")
    .slice(0, 24);
}

export function hashReportResult(report = {}) {
  const checks = (Array.isArray(report.checks) ? report.checks : [])
    .map(
      (check) =>
        `${check.severity}:${check.id}:${check.errorCode || ""}:${boundedCount(check.count)}`,
    )
    .sort();
  return crypto
    .createHash("sha256")
    .update(`${report.overallStatus || "unknown"}|${checks.join("|")}`)
    .digest("hex")
    .slice(0, 24);
}

export function resolveLaunchMonitorCampaign({
  storedMetadata = {},
  configuredStart = null,
  now = new Date(),
  durationHours = DEFAULT_DURATION_HOURS,
} = {}) {
  const metadata = asObject(storedMetadata);
  const startedAt =
    parseDate(configuredStart) ||
    (metadata.active === true ? parseDate(metadata.startedAt) : null) ||
    new Date(now);
  const campaignId = buildCampaignId(startedAt, durationHours);
  return {
    campaignId,
    startedAt,
    previousMetadata: metadata.campaignId === campaignId ? metadata : {},
  };
}

function buildCampaignId(startedAt, durationHours) {
  return crypto
    .createHash("sha256")
    .update(`${startedAt.toISOString()}:${durationHours}`)
    .digest("hex")
    .slice(0, 24);
}

function issueCheck(id, severity, detail, errorCode = null, count = 1) {
  return {
    id,
    severity,
    detail,
    errorCode: errorCode || null,
    count: boundedCount(count) || 1,
  };
}

function okCheck(id, detail) {
  return { id, severity: "ok", detail, errorCode: null, count: 0 };
}

function readinessCheckToMonitorCheck(check) {
  const severity =
    check.status === "fail"
      ? CRITICAL_SEVERITY
      : check.status === "warning" || check.status === "manual"
        ? WARNING_SEVERITY
        : "ok";
  return {
    id: check.id,
    severity,
    detail: check.detail,
    errorCode: null,
    count: severity === "ok" ? 0 : 1,
  };
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function asCheckArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (check) =>
        check &&
        typeof check === "object" &&
        /^[a-z0-9_]{1,100}$/i.test(String(check.id || "")) &&
        ["ok", WARNING_SEVERITY, CRITICAL_SEVERITY].includes(check.severity),
    )
    .map((check) => ({
      id: String(check.id),
      severity: check.severity,
      detail: String(check.detail || "").slice(0, 500),
      errorCode: check.errorCode
        ? stableProbeCode(check.errorCode, "monitor_check_failed")
        : null,
      count: boundedCount(check.count),
    }));
}

function parseDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : fallback;
}

function boundedCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

function safeErrorCode(error) {
  const raw = String(error?.code || error?.name || "monitor_check_failed");
  return stableProbeCode(raw, "monitor_check_failed");
}

function stableProbeCode(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]/g, "_")
    .slice(0, 100);
  return normalized || fallback;
}

function stableCommit(env) {
  return String(
    env.RENDER_GIT_COMMIT || env.GIT_COMMIT || env.COMMIT_SHA || "unknown",
  )
    .trim()
    .slice(0, 64);
}

function normalizeNotificationKind(value) {
  return ["started", "alert", "recovered", "completed"].includes(value)
    ? value
    : null;
}

function formatJst(value) {
  const date = parseDate(value);
  return date
    ? new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        dateStyle: "medium",
        timeStyle: "medium",
      }).format(date)
    : "-";
}

function hourBucket(value) {
  const date = parseDate(value) || new Date();
  return Math.floor(date.getTime() / (60 * 60 * 1000));
}

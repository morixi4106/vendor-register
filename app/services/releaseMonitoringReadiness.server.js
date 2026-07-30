import prisma from "../db.server.js";

export const PRODUCTION_INTEGRITY_MONITOR_HEARTBEAT_KEY =
  "production_integrity_monitor";
export const SALE_ELIGIBILITY_WATCHDOG_HEARTBEAT_KEY =
  "sale_eligibility_watchdog";

const DEFAULT_FRESHNESS_MINUTES = 15;

export async function inspectReleaseMonitoringReadiness({
  prismaClient = prisma,
  env = process.env,
  now = new Date(),
} = {}) {
  if (!prismaClient?.operationalHeartbeat?.findMany) {
    return {
      available: false,
      monitor: unavailableState("heartbeat_model_unavailable"),
      watchdog: unavailableState("heartbeat_model_unavailable"),
    };
  }

  const rows = await prismaClient.operationalHeartbeat.findMany({
    where: {
      key: {
        in: [
          PRODUCTION_INTEGRITY_MONITOR_HEARTBEAT_KEY,
          SALE_ELIGIBILITY_WATCHDOG_HEARTBEAT_KEY,
        ],
      },
    },
  });
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const freshnessMinutes = boundedNumber(
    env.RELEASE_MONITOR_FRESHNESS_MINUTES,
    DEFAULT_FRESHNESS_MINUTES,
    5,
    60,
  );

  return {
    available: true,
    freshnessMinutes,
    monitor: inspectProductionMonitor({
      row: byKey.get(PRODUCTION_INTEGRITY_MONITOR_HEARTBEAT_KEY),
      env,
      now,
      freshnessMinutes,
    }),
    watchdog: inspectWatchdog({
      row: byKey.get(SALE_ELIGIBILITY_WATCHDOG_HEARTBEAT_KEY),
      env,
      now,
      freshnessMinutes,
    }),
  };
}

export function buildReleaseMonitoringChecks(inspection) {
  const monitor = inspection?.monitor || unavailableState("not_inspected");
  const watchdog = inspection?.watchdog || unavailableState("not_inspected");
  return [
    {
      id: "production_integrity_monitor_live",
      category: "operations",
      status: monitor.ready ? "pass" : "fail",
      title: "Production integrity monitor",
      detail: monitor.ready
        ? `GitHub Actions由来のfull runが${monitor.ageMinutes}分前に正常完了しています。`
        : monitor.prelaunchPasswordProbePassed
          ? "パスワード保護を検知するfull runとCritical通知は成功しました。一般公開後のhealthy runはまだありません。"
          : `監視を公開条件として確認できません: ${monitor.reason}`,
      action: monitor.ready
        ? ""
        : monitor.prelaunchPasswordProbePassed
          ? "パスワード解除直後にfull runを実行し、healthyまたはrecoveredを確認してください。"
          : "GitHub ActionsとRenderの監視フラグを有効にし、full runを成功させてください。",
    },
    {
      id: "independent_sale_eligibility_watchdog_live",
      category: "operations",
      status: watchdog.ready ? "pass" : "fail",
      title: "Independent sale eligibility watchdog",
      detail: watchdog.ready
        ? `独立Shopify認証を確認したlive runが${watchdog.ageMinutes}分前に正常完了しています。`
        : `独立販売停止Watchdogを確認できません: ${watchdog.reason}`,
      action: watchdog.ready
        ? ""
        : "専用Shopifyアプリの最小権限を検証し、Watchdogのlive runと停止・復旧訓練を完了してください。",
    },
  ];
}

export async function recordSaleEligibilityWatchdogHeartbeat(
  {
    status,
    mode,
    action,
    protected: protectedState,
    source,
    credentialValidation,
    schedulerEnabled = false,
    runId = null,
    errorCode = null,
  },
  { prismaClient = prisma, now = new Date() } = {},
) {
  const normalizedStatus = String(status || "").toLowerCase();
  const succeeded =
    ["healthy", "warning", "critical", "validated"].includes(
      normalizedStatus,
    ) && errorCode == null;
  const data = {
    lastStartedAt: now,
    lastSucceededAt: succeeded ? now : undefined,
    lastFailedAt: succeeded ? undefined : now,
    lastErrorCode: succeeded ? null : String(errorCode || "watchdog_failed"),
    metadataJson: {
      schemaVersion: 1,
      mode: String(mode || "live"),
      status: normalizedStatus || "unknown",
      action: String(action || "none"),
      protected: protectedState === true,
      source: String(source || "unknown"),
      credentialValidation: credentialValidation === true,
      schedulerEnabled: schedulerEnabled === true,
      runId: clean(runId),
      checkedAt: now.toISOString(),
    },
  };
  return prismaClient.operationalHeartbeat.upsert({
    where: { key: SALE_ELIGIBILITY_WATCHDOG_HEARTBEAT_KEY },
    create: {
      key: SALE_ELIGIBILITY_WATCHDOG_HEARTBEAT_KEY,
      ...data,
    },
    update: data,
  });
}

function inspectProductionMonitor({
  row,
  env,
  now,
  freshnessMinutes,
}) {
  const metadata = asObject(row?.metadataJson);
  const report = asObject(metadata.lastReport);
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const checkedAt = parseDate(metadata.lastCheckedAt);
  const ageMinutes = ageInMinutes(checkedAt, now);
  const endpointEnabled = isEnabled(env.LAUNCH_MONITOR_ENABLED);
  const schedulerEnabled = report.agent?.schedulerEnabled === true;
  const source = String(report.agent?.source || metadata.agentSource || "");
  const fullRun = report.checkMode === "full";
  const fresh = ageMinutes != null && ageMinutes <= freshnessMinutes;
  const healthy =
    metadata.lastOverallStatus === "healthy" &&
    report.overallStatus === "healthy" &&
    Number(report.criticalCount || 0) === 0 &&
    Number(report.warningCount || 0) === 0;
  const prelaunchPasswordProbePassed = Boolean(
    endpointEnabled &&
      fullRun &&
      fresh &&
      source === "github_actions" &&
      isPasswordOnlyCritical(checks) &&
      (metadata.lastNotifiedAt || metadata.startNotificationSentAt),
  );
  const ready = Boolean(
    endpointEnabled &&
      schedulerEnabled &&
      fullRun &&
      fresh &&
      source === "github_actions" &&
      healthy,
  );

  return {
    ready,
    enabled: endpointEnabled && schedulerEnabled,
    endpointEnabled,
    schedulerEnabled,
    fullRun,
    fresh,
    healthy,
    source,
    ageMinutes,
    prelaunchPasswordProbePassed,
    reason: ready
      ? null
      : !endpointEnabled
        ? "monitor_endpoint_disabled"
        : !row
          ? "monitor_not_started"
          : !fullRun
            ? "full_run_missing"
            : source !== "github_actions"
              ? "external_agent_run_missing"
              : prelaunchPasswordProbePassed
                ? "storefront_password_protected"
                : !schedulerEnabled
                  ? "monitor_schedule_disabled"
                  : !fresh
                    ? "monitor_stale"
                    : "monitor_not_healthy",
  };
}

function inspectWatchdog({ row, env, now, freshnessMinutes }) {
  const metadata = asObject(row?.metadataJson);
  const checkedAt = parseDate(metadata.checkedAt);
  const ageMinutes = ageInMinutes(checkedAt, now);
  const endpointConfigured =
    String(env.SALE_ELIGIBILITY_WATCHDOG_TOKEN || "").trim().length >= 32;
  const schedulerEnabled = metadata.schedulerEnabled === true;
  const fresh = ageMinutes != null && ageMinutes <= freshnessMinutes;
  const source = String(metadata.source || "");
  const liveRun = metadata.mode === "live";
  const healthy =
    metadata.status === "healthy" &&
    metadata.action === "none" &&
    metadata.credentialValidation === true;
  const ready = Boolean(
    endpointConfigured &&
      schedulerEnabled &&
      fresh &&
      liveRun &&
      healthy &&
      source === "github_actions",
  );

  return {
    ready,
    enabled: endpointConfigured && schedulerEnabled,
    endpointConfigured,
    schedulerEnabled,
    fresh,
    liveRun,
    healthy,
    source,
    ageMinutes,
    reason: ready
      ? null
      : !endpointConfigured
        ? "watchdog_endpoint_unconfigured"
        : !row
          ? "watchdog_not_started"
          : !liveRun
            ? "watchdog_live_run_missing"
            : source !== "github_actions"
              ? "external_watchdog_run_missing"
              : !schedulerEnabled
                ? "watchdog_schedule_disabled"
                : metadata.credentialValidation !== true
                  ? "watchdog_credentials_unverified"
                  : !fresh
                    ? "watchdog_stale"
                    : "watchdog_not_healthy",
  };
}

function isPasswordOnlyCritical(checks) {
  const issues = checks.filter((check) => check?.severity !== "ok");
  return (
    issues.length === 1 &&
    issues[0]?.id === "official_storefront" &&
    issues[0]?.errorCode === "password_page"
  );
}

function unavailableState(reason) {
  return {
    ready: false,
    enabled: false,
    fresh: false,
    ageMinutes: null,
    reason,
  };
}

function ageInMinutes(value, now) {
  if (!value) return null;
  return Math.max(
    0,
    Math.floor((now.getTime() - value.getTime()) / 60_000),
  );
}

function parseDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : fallback;
}

function clean(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

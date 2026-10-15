import { resolveOperationalTimingPolicy } from "./operationalTimingPolicy.js";
import { resolveMonitorNotificationMode } from "./monitorNotificationPolicy.js";

const EVENTS = new Set([
  "pending",
  "sent",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "failed",
  "suppressed",
  "unknown",
  "unchecked",
]);

function timestamp(value, now) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date <= now
    ? date.toISOString()
    : null;
}

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

function freshness(value, limitMinutes, now, enabled) {
  const checkedAt = timestamp(value, now);
  const ageMinutes = checkedAt ? (now - new Date(checkedAt)) / 60_000 : null;
  return {
    status: !enabled
      ? "waiting"
      : ageMinutes === null || ageMinutes >= limitMinutes
        ? "critical"
        : "ok",
    code: !enabled
      ? "disabled"
      : ageMinutes === null
        ? "missing_or_invalid"
        : ageMinutes >= limitMinutes
          ? "stale"
          : "fresh",
    checkedAt,
    ageMinutes: ageMinutes === null ? null : Math.floor(ageMinutes),
  };
}

export function buildLaunchMonitorStatus({
  notification = {},
  monitorMetadata = {},
  catalogHeartbeat = null,
  catalogAvailable = true,
  env = {},
  now = new Date(),
} = {}) {
  const monitorEnabled = enabled(env.LAUNCH_MONITOR_ENABLED);
  const monitor = freshness(
    monitorMetadata.lastCheckedAt,
    15,
    now,
    monitorEnabled,
  );
  const heavy = freshness(
    monitorMetadata.lastHeavyCheckedAt,
    30,
    now,
    monitorEnabled,
  );
  const external = freshness(
    monitorMetadata.lastExternalCheckedAt,
    30,
    now,
    enabled(env.PRODUCTION_INTEGRITY_MONITOR_ENABLED),
  );
  const policy = resolveOperationalTimingPolicy(env);
  const lastSucceededAt = timestamp(catalogHeartbeat?.lastSucceededAt, now);
  const lastFailedAt = timestamp(catalogHeartbeat?.lastFailedAt, now);
  const age = lastSucceededAt
    ? (now - new Date(lastSucceededAt)) / 60_000
    : null;
  const invalidFailure = Boolean(
    catalogHeartbeat?.lastFailedAt && !lastFailedAt,
  );
  const failed = Boolean(
    lastFailedAt && (!lastSucceededAt || lastFailedAt > lastSucceededAt),
  );
  const catalogCode = !catalogAvailable
    ? "unavailable"
    : !policy.valid
      ? "timing_invalid"
      : !lastSucceededAt
        ? "success_missing_or_invalid"
        : invalidFailure || failed
          ? "latest_run_failed"
          : age >= policy.catalogSyncCriticalMinutes
            ? "critical_stale"
            : age >= policy.catalogSyncWarningMinutes
              ? "warning_stale"
              : "fresh";

  const humanVerifiedAt = timestamp(notification.humanVerifiedAt, now);
  const notificationReady =
    notification.ready === true &&
    notification.status === "VERIFIED" &&
    Boolean(humanVerifiedAt);
  const notificationCode = notificationReady
    ? "verified"
    : notification.status === "UNAVAILABLE"
      ? "unavailable"
      : notification.status === "UNCONFIGURED"
        ? "unconfigured"
        : ["DELIVERY_FAILED", "SEND_FAILED"].includes(notification.status)
          ? "delivery_failed"
          : notification.status !== "VERIFIED" || !humanVerifiedAt
            ? "human_confirmation_required"
            : "delivery_confirmation_required";

  const checks = Array.isArray(monitorMetadata.lastReport?.checks)
    ? monitorMetadata.lastReport.checks
    : [];
  const issues = checks.filter((check) =>
    ["warning", "critical"].includes(check?.severity),
  );
  const reportStatus = monitorMetadata.lastOverallStatus;
  const reportValid =
    checks.length > 0 &&
    ["healthy", "warning", "critical"].includes(reportStatus) &&
    checks.every((check) =>
      ["ok", "warning", "critical"].includes(check?.severity),
    );
  const reportFresh =
    monitor.status === "ok" &&
    heavy.status === "ok" &&
    external.status === "ok";

  return {
    schemaVersion: 1,
    checkedAt: now.toISOString(),
    notification: {
      ready: notificationReady,
      status: notificationReady
        ? "ok"
        : notificationCode === "delivery_failed" ||
            notificationCode === "unavailable"
          ? "critical"
          : "waiting",
      code: notificationCode,
      providerEvent: EVENTS.has(notification.providerEvent)
        ? notification.providerEvent
        : "unknown",
      sentAt: timestamp(notification.sentAt, now),
      humanVerifiedAt:
        notification.status === "VERIFIED" ? humanVerifiedAt : null,
    },
    catalog: {
      status:
        catalogCode === "fresh"
          ? "ok"
          : catalogCode === "warning_stale"
            ? "warning"
            : "critical",
      code: catalogCode,
      lastSucceededAt,
      lastFailedAt,
      ageMinutes: age === null ? null : Math.floor(age),
    },
    monitoring: { current: monitor, heavy, external },
    publication: {
      status:
        !reportValid || !reportFresh
          ? "waiting"
          : reportStatus === "critical" ||
              issues.some((check) => check.severity === "critical")
            ? "critical"
            : reportStatus === "warning" || issues.length > 0
              ? "warning"
              : "ok",
      code: !reportValid
        ? "report_missing_or_invalid"
        : !reportFresh
          ? "report_stale"
          : issues.length > 0 || reportStatus !== "healthy"
            ? "issues_pending"
            : "monitor_issues_clear",
      criticalCount: issues.filter((check) => check.severity === "critical")
        .length,
      warningCount: issues.filter((check) => check.severity === "warning")
        .length,
      checkedAt: monitor.checkedAt,
    },
    configuration: {
      notificationMode: resolveMonitorNotificationMode(env),
      scheduler:
        env.MAINTENANCE_SCHEDULER === "render"
          ? "render"
          : !env.MAINTENANCE_SCHEDULER || env.MAINTENANCE_SCHEDULER === "github"
            ? "github"
            : "unknown",
      maintenanceAuthorized:
        env.AUTONOMOUS_MAINTENANCE_AUTHORIZATION ===
        "OWNER_APPROVED_ROUTINE_DEV_PATCHES_V1",
    },
  };
}

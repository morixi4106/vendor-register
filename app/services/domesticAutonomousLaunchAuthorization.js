import { inspectPlatformDirectCheckoutMode } from "./platformDirectCheckoutMode.server.js";

export const DOMESTIC_AUTONOMOUS_LAUNCH_AUTHORIZATION =
  "OWNER_ACCEPTED_DOMESTIC_DIRECT_2026_09_29";
export const DOMESTIC_AUTONOMOUS_LAUNCH_SCOPE =
  "DOMESTIC_PLATFORM_DIRECT_ONLY";

export const DOMESTIC_AUTONOMOUS_LAUNCH_RISK_ACCEPTED_CHECK_KEYS =
  Object.freeze([
    "LEGAL_DISCLOSURES_REVIEWED",
    "CHECKOUT_FINAL_SCREEN_REVIEWED",
    "UNSUPPORTED_SALES_SURFACES_DISABLED",
    "EMERGENCY_STOP_DRILL_COMPLETED",
    "REFUND_LIQUIDITY_CONFIRMED",
    "ADMIN_MFA_ACCESS_REVIEWED",
    "PRIVACY_INCIDENT_RUNBOOK_CONFIRMED",
    "EMAIL_DELIVERY_CONFIRMED",
    "PLATFORM_DIRECT_PAYMENT_FLOW_VERIFIED",
  ]);

const AUTHORIZATION_MAX_DAYS = 90;
const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const ACCEPTED_CHECK_KEYS = new Set(
  DOMESTIC_AUTONOMOUS_LAUNCH_RISK_ACCEPTED_CHECK_KEYS,
);

function parseDate(value) {
  const date = new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date : null;
}

function isEnabled(value) {
  return ENABLED_VALUES.has(String(value || "").trim().toLowerCase());
}

export function getOperationalReadinessKeyFromCheckId(checkId) {
  const prefix = "operational_attestation_";
  const normalized = String(checkId || "").trim().toLowerCase();
  if (!normalized.startsWith(prefix)) return null;
  const suffix = normalized.slice(prefix.length);
  return (
    DOMESTIC_AUTONOMOUS_LAUNCH_RISK_ACCEPTED_CHECK_KEYS.find(
      (key) => key.toLowerCase() === suffix,
    ) || null
  );
}

export function isDomesticAutonomousLaunchRiskAcceptedCheck(checkId) {
  return Boolean(getOperationalReadinessKeyFromCheckId(checkId));
}

export function inspectDomesticAutonomousLaunchAuthorization(
  env = process.env,
  now = new Date(),
) {
  const checkoutMode = inspectPlatformDirectCheckoutMode(env);
  const authorizedAt = parseDate(
    env.DOMESTIC_AUTONOMOUS_LAUNCH_AUTHORIZED_AT,
  );
  const expiresAt = parseDate(env.DOMESTIC_AUTONOMOUS_LAUNCH_EXPIRES_AT);
  const enabled = isEnabled(env.DOMESTIC_AUTONOMOUS_LAUNCH_ENABLED);
  const authorizationMatches =
    String(env.DOMESTIC_AUTONOMOUS_LAUNCH_AUTHORIZATION || "").trim() ===
    DOMESTIC_AUTONOMOUS_LAUNCH_AUTHORIZATION;
  const scopeMatches =
    String(env.DOMESTIC_AUTONOMOUS_LAUNCH_SCOPE || "")
      .trim()
      .toUpperCase() === DOMESTIC_AUTONOMOUS_LAUNCH_SCOPE;
  const monitorEnabled = isEnabled(env.PRODUCTION_INTEGRITY_MONITOR_ENABLED);
  const durationValid = Boolean(
    authorizedAt &&
      expiresAt &&
      expiresAt.getTime() > authorizedAt.getTime() &&
      expiresAt.getTime() - authorizedAt.getTime() <=
        AUTHORIZATION_MAX_DAYS * 24 * 60 * 60 * 1000,
  );
  const timeValid = Boolean(
    durationValid &&
      authorizedAt.getTime() <= now.getTime() + 5 * 60 * 1000 &&
      expiresAt.getTime() > now.getTime(),
  );
  const active = Boolean(
    enabled &&
      authorizationMatches &&
      scopeMatches &&
      monitorEnabled &&
      checkoutMode.standardDirectReady &&
      timeValid,
  );

  let reason = null;
  if (!enabled) reason = "authorization_disabled";
  else if (!authorizationMatches) reason = "authorization_value_invalid";
  else if (!scopeMatches) reason = "authorization_scope_invalid";
  else if (!monitorEnabled) reason = "production_monitor_required";
  else if (!checkoutMode.standardDirectReady) {
    reason = checkoutMode.reason || "standard_direct_mode_required";
  } else if (!durationValid) reason = "authorization_window_invalid";
  else if (!timeValid) reason = "authorization_expired_or_not_started";

  return {
    active,
    reason,
    enabled,
    authorizationMatches,
    scopeMatches,
    monitorEnabled,
    durationValid,
    timeValid,
    authorizedAt,
    expiresAt,
    checkoutMode,
    acceptedCheckKeys: DOMESTIC_AUTONOMOUS_LAUNCH_RISK_ACCEPTED_CHECK_KEYS,
  };
}

export function canRiskAcceptOperationalReadinessRow(row) {
  const key = row?.definition?.key;
  return Boolean(
    ACCEPTED_CHECK_KEYS.has(key) && row?.attestation?.status !== "FAILED",
  );
}

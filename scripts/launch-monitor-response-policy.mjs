const PASSWORD_PROTECTION_CHECK_ID = "official_storefront";
const PASSWORD_PROTECTION_CODE = "password_page";

const ALLOWED_OWNER_RISK_WARNING_IDS = new Set([
  "operational_attestation_legal_disclosures_reviewed",
  "operational_attestation_checkout_final_screen_reviewed",
  "operational_attestation_unsupported_sales_surfaces_disabled",
  "operational_attestation_emergency_stop_drill_completed",
  "operational_attestation_refund_liquidity_confirmed",
  "operational_attestation_admin_mfa_access_reviewed",
  "operational_attestation_privacy_incident_runbook_confirmed",
  "operational_attestation_email_delivery_confirmed",
  "operational_attestation_platform_direct_payment_flow_verified",
]);

export function isExpectedPasswordCriticalPayload(payload) {
  if (
    payload?.status !== "critical" ||
    payload?.notificationKind !== "alert" ||
    !Array.isArray(payload?.checks)
  ) {
    return false;
  }

  const issues = payload.checks.filter((check) => check.status !== "healthy");
  const criticals = issues.filter((check) => check.status === "critical");
  const warnings = issues.filter((check) => check.status === "warning");

  return (
    criticals.length === 1 &&
    criticals[0]?.id === PASSWORD_PROTECTION_CHECK_ID &&
    criticals[0]?.code === PASSWORD_PROTECTION_CODE &&
    warnings.every((check) => ALLOWED_OWNER_RISK_WARNING_IDS.has(check.id)) &&
    criticals.length + warnings.length === issues.length
  );
}

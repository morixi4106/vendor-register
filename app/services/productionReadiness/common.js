export const STRIPE_ACCOUNT_PROBE_LIMIT = 10;
export const STRIPE_CONNECT_PRODUCTION_ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const PAYMENT_PROVIDER_SHOPIFY_PAYMENTS = "shopify_payments";
const SELLER_PAYOUT_PROVIDER_MANUAL = "manual";
export const SELLER_PAYOUT_PROVIDER_WISE = "wise";
export const DEFAULT_PAYMENT_PROVIDER = PAYMENT_PROVIDER_SHOPIFY_PAYMENTS;
export const DEFAULT_SELLER_PAYOUT_PROVIDER = SELLER_PAYOUT_PROVIDER_MANUAL;
export const SUPPORTED_PAYMENT_PROVIDERS = new Set([PAYMENT_PROVIDER_SHOPIFY_PAYMENTS]);
export const SUPPORTED_SELLER_PAYOUT_PROVIDERS = new Set([SELLER_PAYOUT_PROVIDER_MANUAL, SELLER_PAYOUT_PROVIDER_WISE]);
export const PAYMENT_PROVIDER_LABELS = {
  [PAYMENT_PROVIDER_SHOPIFY_PAYMENTS]: "Shopify Payments"
};
export const SELLER_PAYOUT_PROVIDER_LABELS = {
  [SELLER_PAYOUT_PROVIDER_MANUAL]: "Manual bank/Wise transfer",
  [SELLER_PAYOUT_PROVIDER_WISE]: "Wise API payout"
};
export const OPEN_PAYOUT_RUN_STATUSES = ["draft", "approved", "processing"];
export function normalizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}
export function normalizeShopDomain(value) {
  return String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
}
export function extractEmailAddress(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  const displayAddressMatch = normalized.match(/<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>/);
  if (displayAddressMatch) {
    return displayAddressMatch[1].toLowerCase();
  }
  return /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(normalized) ? normalized.toLowerCase() : null;
}
export function parseScopes(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return [];
  }
  return normalized.split(",").map(scope => scope.trim()).filter(Boolean);
}
export function detectStripeKeyMode(value, {
  livePrefix,
  testPrefix
}) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "missing";
  }
  if (normalized.startsWith(livePrefix)) {
    return "live";
  }
  if (normalized.startsWith(testPrefix)) {
    return "test";
  }
  return "unknown";
}
export function sanitizeStripeErrorMessage(message) {
  return String(message || "").replace(/sk_(live|test)_[A-Za-z0-9_]+/g, "sk_$1_***").replace(/rk_(live|test)_[A-Za-z0-9_]+/g, "rk_$1_***");
}
export function createCheck({
  id,
  category,
  status,
  title,
  detail,
  action,
  releaseBlocking,
  releaseDisposition,
  releaseDispositionReason
}) {
  return {
    id,
    category,
    status,
    title,
    detail: detail || "",
    action: action || "",
    ...(typeof releaseBlocking === "boolean" ? {
      releaseBlocking
    } : {}),
    ...(releaseDisposition ? {
      releaseDisposition
    } : {}),
    ...(releaseDispositionReason ? {
      releaseDispositionReason
    } : {})
  };
}
export function summarizeProductionReadinessChecks(checks) {
  const normalizedChecks = (checks || []).map(check => {
    if (typeof check.releaseBlocking === "boolean") {
      return check;
    }
    return {
      ...check,
      releaseBlocking: check.status !== "pass",
      releaseDisposition: check.status === "pass" ? "satisfied" : "decision_required"
    };
  });
  const blockingChecks = normalizedChecks.filter(check => check.status === "fail");
  const warningChecks = normalizedChecks.filter(check => check.status === "warning");
  const manualChecks = normalizedChecks.filter(check => check.status === "manual");
  const decisionRequiredChecks = normalizedChecks.filter(check => check.releaseBlocking && check.status !== "fail");
  const optionalChecks = normalizedChecks.filter(check => check.releaseDisposition === "scope_excluded");
  const releaseBlockingChecks = normalizedChecks.filter(check => check.releaseBlocking);
  return {
    checks: normalizedChecks,
    canGoLive: releaseBlockingChecks.length === 0,
    codeCanGoLive: blockingChecks.length === 0,
    summary: {
      totalChecks: normalizedChecks.length,
      blockingCount: blockingChecks.length,
      warningCount: warningChecks.length,
      manualCount: manualChecks.length,
      decisionRequiredCount: decisionRequiredChecks.length,
      optionalCount: optionalChecks.length,
      releaseBlockingCount: releaseBlockingChecks.length
    }
  };
}
export function isEnabledEnvFlag(env, key) {
  return STRIPE_CONNECT_PRODUCTION_ENABLED_VALUES.has(String(env[key] || "").trim().toLowerCase());
}
export function requiredOrWarningStatus(passes, required) {
  if (passes) {
    return "pass";
  }
  return required ? "fail" : "warning";
}

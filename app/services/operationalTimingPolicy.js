export const OPERATIONAL_TIMING_DEFAULTS = Object.freeze({
  catalogSyncIntervalMinutes: 15,
  catalogSyncWarningMinutes: 30,
  catalogSyncCriticalMinutes: 180,
  projectionTtlMinutes: 26 * 60,
});

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveOperationalTimingPolicy(env = process.env) {
  const policy = {
    catalogSyncIntervalMinutes:
      OPERATIONAL_TIMING_DEFAULTS.catalogSyncIntervalMinutes,
    catalogSyncWarningMinutes: positiveNumber(
      env?.SHOPIFY_PRODUCT_CATALOG_SYNC_WARNING_MINUTES,
      OPERATIONAL_TIMING_DEFAULTS.catalogSyncWarningMinutes,
    ),
    catalogSyncCriticalMinutes: positiveNumber(
      env?.SHOPIFY_PRODUCT_CATALOG_SYNC_CRITICAL_MINUTES,
      OPERATIONAL_TIMING_DEFAULTS.catalogSyncCriticalMinutes,
    ),
    projectionTtlMinutes: OPERATIONAL_TIMING_DEFAULTS.projectionTtlMinutes,
  };
  const valid =
    policy.catalogSyncIntervalMinutes < policy.catalogSyncWarningMinutes &&
    policy.catalogSyncWarningMinutes < policy.catalogSyncCriticalMinutes &&
    policy.catalogSyncCriticalMinutes < policy.projectionTtlMinutes;

  return {
    ...policy,
    valid,
    invariant:
      "catalogSyncIntervalMinutes < catalogSyncWarningMinutes < catalogSyncCriticalMinutes < projectionTtlMinutes",
  };
}

export const INTERNATIONAL_SHIPPING_SERVICE = "JAPAN_POST_AIR_PACKET";

export const INTERNATIONAL_SERVICE_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  PARTIAL: "PARTIAL",
  SUSPENDED: "SUSPENDED",
  UNKNOWN: "UNKNOWN",
});

const VALID_STATUSES = new Set(Object.values(INTERNATIONAL_SERVICE_STATUS));

export function normalizeInternationalServiceStatus(value) {
  const status = String(value || "").trim().toUpperCase();
  return VALID_STATUSES.has(status)
    ? status
    : INTERNATIONAL_SERVICE_STATUS.UNKNOWN;
}

export function isInternationalServiceActive(value) {
  return (
    normalizeInternationalServiceStatus(value) ===
    INTERNATIONAL_SERVICE_STATUS.ACTIVE
  );
}

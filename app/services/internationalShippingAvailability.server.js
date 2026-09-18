import prisma from "../db.server.js";
import { resolveJapanPostAirPacketZone } from "./japanPostAirPacket.server.js";
import {
  INTERNATIONAL_SERVICE_STATUS,
  INTERNATIONAL_SHIPPING_SERVICE,
  normalizeInternationalServiceStatus,
} from "../utils/internationalShipping.js";

export const INTERNATIONAL_SHIPPING_AVAILABILITY_MAX_AGE_DAYS = 7;

export {
  INTERNATIONAL_SERVICE_STATUS,
  INTERNATIONAL_SHIPPING_SERVICE,
  isInternationalServiceActive,
  normalizeInternationalServiceStatus,
} from "../utils/internationalShipping.js";

export function evaluateInternationalShippingAvailability(
  availability,
  {
    now = new Date(),
    maxAgeDays = INTERNATIONAL_SHIPPING_AVAILABILITY_MAX_AGE_DAYS,
  } = {},
) {
  const status = normalizeInternationalServiceStatus(availability?.status);
  const checkedAt = availability?.checkedAt
    ? new Date(availability.checkedAt)
    : null;
  const checkedAtValid = checkedAt && !Number.isNaN(checkedAt.getTime());
  const checkedAtInFuture = checkedAtValid && checkedAt.getTime() > now.getTime();
  const staleBefore = new Date(
    now.getTime() - Number(maxAgeDays) * 24 * 60 * 60 * 1000,
  );
  const stale = !checkedAtValid || checkedAtInFuture || checkedAt < staleBefore;

  return {
    status,
    checkedAt: checkedAtValid ? checkedAt : null,
    configured: availability?.configured !== false && Boolean(availability),
    stale,
    deliverable: status === INTERNATIONAL_SERVICE_STATUS.ACTIVE && !stale,
    reason:
      status !== INTERNATIONAL_SERVICE_STATUS.ACTIVE
        ? "international_service_not_active"
        : checkedAtInFuture
          ? "international_service_status_invalid"
          : stale
          ? "international_service_status_stale"
          : null,
  };
}

export async function getInternationalShippingCountryAvailability({
  countryCode,
  service = INTERNATIONAL_SHIPPING_SERVICE,
  prismaClient = prisma,
} = {}) {
  const normalizedCountryCode = String(countryCode || "").trim().toUpperCase();

  if (!normalizedCountryCode || !resolveJapanPostAirPacketZone(normalizedCountryCode)) {
    return {
      countryCode: normalizedCountryCode || null,
      service,
      status: INTERNATIONAL_SERVICE_STATUS.UNKNOWN,
      checkedAt: null,
      configured: false,
    };
  }

  const record = await prismaClient.internationalShippingCountryAvailability.findUnique({
    where: {
      countryCode_service: {
        countryCode: normalizedCountryCode,
        service,
      },
    },
  });

  return record || {
    countryCode: normalizedCountryCode,
    service,
    status: INTERNATIONAL_SERVICE_STATUS.UNKNOWN,
    checkedAt: null,
    configured: false,
  };
}

export async function saveInternationalShippingCountryAvailability({
  countryCode,
  status,
  note = null,
  sourceUrl = null,
  service = INTERNATIONAL_SHIPPING_SERVICE,
  prismaClient = prisma,
  now = new Date(),
} = {}) {
  const normalizedCountryCode = String(countryCode || "").trim().toUpperCase();
  const normalizedStatus = normalizeInternationalServiceStatus(status);

  if (!resolveJapanPostAirPacketZone(normalizedCountryCode)) {
    throw new Error("料金地帯を特定できない国・地域コードです。");
  }

  return prismaClient.internationalShippingCountryAvailability.upsert({
    where: {
      countryCode_service: {
        countryCode: normalizedCountryCode,
        service,
      },
    },
    create: {
      countryCode: normalizedCountryCode,
      service,
      status: normalizedStatus,
      note: String(note || "").trim() || null,
      sourceUrl: String(sourceUrl || "").trim() || null,
      checkedAt: now,
    },
    update: {
      status: normalizedStatus,
      note: String(note || "").trim() || null,
      sourceUrl: String(sourceUrl || "").trim() || null,
      checkedAt: now,
    },
  });
}

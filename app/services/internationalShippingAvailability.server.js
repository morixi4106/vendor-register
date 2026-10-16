import prisma from "../db.server.js";
import {
  assertInternationalEvidenceVersion,
  internationalGateTransaction,
  invalidateInternationalGates,
  flushInternationalGateStops,
} from "./internationalGateQueue.server.js";
import { resolveJapanPostAirPacketZone } from "./japanPostAirPacket.server.js";
import {
  INTERNATIONAL_SERVICE_STATUS,
  INTERNATIONAL_SHIPPING_SERVICE,
  normalizeInternationalServiceStatus,
} from "../utils/internationalShipping.js";
import {
  getInternationalMarketReadiness,
  revokeInternationalMarketEvidence,
  saveInternationalMarketEvidence,
} from "./internationalMarketReadiness.server.js";

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
  const checkedAtInFuture =
    checkedAtValid && checkedAt.getTime() > now.getTime();
  const staleBefore = new Date(
    now.getTime() - Number(maxAgeDays) * 24 * 60 * 60 * 1000,
  );
  const stale = !checkedAtValid || checkedAtInFuture || checkedAt < staleBefore;
  const marketReady = availability?.marketReadiness?.ready === true;

  return {
    status,
    checkedAt: checkedAtValid ? checkedAt : null,
    configured: availability?.configured !== false && Boolean(availability),
    stale,
    marketReady,
    deliverable:
      status === INTERNATIONAL_SERVICE_STATUS.ACTIVE && !stale && marketReady,
    reason:
      status !== INTERNATIONAL_SERVICE_STATUS.ACTIVE
        ? "international_service_not_active"
        : checkedAtInFuture
          ? "international_service_status_invalid"
          : stale
            ? "international_service_status_stale"
            : !marketReady
              ? "international_market_evidence_incomplete"
              : null,
  };
}

export async function getInternationalShippingCountryAvailability({
  countryCode,
  service = INTERNATIONAL_SHIPPING_SERVICE,
  prismaClient = prisma,
} = {}) {
  const normalizedCountryCode = String(countryCode || "")
    .trim()
    .toUpperCase();

  if (
    !normalizedCountryCode ||
    !resolveJapanPostAirPacketZone(normalizedCountryCode)
  ) {
    return {
      countryCode: normalizedCountryCode || null,
      service,
      status: INTERNATIONAL_SERVICE_STATUS.UNKNOWN,
      checkedAt: null,
      configured: false,
    };
  }

  const record =
    await prismaClient.internationalShippingCountryAvailability.findUnique({
      where: {
        countryCode_service: {
          countryCode: normalizedCountryCode,
          service,
        },
      },
    });

  if (!record) {
    return {
      countryCode: normalizedCountryCode,
      service,
      status: INTERNATIONAL_SERVICE_STATUS.UNKNOWN,
      checkedAt: null,
      configured: false,
      marketReadiness: null,
    };
  }

  const marketReadiness = await getInternationalMarketReadiness({
    countryCode: normalizedCountryCode,
    prismaClient,
  });

  return {
    ...record,
    marketReadiness,
  };
}

export async function saveInternationalShippingCountryAvailability({
  countryCode,
  status,
  note = null,
  sourceUrl = null,
  evidenceReference = null,
  evidenceHash = null,
  confirmedBy = null,
  deliveryProfileId = null,
  carrierConfirmations = {},
  routeAuditConfirmations = {},
  expectedVersion,
  expectedEvidenceVersions,
  service = INTERNATIONAL_SHIPPING_SERVICE,
  prismaClient = prisma,
  now = new Date(),
} = {}) {
  const normalizedCountryCode = String(countryCode || "")
    .trim()
    .toUpperCase();
  const normalizedStatus = normalizeInternationalServiceStatus(status);

  if (!resolveJapanPostAirPacketZone(normalizedCountryCode)) {
    throw new Error("料金地帯を特定できない国・地域コードです。");
  }

  async function persist(client) {
    if (
      expectedVersion !== undefined &&
      (!expectedEvidenceVersions ||
        [
          "INTERNATIONAL_CARRIER_SERVICE_STATUS",
          "INTERNATIONAL_SHOPIFY_DELIVERY_ROUTE_AUDIT",
        ].some((code) => typeof expectedEvidenceVersions[code] !== "string"))
    ) {
      throw new Error("international_shipping_evidence_versions_required");
    }
    if (expectedVersion !== undefined)
      assertInternationalEvidenceVersion(
        await client.internationalShippingCountryAvailability.findUnique({
          where: {
            countryCode_service: {
              countryCode: normalizedCountryCode,
              service,
            },
          },
        }),
        expectedVersion,
      );
    if (normalizedStatus === INTERNATIONAL_SERVICE_STATUS.ACTIVE) {
      const normalizedDeliveryProfileId = String(
        deliveryProfileId || "",
      ).trim();
      if (!normalizedDeliveryProfileId) {
        throw new Error(
          "Shopify delivery profile ID is required for an active international route.",
        );
      }
      await saveInternationalMarketEvidence({
        countryCode: normalizedCountryCode,
        requirementCode: "INTERNATIONAL_CARRIER_SERVICE_STATUS",
        evidenceReference,
        evidenceHash,
        officialSourceUrl: sourceUrl,
        confirmedBy,
        confirmations: carrierConfirmations,
        notes: note,
        metadata: { service },
        expectedVersion:
          expectedEvidenceVersions?.INTERNATIONAL_CARRIER_SERVICE_STATUS,
        enqueueSync: false,
        prismaClient: client,
        now,
      });
      await saveInternationalMarketEvidence({
        countryCode: normalizedCountryCode,
        requirementCode: "INTERNATIONAL_SHOPIFY_DELIVERY_ROUTE_AUDIT",
        evidenceReference,
        evidenceHash,
        officialSourceUrl: sourceUrl,
        confirmedBy,
        confirmations: routeAuditConfirmations,
        notes: note,
        metadata: {
          service,
          deliveryProfileId: normalizedDeliveryProfileId,
        },
        expectedVersion:
          expectedEvidenceVersions?.INTERNATIONAL_SHOPIFY_DELIVERY_ROUTE_AUDIT,
        enqueueSync: false,
        prismaClient: client,
        now,
      });
    } else {
      await revokeInternationalMarketEvidence({
        countryCode: normalizedCountryCode,
        requirementCode: "INTERNATIONAL_CARRIER_SERVICE_STATUS",
        confirmedBy,
        notes: note || `Shipping service changed to ${normalizedStatus}`,
        expectedVersion:
          expectedEvidenceVersions?.INTERNATIONAL_CARRIER_SERVICE_STATUS,
        enqueueSync: false,
        prismaClient: client,
        now,
      });
      await revokeInternationalMarketEvidence({
        countryCode: normalizedCountryCode,
        requirementCode: "INTERNATIONAL_SHOPIFY_DELIVERY_ROUTE_AUDIT",
        confirmedBy,
        notes: note || `Shipping route changed to ${normalizedStatus}`,
        expectedVersion:
          expectedEvidenceVersions?.INTERNATIONAL_SHOPIFY_DELIVERY_ROUTE_AUDIT,
        enqueueSync: false,
        prismaClient: client,
        now,
      });
    }

    const result = await client.internationalShippingCountryAvailability.upsert(
      {
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
          revision: { increment: 1 },
          status: normalizedStatus,
          note: String(note || "").trim() || null,
          sourceUrl: String(sourceUrl || "").trim() || null,
          checkedAt: now,
        },
      },
    );
    await invalidateInternationalGates(client, { now });
    return result;
  }

  const result = await internationalGateTransaction(prismaClient, persist);
  await flushInternationalGateStops(prismaClient);
  return result;
}

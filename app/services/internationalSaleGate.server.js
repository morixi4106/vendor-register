import crypto from "node:crypto";

import prisma from "../db.server.js";
import { normalizeCountryCode } from "../utils/deliveryEligibility.js";
import { evaluateInternationalMarketReadiness } from "../utils/internationalMarketReadiness.js";
import {
  normalizeShopDomain,
  shopifyGraphQLWithOfflineSession,
} from "../utils/shopifyAdmin.server.js";
import { SHOPIFY_API_VERSION } from "../utils/shopifyApiVersion.js";
import { evaluateInternationalShippingAvailability } from "./internationalShippingAvailability.server.js";

export const INTERNATIONAL_SALE_GATE_KEY = "international_sale_gate";
export const INTERNATIONAL_SALE_GATE_VERSION = 1;

const SHOP_GATE_QUERY = `#graphql
  query InternationalSaleGateState {
    shop {
      id
      internationalSaleGate: metafield(
        namespace: "$app"
        key: "international_sale_gate"
      ) {
        value
        compareDigest
      }
    }
  }
`;

const SHOP_GATE_MUTATION = `#graphql
  mutation SetInternationalSaleGate($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        key
        value
        compareDigest
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

function parseJson(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function hashProjection(projection) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(projection))
    .digest("hex");
}

function isoDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function getEarliestExpiry(row, attestations) {
  const shippingExpiry = new Date(
    new Date(row.checkedAt).getTime() + 7 * 24 * 60 * 60 * 1000,
  );
  return attestations.reduce((earliest, attestation) => {
    const expiresAt = attestation?.expiresAt
      ? new Date(attestation.expiresAt)
      : null;
    return expiresAt && expiresAt < earliest ? expiresAt : earliest;
  }, shippingExpiry);
}

export async function buildInternationalSaleGateProjection({
  prismaClient = prisma,
  now = new Date(),
  revision = 1,
} = {}) {
  const shippingRows =
    await prismaClient.internationalShippingCountryAvailability.findMany({
      where: { status: "ACTIVE" },
      orderBy: [{ countryCode: "asc" }],
    });
  const countryCodes = shippingRows
    .map((row) => normalizeCountryCode(row.countryCode))
    .filter(Boolean);
  const attestations =
    countryCodes.length === 0
      ? []
      : await prismaClient.operationalReadinessAttestation.findMany({
          where: {
            scopeType: "MARKET_COUNTRY",
            scopeId: { in: countryCodes },
          },
        });
  const byCountry = new Map();
  for (const attestation of attestations) {
    const country = normalizeCountryCode(attestation.scopeId);
    if (!byCountry.has(country)) byCountry.set(country, []);
    byCountry.get(country).push(attestation);
  }

  const allowedCountries = [];
  const blockedCountries = [];
  const expiries = [];
  for (const row of shippingRows) {
    const countryCode = normalizeCountryCode(row.countryCode);
    const countryAttestations = byCountry.get(countryCode) || [];
    const marketReadiness = evaluateInternationalMarketReadiness({
      countryCode,
      attestations: countryAttestations,
      now,
    });
    const shippingReadiness = evaluateInternationalShippingAvailability(
      { ...row, marketReadiness },
      { now },
    );
    if (shippingReadiness.deliverable) {
      allowedCountries.push(countryCode);
      expiries.push(getEarliestExpiry(row, countryAttestations));
    } else {
      blockedCountries.push({
        countryCode,
        reason: shippingReadiness.reason,
        marketReasons: marketReadiness.reasons,
      });
    }
  }

  const fallbackExpiry = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const earliestExpiry = expiries.sort((left, right) => left - right)[0] || fallbackExpiry;
  const base = {
    v: INTERNATIONAL_SALE_GATE_VERSION,
    r: Math.max(1, Number(revision) || 1),
    d: isoDate(now),
    e: isoDate(earliestExpiry),
    c: allowedCountries.sort(),
  };

  return {
    projection: { ...base, h: hashProjection(base) },
    allowedCountries: base.c,
    blockedCountries,
  };
}

export async function getInternationalSaleGateState(
  { shopDomain: rawShopDomain },
  { graphQL = shopifyGraphQLWithOfflineSession } = {},
) {
  const shopDomain = normalizeShopDomain(rawShopDomain);
  if (!shopDomain) return { ok: false, reason: "invalid_shop_domain" };
  const response = await graphQL({
    shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: SHOP_GATE_QUERY,
  });
  const shop = response?.data?.shop;
  if (!shop?.id) return { ok: false, reason: "shop_not_found" };
  return {
    ok: true,
    shopDomain,
    shopId: shop.id,
    value: parseJson(shop.internationalSaleGate?.value),
    serializedValue: shop.internationalSaleGate?.value || null,
    compareDigest: shop.internationalSaleGate?.compareDigest ?? null,
  };
}

export async function syncInternationalSaleGate(
  {
    shopDomain,
    prismaClient = prisma,
    now = new Date(),
  },
  { graphQL = shopifyGraphQLWithOfflineSession } = {},
) {
  const current = await getInternationalSaleGateState(
    { shopDomain },
    { graphQL },
  );
  if (!current.ok) return current;
  const currentRevision = Number(current.value?.r);
  const built = await buildInternationalSaleGateProjection({
    prismaClient,
    now,
    revision: Number.isInteger(currentRevision) ? currentRevision + 1 : 1,
  });
  const serialized = JSON.stringify(built.projection);

  const response = await graphQL({
    shopDomain: current.shopDomain,
    apiVersion: SHOPIFY_API_VERSION,
    query: SHOP_GATE_MUTATION,
    variables: {
      metafields: [
        {
          ownerId: current.shopId,
          namespace: "$app",
          key: INTERNATIONAL_SALE_GATE_KEY,
          type: "json",
          value: serialized,
          compareDigest: current.compareDigest,
        },
      ],
    },
  });
  const payload = response?.data?.metafieldsSet;
  const errors = Array.isArray(payload?.userErrors) ? payload.userErrors : [];
  if (errors.length > 0) {
    const error = new Error(
      `International sale gate sync failed: ${errors
        .map((entry) => entry.message)
        .join(", ")}`,
    );
    error.userErrors = errors;
    throw error;
  }

  const verified = await getInternationalSaleGateState(
    { shopDomain: current.shopDomain },
    { graphQL },
  );
  if (!verified.ok || verified.serializedValue !== serialized) {
    throw new Error("International sale gate read-back verification failed");
  }

  return {
    ok: true,
    shopDomain: current.shopDomain,
    projection: built.projection,
    allowedCountries: built.allowedCountries,
    blockedCountries: built.blockedCountries,
    compareDigest: verified.compareDigest,
  };
}

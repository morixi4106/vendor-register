import { createHash } from "node:crypto";
import { evaluateInternationalMarketReadiness } from "../utils/internationalMarketReadiness.js";
import { evaluateInternationalMarketCompliance } from "../utils/internationalMarketCompliance.js";
import { JAPAN_POST_AIR_PACKET_COUNTRY_CODES } from "../utils/japanPostAirPacket.js";
import { evaluateInternationalShippingAvailability } from "./internationalShippingAvailability.server.js";
import {
  evaluateSaleEligibilitySnapshot,
  SALE_ELIGIBILITY_PRODUCT_INCLUDE,
  persistSaleEligibilityProjection,
} from "./saleEligibility.server.js";
import { getPlatformOperationalControl } from "./operationalControls.server.js";

export const INTERNATIONAL_GATE_POLICY = "international-sale-2026-10-v1";
export const INTERNATIONAL_PRODUCT_GATE_KEY = "international_sale_eligibility";
export const INTERNATIONAL_SHOP_GATE_KEY = "international_sale_gate";
export const MAX_INTERNATIONAL_PRODUCTS = 200;

function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export function serializeInternationalProjection(value) {
  return JSON.stringify(canonical(value));
}

export function internationalHash(value) {
  return createHash("sha256")
    .update(serializeInternationalProjection(value))
    .digest("hex");
}

export function sealInternationalProjection(base) {
  return { ...base, h: internationalHash(base) };
}

export function internationalLocalDate(value, timezone) {
  if (!timezone || !Number.isFinite(new Date(value).getTime()))
    throw new Error("international_timezone_or_date_invalid");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function normalizeInternationalScope(scope) {
  if (
    Array.isArray(scope) &&
    scope.reduce(
      (sum, row) =>
        sum + (Array.isArray(row?.countries) ? row.countries.length : 0),
      0,
    ) > 256
  )
    throw new Error("international_scope_work_limit");
  if (
    !Array.isArray(scope) ||
    !scope.length ||
    scope.length > MAX_INTERNATIONAL_PRODUCTS
  )
    throw new Error("international_scope_invalid");
  const ids = new Set();
  return scope
    .map((row) => {
      if (
        !row?.productId ||
        typeof row.productId !== "string" ||
        ids.has(row.productId) ||
        !/^gid:\/\/shopify\/Product\/\d+$/.test(row.shopifyProductId || "") ||
        !Array.isArray(row.countries) ||
        !row.countries.length ||
        row.countries.length > 128
      )
        throw new Error("international_scope_invalid");
      ids.add(row.productId);
      const countries = [...new Set(row.countries)].sort();
      if (
        countries.some(
          (code) =>
            code === "JP" ||
            !JAPAN_POST_AIR_PACKET_COUNTRY_CODES.includes(code),
        )
      )
        throw new Error("international_country_invalid");
      return {
        productId: row.productId,
        shopifyProductId: row.shopifyProductId,
        countries,
      };
    })
    .sort((a, b) => a.productId.localeCompare(b.productId));
}

function minimumDate(values) {
  const timestamps = values
    .filter((v) => v != null)
    .map((v) => new Date(v).getTime());
  if (!timestamps.length || timestamps.some((v) => !Number.isFinite(v)))
    throw new Error("international_dependency_date_invalid");
  return new Date(Math.min(...timestamps));
}

// Only the selected decisions/evidence and their requirement versions bound an allow.
function productDeadline(product, result, country, now) {
  const international = evaluateInternationalMarketCompliance({
    product,
    destinationCountry: country,
    evaluatedAt: now,
  });
  const decisionIds = new Set(
    international.requirements.map((r) => r.decisionId),
  );
  const genericDecision = (product.complianceDecisions || [])
    .filter(
      (row) =>
        !row.requirementId &&
        !row.requirement &&
        (!row.reviewDueAt || new Date(row.reviewDueAt) > now),
    )
    .sort((a, b) => new Date(b.decidedAt) - new Date(a.decidedAt))[0];
  if (genericDecision) decisionIds.add(genericDecision.id);
  const selected = (product.complianceDecisions || []).filter((row) =>
    decisionIds.has(row.id),
  );
  const levels = [
    "UNVERIFIED",
    "SELF_ATTESTED",
    "DOCUMENT_REVIEWED",
    "ISSUER_VERIFIED",
    "API_VERIFIED",
  ];
  const evidence = selected
    .filter((decision) => decision.decision === "COMPLIANT")
    .map((decision) => {
      const candidates = (product.complianceEvidence || []).filter(
        (row) =>
          row.status === "VERIFIED" &&
          !row.revokedAt &&
          (row.requirementId || null) === (decision.requirementId || null) &&
          levels.indexOf(row.verificationLevel) >=
            levels.indexOf(
              decision.requirement?.requiredVerificationLevel ||
                "DOCUMENT_REVIEWED",
            ) &&
          [row.expiresAt, row.reviewDueAt].every(
            (date) => !date || new Date(date) > now,
          ),
      );
      return candidates.sort((a, b) => {
        const deadline = (row) =>
          Math.min(
            ...[row.expiresAt, row.reviewDueAt]
              .filter(Boolean)
              .map((d) => new Date(d).getTime()),
            Infinity,
          );
        return deadline(b) - deadline(a);
      })[0];
    })
    .filter(Boolean);
  return minimumDate([
    result.expiresAt,
    product.complianceProfile?.nextReviewAt,
    ...[...selected, ...evidence].flatMap((row) => [
      row.expiresAt,
      row.reviewDueAt,
      row.requirement?.effectiveUntil,
      row.requirement?.reviewDueAt,
    ]),
  ]);
}

export function closedInternationalGate(
  generation,
  now,
  timezone,
  state = "PREPARING",
) {
  const d = internationalLocalDate(now, timezone);
  return sealInternationalProjection({
    v: 2,
    p: INTERNATIONAL_GATE_POLICY,
    g: generation,
    s: state,
    d,
    e: d,
    c: [],
  });
}

export async function buildInternationalGateSnapshot({
  state,
  prismaClient,
  now = new Date(),
  env = process.env,
  persist = false,
}) {
  const scope = normalizeInternationalScope(state.authorizedScopeJson);
  const products = await prismaClient.product.findMany({
    where: {
      id: { in: scope.map((s) => s.productId) },
      shopDomain: state.shopDomain,
    },
    include: SALE_ELIGIBILITY_PRODUCT_INCLUDE,
  });
  const countries = [...new Set(scope.flatMap((s) => s.countries))].sort();
  const shipping =
    await prismaClient.internationalShippingCountryAvailability.findMany({
      where: { countryCode: { in: countries } },
    });
  const attestations =
    await prismaClient.operationalReadinessAttestation.findMany({
      where: { scopeType: "MARKET_COUNTRY", scopeId: { in: countries } },
    });
  const control = await getPlatformOperationalControl({ prismaClient });
  if (!control.available)
    throw new Error("international_operational_control_unverified");
  if (
    !state.authorizationExpiresAt ||
    !Number.isFinite(new Date(state.authorizationExpiresAt).getTime())
  )
    throw new Error("international_authorization_unverified");
  const countryResults = new Map(
    countries.map((country) => {
      const rows = attestations.filter((row) => row.scopeId === country);
      const market = evaluateInternationalMarketReadiness({
        countryCode: country,
        attestations: rows,
        now,
      });
      const route = shipping.find(
        (row) =>
          row.countryCode === country &&
          row.service === "JAPAN_POST_AIR_PACKET",
      );
      const ready = evaluateInternationalShippingAvailability(
        route && { ...route, marketReadiness: market },
        { now },
      ).deliverable;
      const expiresAt = ready
        ? minimumDate([
            new Date(new Date(route.checkedAt).getTime() + 7 * 86400000),
            ...market.requirements.map((r) => r.expiresAt),
          ])
        : now;
      return [
        country,
        {
          ready,
          expiresAt,
          source: [
            route?.id,
            route?.status,
            route?.checkedAt,
            ...rows.map((r) => [
              r.id,
              r.checkKey,
              r.revision,
              r.updatedAt,
              r.status,
              r.expiresAt,
              r.evidenceHash,
            ]),
          ],
        },
      ];
    }),
  );
  const d = internationalLocalDate(now, state.shopTimezone);
  const targets = [];
  const sources = [];
  const expiries = [];
  for (const entry of scope) {
    const product = products.find((p) => p.id === entry.productId);
    const allowed = [];
    const productExpiries = [];
    for (const country of entry.countries) {
      if (
        !product ||
        product.shopifyProductId !== entry.shopifyProductId ||
        product.vendorStore?.isPlatformStore !== true ||
        product.vendorStore?.isTestStore === true ||
        product.complianceEvidence.length >= 100 ||
        product.complianceDecisions.length >= 100
      )
        continue;
      let result = evaluateSaleEligibilitySnapshot({
        product,
        shopDomain: state.shopDomain,
        destinationCountry: country,
        salesChannel: "SHOPIFY_STANDARD_CHECKOUT",
        operationalControl: control,
        env,
        evaluatedAt: now,
      });
      sources.push([
        product.id,
        country,
        result.inputHash,
        result.status,
        result.requirementVersions,
        result.decisionIds,
      ]);
      if (
        state.mode !== "ENFORCE" ||
        control.internationalShippingHold ||
        !result.allowed ||
        result.status !== "ELIGIBLE" ||
        !countryResults.get(country)?.ready
      )
        continue;
      if (persist)
        result =
          (await persistSaleEligibilityProjection(result, { prismaClient })) ||
          result;
      const deadline = minimumDate([
        productDeadline(product, result, country, now),
        countryResults.get(country).expiresAt,
        state.authorizationExpiresAt,
      ]);
      if (internationalLocalDate(deadline, state.shopTimezone) <= d) continue;
      allowed.push(country);
      productExpiries.push(deadline);
    }
    const deadline = productExpiries.length
      ? minimumDate(productExpiries)
      : now;
    expiries.push(deadline);
    const projection = sealInternationalProjection({
      v: 1,
      p: INTERNATIONAL_GATE_POLICY,
      i: entry.shopifyProductId,
      g: state.desiredGeneration,
      r: state.desiredGeneration,
      d,
      e: internationalLocalDate(deadline, state.shopTimezone),
      c: allowed.sort(),
    });
    targets.push({
      productId: entry.productId,
      targetId: entry.shopifyProductId,
      projection,
    });
  }
  const allowedCountries = [
    ...new Set(targets.flatMap((t) => t.projection.c)),
  ].sort();
  const activeExpiries = targets
    .filter((t) => t.projection.c.length)
    .map((t) => t.projection.e)
    .sort();
  const e = activeExpiries[0] || d;
  const shop = sealInternationalProjection({
    v: 2,
    p: INTERNATIONAL_GATE_POLICY,
    g: state.desiredGeneration,
    s: allowedCountries.length ? "ACTIVE" : "BLOCKED",
    d,
    e,
    c: allowedCountries,
  });
  const controlSource = {
    checkoutHold: control.checkoutHold,
    checkoutControlState: control.checkoutControlState,
    internationalShippingHold: control.internationalShippingHold,
  };
  return {
    targets,
    shop,
    sourceHash: internationalHash([
      sources,
      [...countryResults],
      controlSource,
    ]),
    nextExpiryAt:
      expiries.filter((date) => date > now).sort((a, b) => a - b)[0] || null,
  };
}

import { inspectMarketplaceCheckoutValidation } from "./shopifyCheckoutValidation.server.js";
import { collectInternationalCheckoutInventory } from "./internationalCheckoutInventory.server.js";
import {
  createNativeReadSession,
  hashNativeConfiguration,
  inspectNativeReadAccess,
  nativeConnectionComplete as complete,
  NATIVE_MARKETS_QUERY,
  readNativeInventory,
} from "./internationalNativeInventory.server.js";
const PROFILES = `query InternationalNativeProfiles($after: String) {
  deliveryProfiles(first: 1, after: $after) { nodes { id default version
    sellingPlanGroups(first: 1) { nodes { id } pageInfo { hasNextPage } }
    profileItems(first: 25) { nodes { product { id } variants(first: 10) { nodes { id } pageInfo { hasNextPage } } } pageInfo { hasNextPage } }
    profileLocationGroups { locationGroupZones(first: 5) { nodes {
      zone { id countries { code { countryCode restOfWorld } provinces { code } } }
      methodDefinitions(first: 10) { nodes { id active methodConditions { id }
        rateProvider { __typename ... on DeliveryRateDefinition { id price { amount currencyCode } }
          ... on DeliveryParticipant { id adaptToNewServicesFlag percentageOfRateFee fixedFee { amount currencyCode }
            participantServices { name active } carrierService { id active callbackUrl } } }
      } pageInfo { hasNextPage } }
    } pageInfo { hasNextPage } } }
  } pageInfo { hasNextPage endCursor } }
}`;

export function evaluateInternationalNativeInventory({
  markets,
  profiles,
  scope = [],
  expectedRoutes = {},
}) {
  if (!markets.length)
    return { available: false, reason: "international_market_inventory_empty" };
  const countries = new Set();
  for (const market of markets) {
    if (market.status === "DRAFT") continue;
    const condition = market.conditions;
    const regions = condition?.regionsCondition;
    if (
      market.status !== "ACTIVE" ||
      !Array.isArray(condition?.conditionTypes) ||
      condition.conditionTypes.length !== 1 ||
      condition.conditionTypes[0] !== "REGION" ||
      regions?.applicationLevel !== "SPECIFIED" ||
      !complete(regions?.regions) ||
      regions.regions.nodes.some(
        (r) =>
          r.__typename !== "MarketRegionCountry" || !/^[A-Z]{2}$/.test(r.code),
      )
    ) {
      return {
        available: false,
        reason: "international_market_shape_unverified",
      };
    }
    for (const region of regions.regions.nodes) countries.add(region.code);
  }
  for (const profile of profiles) {
    if (
      !complete(profile.profileItems) ||
      !complete(profile.sellingPlanGroups) ||
      profile.sellingPlanGroups.nodes.length ||
      !Array.isArray(profile.profileLocationGroups) ||
      profile.profileLocationGroups.length > 5 ||
      profile.profileItems.nodes.some((p) => !complete(p.variants))
    ) {
      return {
        available: false,
        reason: "international_profile_inventory_incomplete",
      };
    }
    for (const group of profile.profileLocationGroups) {
      if (!complete(group.locationGroupZones))
        return {
          available: false,
          reason: "international_zone_inventory_incomplete",
        };
      for (const zone of group.locationGroupZones.nodes) {
        if (
          !Array.isArray(zone.zone?.countries) ||
          zone.zone.countries.some(
            (country) =>
              !Array.isArray(country.provinces) ||
              country.provinces.length > 200 ||
              (!country.code?.restOfWorld &&
                !/^[A-Z]{2}$/.test(country.code?.countryCode || "")),
          ) ||
          !complete(zone.methodDefinitions) ||
          zone.methodDefinitions.nodes.some(
            (m) =>
              !m.id ||
              typeof m.active !== "boolean" ||
              !Array.isArray(m.methodConditions) ||
              m.methodConditions.length > 0 ||
              !["DeliveryRateDefinition", "DeliveryParticipant"].includes(
                m.rateProvider?.__typename,
              ),
          )
        ) {
          return {
            available: false,
            reason: "international_rate_inventory_incomplete",
          };
        }
      }
    }
  }
  if (profiles.filter((p) => p.default).length !== 1)
    return {
      available: false,
      reason: "international_default_profile_unverified",
    };
  for (const target of scope) {
    const assigned = profiles.filter((p) =>
      p.profileItems.nodes.some(
        (item) => item.product?.id === target.shopifyProductId,
      ),
    );
    if (assigned.length > 1)
      return {
        available: false,
        reason: "international_split_profile_unverified",
      };
    const profile = assigned[0] || profiles.find((p) => p.default);
    for (const country of target.countries) {
      const matchingZone = profile.profileLocationGroups.some((group) =>
        group.locationGroupZones.nodes.some(
          (row) =>
            row.zone.countries.some(
              (c) =>
                c.code?.countryCode === country && Array.isArray(c.provinces),
            ) && row.methodDefinitions.nodes.some((method) => method.active),
        ),
      );
      if (
        !countries.has(country) ||
        !matchingZone ||
        expectedRoutes[country] !== profile.id
      ) {
        return {
          available: false,
          reason: "international_native_route_mismatch",
        };
      }
    }
  }
  const overseasRoutes = profiles.some((profile) =>
    profile.profileLocationGroups.some((group) =>
      group.locationGroupZones.nodes.some((row) =>
        row.zone.countries.some(
          (c) => c.code?.restOfWorld || c.code?.countryCode !== "JP",
        ),
      ),
    ),
  );
  return {
    available: true,
    countries: [...countries].sort(),
    internationalConfigured:
      overseasRoutes || [...countries].some((c) => c !== "JP"),
    configHash: hashNativeConfiguration([markets, profiles]),
  };
}

export async function inspectInternationalNativeConfiguration({
  shopDomain,
  scope = [],
  expectedRoutes = {},
  graphQL = createNativeReadSession(),
}) {
  try {
    if (!await inspectNativeReadAccess({ shopDomain, graphQL })) {
      return {
        available: false,
        reason: "international_native_read_scope_missing",
      };
    }
    const markets = await readNativeInventory({ shopDomain, query: NATIVE_MARKETS_QUERY, field: "markets", graphQL });
    const profiles = await readNativeInventory({ shopDomain, query: PROFILES, field: "deliveryProfiles", graphQL });
    const result = evaluateInternationalNativeInventory({
      markets,
      profiles,
      scope,
      expectedRoutes,
    });
    if (!result.available) return result;
    const variantFacts = [];
    for (let index = 0; index < scope.length; index += 25) {
      const batch = scope.slice(index, index + 25);
      const response = await graphQL({
        shopDomain,
        query: `query InternationalNativeProducts($ids: [ID!]!) {
        nodes(ids: $ids) { ... on Product { id variants(first: 2) { nodes { id inventoryItem { requiresShipping } } pageInfo { hasNextPage } } } }
      }`,
        variables: { ids: batch.map((entry) => entry.shopifyProductId) },
      });
      const nodes = response?.data?.nodes;
      if (
        !Array.isArray(nodes) ||
        nodes.length !== batch.length ||
        batch.some((target) => {
          const node = nodes.find((row) => row?.id === target.shopifyProductId);
          return (
            !complete(node?.variants) ||
            node.variants.nodes.length !== 1 ||
            node.variants.nodes[0]?.inventoryItem?.requiresShipping !== true
          );
        })
      )
        return {
          available: false,
          reason: "international_native_variants_unverified",
        };
      variantFacts.push(...nodes);
    }
    const validation = await inspectMarketplaceCheckoutValidation(shopDomain, {
      graphQL,
    });
    let verificationInventory = null;
    try {
      verificationInventory = collectInternationalCheckoutInventory({ markets, profiles, scope, variantFacts });
    } catch {
      // A stricter test plan must not change the existing native-scope result.
    }
    return {
      ...result,
      verificationInventory,
      configHash: hashNativeConfiguration([result.configHash, variantFacts]),
      validationReady:
        validation.ok && validation.active && !validation.runtimeErrorDetected,
      validationId: validation.validation?.id,
      functionId: validation.validation?.shopifyFunction?.id,
      functionApiVersion: validation.validation?.shopifyFunction?.apiVersion,
    };
  } catch {
    return {
      available: false,
      reason: "international_native_configuration_unverified",
    };
  }
}

import {
  createNativeReadSession,
  hashNativeConfiguration,
  inspectNativeReadAccess,
  nativeConnectionComplete,
  NATIVE_MARKETS_QUERY,
  readNativeInventory,
} from "./internationalNativeInventory.server.js";

const PROFILES_QUERY = `query CheckoutNativeScopeProfiles($after: String) {
  deliveryProfiles(first: 1, after: $after) { nodes { id default version
    profileLocationGroups { locationGroup { id } locationGroupZones(first: 5) { nodes {
      zone { id countries { code { countryCode restOfWorld } provinces { code } } }
    } pageInfo { hasNextPage } } }
  } pageInfo { hasNextPage endCursor } }
}`;

export function evaluateShopifyCommerceScope({
  markets = [],
  profiles = [],
} = {}) {
  let complete = markets.length > 0 && profiles.length > 0;
  let internationalConfigured = false;
  let activeMarketCount = 0;
  const marketIds = new Set();
  for (const market of markets) {
    if (!market?.id || marketIds.has(market.id)) complete = false;
    marketIds.add(market?.id);
    if (market?.status === "DRAFT") continue;
    if (market?.status !== "ACTIVE") {
      complete = false;
      continue;
    }
    activeMarketCount++;
    const conditions = market.conditions;
    const region = conditions?.regionsCondition;
    const regions = region?.regions;
    if (region?.applicationLevel === "ALL") internationalConfigured = true;
    for (const row of Array.isArray(regions?.nodes) ? regions.nodes : []) {
      if (
        row?.__typename === "MarketRegionCountry" &&
        /^[A-Z]{2}$/.test(row.code || "") &&
        row.code !== "JP"
      )
        internationalConfigured = true;
    }
    if (
      !Array.isArray(conditions?.conditionTypes) ||
      conditions.conditionTypes.length !== 1 ||
      conditions.conditionTypes[0] !== "REGION" ||
      !["SPECIFIED", "ALL"].includes(region?.applicationLevel) ||
      !nativeConnectionComplete(regions) ||
      regions.nodes.length > 250 ||
      (region.applicationLevel === "SPECIFIED" && !regions.nodes.length) ||
      regions.nodes.some(
        (row) =>
          row?.__typename !== "MarketRegionCountry" ||
          !/^[A-Z]{2}$/.test(row.code || ""),
      )
    )
      complete = false;
  }
  if (!activeMarketCount) complete = false;
  const profileIds = new Set();
  let defaults = 0;
  for (const profile of profiles) {
    if (
      !profile?.id ||
      profileIds.has(profile.id) ||
      typeof profile.default !== "boolean"
    )
      complete = false;
    profileIds.add(profile?.id);
    if (profile?.default === true) defaults++;
    const groups = profile?.profileLocationGroups;
    if (!Array.isArray(groups) || groups.length > 5) {
      complete = false;
      continue;
    }
    for (const group of groups) {
      const zones = group?.locationGroupZones;
      if (!nativeConnectionComplete(zones) || zones.nodes.length > 5)
        complete = false;
      for (const entry of Array.isArray(zones?.nodes) ? zones.nodes : []) {
        const countries = entry?.zone?.countries;
        if (
          !entry?.zone?.id ||
          !Array.isArray(countries) ||
          countries.length > 250
        ) {
          complete = false;
          continue;
        }
        for (const country of countries) {
          const code = country?.code;
          if (
            code?.restOfWorld === true ||
            (/^[A-Z]{2}$/.test(code?.countryCode || "") &&
              code.countryCode !== "JP")
          )
            internationalConfigured = true;
          if (
            typeof code?.restOfWorld !== "boolean" ||
            (!code.restOfWorld && !/^[A-Z]{2}$/.test(code.countryCode || "")) ||
            !Array.isArray(country.provinces) ||
            country.provinces.length > 200
          )
            complete = false;
        }
      }
    }
  }
  if (defaults !== 1) complete = false;
  return {
    available: complete,
    internationalConfigured,
    scopeStatus: internationalConfigured
      ? "INTERNATIONAL"
      : complete
        ? "DOMESTIC_ONLY"
        : "UNKNOWN",
    configHash: complete
      ? hashNativeConfiguration({ markets, profiles })
      : null,
    reason: complete ? null : "checkout_native_inventory_incomplete",
  };
}

export async function inspectShopifyCommerceScope({
  shopDomain,
  graphQL = createNativeReadSession(),
  now = new Date(),
} = {}) {
  const partial = { markets: [], profiles: [] };
  const result = (reason = null) => ({
    ...evaluateShopifyCommerceScope(partial),
    ...(reason ? { available: false, configHash: null, reason } : {}),
    shopDomain,
    observedAt: now.toISOString(),
  });
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain || ""))
    return result("checkout_native_shop_unverified");
  try {
    if (!(await inspectNativeReadAccess({ shopDomain, graphQL })))
      return result("checkout_native_read_scope_missing");
    await readNativeInventory({
      shopDomain,
      query: NATIVE_MARKETS_QUERY,
      field: "markets",
      graphQL,
      onPage: (rows) => partial.markets.push(...rows),
    });
    await readNativeInventory({
      shopDomain,
      query: PROFILES_QUERY,
      field: "deliveryProfiles",
      graphQL,
      onPage: (rows) => partial.profiles.push(...rows),
    });
    return result();
  } catch {
    const failed = result("checkout_native_inspection_unverified");
    return {
      ...failed,
      scopeStatus: failed.internationalConfigured ? "INTERNATIONAL" : "UNKNOWN",
    };
  }
}

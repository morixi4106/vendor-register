import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateShopifyCommerceScope,
  inspectShopifyCommerceScope,
} from "../../app/services/shopifyCommerceScope.server.js";
import {
  createNativeReadSession,
  readNativeInventory,
} from "../../app/services/internationalNativeInventory.server.js";

const shopDomain = "example.myshopify.com";
const now = new Date("2026-10-16T10:00:00Z");
const connection = (nodes = [], pageInfo = {}) => ({
  nodes,
  pageInfo: { hasNextPage: false, ...pageInfo },
});
function fixture() {
  return {
    markets: [
      {
        id: "market-jp",
        status: "ACTIVE",
        conditions: {
          conditionTypes: ["REGION"],
          regionsCondition: {
            applicationLevel: "SPECIFIED",
            regions: connection([
              { __typename: "MarketRegionCountry", code: "JP" },
            ]),
          },
        },
        currencySettings: {
          baseCurrency: { currencyCode: "JPY" },
          localCurrencies: false,
        },
      },
    ],
    profiles: [
      {
        id: "profile-default",
        default: true,
        version: 1,
        profileLocationGroups: [
          {
            locationGroup: { id: "group" },
            locationGroupZones: connection([
              {
                zone: {
                  id: "zone",
                  countries: [
                    {
                      code: { countryCode: "JP", restOfWorld: false },
                      provinces: [],
                    },
                  ],
                },
              },
            ]),
          },
        ],
      },
    ],
  };
}
function responses(
  inventory,
  { scopes = ["read_markets", "read_shipping"], calls = [] } = {},
) {
  return async ({ query, variables, ...args }) => {
    calls.push({ query, variables, ...args });
    assert.ok(!/mutation/.test(query));
    if (query.includes("InternationalNativeAccess"))
      return {
        data: {
          currentAppInstallation: {
            accessScopes: scopes.map((handle) => ({ handle })),
          },
        },
      };
    const field = query.includes("InternationalNativeMarkets")
      ? "markets"
      : "deliveryProfiles";
    const rows = field === "markets" ? inventory.markets : inventory.profiles;
    const index = variables?.after ? Number(variables.after) : 0;
    const nodes = rows.slice(index, index + 1);
    const next = index + 1 < rows.length;
    return {
      data: {
        [field]: connection(nodes, {
          hasNextPage: next,
          endCursor: next ? String(index + 1) : null,
        }),
      },
    };
  };
}

test("domestic-only native inspection is read-only and does not query products, rates or Validation", async () => {
  const calls = [];
  const result = await inspectShopifyCommerceScope({
    shopDomain,
    now,
    graphQL: responses(fixture(), { calls }),
  });
  assert.equal(result.available, true);
  assert.equal(result.scopeStatus, "DOMESTIC_ONLY");
  assert.equal(result.internationalConfigured, false);
  assert.equal(result.observedAt, now.toISOString());
  assert.match(result.configHash, /^[a-f0-9]{64}$/);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.shopDomain === shopDomain));
  assert.ok(
    calls.every(
      ({ query }) =>
        !/profileItems|methodDefinitions|validations|customer|address1|email/.test(
          query,
        ),
    ),
  );
});

for (const source of ["market", "zone", "allMarkets", "restOfWorld"]) {
  test(`native ${source} independently identifies international configuration`, () => {
    const f = fixture();
    if (source === "market")
      f.markets[0].conditions.regionsCondition.regions.nodes[0].code = "US";
    if (source === "zone")
      f.profiles[0].profileLocationGroups[0].locationGroupZones.nodes[0].zone.countries[0].code.countryCode =
        "US";
    if (source === "allMarkets")
      f.markets[0].conditions.regionsCondition.applicationLevel = "ALL";
    if (source === "restOfWorld")
      f.profiles[0].profileLocationGroups[0].locationGroupZones.nodes[0].zone.countries[0].code.restOfWorld = true;
    const result = evaluateShopifyCommerceScope(f);
    assert.equal(result.available, true);
    assert.equal(result.scopeStatus, "INTERNATIONAL");
  });
}

for (const boundary of [
  "markets",
  "activeMarket",
  "profiles",
  "regions",
  "compound",
  "unknownRegion",
  "zones",
  "groups",
  "country",
  "defaultProfile",
  "duplicateProfile",
]) {
  test(`an incomplete ${boundary} cannot establish domestic-only scope`, () => {
    const f = fixture();
    if (boundary === "markets") f.markets = [];
    if (boundary === "activeMarket") f.markets[0].status = "DRAFT";
    if (boundary === "profiles") f.profiles = [];
    if (boundary === "regions")
      f.markets[0].conditions.regionsCondition.regions.pageInfo.hasNextPage = true;
    if (boundary === "compound")
      f.markets[0].conditions.conditionTypes.push("COMPANY_LOCATION");
    if (boundary === "unknownRegion")
      f.markets[0].conditions.regionsCondition.regions.nodes[0].__typename =
        "FutureRegion";
    if (boundary === "zones")
      f.profiles[0].profileLocationGroups[0].locationGroupZones.pageInfo.hasNextPage = true;
    if (boundary === "groups") f.profiles[0].profileLocationGroups = null;
    if (boundary === "country")
      f.profiles[0].profileLocationGroups[0].locationGroupZones.nodes[0].zone.countries[0].code =
        null;
    if (boundary === "defaultProfile") f.profiles[0].default = false;
    if (boundary === "duplicateProfile")
      f.profiles.push(structuredClone(f.profiles[0]));
    const result = evaluateShopifyCommerceScope(f);
    assert.equal(result.available, false);
    assert.equal(result.scopeStatus, "UNKNOWN");
    assert.equal(result.configHash, null);
  });
}

test("draft foreign markets do not activate foreign sales and domestic conditional rates are irrelevant to country inventory", () => {
  const f = fixture();
  const draft = structuredClone(f.markets[0]);
  draft.id = "draft-us";
  draft.status = "DRAFT";
  draft.conditions.regionsCondition.regions.nodes[0].code = "US";
  f.markets.push(draft);
  f.profiles[0].profileItems = connection([], { hasNextPage: true });
  f.profiles[0].profileLocationGroups[0].locationGroupZones.nodes[0].methodDefinitions =
    connection(
      [{ methodConditions: [{ id: "weight-condition" }], active: true }],
      { hasNextPage: true },
    );
  assert.equal(evaluateShopifyCommerceScope(f).scopeStatus, "DOMESTIC_ONLY");
});

test("partial nested inventory retains a positive foreign observation", () => {
  const f = fixture();
  f.markets[0].conditions.regionsCondition.regions.nodes.push({
    __typename: "MarketRegionCountry",
    code: "US",
  });
  f.markets[0].conditions.regionsCondition.regions.pageInfo.hasNextPage = true;
  const result = evaluateShopifyCommerceScope(f);
  assert.equal(result.available, false);
  assert.equal(result.scopeStatus, "INTERNATIONAL");
});

test("failed later pages retain foreign observations and do not expose underlying errors", async () => {
  const f = fixture();
  f.markets[0].conditions.regionsCondition.regions.nodes[0].code = "US";
  let calls = 0;
  const result = await inspectShopifyCommerceScope({
    shopDomain,
    now,
    graphQL: async ({ query }) => {
      calls++;
      if (query.includes("Access")) return responses(f)({ query });
      if (calls === 2)
        return {
          data: {
            markets: connection(f.markets, {
              hasNextPage: true,
              endCursor: "next",
            }),
          },
        };
      throw new Error("private transport detail");
    },
  });
  assert.equal(result.available, false);
  assert.equal(result.scopeStatus, "INTERNATIONAL");
  assert.equal(result.configHash, null);
  assert.ok(!JSON.stringify(result).includes("private transport detail"));
});

test("scope absence, invalid shop and GraphQL errors are never successful empty inventories", async () => {
  const missingScope = await inspectShopifyCommerceScope({
    shopDomain,
    now,
    graphQL: responses(fixture(), { scopes: ["read_shipping"] }),
  });
  assert.equal(missingScope.reason, "checkout_native_read_scope_missing");
  const invalidShop = await inspectShopifyCommerceScope({
    shopDomain: "https://example.test",
    now,
    graphQL: () => assert.fail("must not request another host"),
  });
  assert.equal(invalidShop.available, false);
  const partial = await inspectShopifyCommerceScope({
    shopDomain,
    now,
    graphQL: async ({ query }) =>
      query.includes("Access")
        ? responses(fixture())({ query })
        : {
            data: { markets: connection(fixture().markets) },
            errors: [{ message: "redacted" }],
          },
  });
  assert.equal(partial.available, false);
  assert.equal(partial.scopeStatus, "UNKNOWN");
});

test("native configuration hashing ignores collection ordering but detects country and currency changes", () => {
  const f = fixture();
  const other = structuredClone(f.markets[0]);
  other.id = "market-b";
  f.markets.push(other);
  const hash = evaluateShopifyCommerceScope(f).configHash;
  f.markets.reverse();
  assert.equal(evaluateShopifyCommerceScope(f).configHash, hash);
  f.markets[0].currencySettings.baseCurrency.currencyCode = "USD";
  assert.notEqual(evaluateShopifyCommerceScope(f).configHash, hash);
});

test("root pagination is complete and bounded; repeated cursors and duplicate IDs are rejected", async () => {
  const f = fixture();
  f.profiles.push({
    ...structuredClone(f.profiles[0]),
    id: "profile-other",
    default: false,
  });
  assert.equal(
    (
      await inspectShopifyCommerceScope({
        shopDomain,
        now,
        graphQL: responses(f),
      })
    ).available,
    true,
  );
  for (const mode of ["cursor", "duplicate", "limit"]) {
    let calls = 0;
    await assert.rejects(
      readNativeInventory({
        shopDomain,
        field: "markets",
        query: "query Test { markets { nodes { id } } }",
        graphQL: async () => {
          calls++;
          return {
            data: {
              markets: connection(
                [{ id: mode === "duplicate" ? "same" : String(calls) }],
                {
                  hasNextPage: true,
                  endCursor: mode === "cursor" ? "same" : String(calls),
                },
              ),
            },
          };
        },
      }),
      { code: "international_inventory_incomplete" },
    );
    assert.ok(calls <= 10);
  }
});

test("read sessions share identical reads only within an inspection and propagate a bounded abort", async () => {
  let calls = 0;
  const graphQL = async () => {
    calls++;
    return { data: {} };
  };
  const args = { shopDomain, query: "#graphql\nquery Test { shop { id } }" };
  const first = createNativeReadSession({ graphQL });
  await first(args);
  await first(args);
  assert.equal(calls, 1);
  await createNativeReadSession({ graphQL })(args);
  assert.equal(calls, 2);
  await assert.rejects(
    first({ ...args, query: "mutation Never { shop { id } }" }),
    { code: "international_native_read_only" },
  );
  let signal;
  const blocked = createNativeReadSession({
    budgetMs: 10,
    graphQL: async (request) => {
      signal = request.signal;
      return new Promise(() => {});
    },
  });
  await assert.rejects(blocked(args), { code: "international_native_timeout" });
  assert.equal(signal.aborted, true);
  await assert.rejects(blocked(args), { code: "international_native_timeout" });
});

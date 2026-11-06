import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateInternationalNativeInventory,
  inspectInternationalNativeConfiguration,
} from "../../app/services/internationalNativeConfiguration.server.js";

const connection = (nodes = []) => ({
  nodes,
  pageInfo: { hasNextPage: false },
});
function fixture() {
  return {
    markets: [
      {
        id: "market",
        status: "ACTIVE",
        conditions: {
          conditionTypes: ["REGION"],
          regionsCondition: {
            applicationLevel: "SPECIFIED",
            regions: connection([
              { __typename: "MarketRegionCountry", code: "JP" },
              { __typename: "MarketRegionCountry", code: "US" },
            ]),
          },
        },
      },
    ],
    profiles: [
      {
        id: "profile",
        default: true,
        version: 1,
        profileItems: connection(),
        sellingPlanGroups: connection(),
        profileLocationGroups: [
          {
            locationGroupZones: connection([
              {
                zone: {
                  id: "zone",
                  countries: [
                    {
                      code: { countryCode: "US", restOfWorld: false },
                      provinces: [],
                    },
                  ],
                },
                methodDefinitions: connection([
                  {
                    id: "manual-free",
                    active: true,
                    methodConditions: [],
                    rateProvider: {
                      __typename: "DeliveryRateDefinition",
                      id: "rate",
                      price: { amount: "0", currencyCode: "JPY" },
                    },
                  },
                ]),
              },
            ]),
          },
        ],
      },
    ],
    scope: [
      {
        productId: "p1",
        shopifyProductId: "gid://shopify/Product/1",
        countries: ["US"],
      },
    ],
    expectedRoutes: { US: "profile" },
  };
}

test("native inventory fingerprints manual and free routes and product membership", () => {
  const f = fixture();
  const result = evaluateInternationalNativeInventory(f);
  assert.equal(result.available, true);
  assert.equal(result.internationalConfigured, true);
  f.profiles[0].profileLocationGroups[0].locationGroupZones.nodes[0].methodDefinitions.nodes[0].rateProvider.price.amount =
    "10";
  assert.notEqual(
    evaluateInternationalNativeInventory(f).configHash,
    result.configHash,
  );
});

for (const boundary of [
  "regions",
  "products",
  "variants",
  "zones",
  "methods",
  "conditions",
  "profileMismatch",
  "splitProfiles",
  "unknownProvider",
]) {
  test(`native inventory refuses incomplete ${boundary}`, () => {
    const f = fixture();
    const p = f.profiles[0];
    if (boundary === "regions")
      f.markets[0].conditions.regionsCondition.regions.pageInfo.hasNextPage = true;
    if (boundary === "products") p.profileItems.pageInfo.hasNextPage = true;
    if (boundary === "variants")
      p.profileItems.nodes.push({
        product: { id: "gid://shopify/Product/1" },
        variants: { ...connection(), pageInfo: { hasNextPage: true } },
      });
    if (boundary === "zones")
      p.profileLocationGroups[0].locationGroupZones.pageInfo.hasNextPage = true;
    if (boundary === "methods")
      p.profileLocationGroups[0].locationGroupZones.nodes[0].methodDefinitions.pageInfo.hasNextPage = true;
    if (boundary === "conditions")
      f.markets[0].conditions.conditionTypes.push("COMPANY_LOCATION");
    if (boundary === "profileMismatch") f.expectedRoutes.US = "other";
    if (boundary === "splitProfiles") {
      p.profileItems.nodes.push({
        product: { id: "gid://shopify/Product/1" },
        variants: connection([{ id: "v1" }]),
      });
      f.profiles.push({ ...p, id: "other", default: false });
    }
    if (boundary === "unknownProvider")
      p.profileLocationGroups[0].locationGroupZones.nodes[0].methodDefinitions.nodes[0].rateProvider.__typename =
        "Future";
    assert.equal(evaluateInternationalNativeInventory(f).available, false);
  });
}

test("missing read scopes are unverified and never changed by inspection", async () => {
  let calls = 0;
  const result = await inspectInternationalNativeConfiguration({
    shopDomain: "example.myshopify.com",
    graphQL: async ({ query }) => {
      calls++;
      assert.ok(!query.includes("mutation"));
      return {
        data: {
          currentAppInstallation: {
            accessScopes: [{ handle: "read_shipping" }],
          },
        },
      };
    },
  });
  assert.equal(result.reason, "international_native_read_scope_missing");
  assert.equal(calls, 1);
});

test("detailed native fingerprints ignore record ordering without relaxing conditional-rate checks", () => {
  const f = fixture();
  const method = structuredClone(f.profiles[0].profileLocationGroups[0].locationGroupZones.nodes[0].methodDefinitions.nodes[0]);
  method.id = "paid-rate";
  method.rateProvider.price.amount = "500";
  const methods = f.profiles[0].profileLocationGroups[0].locationGroupZones.nodes[0].methodDefinitions.nodes;
  methods.push(method);
  const first = evaluateInternationalNativeInventory(f);
  methods.reverse();
  assert.equal(evaluateInternationalNativeInventory(f).configHash, first.configHash);
  methods[0].methodConditions = [{ id: "weight-condition" }];
  assert.equal(evaluateInternationalNativeInventory(f).available, false);
});

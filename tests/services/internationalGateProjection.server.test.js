import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInternationalGateSnapshot,
  internationalLocalDate,
  normalizeInternationalScope,
  internationalHash,
  serializeInternationalProjection,
} from "../../app/services/internationalGateProjection.server.js";
import { getInternationalMarketRequirements } from "../../app/utils/internationalMarketReadiness.js";

test("JSONB key reordering preserves canonical content hashes and wire values", () => {
  const first = {
    z: 1,
    d: new Date("2026-10-16T00:00:00Z"),
    a: { b: 2, a: 1 },
    c: ["US", "FR"],
  };
  const second = {
    c: ["US", "FR"],
    a: { a: 1, b: 2 },
    d: "2026-10-16T00:00:00.000Z",
    z: 1,
  };
  assert.equal(internationalHash(first), internationalHash(second));
  assert.equal(
    serializeInternationalProjection(first),
    serializeInternationalProjection(second),
  );
});

function fixture() {
  const now = new Date();
  const future = new Date(now.getTime() + 5 * 86400000);
  const product = {
    id: "p1",
    name: "Cotton pouch",
    category: "GENERAL_GOODS",
    approvalStatus: "approved",
    shopDomain: "example.myshopify.com",
    shopifyProductId: "gid://shopify/Product/1",
    vendorStoreId: "store",
    vendorStore: { id: "store", isPlatformStore: true, isTestStore: false },
    productEuStatus: "DISABLED",
    internationalShippingMethod: "AIR_PACKET",
    shippingWeightGrams: 500,
    shippingLengthMm: 250,
    shippingWidthMm: 180,
    shippingHeightMm: 70,
    shippingWeightConfirmedAt: now,
    shippingWeightSource: "MANUAL_CONFIRMED",
    shopifyVariantCount: 1,
    shopifyWeightSyncStatus: "SYNCED",
    countryPolicy: {
      allowedCountries: ["US", "FR"],
      blockedCountries: [],
      requiresWarningCountries: [],
    },
    complianceProfile: {
      approvalStatus: "APPROVED",
      legalSellerType: "PLATFORM",
      conditionStatus: "NEW",
      countryOfOriginCode: "JP",
      hsCode: "420292",
      customsDescriptionEn: "Cotton pouch",
      regulatoryCategory: "GENERAL_GOODS",
      authenticityConfirmedAt: now,
      ipRightsConfirmedAt: now,
      applicabilityStatus: "REQUIRED",
      verificationLevel: "DOCUMENT_REVIEWED",
      applicabilityReasonText: "Export review",
      applicabilitySourceUrl: "https://example.test/review",
      applicabilityDecidedAt: now,
      applicabilityDecidedBy: "operator:1",
      nextReviewAt: future,
    },
    complianceEvidence: [
      {
        id: "e1",
        status: "VERIFIED",
        verificationLevel: "DOCUMENT_REVIEWED",
        expiresAt: future,
        reviewDueAt: future,
      },
    ],
    complianceDecisions: [
      { id: "d1", decision: "COMPLIANT", decidedAt: now, reviewDueAt: future },
    ],
  };
  const evidence = getInternationalMarketRequirements("US").map(
    (definition) => ({
      id: definition.code,
      checkKey: definition.code,
      scopeType: "MARKET_COUNTRY",
      scopeId: "US",
      status: "CONFIRMED",
      evidenceReference: "test-evidence",
      evidenceHash: "a".repeat(64),
      confirmedBy: "operator:1",
      confirmedAt: now,
      expiresAt: future,
      metadataJson: {
        countryCode: "US",
        requirementVersion: definition.version,
        officialSourceUrl: definition.sourceUrl,
        confirmations: Object.fromEntries(
          definition.confirmations.map((key) => [key, true]),
        ),
      },
    }),
  );
  const state = {
    shopDomain: product.shopDomain,
    mode: "ENFORCE",
    desiredGeneration: 3,
    shopTimezone: "Asia/Tokyo",
    authorizationExpiresAt: future,
    authorizedScopeJson: [
      {
        productId: product.id,
        shopifyProductId: product.shopifyProductId,
        countries: ["FR", "US"],
      },
    ],
  };
  const control = {
    internationalShippingHold: false,
    checkoutHold: false,
    checkoutControlState: "IDLE",
  };
  const db = {
    product: { findMany: async () => [product] },
    platformOperationalControl: { findUnique: async () => control },
    operationalReadinessAttestation: { findMany: async () => evidence },
    internationalShippingCountryAvailability: {
      findMany: async () => [
        {
          id: "us",
          countryCode: "US",
          service: "JAPAN_POST_AIR_PACKET",
          status: "ACTIVE",
          checkedAt: now,
        },
        {
          id: "fr",
          countryCode: "FR",
          service: "JAPAN_POST_AIR_PACKET",
          status: "ACTIVE",
          checkedAt: now,
        },
      ],
    },
  };
  const build = () =>
    buildInternationalGateSnapshot({
      state,
      prismaClient: db,
      now,
      env: { MARKETPLACE_GOVERNANCE_GATE_ENABLED: "false" },
    });
  return { now, future, product, state, evidence, db, control, build };
}

test("product-country snapshot uses the real eligibility engine and complete market evidence", async () => {
  const f = fixture();
  const result = await f.build();
  assert.deepEqual(result.shop.c, ["US"]);
  assert.deepEqual(result.targets[0].projection.c, ["US"]);
  assert.equal(result.targets[0].projection.g, 3);
  assert.equal(result.targets[0].projection.i, f.product.shopifyProductId);
  assert.ok(result.nextExpiryAt <= f.future);
  assert.ok(!JSON.stringify(result).includes("operator:1"));
});

test("one approved product does not grant a second recalled product its countries", async () => {
  const f = fixture();
  const second = {
    ...f.product,
    id: "p2",
    shopifyProductId: "gid://shopify/Product/2",
    complianceProfile: {
      ...f.product.complianceProfile,
      approvalStatus: "RECALLED",
    },
  };
  f.db.product.findMany = async () => [f.product, second];
  f.state.authorizedScopeJson.push({
    productId: "p2",
    shopifyProductId: second.shopifyProductId,
    countries: ["US"],
  });
  const result = await f.build();
  assert.deepEqual(result.targets[0].projection.c, ["US"]);
  assert.deepEqual(result.targets[1].projection.c, []);
});

for (const field of [
  "legacy",
  "testStore",
  "thirdParty",
  "missingCustoms",
  "linkMismatch",
  "truncatedEvidence",
  "internationalHold",
  "revokedMarket",
]) {
  test(`country projection fails closed for ${field}`, async () => {
    const f = fixture();
    if (field === "legacy")
      f.product.complianceProfile.approvalStatus = "PENDING";
    if (field === "testStore") f.product.vendorStore.isTestStore = true;
    if (field === "thirdParty") f.product.vendorStore.isPlatformStore = false;
    if (field === "missingCustoms") f.product.complianceProfile.hsCode = null;
    if (field === "linkMismatch")
      f.product.shopifyProductId = "gid://shopify/Product/2";
    if (field === "truncatedEvidence")
      f.product.complianceEvidence = Array.from(
        { length: 100 },
        () => f.product.complianceEvidence[0],
      );
    if (field === "internationalHold")
      f.control.internationalShippingHold = true;
    if (field === "revokedMarket") f.evidence[0].status = "REVOKED";
    const result = await f.build();
    assert.deepEqual(result.shop.c, []);
    assert.equal(result.shop.s, "BLOCKED");
    assert.deepEqual(result.targets[0].projection.c, []);
  });
}

test("authorization expiry is a hard limit and never renewed by synchronization", async () => {
  const f = fixture();
  f.state.authorizationExpiresAt = new Date(f.now.getTime() + 60000);
  const result = await f.build();
  assert.deepEqual(result.shop.c, []);
  assert.equal(result.shop.e, internationalLocalDate(f.now, "Asia/Tokyo"));
});

test("unused obsolete evidence does not shorten a still valid selected review", async () => {
  const f = fixture();
  f.product.complianceEvidence.push({
    ...f.product.complianceEvidence[0],
    id: "obsolete",
    expiresAt: new Date(f.now.getTime() + 60000),
  });
  const result = await f.build();
  assert.deepEqual(result.shop.c, ["US"]);
});

test("local exclusive dates use IANA zones across UTC and DST boundaries", () => {
  assert.equal(
    internationalLocalDate("2026-10-15T16:00:00Z", "Asia/Tokyo"),
    "2026-10-16",
  );
  assert.equal(
    internationalLocalDate("2026-10-15T01:00:00Z", "America/Los_Angeles"),
    "2026-10-14",
  );
  assert.equal(
    internationalLocalDate("2026-11-01T08:59:00Z", "America/Los_Angeles"),
    "2026-11-01",
  );
  assert.equal(
    internationalLocalDate("2026-11-01T09:01:00Z", "America/Los_Angeles"),
    "2026-11-01",
  );
  assert.throws(() => internationalLocalDate("invalid", "Asia/Tokyo"));
  assert.throws(() => internationalLocalDate(new Date(), "invalid/zone"));
});

test("scope authorization rejects world-wide, domestic and duplicate product grants", () => {
  const scope = [
    {
      productId: "p1",
      shopifyProductId: "gid://shopify/Product/1",
      countries: ["US"],
    },
  ];
  assert.throws(() => normalizeInternationalScope([]));
  assert.throws(() => normalizeInternationalScope([...scope, ...scope]));
  for (const countries of [["JP"], ["ZZ"], []])
    assert.throws(() =>
      normalizeInternationalScope([{ ...scope[0], countries }]),
    );
});

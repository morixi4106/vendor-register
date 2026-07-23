import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPostOrderEligibilityPolicy,
  inspectPaidOrderSaleEligibility,
  POST_ORDER_ELIGIBILITY_POLICY,
  POST_ORDER_ELIGIBILITY_TRIGGER,
  SALE_ELIGIBILITY_CHANNEL,
  SALE_ELIGIBILITY_POLICY_VERSION,
  evaluateSaleEligibilitySnapshot,
} from "../../app/services/saleEligibility.server.js";

function platformProduct(overrides = {}) {
  return {
    id: "product-1",
    approvalStatus: "approved",
    shopifyProductId: "gid://shopify/Product/1",
    shopDomain: "example.myshopify.com",
    vendorStoreId: "store-1",
    vendorStore: {
      id: "store-1",
      isPlatformStore: true,
      isTestStore: false,
      seller: null,
      vendorAuth: null,
    },
    complianceProfile: {
      approvalStatus: "PENDING",
      legalSellerType: "PLATFORM",
    },
    complianceEvidence: [],
    complianceDecisions: [],
    ...overrides,
  };
}

test("global purchase stop blocks an otherwise eligible platform product", () => {
  const result = evaluateSaleEligibilitySnapshot({
    product: platformProduct(),
    salesChannel: SALE_ELIGIBILITY_CHANNEL.SHOPIFY_STANDARD_CHECKOUT,
    operationalControl: {
      checkoutHold: true,
      checkoutControlState: "ACTIVE",
    },
    env: {
      MARKETPLACE_GOVERNANCE_GATE_ENABLED: "false",
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.reasonCodes.includes("GLOBAL_PURCHASE_STOP_ACTIVE"));
});

test("recovery evaluation keeps recalled product blocked", () => {
  const result = evaluateSaleEligibilitySnapshot({
    product: platformProduct({
      complianceProfile: {
        approvalStatus: "RECALLED",
        legalSellerType: "PLATFORM",
      },
    }),
    salesChannel: SALE_ELIGIBILITY_CHANNEL.PUBLICATION_SYNC,
    operationalControl: {
      checkoutHold: false,
      checkoutControlState: "RECOVERING",
    },
    env: {
      MARKETPLACE_GOVERNANCE_GATE_ENABLED: "false",
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.status, "RECALLED");
});

test("dark deploy keeps legacy platform product sellable but records review requirement", () => {
  const result = evaluateSaleEligibilitySnapshot({
    product: platformProduct(),
    salesChannel: SALE_ELIGIBILITY_CHANNEL.PUBLICATION_SYNC,
    operationalControl: {
      checkoutHold: false,
      checkoutControlState: "IDLE",
    },
    env: {
      MARKETPLACE_GOVERNANCE_GATE_ENABLED: "false",
    },
  });

  assert.equal(result.allowed, true);
  assert.equal(result.status, "LEGACY_REVIEW_REQUIRED");
  assert.ok(result.policyVersion);
  assert.ok(result.inputHash);
});

test("enforcement blocks the same legacy product until governance is ready", () => {
  const result = evaluateSaleEligibilitySnapshot({
    product: platformProduct(),
    salesChannel: SALE_ELIGIBILITY_CHANNEL.PUBLICATION_SYNC,
    operationalControl: {
      checkoutHold: false,
      checkoutControlState: "IDLE",
    },
    env: {
      MARKETPLACE_GOVERNANCE_GATE_ENABLED: "true",
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.status, "REVIEW_REQUIRED");
});

test("post-order policy separates recalls, prospective stops, and order edits", () => {
  assert.equal(
    classifyPostOrderEligibilityPolicy({
      decisionReasonCodes: ["PRODUCT_RECALL"],
    }),
    POST_ORDER_ELIGIBILITY_POLICY.RETROACTIVE_HOLD,
  );
  assert.equal(
    classifyPostOrderEligibilityPolicy({
      reasonCodes: ["GLOBAL_PURCHASE_STOP_ACTIVE"],
      triggerType: POST_ORDER_ELIGIBILITY_TRIGGER.PERIODIC_RECONCILIATION,
    }),
    POST_ORDER_ELIGIBILITY_POLICY.PROSPECTIVE_ONLY,
  );
  assert.equal(
    classifyPostOrderEligibilityPolicy({
      reasonCodes: ["GLOBAL_PURCHASE_STOP_ACTIVE"],
      triggerType: POST_ORDER_ELIGIBILITY_TRIGGER.ORDERS_EDITED,
    }),
    POST_ORDER_ELIGIBILITY_POLICY.CHECKOUT_INTEGRITY_ONLY,
  );
});

function buildProjection(overrides = {}) {
  return {
    productId: "product-1",
    status: "ELIGIBLE",
    policyVersion: SALE_ELIGIBILITY_POLICY_VERSION,
    inputHash: "a".repeat(64),
    projectionRevision: 7,
    evaluatedAt: new Date("2026-07-24T00:00:00.000Z"),
    expiresAt: new Date("2026-07-25T00:00:00.000Z"),
    ...overrides,
  };
}

function buildPaidInspectionPrisma(product, projection = buildProjection()) {
  return {
    saleEligibilityProjection: {
      async findMany() {
        return projection ? [projection] : [];
      },
    },
    product: {
      async findMany() {
        return [product];
      },
    },
  };
}

test("a prospective platform stop after purchase does not quarantine an older valid order", async () => {
  const product = platformProduct({
    updatedAt: new Date("2026-07-24T00:00:00.000Z"),
  });
  const result = await inspectPaidOrderSaleEligibility(
    {
      shopDomain: "example.myshopify.com",
      matchedLines: [{ product }],
      orderOccurredAt: new Date("2026-07-24T01:00:00.000Z"),
      triggerType: POST_ORDER_ELIGIBILITY_TRIGGER.PERIODIC_RECONCILIATION,
    },
    {
      prismaClient: buildPaidInspectionPrisma(product),
      operationalControl: {
        checkoutHold: true,
        checkoutControlState: "ACTIVE",
        updatedAt: new Date("2026-07-24T02:00:00.000Z"),
      },
      env: { MARKETPLACE_GOVERNANCE_GATE_ENABLED: "false" },
      now: new Date("2026-07-24T03:00:00.000Z"),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(
    result.evidence[0].postOrderPolicy,
    POST_ORDER_ELIGIBILITY_POLICY.PROSPECTIVE_ONLY,
  );
  assert.equal(result.evidence[0].blockWasEffectiveAtOrder, false);
});

test("a recall remains retroactive even when recorded after purchase", async () => {
  const product = platformProduct({
    updatedAt: new Date("2026-07-24T02:00:00.000Z"),
    complianceProfile: {
      approvalStatus: "RECALLED",
      legalSellerType: "PLATFORM",
      updatedAt: new Date("2026-07-24T02:00:00.000Z"),
    },
    complianceDecisions: [
      {
        decision: "BLOCKED",
        reasonCode: "PRODUCT_RECALL",
        decidedAt: new Date("2026-07-24T02:00:00.000Z"),
      },
    ],
  });
  const result = await inspectPaidOrderSaleEligibility(
    {
      shopDomain: "example.myshopify.com",
      matchedLines: [{ product }],
      orderOccurredAt: new Date("2026-07-24T01:00:00.000Z"),
      triggerType: POST_ORDER_ELIGIBILITY_TRIGGER.PERIODIC_RECONCILIATION,
      verifyOrderTimeProjection: false,
    },
    {
      prismaClient: buildPaidInspectionPrisma(product, null),
      operationalControl: {
        checkoutHold: false,
        checkoutControlState: "IDLE",
      },
      env: { MARKETPLACE_GOVERNANCE_GATE_ENABLED: "false" },
      now: new Date("2026-07-24T03:00:00.000Z"),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(
    result.evidence[0].postOrderPolicy,
    POST_ORDER_ELIGIBILITY_POLICY.RETROACTIVE_HOLD,
  );
  assert.ok(
    result.failures.some((failure) => failure.code === "CURRENT_SALE_BLOCKED"),
  );
  assert.equal(
    result.failures.some(
      (failure) => failure.code === "ORDER_TIME_PROJECTION_MISSING",
    ),
    false,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  DOMESTIC_MARKETPLACE_PILOT_STATUSES,
  claimDomesticMarketplacePilotCheckout,
  completeDomesticMarketplacePilotForPaidOrder,
  evaluateDomesticMarketplacePilot,
  evaluateDomesticMarketplacePilotCheckout,
  markDomesticMarketplacePilotDraftOrderCreated,
  prepareDomesticMarketplacePilot,
  releaseDomesticMarketplacePilotCheckout,
} from "../../app/services/domesticMarketplacePilot.server.js";

const NOW = new Date("2026-08-20T03:00:00.000Z");

const PILOT_ENV = Object.freeze({
  DOMESTIC_MARKETPLACE_PILOT_ENABLED: "true",
  PUBLIC_DRAFT_ORDER_CHECKOUT_ENABLED: "true",
  MARKETPLACE_GOVERNANCE_GATE_ENABLED: "true",
  PAYMENT_PROVIDERS: "shopify_payments,komoju",
  KOMOJU_PAYMENT_OPERATIONS_ENABLED: "true",
  PAYMENT_REFUND_CONFIRMATION_ENFORCED: "true",
  SELLER_ORDER_SHADOW_WRITE_ENABLED: "true",
  VENDOR_ORDERS_USE_SELLER_ORDERS: "true",
  SELLER_PAYOUT_PROVIDER: "manual",
  SHOPIFY_MARKETPLACE_PAYMENTS_WRITTEN_APPROVAL_CONFIRMED: "true",
  SHOPIFY_MARKETPLACE_PAYMENTS_WRITTEN_APPROVAL_REFERENCE:
    "shopify-case-123",
  SELLER_AGREEMENT_VERSION: "seller-2026-08",
  SELLER_AGREEMENT_DOCUMENT_HASH: "a".repeat(64),
  SELLER_AGREEMENT_URL: "https://example.com/seller-agreement",
  BUYER_TERMS_VERSION: "buyer-2026-08",
  BUYER_TERMS_DOCUMENT_HASH: "b".repeat(64),
  BUYER_TERMS_URL: "https://example.com/buyer-terms",
});

function readyPilot(overrides = {}) {
  const seller = {
    id: "seller_1",
    status: "active",
    complianceProfile: {
      entityType: "CORPORATION",
      legalName: "Example Seller Ltd.",
      countryCode: "JP",
      address1: "1-1-1 Chiyoda",
      reviewStatus: "APPROVED",
      antisocialDeclarationAt: new Date("2026-01-01T00:00:00.000Z"),
      shipFromConfirmedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    agreementAcceptances: [
      {
        agreementType: "SELLER_MASTER",
        version: "seller-2026-08",
        documentHash: "a".repeat(64),
        revokedAt: null,
      },
    ],
    settlementControl: {
      salesHold: false,
      payoutHold: false,
      reserveAmount: 0,
      directInvoiceBalance: 0,
    },
  };
  const vendorStore = {
    id: "store_1",
    isTestStore: false,
    isPlatformStore: false,
    seller,
    vendorAuth: { status: "active", seller },
    returnAddresses: [
      {
        status: "ACTIVE",
        activatedAt: new Date("2026-01-01T00:00:00.000Z"),
        confirmedAt: new Date("2026-01-01T00:00:00.000Z"),
        canReceiveReturnsConfirmed: true,
        buyerDisclosureConfirmed: true,
        legalRecipientConfirmed: true,
      },
    ],
  };
  const product = {
    id: "product_1",
    vendorStoreId: vendorStore.id,
    approvalStatus: "approved",
    shopifyProductId: "gid://shopify/Product/1",
    shopifyVariantId: "gid://shopify/ProductVariant/1",
    productEuStatus: "DISABLED",
    euSaleRequested: false,
    complianceProfile: {
      legalSellerType: "VENDOR",
      conditionStatus: "NEW",
      countryOfOriginCode: "JP",
      customsDescriptionEn: "Cotton pouch",
      approvalStatus: "APPROVED",
      authenticityConfirmedAt: new Date("2026-01-01T00:00:00.000Z"),
      ipRightsConfirmedAt: new Date("2026-01-01T00:00:00.000Z"),
      applicabilityStatus: "REQUIRED",
      verificationLevel: "DOCUMENT_REVIEWED",
      applicabilityReasonText: "Reviewed requirements.",
      applicabilitySourceUrl: "https://example.com/requirements",
      applicabilityDecidedAt: new Date("2026-01-01T00:00:00.000Z"),
      applicabilityDecidedBy: "operator_1",
      nextReviewAt: new Date("2099-01-01T00:00:00.000Z"),
    },
    complianceEvidence: [
      {
        status: "VERIFIED",
        verificationLevel: "DOCUMENT_REVIEWED",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        reviewDueAt: new Date("2099-01-01T00:00:00.000Z"),
        revokedAt: null,
      },
    ],
    complianceDecisions: [
      {
        decision: "COMPLIANT",
        decidedAt: new Date("2026-01-01T00:00:00.000Z"),
        reviewDueAt: new Date("2099-01-01T00:00:00.000Z"),
      },
    ],
  };

  return {
    id: "pilot_1",
    vendorStoreId: vendorStore.id,
    productId: product.id,
    status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.ACTIVE,
    countryCode: "JP",
    maxQuantityPerOrder: 1,
    maxOrderSubtotalAmount: 10_000,
    startsAt: new Date("2026-08-20T00:00:00.000Z"),
    expiresAt: new Date("2026-08-27T00:00:00.000Z"),
    approvalReference: "shopify-case-123",
    approvalEvidenceHash: "c".repeat(64),
    approvedAt: new Date("2026-08-19T00:00:00.000Z"),
    approvedBy: "operator_1",
    revision: 2,
    vendorStore,
    product,
    ...overrides,
  };
}

test("a complete domestic pilot permit is ready", () => {
  const result = evaluateDomesticMarketplacePilot(readyPilot(), {
    env: PILOT_ENV,
    now: NOW,
  });

  assert.equal(result.ready, true, result.reasons.join(", "));
  assert.deepEqual(result.reasons, []);
});

test("the pilot permit fails closed when the environment or evidence is incomplete", () => {
  const disabled = evaluateDomesticMarketplacePilot(readyPilot(), {
    env: { ...PILOT_ENV, DOMESTIC_MARKETPLACE_PILOT_ENABLED: "false" },
    now: NOW,
  });
  assert.equal(disabled.ready, false);
  assert.ok(disabled.reasons.includes("pilot_environment_disabled"));

  const invalidEvidence = evaluateDomesticMarketplacePilot(
    readyPilot({ approvalEvidenceHash: "not-a-hash" }),
    { env: PILOT_ENV, now: NOW },
  );
  assert.equal(invalidEvidence.ready, false);
  assert.ok(
    invalidEvidence.reasons.includes("pilot_approval_evidence_hash_invalid"),
  );

  const unsafeSettlement = evaluateDomesticMarketplacePilot(readyPilot(), {
    env: { ...PILOT_ENV, SELLER_PAYOUT_PROVIDER: "stripe_connect" },
    now: NOW,
  });
  assert.equal(unsafeSettlement.ready, false);
  assert.ok(
    unsafeSettlement.reasons.includes("manual_seller_payout_not_configured"),
  );

  const excessivePeriod = evaluateDomesticMarketplacePilot(
    readyPilot({
      maxQuantityPerOrder: 2,
      expiresAt: new Date("2026-08-28T00:00:00.001Z"),
    }),
    { env: PILOT_ENV, now: NOW },
  );
  assert.equal(excessivePeriod.ready, false);
  assert.ok(excessivePeriod.reasons.includes("pilot_quantity_must_be_one"));
  assert.ok(
    excessivePeriod.reasons.includes("pilot_period_exceeds_seven_days"),
  );
});

test("preparing a pilot fixes quantity at one and interprets operator times as JST", async () => {
  let createdData = null;
  const prismaClient = {
    product: {
      async findUnique() {
        return { vendorStoreId: "store_1" };
      },
    },
    domesticMarketplacePilot: {
      async findFirst() {
        return null;
      },
      async create({ data }) {
        createdData = data;
        return { id: "pilot_1", ...data };
      },
    },
  };

  const result = await prepareDomesticMarketplacePilot(
    {
      vendorStoreId: "store_1",
      productId: "product_1",
      maxQuantityPerOrder: "1",
      maxOrderSubtotalAmount: "10000",
      startsAt: "2026-08-20T12:00",
      expiresAt: "2026-08-27T12:00",
      approvalReference: "shopify-case-123",
      approvalEvidenceHash: "d".repeat(64),
      actor: "operator_1",
    },
    { prismaClient },
  );

  assert.equal(result.ok, true);
  assert.equal(createdData.maxQuantityPerOrder, 1);
  assert.equal(createdData.startsAt.toISOString(), "2026-08-20T03:00:00.000Z");
  assert.equal(createdData.expiresAt.toISOString(), "2026-08-27T03:00:00.000Z");

  const invalidQuantity = await prepareDomesticMarketplacePilot(
    {
      vendorStoreId: "store_1",
      productId: "product_1",
      maxQuantityPerOrder: "2",
      maxOrderSubtotalAmount: "10000",
      startsAt: "2026-08-20T12:00",
      expiresAt: "2026-08-27T12:00",
      approvalReference: "shopify-case-123",
      approvalEvidenceHash: "d".repeat(64),
      actor: "operator_1",
    },
    { prismaClient },
  );
  assert.deepEqual(invalidQuantity, {
    ok: false,
    reason: "invalid_pilot_configuration",
  });
});

test("checkout allows only one permitted product, one unit, JP shipping, and the amount cap", () => {
  const pilot = readyPilot();
  const allowed = evaluateDomesticMarketplacePilotCheckout({
    pilot,
    vendorStoreId: "store_1",
    items: [{ productId: "product_1", quantity: 1 }],
    shippingCountry: "JP",
    subtotalAmount: 5_000,
  });
  assert.equal(allowed.ready, true);

  const blocked = evaluateDomesticMarketplacePilotCheckout({
    pilot,
    vendorStoreId: "store_1",
    items: [
      { productId: "product_1", quantity: 2 },
      { productId: "product_2", quantity: 1 },
    ],
    shippingCountry: "US",
    subtotalAmount: 20_000,
    salesCreditRequested: true,
  });
  assert.equal(blocked.ready, false);
  assert.ok(blocked.reasons.includes("pilot_single_item_required"));
  assert.ok(blocked.reasons.includes("pilot_quantity_exceeded"));
  assert.ok(blocked.reasons.includes("pilot_domestic_shipping_required"));
  assert.ok(blocked.reasons.includes("pilot_amount_exceeded"));
  assert.ok(blocked.reasons.includes("pilot_sales_credit_not_allowed"));
});

test("the one-order slot can be claimed only once", async () => {
  let state = {
    status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.ACTIVE,
    checkoutClaimReference: null,
    draftOrderId: null,
  };
  const prismaClient = {
    domesticMarketplacePilot: {
      async updateMany({ where, data }) {
        const matches =
          state.status === where.status &&
          state.checkoutClaimReference === where.checkoutClaimReference;
        if (!matches) return { count: 0 };
        state = { ...state, ...data };
        return { count: 1 };
      },
    },
  };

  const first = await claimDomesticMarketplacePilotCheckout(
    { pilotId: "pilot_1", checkoutReference: "checkout_1" },
    { prismaClient },
  );
  const second = await claimDomesticMarketplacePilotCheckout(
    { pilotId: "pilot_1", checkoutReference: "checkout_2" },
    { prismaClient },
  );

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(state.status, DOMESTIC_MARKETPLACE_PILOT_STATUSES.RESERVED);
  assert.equal(state.checkoutClaimReference, "checkout_1");
});

test("a checkout claim is idempotent when the database write succeeds but its response is lost", async () => {
  let updateCalls = 0;
  let state = {
    id: "pilot_1",
    status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.ACTIVE,
    checkoutClaimReference: null,
    draftOrderId: null,
  };
  const prismaClient = {
    domesticMarketplacePilot: {
      async updateMany({ where, data }) {
        updateCalls += 1;
        const matches =
          state.id === where.id &&
          state.status === where.status &&
          state.checkoutClaimReference === where.checkoutClaimReference;
        if (!matches) return { count: 0 };
        state = { ...state, ...data };
        throw new Error("database response lost after commit");
      },
      async findUnique({ where }) {
        return state.checkoutClaimReference === where.checkoutClaimReference
          ? state
          : null;
      },
    },
  };

  const result = await claimDomesticMarketplacePilotCheckout(
    { pilotId: "pilot_1", checkoutReference: "checkout_1" },
    { prismaClient },
  );

  assert.equal(result.ok, true);
  assert.equal(result.idempotent, true);
  assert.equal(updateCalls, 2);
  assert.equal(state.status, DOMESTIC_MARKETPLACE_PILOT_STATUSES.RESERVED);
});

test("a failed draft releases the slot, while a created draft consumes it", async () => {
  let state = {
    status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.RESERVED,
    checkoutClaimReference: "checkout_1",
    draftOrderId: null,
  };
  const prismaClient = {
    domesticMarketplacePilot: {
      async updateMany({ where, data }) {
        const matches =
          state.status === where.status &&
          state.checkoutClaimReference === where.checkoutClaimReference &&
          (where.draftOrderId === undefined ||
            state.draftOrderId === where.draftOrderId);
        if (!matches) return { count: 0 };
        state = { ...state, ...data };
        return { count: 1 };
      },
    },
  };

  const released = await releaseDomesticMarketplacePilotCheckout(
    { pilotId: "pilot_1", checkoutReference: "checkout_1" },
    { prismaClient },
  );
  assert.equal(released.ok, true);
  assert.equal(state.status, DOMESTIC_MARKETPLACE_PILOT_STATUSES.ACTIVE);

  state = {
    status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.RESERVED,
    checkoutClaimReference: "checkout_2",
    draftOrderId: null,
  };
  const created = await markDomesticMarketplacePilotDraftOrderCreated(
    {
      pilotId: "pilot_1",
      checkoutReference: "checkout_2",
      draftOrderId: "gid://shopify/DraftOrder/1",
    },
    { prismaClient },
  );
  const cannotRelease = await releaseDomesticMarketplacePilotCheckout(
    { pilotId: "pilot_1", checkoutReference: "checkout_2" },
    { prismaClient },
  );

  assert.equal(created.ok, true);
  assert.equal(cannotRelease.ok, false);
  assert.equal(
    state.status,
    DOMESTIC_MARKETPLACE_PILOT_STATUSES.ORDER_CREATED,
  );
});

test("recording a draft is idempotent when the database write succeeds but its response is lost", async () => {
  let updateCalls = 0;
  let state = {
    id: "pilot_1",
    status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.RESERVED,
    checkoutClaimReference: "checkout_1",
    draftOrderId: null,
  };
  const prismaClient = {
    domesticMarketplacePilot: {
      async updateMany({ where, data }) {
        updateCalls += 1;
        const matches =
          state.id === where.id &&
          state.status === where.status &&
          state.checkoutClaimReference === where.checkoutClaimReference;
        if (!matches) return { count: 0 };
        state = { ...state, ...data };
        throw new Error("database response lost after commit");
      },
      async findUnique({ where }) {
        return state.checkoutClaimReference === where.checkoutClaimReference
          ? state
          : null;
      },
    },
  };

  const result = await markDomesticMarketplacePilotDraftOrderCreated(
    {
      pilotId: "pilot_1",
      checkoutReference: "checkout_1",
      draftOrderId: "gid://shopify/DraftOrder/1",
    },
    { prismaClient },
  );

  assert.equal(result.ok, true);
  assert.equal(result.idempotent, true);
  assert.equal(updateCalls, 2);
  assert.equal(
    state.status,
    DOMESTIC_MARKETPLACE_PILOT_STATUSES.ORDER_CREATED,
  );
  assert.equal(state.draftOrderId, "gid://shopify/DraftOrder/1");
});

test("a paid KOMOJU card order completes the pilot only after SellerOrder exists", async () => {
  let state = {
    id: "pilot_1",
    status: DOMESTIC_MARKETPLACE_PILOT_STATUSES.ORDER_CREATED,
    checkoutClaimReference: "checkout_1",
    shopifyOrderId: null,
  };
  let paymentAttempt = null;
  const prismaClient = {
    domesticMarketplacePilot: {
      async findUnique() {
        return state;
      },
      async updateMany({ where, data }) {
        const matches =
          state.id === where.id &&
          state.status === where.status &&
          state.checkoutClaimReference === where.checkoutClaimReference &&
          state.shopifyOrderId === where.shopifyOrderId;
        if (!matches) return { count: 0 };
        state = { ...state, ...data, revision: 3 };
        return { count: 1 };
      },
    },
    sellerOrder: {
      async findFirst({ where }) {
        return where.shopifyOrderId === "gid://shopify/Order/1" &&
          where.checkoutReference === "checkout_1"
          ? { id: "seller_order_1" }
          : null;
      },
    },
    marketplacePaymentAttempt: {
      async findFirst() {
        return paymentAttempt;
      },
    },
  };

  const wrongProvider = await completeDomesticMarketplacePilotForPaidOrder(
    {
      checkoutReference: "checkout_1",
      shopifyOrderId: "gid://shopify/Order/1",
    },
    { prismaClient },
  );
  assert.deepEqual(wrongProvider, {
    ok: false,
    reason: "pilot_komoju_card_not_confirmed",
  });

  paymentAttempt = {
    id: "attempt_without_structured_card_details",
    metadataJson: {
      paymentDetailsType: null,
      paymentWallet: null,
    },
  };
  const unstructuredPayment =
    await completeDomesticMarketplacePilotForPaidOrder(
      {
        checkoutReference: "checkout_1",
        shopifyOrderId: "gid://shopify/Order/1",
      },
      { prismaClient },
    );
  assert.deepEqual(unstructuredPayment, {
    ok: false,
    reason: "pilot_komoju_card_not_confirmed",
  });

  paymentAttempt = {
    id: "attempt_1",
    metadataJson: {
      paymentDetailsType: "CardPaymentDetails",
      paymentWallet: null,
    },
  };

  const completed = await completeDomesticMarketplacePilotForPaidOrder(
    {
      checkoutReference: "checkout_1",
      shopifyOrderId: "gid://shopify/Order/1",
    },
    { prismaClient },
  );
  assert.equal(completed.ok, true);
  assert.equal(state.status, DOMESTIC_MARKETPLACE_PILOT_STATUSES.COMPLETED);
  assert.equal(state.shopifyOrderId, "gid://shopify/Order/1");

  const repeated = await completeDomesticMarketplacePilotForPaidOrder(
    {
      checkoutReference: "checkout_1",
      shopifyOrderId: "gid://shopify/Order/1",
    },
    { prismaClient },
  );
  assert.equal(repeated.ok, true);
  assert.equal(repeated.idempotent, true);
});

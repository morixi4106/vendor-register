import assert from "node:assert/strict";
import test from "node:test";

import {
  applySettlementAdjustment,
  buildProductComplianceSnapshot,
  buildSellerGovernanceSnapshot,
  calculateGovernedPayoutAvailability,
  createSettlementAdjustment,
  evaluateProductGovernanceReadiness,
  evaluateSellerGovernanceReadiness,
  getMarketplaceGovernanceConfiguration,
  getSellerAgreementReadinessOptions,
  recordSellerAgreementAcceptance,
  updateMarketplaceOperationalCase,
} from "../../app/services/marketplaceGovernance.server.js";

function readySeller() {
  return {
    id: "seller_1",
    status: "active",
    sellerLegalRole: "MARKETPLACE_SELLER",
    complianceProfile: {
      entityType: "CORPORATION",
      legalName: "Example Seller Ltd.",
      countryCode: "JP",
      address1: "1-1-1 Chiyoda",
      reviewStatus: "APPROVED",
      antisocialDeclarationAt: new Date("2026-01-01T00:00:00Z"),
      shipFromConfirmedAt: new Date("2026-01-01T00:00:00Z"),
    },
    agreementAcceptances: [
      {
        agreementType: "SELLER_MASTER",
        version: "seller-2026-01",
        documentHash: "hash",
        acceptedAt: new Date("2026-01-01T00:00:00Z"),
        revokedAt: null,
      },
    ],
    settlementControl: {
      salesHold: false,
      payoutHold: false,
      reserveAmount: 0,
      directInvoiceBalance: 0,
    },
    vendorStore: {
      id: "store_1",
      storeName: "Example Store",
      isTestStore: false,
      returnAddresses: [
        {
          status: "ACTIVE",
          activatedAt: new Date("2026-01-01T00:00:00Z"),
          confirmedAt: new Date("2026-01-01T00:00:00Z"),
          canReceiveReturnsConfirmed: true,
          buyerDisclosureConfirmed: true,
          legalRecipientConfirmed: true,
        },
      ],
    },
  };
}

function readyProduct() {
  return {
    id: "product_1",
    approvalStatus: "approved",
    shopifyProductId: "gid://shopify/Product/1",
    shopifyVariantId: "gid://shopify/ProductVariant/1",
    complianceProfile: {
      legalSellerType: "VENDOR",
      conditionStatus: "NEW",
      countryOfOriginCode: "JP",
      customsDescriptionEn: "Cotton pouch",
      approvalStatus: "APPROVED",
      authenticityConfirmedAt: new Date("2026-01-01T00:00:00Z"),
      ipRightsConfirmedAt: new Date("2026-01-01T00:00:00Z"),
    },
  };
}

test("seller governance readiness requires the active agreement and verified return address", () => {
  const result = evaluateSellerGovernanceReadiness(readySeller(), {
    agreementVersion: "seller-2026-01",
  });

  assert.equal(result.ready, true);
  assert.deepEqual(result.reasons, []);
});

test("seller governance readiness reports holds and incomplete return address", () => {
  const seller = readySeller();
  seller.vendorStore.returnAddresses[0].buyerDisclosureConfirmed = false;
  seller.settlementControl.salesHold = true;

  const result = evaluateSellerGovernanceReadiness(seller, {
    agreementVersion: "seller-2026-01",
  });

  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes("active_return_address_missing"));
  assert.ok(result.reasons.includes("sales_hold"));
});

test("governance configuration requires published contract URLs and a SHA-256", () => {
  const incomplete = getMarketplaceGovernanceConfiguration({
    SELLER_AGREEMENT_VERSION: "seller-2026-01",
    SELLER_AGREEMENT_DOCUMENT_HASH: "not-a-sha256",
    BUYER_TERMS_VERSION: "buyer-2026-01",
  });

  assert.equal(incomplete.ready, false);
  assert.ok(incomplete.reasons.includes("agreement_document_hash_unconfigured"));
  assert.ok(incomplete.reasons.includes("agreement_url_unconfigured"));
  assert.ok(incomplete.reasons.includes("buyer_terms_url_unconfigured"));

  const complete = getMarketplaceGovernanceConfiguration({
    SELLER_AGREEMENT_VERSION: "seller-2026-01",
    SELLER_AGREEMENT_DOCUMENT_HASH: "a".repeat(64),
    SELLER_AGREEMENT_URL: "https://example.com/seller-agreement",
    BUYER_TERMS_VERSION: "buyer-2026-01",
    BUYER_TERMS_URL: "https://example.com/terms",
  });

  assert.equal(complete.ready, true);
  assert.equal(
    complete.sellerAgreementUrl,
    "https://example.com/seller-agreement",
  );
});

test("seller readiness rejects an acceptance for a different contract hash", () => {
  const seller = readySeller();
  seller.agreementAcceptances[0].documentHash = "b".repeat(64);
  const env = {
    SELLER_AGREEMENT_VERSION: "seller-2026-01",
    SELLER_AGREEMENT_DOCUMENT_HASH: "a".repeat(64),
    SELLER_AGREEMENT_URL: "https://example.com/seller-agreement",
    BUYER_TERMS_VERSION: "buyer-2026-01",
    BUYER_TERMS_URL: "https://example.com/terms",
  };

  const result = evaluateSellerGovernanceReadiness(
    seller,
    getSellerAgreementReadinessOptions(env),
  );

  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes("agreement_not_accepted"));
});

test("agreement acceptance only stores a valid SHA-256", async () => {
  let stored = null;
  const prismaClient = {
    sellerAgreementAcceptance: {
      async upsert(args) {
        stored = args;
        return { id: "acceptance_1", ...args.create };
      },
    },
  };

  const invalid = await recordSellerAgreementAcceptance(
    {
      sellerId: "seller_1",
      version: "seller-2026-01",
      documentHash: "invalid",
      acceptedBy: "seller@example.com",
    },
    { prismaClient },
  );
  assert.equal(invalid.ok, false);
  assert.equal(stored, null);

  const valid = await recordSellerAgreementAcceptance(
    {
      sellerId: "seller_1",
      version: "seller-2026-01",
      documentHash: "A".repeat(64),
      acceptedBy: "seller@example.com",
    },
    { prismaClient },
  );
  assert.equal(valid.ok, true);
  assert.equal(stored.create.documentHash, "a".repeat(64));
});

test("product governance readiness requires approved provenance and authenticity data", () => {
  assert.equal(evaluateProductGovernanceReadiness(readyProduct()).ready, true);

  const product = readyProduct();
  product.complianceProfile.countryOfOriginCode = null;
  product.complianceProfile.ipRightsConfirmedAt = null;
  const result = evaluateProductGovernanceReadiness(product);

  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes("country_of_origin_missing"));
  assert.ok(result.reasons.includes("ip_rights_confirmation_missing"));
});

test("governed payout availability subtracts reserves and direct invoices", () => {
  assert.deepEqual(
    calculateGovernedPayoutAvailability(10_000, {
      reserveAmount: 2_000,
      directInvoiceBalance: 1_500,
      payoutHold: false,
    }),
    {
      ledgerBalance: 10_000,
      reserveAmount: 2_000,
      directInvoiceBalance: 1_500,
      payoutHold: false,
      availableAmount: 6_500,
    },
  );
  assert.equal(
    calculateGovernedPayoutAvailability(10_000, { payoutHold: true })
      .availableAmount,
    0,
  );
});

test("order snapshots preserve seller contract and product compliance versions", () => {
  const sellerSnapshot = buildSellerGovernanceSnapshot(readySeller(), {
    agreementVersion: "seller-2026-01",
    buyerTermsVersion: "buyer-2026-01",
  });
  const productSnapshot = buildProductComplianceSnapshot(readyProduct());

  assert.equal(sellerSnapshot.buyerTermsVersion, "buyer-2026-01");
  assert.equal(
    sellerSnapshot.sellerAgreementSnapshotJson.version,
    "seller-2026-01",
  );
  assert.equal(sellerSnapshot.legalSellerSnapshotJson.legalName, "Example Seller Ltd.");
  assert.equal(productSnapshot.conditionStatus, "NEW");
  assert.equal(productSnapshot.countryOfOriginCode, "JP");
});

function transactionClient(tx) {
  return {
    async $transaction(callback) {
      return callback(tx);
    },
  };
}

test("seller set-off requires confirmed responsibility and explicit authorization", async () => {
  const tx = {
    seller: {
      async findUnique() {
        return {
          id: "seller_1",
          settlementControl: { futureSetoffEnabled: false },
        };
      },
    },
    marketplaceOperationalCase: {
      async findUnique() {
        return {
          id: "case_1",
          status: "RESPONSIBILITY_CONFIRMED",
          responsibilitySellerId: "seller_1",
          responsibilityStatus: "SELLER",
          confirmedSellerLiabilityAmount: 1_000,
          settlementAdjustments: [],
        };
      },
    },
    sellerSettlementAdjustment: {
      async create() {
        throw new Error("an unauthorized set-off must not be persisted");
      },
    },
  };

  const result = await createSettlementAdjustment(
    {
      sellerId: "seller_1",
      caseId: "case_1",
      adjustmentType: "SET_OFF",
      direction: "debit",
      amount: 500,
      reason: "confirmed damage",
    },
    { prismaClient: transactionClient(tx) },
  );

  assert.deepEqual(result, {
    ok: false,
    reason: "future_setoff_not_authorized",
  });
});

test("seller debit adjustments cannot exceed the confirmed liability", async () => {
  const tx = {
    seller: {
      async findUnique() {
        return {
          id: "seller_1",
          settlementControl: { futureSetoffEnabled: true },
        };
      },
    },
    marketplaceOperationalCase: {
      async findUnique() {
        return {
          id: "case_1",
          status: "RESPONSIBILITY_CONFIRMED",
          responsibilitySellerId: "seller_1",
          responsibilityStatus: "SELLER",
          confirmedSellerLiabilityAmount: 1_000,
          settlementAdjustments: [
            {
              adjustmentType: "DIRECT_INVOICE",
              direction: "debit",
              amount: 700,
              status: "PENDING",
            },
          ],
        };
      },
    },
    sellerSettlementAdjustment: {
      async create() {
        throw new Error("an excessive adjustment must not be persisted");
      },
    },
  };

  const result = await createSettlementAdjustment(
    {
      sellerId: "seller_1",
      caseId: "case_1",
      adjustmentType: "SET_OFF",
      direction: "debit",
      amount: 400,
      reason: "confirmed damage",
    },
    { prismaClient: transactionClient(tx) },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "liability_amount_exceeded");
});

test("case liability cannot be lowered below committed adjustments", async () => {
  const prismaClient = {
    marketplaceOperationalCase: {
      async findUnique() {
        return {
          id: "case_1",
          status: "RESPONSIBILITY_CONFIRMED",
          responsibilityStatus: "SELLER",
          settlementAdjustments: [
            {
              adjustmentType: "SET_OFF",
              direction: "debit",
              amount: 800,
              status: "PENDING",
            },
          ],
        };
      },
    },
    async $transaction() {
      throw new Error("an invalid case update must not start a transaction");
    },
  };

  const result = await updateMarketplaceOperationalCase(
    {
      caseId: "case_1",
      status: "RESPONSIBILITY_CONFIRMED",
      confirmedSellerLiabilityAmount: 500,
    },
    { prismaClient },
  );

  assert.deepEqual(result, {
    ok: false,
    reason: "liability_below_committed_adjustments",
  });
});

test("reserve adjustments change payout controls without creating a ledger debit", async () => {
  let controlData = null;
  const tx = {
    sellerSettlementAdjustment: {
      async findUnique() {
        return {
          id: "adjustment_1",
          sellerId: "seller_1",
          caseId: "case_1",
          adjustmentType: "RESERVE",
          direction: "debit",
          amount: 600,
          currencyCode: "jpy",
          status: "PENDING",
          reason: "temporary reserve",
          approvedAt: null,
          approvedBy: null,
        };
      },
      async update({ data }) {
        return { id: "adjustment_1", ...data };
      },
    },
    sellerSettlementControl: {
      async findUnique() {
        return { sellerId: "seller_1", reserveAmount: 200 };
      },
      async upsert({ update }) {
        controlData = update;
        return { sellerId: "seller_1", ...update };
      },
    },
    ledgerEntry: {
      async create() {
        throw new Error("a reserve must not alter the ledger");
      },
    },
    marketplaceOperationalCaseEvent: {
      async create() {
        return { id: "event_1" };
      },
    },
  };

  const result = await applySettlementAdjustment(
    { adjustmentId: "adjustment_1", actor: "admin@example.com" },
    { prismaClient: transactionClient(tx) },
  );

  assert.equal(result.ok, true);
  assert.equal(result.ledgerEntry, null);
  assert.equal(controlData.reserveAmount, 800);
});

test("an applied set-off is idempotent", async () => {
  const adjustment = { id: "adjustment_1", status: "APPLIED" };
  const tx = {
    sellerSettlementAdjustment: {
      async findUnique() {
        return adjustment;
      },
    },
  };

  const result = await applySettlementAdjustment(
    { adjustmentId: "adjustment_1" },
    { prismaClient: transactionClient(tx) },
  );

  assert.deepEqual(result, {
    ok: true,
    unchanged: true,
    adjustment,
  });
});

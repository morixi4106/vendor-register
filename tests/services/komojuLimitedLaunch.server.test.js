import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectKomojuLimitedLaunchScope,
  previewKomojuZeroBalanceLimitedLaunch,
  recordKomojuZeroBalanceLimitedLaunch,
} from "../../app/services/komojuLimitedLaunch.server.js";
import {
  buildProductionReleaseExpectation,
  buildProductionReleaseFingerprint,
} from "../../app/services/productionRelease.server.js";

const SHOP = "example.myshopify.com";
const NOW = new Date("2026-08-07T02:00:00.000Z");
const EVIDENCE_HASH = "a".repeat(64);
const RELEASE_ENV = {
  RENDER_GIT_COMMIT: "b".repeat(40),
  SHOPIFY_APP_VERSION: "app-version-1",
  SHOPIFY_PRIMARY_SHOP_DOMAIN: SHOP,
  SHOPIFY_API_SECRET: "test-preview-secret",
};

function releaseExpectation() {
  return buildProductionReleaseExpectation({ env: RELEASE_ENV });
}

function eligibleProbe(overrides = {}) {
  const release = releaseExpectation();
  return {
    id: "probe_limited_1",
    shopDomain: SHOP,
    shopifyOrderId: "gid://shopify/Order/1",
    marketplaceOrderId: "marketplace_order_1",
    status: "AWAITING_PAYOUT_EVIDENCE",
    releaseId: release.releaseId,
    releaseFingerprint: buildProductionReleaseFingerprint(release),
    paidVerifiedAt: new Date("2026-08-07T01:00:00.000Z"),
    updatedAt: new Date("2026-08-07T01:30:00.000Z"),
    orderEvidenceJson: {
      products: [{ productId: "product_1", quantity: 1 }],
      commercialEvidence: {
        lines: [
          {
            productId: "product_1",
            variantId: "gid://shopify/ProductVariant/1",
            quantity: 1,
          },
        ],
      },
      probeConfig: {
        provider: "KOMOJU",
        paymentMethod: "CARD",
      },
      externalReadiness: {
        strategy: "ZERO_BALANCE_LIMITED_LAUNCH",
        maximumPlannedChargeAmount: 2000,
        confirmedRefundReserveAmount: 3000,
        confirmedKomojuUnsettledBalanceAmount: 0,
        zeroUnsettledBalanceConfirmed: true,
        companyRefundReserveConfirmed: true,
        directRefundFallbackConfirmed: true,
        domesticPlatformDirectOnlyConfirmed: true,
        limitedLaunchMaxOrderCount: 2,
        limitedLaunchMaxGrossAmount: 3000,
        limitedLaunchMaxOutstandingLiability: 3000,
        komojuPayoutCycle: "WEEKLY",
        expectedBankDepositAt: "2026-08-09T02:00:00.000Z",
        komojuMinimumPayoutAmount: 1000,
        estimatedProcessingFeeAmount: 100,
        payoutNotOnHoldConfirmed: true,
      },
    },
    paidEvidenceJson: {
      passed: true,
      actualPaidAmount: 1650,
      currencyCode: "JPY",
    },
    ...overrides,
  };
}

function buildPrismaClient({
  probe = eligibleProbe(),
  euEnabledSellerCount = 0,
  euEnabledProductCount = 0,
  internationalEnabledProductCount = 0,
} = {}) {
  let storedAttestation = null;
  let storedControl = null;
  let productCountCall = 0;
  let allowedProducts = [
    {
      id: "product_1",
      name: "Platform product",
      shopifyProductId: "gid://shopify/Product/1",
      shopifyVariantId: "gid://shopify/ProductVariant/1",
      inventoryQuantity: 1,
    },
  ];
  const client = {
    productionTransactionProbe: {
      async findUnique() {
        return probe;
      },
    },
    seller: {
      async count() {
        return euEnabledSellerCount;
      },
    },
    product: {
      async count() {
        productCountCall += 1;
        return productCountCall % 2 === 1
          ? euEnabledProductCount
          : internationalEnabledProductCount;
      },
      async findMany() {
        return allowedProducts;
      },
    },
    operationalReadinessAttestation: {
      async findUnique() {
        return storedAttestation;
      },
      async upsert({ create }) {
        storedAttestation = { id: "att_limited_1", ...create };
        return storedAttestation;
      },
      async update({ data }) {
        storedAttestation = { ...storedAttestation, ...data };
        return storedAttestation;
      },
    },
    komojuLimitedLaunchControl: {
      async findUnique() {
        return storedControl;
      },
      async create({ data }) {
        storedControl = { id: "control_1", ...data };
        return storedControl;
      },
      async update({ data }) {
        storedControl = { ...storedControl, ...data };
        return storedControl;
      },
    },
    async $transaction(callback) {
      return callback(client);
    },
    setAllowedProducts(products) {
      allowedProducts = products;
    },
    get storedAttestation() {
      return storedAttestation;
    },
    get storedControl() {
      return storedControl;
    },
  };
  return client;
}

function previewInput(overrides = {}) {
  return {
    probeId: "probe_limited_1",
    releaseExpectation: releaseExpectation(),
    evidenceReference: "private-evidence:komoju-zero-balance-launch",
    evidenceHash: EVIDENCE_HASH,
    ...overrides,
  };
}

function recordInput(previewToken, overrides = {}) {
  return {
    ...previewInput(),
    actorKey: "shopify_user:1",
    previewToken,
    confirm: "activate_zero_balance_limited_launch",
    ...overrides,
  };
}

const canaryGraphQL = async ({ variables }) => ({
  data: {
    productVariant: {
      id: variables.id,
      inventoryQuantity: 1,
      inventoryPolicy: "DENY",
      product: { id: "gid://shopify/Product/1" },
      inventoryItem: { tracked: true },
    },
  },
});

async function createPreview(prismaClient, options = {}) {
  return previewKomojuZeroBalanceLimitedLaunch(previewInput(), {
    prismaClient,
    env: RELEASE_ENV,
    now: NOW,
    graphQL: canaryGraphQL,
    ...options,
  });
}

const syncProjection = async ({ projection }) => ({
  ok: true,
  compareDigest: `digest:${projection.r}`,
  projection,
});

test("limited launch scope requires third-party and EU commerce to remain disabled", async () => {
  const ready = await inspectKomojuLimitedLaunchScope({
    prismaClient: buildPrismaClient(),
    env: {},
  });
  assert.equal(ready.ready, true);

  const thirdPartyEnabled = await inspectKomojuLimitedLaunchScope({
    prismaClient: buildPrismaClient(),
    env: { PUBLIC_DRAFT_ORDER_CHECKOUT_ENABLED: "true" },
  });
  assert.equal(thirdPartyEnabled.ready, false);

  const euEnabled = await inspectKomojuLimitedLaunchScope({
    prismaClient: buildPrismaClient({ euEnabledProductCount: 1 }),
    env: {},
  });
  assert.equal(euEnabled.ready, false);

  const internationalEnabled = await inspectKomojuLimitedLaunchScope({
    prismaClient: buildPrismaClient({ internationalEnabledProductCount: 1 }),
    env: {},
  });
  assert.equal(internationalEnabled.ready, false);
});

test("limited launch cannot be previewed before paid evidence is complete", async () => {
  const prismaClient = buildPrismaClient({
    probe: eligibleProbe({
      paidVerifiedAt: null,
      paidEvidenceJson: { passed: false },
    }),
  });
  const result = await createPreview(prismaClient);

  assert.deepEqual(result, {
    ok: false,
    reason: "limited_launch_paid_evidence_incomplete",
  });
  assert.equal(prismaClient.storedAttestation, null);
});

test("limited launch records one release-bound seven-day attestation after preview", async () => {
  const prismaClient = buildPrismaClient();
  const preview = await createPreview(prismaClient);
  assert.equal(preview.ok, true);
  assert.equal(preview.preview.maxOrderCount, 2);
  assert.deepEqual(
    preview.preview.allowedProducts.map((product) => product.id),
    ["product_1"],
  );
  assert.equal(preview.preview.selectedProductId, "product_1");
  assert.equal(
    preview.preview.selectedShopifyVariantId,
    "gid://shopify/ProductVariant/1",
  );
  assert.equal(preview.preview.inventoryQuantity, 1);
  assert.equal(preview.preview.inventoryTracked, true);
  assert.equal(preview.preview.inventoryPolicy, "DENY");
  assert.equal(preview.preview.projectionRevision, 1);
  assert.equal(preview.preview.generatedAt, NOW.toISOString());
  assert.equal(preview.preview.expiresAt, "2026-08-07T02:15:00.000Z");

  const result = await recordKomojuZeroBalanceLimitedLaunch(
    recordInput(preview.preview.previewToken),
    {
      prismaClient,
      env: RELEASE_ENV,
      now: NOW,
      graphQL: canaryGraphQL,
      syncProjection,
    },
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.existing, false);
  assert.equal(
    prismaClient.storedAttestation.expiresAt.toISOString(),
    "2026-08-14T02:00:00.000Z",
  );
  assert.equal(
    prismaClient.storedAttestation.metadataJson.releaseId,
    releaseExpectation().releaseId,
  );
  assert.equal(prismaClient.storedControl.maxOrderCount, 2);
  assert.equal(prismaClient.storedControl.maxGrossAmount, 3000);
});

test("a database finalize failure rolls Shopify back to BLOCKED and the same activation can retry safely", async () => {
  const prismaClient = buildPrismaClient();
  const preview = await createPreview(prismaClient);
  const originalTransaction = prismaClient.$transaction.bind(prismaClient);
  let transactionCount = 0;
  prismaClient.$transaction = async (callback) => {
    transactionCount += 1;
    if (transactionCount === 2) {
      throw new Error("simulated finalize failure");
    }
    return originalTransaction(callback);
  };
  const projectionStates = [];
  const recordingSync = async ({ projection }) => {
    projectionStates.push({ state: projection.s, revision: projection.r });
    return {
      ok: true,
      compareDigest: `digest:${projection.r}`,
      projection,
    };
  };

  const failed = await recordKomojuZeroBalanceLimitedLaunch(
    recordInput(preview.preview.previewToken),
    {
      prismaClient,
      env: RELEASE_ENV,
      now: NOW,
      graphQL: canaryGraphQL,
      syncProjection: recordingSync,
    },
  );

  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "limited_launch_database_finalize_failed");
  assert.equal(prismaClient.storedControl.status, "BLOCKED");
  assert.equal(prismaClient.storedAttestation.status, "FAILED");
  assert.deepEqual(projectionStates, [
    { state: "PREPARING", revision: 1 },
    { state: "ACTIVE", revision: 2 },
    { state: "BLOCKED", revision: 3 },
  ]);

  prismaClient.$transaction = originalTransaction;
  const retryPreview = await createPreview(prismaClient);
  assert.equal(retryPreview.ok, true, JSON.stringify(retryPreview));
  const retried = await recordKomojuZeroBalanceLimitedLaunch(
    recordInput(retryPreview.preview.previewToken),
    {
      prismaClient,
      env: RELEASE_ENV,
      now: NOW,
      graphQL: canaryGraphQL,
      syncProjection: recordingSync,
    },
  );

  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(retried.existing, false);
  assert.equal(prismaClient.storedControl.status, "ACTIVE");
  assert.equal(prismaClient.storedControl.projectionVersion, 6);
  assert.deepEqual(projectionStates.slice(-2), [
    { state: "PREPARING", revision: 5 },
    { state: "ACTIVE", revision: 6 },
  ]);
});

test("limited launch is idempotent but cannot be renewed or reassigned", async () => {
  const prismaClient = buildPrismaClient();
  const preview = await createPreview(prismaClient);
  const options = {
    prismaClient,
    env: RELEASE_ENV,
    now: NOW,
    graphQL: canaryGraphQL,
    syncProjection,
  };
  const first = await recordKomojuZeroBalanceLimitedLaunch(
    recordInput(preview.preview.previewToken),
    options,
  );
  assert.equal(first.ok, true, JSON.stringify(first));

  const repeated = await recordKomojuZeroBalanceLimitedLaunch(
    recordInput(preview.preview.previewToken),
    options,
  );
  assert.equal(repeated.ok, true, JSON.stringify(repeated));
  assert.equal(repeated.existing, true);

  const reassigned = await previewKomojuZeroBalanceLimitedLaunch(
    previewInput({
      evidenceReference: "private-evidence:different-package",
      evidenceHash: "c".repeat(64),
    }),
    { prismaClient, env: RELEASE_ENV, now: NOW, graphQL: canaryGraphQL },
  );
  assert.equal(reassigned.reason, "limited_launch_exception_already_used");
});

test("limited launch preview expires and rejects changed product scope", async () => {
  const expiredClient = buildPrismaClient();
  const expiredPreview = await createPreview(expiredClient);
  const expired = await recordKomojuZeroBalanceLimitedLaunch(
    recordInput(expiredPreview.preview.previewToken),
    {
      prismaClient: expiredClient,
      env: RELEASE_ENV,
      now: new Date(NOW.getTime() + 16 * 60 * 1000),
      graphQL: canaryGraphQL,
      syncProjection,
    },
  );
  assert.equal(expired.reason, "limited_launch_preview_expired");

  const changedClient = buildPrismaClient();
  const changedPreview = await createPreview(changedClient);
  changedClient.setAllowedProducts([
    {
      id: "product_1",
      name: "Platform product",
      shopifyProductId: "gid://shopify/Product/2",
    },
  ]);
  const changed = await recordKomojuZeroBalanceLimitedLaunch(
    recordInput(changedPreview.preview.previewToken),
    {
      prismaClient: changedClient,
      env: RELEASE_ENV,
      now: NOW,
      graphQL: canaryGraphQL,
      syncProjection,
    },
  );
  assert.equal(changed.reason, "limited_launch_canary_inventory_invalid");
});

test("limited launch preview rejects a different release and non-restricted scope", async () => {
  const releaseMismatch = await previewKomojuZeroBalanceLimitedLaunch(
    previewInput({
      releaseExpectation: buildProductionReleaseExpectation({
        env: { ...RELEASE_ENV, RENDER_GIT_COMMIT: "c".repeat(40) },
      }),
    }),
    { prismaClient: buildPrismaClient(), env: RELEASE_ENV, now: NOW },
  );
  assert.equal(releaseMismatch.reason, "limited_launch_probe_not_eligible");

  const thirdPartyEnabled = await previewKomojuZeroBalanceLimitedLaunch(
    previewInput(),
    {
      prismaClient: buildPrismaClient(),
      env: {
        ...RELEASE_ENV,
        MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED: "true",
      },
      now: NOW,
    },
  );
  assert.equal(thirdPartyEnabled.reason, "limited_launch_scope_not_restricted");
});

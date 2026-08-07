import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectKomojuLimitedLaunchScope,
  recordKomojuZeroBalanceLimitedLaunch,
} from "../../app/services/komojuLimitedLaunch.server.js";
import {
  buildProductionReleaseExpectation,
  buildProductionReleaseFingerprint,
} from "../../app/services/productionRelease.server.js";

const SHOP = "example.myshopify.com";
const EVIDENCE_HASH = "a".repeat(64);
const RELEASE_ENV = {
  RENDER_GIT_COMMIT: "b".repeat(40),
  SHOPIFY_APP_VERSION: "app-version-1",
  SHOPIFY_PRIMARY_SHOP_DOMAIN: SHOP,
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
    orderEvidenceJson: {
      probeConfig: {
        provider: "KOMOJU",
        paymentMethod: "CARD",
      },
      externalReadiness: {
        strategy: "ZERO_BALANCE_LIMITED_LAUNCH",
        maximumPlannedChargeAmount: 2000,
        confirmedRefundReserveAmount: 2000,
        confirmedKomojuUnsettledBalanceAmount: 0,
        zeroUnsettledBalanceConfirmed: true,
        companyRefundReserveConfirmed: true,
        directRefundFallbackConfirmed: true,
        domesticPlatformDirectOnlyConfirmed: true,
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
  let productCountCall = 0;
  return {
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
    },
    operationalReadinessAttestation: {
      async findUnique() {
        return storedAttestation;
      },
      async upsert({ create }) {
        storedAttestation = { id: "att_limited_1", ...create };
        return storedAttestation;
      },
    },
    get storedAttestation() {
      return storedAttestation;
    },
  };
}

function recordInput(overrides = {}) {
  return {
    probeId: "probe_limited_1",
    actorKey: "shopify_user:1",
    releaseExpectation: releaseExpectation(),
    evidenceReference: "private-evidence:komoju-zero-balance-launch",
    evidenceHash: EVIDENCE_HASH,
    confirm: "activate_zero_balance_limited_launch",
    ...overrides,
  };
}

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
  assert.equal(thirdPartyEnabled.thirdPartyCommerceDisabled, false);

  const euEnabled = await inspectKomojuLimitedLaunchScope({
    prismaClient: buildPrismaClient({ euEnabledProductCount: 1 }),
    env: {},
  });
  assert.equal(euEnabled.ready, false);
  assert.equal(euEnabled.euEnabledProductCount, 1);

  const internationalEnabled = await inspectKomojuLimitedLaunchScope({
    prismaClient: buildPrismaClient({ internationalEnabledProductCount: 1 }),
    env: {},
  });
  assert.equal(internationalEnabled.ready, false);
  assert.equal(internationalEnabled.internationalEnabledProductCount, 1);
});

test("limited launch cannot be recorded before the paid evidence is complete", async () => {
  const prismaClient = buildPrismaClient({
    probe: eligibleProbe({
      paidVerifiedAt: null,
      paidEvidenceJson: { passed: false },
    }),
  });
  const result = await recordKomojuZeroBalanceLimitedLaunch(recordInput(), {
    prismaClient,
    env: {},
  });

  assert.deepEqual(result, {
    ok: false,
    reason: "limited_launch_paid_evidence_incomplete",
  });
  assert.equal(prismaClient.storedAttestation, null);
});

test("limited launch records one release-bound seven-day attestation", async () => {
  const prismaClient = buildPrismaClient();
  const now = new Date("2026-08-07T02:00:00.000Z");
  const result = await recordKomojuZeroBalanceLimitedLaunch(recordInput(), {
    prismaClient,
    env: {},
    now,
  });

  assert.equal(result.ok, true);
  assert.equal(result.existing, false);
  assert.equal(
    prismaClient.storedAttestation.expiresAt.toISOString(),
    "2026-08-14T02:00:00.000Z",
  );
  assert.equal(
    prismaClient.storedAttestation.metadataJson.releaseId,
    releaseExpectation().releaseId,
  );
  assert.equal(
    prismaClient.storedAttestation.metadataJson.companyRefundReserveAmount,
    2000,
  );
  assert.equal(
    prismaClient.storedAttestation.metadataJson.strictE2eStillRequired,
    true,
  );
  assert.equal(
    prismaClient.storedAttestation.metadataJson
      .internationalEnabledProductCount,
    0,
  );
});

test("limited launch is idempotent but cannot be renewed or reassigned", async () => {
  const prismaClient = buildPrismaClient();
  const options = {
    prismaClient,
    env: {},
    now: new Date("2026-08-07T02:00:00.000Z"),
  };
  const first = await recordKomojuZeroBalanceLimitedLaunch(
    recordInput(),
    options,
  );
  assert.equal(first.ok, true);

  const repeated = await recordKomojuZeroBalanceLimitedLaunch(
    recordInput(),
    options,
  );
  assert.equal(repeated.ok, true);
  assert.equal(repeated.existing, true);

  const reassigned = await recordKomojuZeroBalanceLimitedLaunch(
    recordInput({
      evidenceReference: "private-evidence:different-package",
      evidenceHash: "c".repeat(64),
    }),
    options,
  );
  assert.deepEqual(reassigned, {
    ok: false,
    reason: "limited_launch_exception_already_used",
  });
});

test("limited launch rejects a different release and non-restricted scope", async () => {
  const releaseMismatch = await recordKomojuZeroBalanceLimitedLaunch(
    recordInput({
      releaseExpectation: buildProductionReleaseExpectation({
        env: {
          ...RELEASE_ENV,
          RENDER_GIT_COMMIT: "c".repeat(40),
        },
      }),
    }),
    { prismaClient: buildPrismaClient(), env: {} },
  );
  assert.equal(releaseMismatch.reason, "limited_launch_probe_not_eligible");

  const thirdPartyEnabled = await recordKomojuZeroBalanceLimitedLaunch(
    recordInput(),
    {
      prismaClient: buildPrismaClient(),
      env: { MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED: "true" },
    },
  );
  assert.equal(
    thirdPartyEnabled.reason,
    "limited_launch_scope_not_restricted",
  );
});

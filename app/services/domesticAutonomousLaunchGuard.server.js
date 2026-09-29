import prisma from "../db.server.js";
import { inspectMarketplaceCheckoutValidation } from "./shopifyCheckoutValidation.server.js";
import {
  buildProductionReleaseExpectation,
} from "./productionRelease.server.js";
import {
  attachOrderToProductionTransactionProbe,
  createProductionTransactionProbe,
  getProductionTransactionProbePageData,
  inspectProductionTransactionProbePreflight,
  PRODUCTION_TRANSACTION_AUTODETECT,
  PRODUCTION_TRANSACTION_PROBE_STATUS,
  refreshProductionTransactionProbe,
} from "./productionTransactionProbe.server.js";
import { applyPlatformCheckoutEmergencyHold } from "./operationalReadiness.server.js";
import { inspectDomesticAutonomousLaunchAuthorization } from "./domesticAutonomousLaunchAuthorization.js";
import { inspectKomojuLimitedLaunchScope } from "./komojuLimitedLaunchScope.server.js";

const GUARD_ACTOR = "domestic-autonomous-launch-guard";
const DEFAULT_SETTLEMENT_GRACE_MINUTES = 20;
const MIN_SETTLEMENT_GRACE_MINUTES = 5;
const MAX_SETTLEMENT_GRACE_MINUTES = 60;
const MAX_ALLOWED_CHARGE_AMOUNT = 10_000_000;

function normalize(value) {
  return String(value || "").trim();
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function boundedGraceMinutes(value) {
  const parsed = positiveInteger(value);
  if (!parsed) return DEFAULT_SETTLEMENT_GRACE_MINUTES;
  return Math.min(
    MAX_SETTLEMENT_GRACE_MINUTES,
    Math.max(MIN_SETTLEMENT_GRACE_MINUTES, parsed),
  );
}

function isCurrentReleaseProbe(probe, release) {
  return Boolean(
    probe &&
      release?.releaseFingerprint &&
      probe.releaseFingerprint === release.releaseFingerprint,
  );
}

function findPassedProbe(pageData) {
  return (pageData?.recentProbes || []).find(
    (probe) =>
      probe.status === PRODUCTION_TRANSACTION_PROBE_STATUS.PASSED &&
      isCurrentReleaseProbe(probe, pageData?.release),
  );
}

function orderAttachedAgeMs(probe, now) {
  const attachedAt = new Date(probe?.orderAttachedAt || probe?.startedAt || 0);
  return Number.isFinite(attachedAt.getTime())
    ? Math.max(0, now.getTime() - attachedAt.getTime())
    : Number.POSITIVE_INFINITY;
}

async function secureLaunch(
  reason,
  { shopDomain, prismaClient, env, now, applyEmergencyHoldImpl },
) {
  const hold = await applyEmergencyHoldImpl(
    {
      reason: `domestic_autonomous_launch:${normalize(reason) || "guard_failure"}`,
      changedBy: GUARD_ACTOR,
      shopDomain,
    },
    { prismaClient, env, now },
  );
  const secured =
    hold?.ok === true || hold?.reason === "purchase_stop_already_active";
  return {
    ok: false,
    active: true,
    secured,
    reason: normalize(reason) || "guard_failure",
    holdReason: hold?.reason || null,
  };
}

export async function runDomesticAutonomousLaunchGuard(
  {
    shopDomain,
    orderReference = null,
    testOrder = false,
  } = {},
  {
    prismaClient = prisma,
    env = process.env,
    now = new Date(),
    inspectAuthorizationImpl = inspectDomesticAutonomousLaunchAuthorization,
    inspectCheckoutValidationImpl = inspectMarketplaceCheckoutValidation,
    buildReleaseExpectationImpl = buildProductionReleaseExpectation,
    getProbePageDataImpl = getProductionTransactionProbePageData,
    inspectPreflightImpl = inspectProductionTransactionProbePreflight,
    createProbeImpl = createProductionTransactionProbe,
    attachOrderImpl = attachOrderToProductionTransactionProbe,
    refreshProbeImpl = refreshProductionTransactionProbe,
    applyEmergencyHoldImpl = applyPlatformCheckoutEmergencyHold,
    inspectDomesticScopeImpl = inspectKomojuLimitedLaunchScope,
  } = {},
) {
  const shop = normalize(shopDomain).toLowerCase();
  const primaryShop = normalize(env.SHOPIFY_PRIMARY_SHOP_DOMAIN).toLowerCase();
  const authorization = inspectAuthorizationImpl(env, now);

  if (!authorization.active) {
    if (!authorization.enabled) {
      return {
        ok: true,
        active: false,
        secured: false,
        reason: authorization.reason || "authorization_disabled",
      };
    }
    return secureLaunch(authorization.reason, {
      shopDomain: shop,
      prismaClient,
      env,
      now,
      applyEmergencyHoldImpl,
    });
  }

  if (!shop) {
    return secureLaunch("shop_domain_missing", {
      shopDomain: shop,
      prismaClient,
      env,
      now,
      applyEmergencyHoldImpl,
    });
  }
  if (!primaryShop) {
    return secureLaunch("primary_shop_domain_missing", {
      shopDomain: shop,
      prismaClient,
      env,
      now,
      applyEmergencyHoldImpl,
    });
  }
  if (shop !== primaryShop) {
    return {
      ok: true,
      active: false,
      secured: false,
      skipped: true,
      reason: "non_primary_shop_ignored",
    };
  }
  if (testOrder) {
    return {
      ok: true,
      active: true,
      secured: false,
      skipped: true,
      reason: "test_order_ignored",
    };
  }

  const maximumCharge = positiveInteger(
    env.DOMESTIC_AUTONOMOUS_LAUNCH_MAX_ORDER_AMOUNT,
  );
  if (!maximumCharge || maximumCharge > MAX_ALLOWED_CHARGE_AMOUNT) {
    return secureLaunch("maximum_order_amount_invalid", {
      shopDomain: shop,
      prismaClient,
      env,
      now,
      applyEmergencyHoldImpl,
    });
  }

  try {
    const domesticScope = await inspectDomesticScopeImpl({
      prismaClient,
      env,
    });
    if (!domesticScope?.ready) {
      return secureLaunch("domestic_launch_scope_invalid", {
        shopDomain: shop,
        prismaClient,
        env,
        now,
        applyEmergencyHoldImpl,
      });
    }

    const checkoutValidation = await inspectCheckoutValidationImpl(shop);
    const releaseExpectation = buildReleaseExpectationImpl({
      env,
      checkoutValidation,
    });
    const pageData = await getProbePageDataImpl(
      { shopDomain: shop, releaseExpectation },
      { prismaClient },
    );
    if (!pageData?.available || !pageData?.release?.configured) {
      return secureLaunch("production_probe_unavailable", {
        shopDomain: shop,
        prismaClient,
        env,
        now,
        applyEmergencyHoldImpl,
      });
    }

    const passedProbe = findPassedProbe(pageData);
    if (passedProbe) {
      return {
        ok: true,
        active: true,
        secured: false,
        verified: true,
        probeId: passedProbe.id,
        status: passedProbe.status,
      };
    }

    let probe = pageData.activeProbe;
    if (probe && !isCurrentReleaseProbe(probe, pageData.release)) {
      if (orderReference) {
        return secureLaunch("active_probe_release_mismatch", {
          shopDomain: shop,
          prismaClient,
          env,
          now,
          applyEmergencyHoldImpl,
        });
      }
      probe = null;
    }

    if (!probe) {
      if (orderReference) {
        return secureLaunch("probe_not_armed_before_order", {
          shopDomain: shop,
          prismaClient,
          env,
          now,
          applyEmergencyHoldImpl,
        });
      }
      const preflight = await inspectPreflightImpl(
        {
          shopDomain: shop,
          releaseExpectation,
          checkoutValidation,
          targetProvider: PRODUCTION_TRANSACTION_AUTODETECT.provider,
          targetPaymentMethod: PRODUCTION_TRANSACTION_AUTODETECT.paymentMethod,
        },
        { prismaClient, env },
      );
      if (!preflight?.canStart) {
        return secureLaunch("production_probe_preflight_failed", {
          shopDomain: shop,
          prismaClient,
          env,
          now,
          applyEmergencyHoldImpl,
        });
      }
      const created = await createProbeImpl(
        {
          shopDomain: shop,
          startedBy: GUARD_ACTOR,
          releaseExpectation,
          targetProvider: PRODUCTION_TRANSACTION_AUTODETECT.provider,
          targetPaymentMethod: PRODUCTION_TRANSACTION_AUTODETECT.paymentMethod,
          maximumPlannedChargeAmount: maximumCharge,
        },
        { prismaClient, env, now },
      );
      if (!created?.ok || !created?.probe) {
        return secureLaunch(
          created?.reason || "production_probe_arm_failed",
          {
            shopDomain: shop,
            prismaClient,
            env,
            now,
            applyEmergencyHoldImpl,
          },
        );
      }
      probe = created.probe;
      return {
        ok: true,
        active: true,
        secured: false,
        armed: true,
        probeId: probe.id,
        status: probe.status,
      };
    }

    const normalizedOrderReference = normalize(orderReference);
    if (normalizedOrderReference) {
      if (
        probe.shopifyOrderId &&
        normalize(probe.shopifyOrderId) !== normalizedOrderReference
      ) {
        return secureLaunch("unexpected_additional_order", {
          shopDomain: shop,
          prismaClient,
          env,
          now,
          applyEmergencyHoldImpl,
        });
      }
      if (!probe.shopifyOrderId) {
        const attached = await attachOrderImpl(
          {
            probeId: probe.id,
            orderReference: normalizedOrderReference,
            actorKey: GUARD_ACTOR,
            releaseExpectation,
          },
          { prismaClient, now },
        );
        if (!attached?.ok || !attached?.probe) {
          return secureLaunch(attached?.reason || "order_attach_failed", {
            shopDomain: shop,
            prismaClient,
            env,
            now,
            applyEmergencyHoldImpl,
          });
        }
        probe = attached.probe;
      }
    }

    if (!probe.shopifyOrderId) {
      return {
        ok: true,
        active: true,
        secured: false,
        armed: true,
        probeId: probe.id,
        status: probe.status,
      };
    }

    const refreshed = await refreshProbeImpl(
      {
        probeId: probe.id,
        actorKey: GUARD_ACTOR,
        releaseExpectation,
      },
      { prismaClient, now },
    );
    if (refreshed?.ok && refreshed?.pending === false) {
      return {
        ok: true,
        active: true,
        secured: false,
        verified: true,
        probeId: refreshed.probe?.id || probe.id,
        status:
          refreshed.probe?.status || PRODUCTION_TRANSACTION_PROBE_STATUS.PASSED,
      };
    }

    const graceMinutes = boundedGraceMinutes(
      env.DOMESTIC_AUTONOMOUS_LAUNCH_SETTLEMENT_GRACE_MINUTES,
    );
    const latestProbe = refreshed?.probe || probe;
    if (
      orderAttachedAgeMs(latestProbe, now) <=
      graceMinutes * 60 * 1000
    ) {
      return {
        ok: true,
        active: true,
        secured: false,
        pending: true,
        probeId: latestProbe.id,
        status: latestProbe.status,
        reason: refreshed?.reason || latestProbe.lastErrorCode || null,
      };
    }
    return secureLaunch(
      refreshed?.reason || latestProbe.lastErrorCode || "settlement_timeout",
      {
        shopDomain: shop,
        prismaClient,
        env,
        now,
        applyEmergencyHoldImpl,
      },
    );
  } catch (error) {
    console.error("Domestic autonomous launch guard failed", {
      code: error?.code || error?.name || "guard_exception",
    });
    return secureLaunch("guard_exception", {
      shopDomain: shop,
      prismaClient,
      env,
      now,
      applyEmergencyHoldImpl,
    });
  }
}

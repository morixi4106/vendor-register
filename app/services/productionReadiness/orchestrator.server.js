import prisma from "../../db.server.js";
import { isMarketplaceSeller } from "../../utils/sellerRoles.js";
import { getMarketplaceGovernanceDashboard } from ".././marketplaceGovernance.server.js";
import {
  buildOperationalReadinessChecks,
  getPlatformOperationalControl,
  inspectOperationalReadiness,
} from ".././operationalReadiness.server.js";
import {
  buildReleaseMonitoringChecks,
  inspectReleaseMonitoringReadiness,
} from ".././releaseMonitoringReadiness.server.js";
import {
  OPEN_PAYOUT_RUN_STATUSES,
  STRIPE_ACCOUNT_PROBE_LIMIT,
  normalizeShopDomain,
  parseScopes,
  summarizeProductionReadinessChecks,
} from "./common.js";
import {
  applyReleaseDisposition,
  buildDomesticMarketplacePilotChecks,
  buildMarketplaceGovernanceChecks,
} from "./marketplace.server.js";
import { getDomesticMarketplacePilotDashboard } from "../domesticMarketplacePilot.server.js";
import {
  buildDirectReturnChecks,
  buildWithdrawalOperationChecks,
  inspectDirectReturnReadiness,
  inspectWithdrawalOperations,
} from "./withdrawals.server.js";
import {
  buildLaunchIntegrityChecks,
  inspectLaunchIntegrity,
} from "./launchIntegrity.server.js";
import {
  buildEnvironmentChecks,
  inspectOperationEnvironment,
  inspectStripeEnvironment,
} from "./environment.server.js";
import { buildShopifyChecks } from "./shopify.server.js";
import {
  buildPayoutChecks,
  buildSellerChecks,
  getPlatformStripeAccount,
  probeConnectedAccounts,
} from "./sellers.server.js";
import {
  buildProductShippingProfileChecks,
  buildShopifyProductSyncChecks,
  inspectProductShippingProfiles,
  inspectShopifyProductSync,
} from "./products.server.js";
import {
  buildPaymentOperationChecks,
  inspectPaymentOperationReadiness,
} from "./payments.server.js";
export {
  includeCheckoutGateInProductionReadiness,
  includeCheckoutValidationInProductionReadiness,
} from "./checkoutControls.server.js";
export async function getProductionReadiness({
  prismaClient = prisma,
  env = process.env,
  now = new Date(),
  shopDomain = null,
} = {}) {
  const normalizedShopDomain = normalizeShopDomain(shopDomain);
  const stripeEnv = inspectStripeEnvironment(env);
  const operationEnv = inspectOperationEnvironment(env);
  const stripeConnectProductionEnabled =
    operationEnv.stripeConnectProductionEnabled;
  const [sessions, targetOfflineSession, sellerRows, platformStripeAccount] =
    await Promise.all([
      prismaClient.session.findMany({
        where: {
          isOnline: false,
        },
        select: {
          id: true,
          shop: true,
          scope: true,
        },
      }),
      normalizedShopDomain
        ? prismaClient.session.findFirst({
            where: {
              isOnline: false,
              shop: normalizedShopDomain,
            },
            select: {
              id: true,
              shop: true,
              scope: true,
            },
          })
        : Promise.resolve(null),
      prismaClient.seller.findMany({
        orderBy: [
          {
            createdAt: "desc",
          },
        ],
        include: {
          vendor: {
            include: {
              vendorStore: true,
            },
          },
          stripeAccount: true,
          payoutRecipient: true,
          payoutRuns: {
            where: {
              status: {
                in: OPEN_PAYOUT_RUN_STATUSES,
              },
            },
            select: {
              id: true,
              status: true,
              amount: true,
              currencyCode: true,
              createdAt: true,
            },
          },
        },
      }),
      stripeConnectProductionEnabled
        ? getPlatformStripeAccount(stripeEnv)
        : Promise.resolve({
            ok: false,
            reason: "stripe_connect_not_enabled",
          }),
    ]);
  const withdrawalOperations = await inspectWithdrawalOperations({
    prismaClient,
  });
  const [operationalReadiness, platformOperationalControl, releaseMonitoring] =
    await Promise.all([
      inspectOperationalReadiness({
        prismaClient,
        now,
        env,
      }),
      getPlatformOperationalControl({
        prismaClient,
      }),
      inspectReleaseMonitoringReadiness({
        prismaClient,
        now,
        env,
      }),
    ]);
  const marketplaceSellerRows = sellerRows.filter(isMarketplaceSeller);
  const directReturns = await inspectDirectReturnReadiness({
    prismaClient,
  });
  const launchIntegrity = await inspectLaunchIntegrity({
    prismaClient,
    sellerRows: marketplaceSellerRows,
    now,
  });
  const shopifyProductSync = await inspectShopifyProductSync({
    prismaClient,
    shopDomain: normalizedShopDomain,
  });
  const productShippingProfiles = await inspectProductShippingProfiles({
    prismaClient,
    now,
  });
  const paymentOperations = await inspectPaymentOperationReadiness({
    prismaClient,
    now,
  });
  let marketplaceGovernance;
  let domesticMarketplacePilot;
  const governanceModelsAvailable = Boolean(
    prismaClient?.sellerComplianceProfile?.findMany &&
    prismaClient?.productComplianceProfile?.findMany &&
    prismaClient?.marketplaceOperationalCase?.findMany,
  );
  try {
    if (!governanceModelsAvailable) {
      marketplaceGovernance = {
        available: false,
        errorCode: "models_unavailable",
      };
    } else {
      marketplaceGovernance = {
        available: true,
        ...(await getMarketplaceGovernanceDashboard({
          prismaClient,
          env,
        })),
      };
    }
  } catch (error) {
    console.error("marketplace governance readiness inspection failed:", error);
    marketplaceGovernance = {
      available: false,
      errorCode: error?.code || "inspection_failed",
    };
  }
  try {
    if (!prismaClient?.domesticMarketplacePilot?.findMany) {
      domesticMarketplacePilot = {
        available: false,
        errorCode: "models_unavailable",
      };
    } else {
      domesticMarketplacePilot = {
        available: true,
        ...(await getDomesticMarketplacePilotDashboard({
          prismaClient,
          env,
          now,
        })),
      };
    }
  } catch (error) {
    console.error("domestic marketplace pilot inspection failed:", error);
    domesticMarketplacePilot = {
      available: false,
      errorCode: error?.code || "inspection_failed",
    };
  }
  const connectedAccountProbe = stripeConnectProductionEnabled
    ? await probeConnectedAccounts({
        stripeEnv,
        sellerRows: marketplaceSellerRows,
      })
    : [];
  const configuredScopes = parseScopes(env.SCOPES);
  const grantedScopes = parseScopes(targetOfflineSession?.scope);
  const rawChecks = [
    ...buildEnvironmentChecks({
      stripeEnv,
      env,
      operationEnv,
    }),
    ...buildPaymentOperationChecks({
      inspection: paymentOperations,
      operationEnv,
    }),
    ...buildWithdrawalOperationChecks({
      withdrawalOperations,
    }),
    ...buildDirectReturnChecks({
      directReturns,
    }),
    ...buildLaunchIntegrityChecks({
      launchIntegrity,
      env,
    }),
    ...buildShopifyProductSyncChecks(shopifyProductSync),
    ...buildProductShippingProfileChecks(productShippingProfiles),
    ...buildMarketplaceGovernanceChecks({
      governance: marketplaceGovernance,
      env,
    }),
    ...buildDomesticMarketplacePilotChecks({
      pilotDashboard: domesticMarketplacePilot,
      env,
    }),
    ...buildOperationalReadinessChecks({
      inspection: operationalReadiness,
      control: platformOperationalControl,
    }),
    ...buildReleaseMonitoringChecks(releaseMonitoring, { env }),
    ...buildShopifyChecks({
      configuredScopes,
      grantedScopes,
    }),
    ...buildSellerChecks({
      sellerRows: marketplaceSellerRows,
      connectedAccountProbe,
      operationEnv,
    }),
    ...buildPayoutChecks({
      env,
      operationEnv,
    }),
  ];
  const releaseSummary = summarizeProductionReadinessChecks(
    rawChecks.map((check) =>
      applyReleaseDisposition(check, {
        env,
        operationEnv,
        directReturns,
      }),
    ),
  );
  return {
    generatedAt: new Date(),
    canGoLive: releaseSummary.canGoLive,
    codeCanGoLive: releaseSummary.codeCanGoLive,
    summary: releaseSummary.summary,
    operation: {
      paymentFlow: `${operationEnv.paymentProviders.join("+")}_${operationEnv.sellerPayoutProvider}_payout`,
      paymentFlowLabel: `${operationEnv.paymentProviderLabel} + ${operationEnv.sellerPayoutProviderLabel}`,
      paymentProvider: operationEnv.paymentProvider,
      paymentProviders: operationEnv.paymentProviders,
      paymentProviderLabel: operationEnv.paymentProviderLabel,
      sellerPayoutProvider: operationEnv.sellerPayoutProvider,
      sellerPayoutProviderLabel: operationEnv.sellerPayoutProviderLabel,
      stripeConnectProductionEnabled,
    },
    stripe: {
      mode: stripeEnv.isLive ? "live" : stripeEnv.isTest ? "test" : "unknown",
      secretKeyMode: stripeEnv.secretKeyMode,
      publishableKeyMode: stripeEnv.publishableKeyMode,
      platformAccount: platformStripeAccount,
    },
    shopify: {
      configuredScopes,
      grantedScopes,
      evaluatedShopDomain: normalizedShopDomain || null,
      offlineSessionFound: Boolean(targetOfflineSession),
      productSync: shopifyProductSync,
      offlineSessionShops: sessions
        .map((session) => session.shop)
        .filter(Boolean),
    },
    sellers: {
      totalCount: marketplaceSellerRows.length,
      activeCount: marketplaceSellerRows.filter(
        (seller) => seller.status === "active",
      ).length,
      testStoreCount: launchIntegrity.testStores.count,
      connectedAccountProbe,
      probeLimit: STRIPE_ACCOUNT_PROBE_LIMIT,
    },
    integrity: launchIntegrity,
    paymentOperations,
    marketplaceGovernance,
    domesticMarketplacePilot,
    operationalReadiness,
    releaseMonitoring,
    platformOperationalControl,
    withdrawals: {
      ...withdrawalOperations,
      directReturns,
    },
    checks: releaseSummary.checks,
  };
}

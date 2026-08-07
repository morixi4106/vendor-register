import prisma from "../../db.server.js";
import { isMarketplaceSeller } from "../../utils/sellerRoles.js";
import { getMarketplaceGovernanceDashboard } from ".././marketplaceGovernance.server.js";
import { buildOperationalReadinessChecks, getPlatformOperationalControl, inspectOperationalReadiness } from ".././operationalReadiness.server.js";
import { buildProductionReleaseExpectation, inspectProductionReleaseEvidence } from ".././productionRelease.server.js";
import { buildReleaseMonitoringChecks, inspectReleaseMonitoringReadiness } from ".././releaseMonitoringReadiness.server.js";
import { OPEN_PAYOUT_RUN_STATUSES, STRIPE_ACCOUNT_PROBE_LIMIT, normalizeShopDomain, parseScopes, summarizeProductionReadinessChecks } from "./common.js";
import { applyReleaseDisposition, buildMarketplaceGovernanceChecks } from "./marketplace.server.js";
import { buildDirectReturnChecks, buildWithdrawalOperationChecks, inspectDirectReturnReadiness, inspectWithdrawalOperations } from "./withdrawals.server.js";
import { buildLaunchIntegrityChecks, inspectLaunchIntegrity } from "./launchIntegrity.server.js";
import { buildEnvironmentChecks, inspectOperationEnvironment, inspectStripeEnvironment } from "./environment.server.js";
import { buildShopifyChecks } from "./shopify.server.js";
import { buildPayoutChecks, buildSellerChecks, getPlatformStripeAccount, probeConnectedAccounts } from "./sellers.server.js";
import { buildProductShippingProfileChecks, buildShopifyProductSyncChecks, inspectProductShippingProfiles, inspectShopifyProductSync } from "./products.server.js";
import { buildPaymentOperationChecks, inspectPaymentOperationReadiness } from "./payments.server.js";
export async function getProductionReadiness({
  prismaClient = prisma,
  env = process.env,
  now = new Date(),
  shopDomain = null
} = {}) {
  const normalizedShopDomain = normalizeShopDomain(shopDomain);
  const stripeEnv = inspectStripeEnvironment(env);
  const operationEnv = inspectOperationEnvironment(env);
  const stripeConnectProductionEnabled = operationEnv.stripeConnectProductionEnabled;
  const [sessions, targetOfflineSession, sellerRows, platformStripeAccount] = await Promise.all([prismaClient.session.findMany({
    where: {
      isOnline: false
    },
    select: {
      id: true,
      shop: true,
      scope: true
    }
  }), normalizedShopDomain ? prismaClient.session.findFirst({
    where: {
      isOnline: false,
      shop: normalizedShopDomain
    },
    select: {
      id: true,
      shop: true,
      scope: true
    }
  }) : Promise.resolve(null), prismaClient.seller.findMany({
    orderBy: [{
      createdAt: "desc"
    }],
    include: {
      vendor: {
        include: {
          vendorStore: true
        }
      },
      stripeAccount: true,
      payoutRecipient: true,
      payoutRuns: {
        where: {
          status: {
            in: OPEN_PAYOUT_RUN_STATUSES
          }
        },
        select: {
          id: true,
          status: true,
          amount: true,
          currencyCode: true,
          createdAt: true
        }
      }
    }
  }), stripeConnectProductionEnabled ? getPlatformStripeAccount(stripeEnv) : Promise.resolve({
    ok: false,
    reason: "stripe_connect_not_enabled"
  })]);
  const withdrawalOperations = await inspectWithdrawalOperations({
    prismaClient
  });
  const [operationalReadiness, platformOperationalControl, releaseMonitoring] = await Promise.all([inspectOperationalReadiness({
    prismaClient,
    now,
    env
  }), getPlatformOperationalControl({
    prismaClient
  }), inspectReleaseMonitoringReadiness({
    prismaClient,
    now,
    env
  })]);
  const marketplaceSellerRows = sellerRows.filter(isMarketplaceSeller);
  const directReturns = await inspectDirectReturnReadiness({
    prismaClient
  });
  const launchIntegrity = await inspectLaunchIntegrity({
    prismaClient,
    sellerRows: marketplaceSellerRows,
    now
  });
  const shopifyProductSync = await inspectShopifyProductSync({
    prismaClient
  });
  const productShippingProfiles = await inspectProductShippingProfiles({
    prismaClient,
    now
  });
  const paymentOperations = await inspectPaymentOperationReadiness({
    prismaClient,
    now
  });
  let marketplaceGovernance;
  const governanceModelsAvailable = Boolean(prismaClient?.sellerComplianceProfile?.findMany && prismaClient?.productComplianceProfile?.findMany && prismaClient?.marketplaceOperationalCase?.findMany);
  try {
    if (!governanceModelsAvailable) {
      marketplaceGovernance = {
        available: false,
        errorCode: "models_unavailable"
      };
    } else {
      marketplaceGovernance = {
        available: true,
        ...(await getMarketplaceGovernanceDashboard({
          prismaClient,
          env
        }))
      };
    }
  } catch (error) {
    console.error("marketplace governance readiness inspection failed:", error);
    marketplaceGovernance = {
      available: false,
      errorCode: error?.code || "inspection_failed"
    };
  }
  const connectedAccountProbe = stripeConnectProductionEnabled ? await probeConnectedAccounts({
    stripeEnv,
    sellerRows: marketplaceSellerRows
  }) : [];
  const configuredScopes = parseScopes(env.SCOPES);
  const grantedScopes = parseScopes(targetOfflineSession?.scope);
  const rawChecks = [...buildEnvironmentChecks({
    stripeEnv,
    env,
    operationEnv
  }), ...buildPaymentOperationChecks({
    inspection: paymentOperations,
    operationEnv
  }), ...buildWithdrawalOperationChecks({
    withdrawalOperations
  }), ...buildDirectReturnChecks({
    directReturns
  }), ...buildLaunchIntegrityChecks({
    launchIntegrity,
    env
  }), ...buildShopifyProductSyncChecks(shopifyProductSync), ...buildProductShippingProfileChecks(productShippingProfiles), ...buildMarketplaceGovernanceChecks({
    governance: marketplaceGovernance,
    env
  }), ...buildOperationalReadinessChecks({
    inspection: operationalReadiness,
    control: platformOperationalControl
  }), ...buildReleaseMonitoringChecks(releaseMonitoring), ...buildShopifyChecks({
    configuredScopes,
    grantedScopes
  }), ...buildSellerChecks({
    sellerRows: marketplaceSellerRows,
    connectedAccountProbe,
    operationEnv
  }), ...buildPayoutChecks({
    env,
    operationEnv
  })];
  const releaseSummary = summarizeProductionReadinessChecks(rawChecks.map(check => applyReleaseDisposition(check, {
    env,
    operationEnv,
    directReturns
  })));
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
      stripeConnectProductionEnabled
    },
    stripe: {
      mode: stripeEnv.isLive ? "live" : stripeEnv.isTest ? "test" : "unknown",
      secretKeyMode: stripeEnv.secretKeyMode,
      publishableKeyMode: stripeEnv.publishableKeyMode,
      platformAccount: platformStripeAccount
    },
    shopify: {
      configuredScopes,
      grantedScopes,
      evaluatedShopDomain: normalizedShopDomain || null,
      offlineSessionFound: Boolean(targetOfflineSession),
      productSync: shopifyProductSync,
      offlineSessionShops: sessions.map(session => session.shop).filter(Boolean)
    },
    sellers: {
      totalCount: marketplaceSellerRows.length,
      activeCount: marketplaceSellerRows.filter(seller => seller.status === "active").length,
      testStoreCount: launchIntegrity.testStores.count,
      connectedAccountProbe,
      probeLimit: STRIPE_ACCOUNT_PROBE_LIMIT
    },
    integrity: launchIntegrity,
    paymentOperations,
    marketplaceGovernance,
    operationalReadiness,
    releaseMonitoring,
    platformOperationalControl,
    withdrawals: {
      ...withdrawalOperations,
      directReturns
    },
    checks: releaseSummary.checks
  };
}
export function includeCheckoutGateInProductionReadiness(readiness, checkoutGate) {
  const gateReady = Boolean(checkoutGate?.available === true && checkoutGate?.active === true && checkoutGate?.publicationConfigurationReady !== false && Number(checkoutGate?.exposedProductCount || 0) === 0 && Number(checkoutGate?.failedProductCount || 0) === 0);
  const checkoutGateCheck = {
    id: "marketplace_checkout_publication_boundary",
    category: "shopify",
    status: gateReady ? "pass" : "fail",
    title: "Shopify販売チャネルの公開境界",
    detail: gateReady ? "第三者・テスト・未解決の商品は、すべての購入可能Publicationから除外されています。" : checkoutGate?.message || `公開中 ${Number(checkoutGate?.exposedProductCount || 0)}件 / 確認失敗 ${Number(checkoutGate?.failedProductCount || 0)}件 / Publication設定 ${checkoutGate?.publicationConfigurationReady === false ? "未完了" : "確認済み"}`,
    action: gateReady ? "" : "SHOPIFY_ONLINE_STORE_PUBLICATION_IDを設定し、商品カタログ同期と公開境界の有効化を再実行してください。"
  };
  const checks = [...(readiness?.checks || []).filter(check => check.id !== checkoutGateCheck.id), checkoutGateCheck];
  const releaseSummary = summarizeProductionReadinessChecks(checks);
  return {
    ...readiness,
    canGoLive: releaseSummary.canGoLive,
    codeCanGoLive: releaseSummary.codeCanGoLive,
    summary: releaseSummary.summary,
    checkoutGate,
    checks: releaseSummary.checks
  };
}
export function includeCheckoutValidationInProductionReadiness(readiness, checkoutValidation) {
  const validationReady = Boolean(checkoutValidation?.ok === true && checkoutValidation?.active === true);
  const checkoutValidationCheck = {
    id: "marketplace_checkout_server_validation",
    category: "shopify",
    status: validationReady ? "pass" : "fail",
    title: "Shopifyサーバー側の購入制御",
    detail: validationReady ? "Cart and Checkout Validation Functionが有効で、実行失敗時も購入を拒否します。" : `Shopifyの購入制御が未完成です: ${checkoutValidation?.reason || "status_unavailable"}`,
    action: validationReady ? "" : "read_validations/write_validationsを承認し、本番確認画面から購入制御を有効化してください。"
  };
  const expectedRelease = buildProductionReleaseExpectation({
    checkoutValidation
  });
  const productionRelease = inspectProductionReleaseEvidence({
    operationalReadiness: readiness?.operationalReadiness,
    expected: expectedRelease
  });
  const productionReleaseCheck = {
    id: "operational_attestation_checkout_validation_live_probe_completed",
    category: "operations",
    status: productionRelease.ready ? "pass" : "fail",
    title: "本番Function・Release Manifestの必須シナリオ実機確認",
    detail: productionRelease.ready ? `リリース ${productionRelease.manifest.releaseId} の実チェックアウト証跡が現在の稼働版と一致しています。` : `リリース証跡が現在の稼働版と一致しません: ${productionRelease.mismatches.join(", ")}`,
    action: productionRelease.ready ? "" : "SHOPIFY_APP_VERSIONを設定し、本番確認画面で必須シナリオを実行して現在のIDを記録してください。"
  };
  const checks = [...(readiness?.checks || []).filter(check => check.id !== checkoutValidationCheck.id && check.id !== productionReleaseCheck.id), productionReleaseCheck, checkoutValidationCheck];
  const releaseSummary = summarizeProductionReadinessChecks(checks);
  return {
    ...readiness,
    canGoLive: releaseSummary.canGoLive,
    codeCanGoLive: releaseSummary.codeCanGoLive,
    summary: releaseSummary.summary,
    checkoutValidation,
    productionRelease,
    checks: releaseSummary.checks
  };
}

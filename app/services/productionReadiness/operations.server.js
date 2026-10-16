import {
  inspectCheckoutCommerceContext,
  buildCheckoutCommerceScopeCheck,
} from "../checkoutCommerceContext.server.js";
import {
  getPlatformOperationalControl,
  inspectOperationalReadiness,
} from "../operationalReadiness.server.js";
import { inspectReleaseMonitoringReadiness } from "../releaseMonitoringReadiness.server.js";
import { inspectInternationalCheckoutGate, buildInternationalCheckoutGateCheck } from "../internationalCheckoutInspection.server.js";

export async function inspectReadinessOperations({ prismaClient, env, now }) {
  const checkoutContext = await inspectCheckoutCommerceContext({
    prismaClient,
    env,
    now,
  });
  const internationalChecks = checkoutContext.mode.internationalConfigured ? [buildInternationalCheckoutGateCheck(
    await inspectInternationalCheckoutGate({ shopDomain: env.SHOPIFY_PRIMARY_SHOP_DOMAIN || env.SHOPIFY_SHOP,
      prismaClient, env, now }),
  )] : [];
  const [operationalReadiness, platformOperationalControl, releaseMonitoring] =
    await Promise.all([
      inspectOperationalReadiness({ prismaClient, env, now, checkoutContext }),
      getPlatformOperationalControl({ prismaClient }),
      inspectReleaseMonitoringReadiness({ prismaClient, env, now }),
    ]);
  return {
    operationalReadiness,
    platformOperationalControl,
    releaseMonitoring,
    checkoutMode: checkoutContext.mode,
    checkoutScopeCheck: buildCheckoutCommerceScopeCheck(checkoutContext.mode),
    internationalChecks,
    productShippingProfiles: checkoutContext.shippingProfiles,
  };
}

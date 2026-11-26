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
import { createNativeReadSession } from "../internationalNativeInventory.server.js";

export async function inspectReadinessOperations({ prismaClient, env, now, shopDomain, inspectNativeScopeImpl }) {
  const graphQL = createNativeReadSession();
  const checkoutContext = await inspectCheckoutCommerceContext({
    shopDomain,
    prismaClient,
    env,
    now,
    graphQL,
    inspectNativeScopeImpl,
  });
  const internationalChecks = checkoutContext.mode.internationalConfigured
    ? [buildInternationalCheckoutGateCheck(await inspectInternationalCheckoutGate(
      { shopDomain, prismaClient, env, now }, { graphQL },
    ))] : [];
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

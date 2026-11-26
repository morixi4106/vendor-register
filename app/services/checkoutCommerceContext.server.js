import { inspectProductShippingProfiles } from "./productionReadiness/products.server.js";
import { inspectPlatformDirectCheckoutMode } from "./platformDirectCheckoutMode.server.js";
import { inspectShopifyCommerceScope } from "./shopifyCommerceScope.server.js";
import { createNativeReadSession } from "./internationalNativeInventory.server.js";

export function buildCheckoutCommerceContext(
  shippingProfiles,
  env = process.env,
  nativeScope = null,
) {
  const service = shippingProfiles?.serviceAvailability;
  const databaseAvailable =
    shippingProfiles?.available === true &&
    service?.available === true &&
    [
      shippingProfiles.airPacketCount,
      service.activeCount,
      service.requiredCountryCount,
    ].every((count) => Number.isSafeInteger(count) && count >= 0);
  const databaseInternationalConfigured =
    shippingProfiles?.internationalConfigured === true ||
    shippingProfiles?.airPacketCount > 0 ||
    service?.activeCount > 0 ||
    service?.requiredCountryCount > 0;
  const nativeAvailable =
    nativeScope?.available === true &&
    typeof nativeScope.internationalConfigured === "boolean" &&
    /^[a-f0-9]{64}$/.test(nativeScope.configHash || "");
  const available = databaseAvailable && nativeAvailable;
  const internationalConfigured =
    databaseInternationalConfigured ||
    nativeScope?.internationalConfigured === true;
  const scope = {
    available,
    internationalConfigured,
    scopeStatus: internationalConfigured
      ? "INTERNATIONAL"
      : available
        ? "DOMESTIC_ONLY"
        : "UNKNOWN",
    databaseAvailable,
    nativeAvailable,
    observedAt: nativeScope?.observedAt || null,
    nativeConfigHash: nativeAvailable ? nativeScope.configHash : null,
    reason: !databaseAvailable
      ? "checkout_database_scope_unverified"
      : !nativeAvailable
        ? nativeScope?.reason || "checkout_native_scope_unverified"
        : null,
  };
  return {
    mode: {
      ...inspectPlatformDirectCheckoutMode(env, scope),
      scopeStatus: scope.scopeStatus,
      databaseScopeAvailable: databaseAvailable,
      nativeScopeAvailable: nativeAvailable,
    },
    shippingProfiles,
    scope,
  };
}

export async function inspectCheckoutCommerceContext({
  shopDomain,
  prismaClient,
  env = process.env,
  now = new Date(),
  inspectShippingProfilesImpl = inspectProductShippingProfiles,
  inspectNativeScopeImpl = inspectShopifyCommerceScope,
  graphQL = createNativeReadSession(),
} = {}) {
  let shippingProfiles = { available: false };
  let nativeScope = null;
  const shop = String(shopDomain || "")
    .trim()
    .toLowerCase();
  try {
    shippingProfiles = await inspectShippingProfilesImpl({
      prismaClient,
      now,
      shopDomain: shop,
    });
  } catch {
    /* Preserve a positive native observation if DB inspection fails. */
  }
  if (/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    try {
      const observed = await inspectNativeScopeImpl({
        shopDomain: shop,
        graphQL,
        now,
      });
      if (observed?.shopDomain === shop) nativeScope = observed;
    } catch {
      /* A failed read cannot establish domestic-only configuration. */
    }
  }
  return buildCheckoutCommerceContext(shippingProfiles, env, nativeScope);
}

export function buildCheckoutCommerceScopeCheck(mode) {
  const ready = mode?.scopeAvailable === true && !mode.reason;
  return {
    id: "platform_direct_checkout_scope",
    category: "shopify",
    status: ready ? "pass" : "fail",
    title: "販売範囲と購入制御の整合",
    detail: ready
      ? mode.internationalConfigured
        ? "海外設定に対して検証付きの購入経路を使用します。"
        : "配送対象と購入方式を照合しました。"
      : mode?.reason === "international_sales_require_validation"
        ? "海外設定があるため、国内限定の標準チェックアウトは使用できません。"
        : "販売範囲または購入制御の設定を確認できません。",
    action: ready
      ? ""
      : "対象商品・国を確認し、海外直販には検証付き経路を使用してください。",
  };
}

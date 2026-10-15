import { inspectProductShippingProfiles } from "./productionReadiness/products.server.js";
import { inspectPlatformDirectCheckoutMode } from "./platformDirectCheckoutMode.server.js";

export function buildCheckoutCommerceContext(
  shippingProfiles,
  env = process.env,
) {
  const service = shippingProfiles?.serviceAvailability;
  const available =
    shippingProfiles?.available === true &&
    service?.available === true &&
    [
      shippingProfiles.airPacketCount,
      service.activeCount,
      service.requiredCountryCount,
    ].every((count) => Number.isSafeInteger(count) && count >= 0);
  const scope = {
    available,
    internationalConfigured:
      available &&
      (shippingProfiles.internationalConfigured === true ||
        shippingProfiles.airPacketCount > 0 ||
        service.activeCount > 0 ||
        service.requiredCountryCount > 0),
  };
  return {
    mode: inspectPlatformDirectCheckoutMode(env, scope),
    shippingProfiles,
  };
}

export async function inspectCheckoutCommerceContext({
  prismaClient,
  env = process.env,
  now = new Date(),
  inspectShippingProfilesImpl = inspectProductShippingProfiles,
} = {}) {
  try {
    return buildCheckoutCommerceContext(
      await inspectShippingProfilesImpl({ prismaClient, now }),
      env,
    );
  } catch {
    return buildCheckoutCommerceContext({ available: false }, env);
  }
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

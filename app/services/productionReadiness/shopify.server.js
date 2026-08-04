import { createCheck } from "./common.js";
const REQUIRED_OPERATIONAL_SHOPIFY_SCOPES = ["read_products", "write_products", "read_orders", "read_shipping", "write_shipping", "read_inventory", "write_inventory", "read_locations", "read_merchant_managed_fulfillment_orders", "write_merchant_managed_fulfillment_orders", "read_publications", "write_publications", "read_validations", "write_validations", "read_draft_orders", "write_draft_orders", "read_shopify_payments_disputes", "read_shopify_payments_payouts"];
export const WRITE_SCOPES_THAT_SATISFY_READ_SCOPES = {
  read_inventory: "write_inventory",
  read_merchant_managed_fulfillment_orders: "write_merchant_managed_fulfillment_orders",
  read_products: "write_products",
  read_publications: "write_publications",
  read_validations: "write_validations",
  read_draft_orders: "write_draft_orders",
  read_shipping: "write_shipping"
};
function hasGrantedShopifyScope(grantedScopes, requiredScope) {
  if (grantedScopes.includes(requiredScope)) {
    return true;
  }
  const impliedByWriteScope = WRITE_SCOPES_THAT_SATISFY_READ_SCOPES[requiredScope];
  return Boolean(impliedByWriteScope && grantedScopes.includes(impliedByWriteScope));
}
export function buildShopifyChecks({
  configuredScopes,
  grantedScopes
}) {
  const configuredMissingScopes = REQUIRED_OPERATIONAL_SHOPIFY_SCOPES.filter(scope => !configuredScopes.includes(scope));
  const grantedMissingScopes = REQUIRED_OPERATIONAL_SHOPIFY_SCOPES.filter(scope => !hasGrantedShopifyScope(grantedScopes, scope));
  return [createCheck({
    id: "shopify_configured_scopes",
    category: "shopify",
    status: configuredMissingScopes.length === 0 ? "pass" : "fail",
    title: "Shopify configured scopes",
    detail: configuredMissingScopes.length === 0 ? "SCOPES includes the operational scopes." : `Missing from SCOPES: ${configuredMissingScopes.join(", ")}`,
    action: configuredMissingScopes.length === 0 ? "" : "Update production SCOPES / Shopify config, deploy a new version, then re-authorize the app."
  }), createCheck({
    id: "shopify_granted_scopes",
    category: "shopify",
    status: grantedScopes.length > 0 && grantedMissingScopes.length === 0 ? "pass" : "fail",
    title: "Shopify granted scopes",
    detail: grantedScopes.length === 0 ? "No offline Shopify session scope was found." : grantedMissingScopes.length === 0 ? "The installed app has the operational scopes." : `Missing from installed app grant: ${grantedMissingScopes.join(", ")}`,
    action: grantedScopes.length > 0 && grantedMissingScopes.length === 0 ? "" : "Open the app in Shopify admin and approve the new permissions, or uninstall/reinstall if re-authorization does not appear."
  })];
}

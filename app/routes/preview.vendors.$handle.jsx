import { buildVendorPreviewDocumentHeaders, createAdminVendorPreviewLoader, createDisabledVendorPreviewAction, createVendorPreviewOperatorAuthorizer } from "../services/vendorPreviewAccess.server";
import { requireMarketplaceOperator } from "../utils/marketplaceOperator.server";
import { getConfiguredPrimaryShopDomain } from "../utils/shopifyAdmin.server";
import { loadVendorPreview } from "../services/vendorPreview.server.js";
const authorizeVendorPreviewOperator = createVendorPreviewOperatorAuthorizer({
  requireOperatorImpl: requireMarketplaceOperator,
  primaryShopDomain: getConfiguredPrimaryShopDomain()
});
export const meta = () => [{
  title: "Storefront Preview"
}, {
  name: "robots",
  content: "noindex,nofollow"
}];
export const headers = buildVendorPreviewDocumentHeaders;
export const loader = createAdminVendorPreviewLoader({
  authenticateAdminImpl: authorizeVendorPreviewOperator,
  loadPreviewImpl: loadVendorPreview
});
export const action = createDisabledVendorPreviewAction();
export { default } from "../components/vendors/VendorPreviewPage.jsx";

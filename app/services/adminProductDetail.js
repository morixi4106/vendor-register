export const PRODUCT_EU_STATUS_OPTIONS = [{
  value: "DISABLED",
  label: "EU販売なし"
}, {
  value: "PENDING_REVIEW",
  label: "EU審査待ち"
}, {
  value: "APPROVED_LOW_RISK",
  label: "EU低リスク承認"
}, {
  value: "REJECTED_HIGH_RISK",
  label: "EU高リスク却下"
}, {
  value: "REQUIRES_ADDITIONAL_DOCS",
  label: "追加資料待ち"
}];
export const PRODUCT_EU_STATUS_VALUES = new Set(PRODUCT_EU_STATUS_OPTIONS.map(option => option.value));

// eslint-disable-next-line no-unused-vars
export function getPublicShopifyReconnectNotice() {
  return "Shopify連携の確認が必要です。必要に応じて再接続してください。";
}

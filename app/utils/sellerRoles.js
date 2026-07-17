export const MARKETPLACE_SELLER_ROLE = "MARKETPLACE_SELLER";
export const PLATFORM_OPERATOR_ROLE = "PLATFORM_OPERATOR";

export function normalizeSellerLegalRole(value) {
  return String(value || MARKETPLACE_SELLER_ROLE)
    .trim()
    .toUpperCase();
}

export function isMarketplaceSeller(seller) {
  return (
    normalizeSellerLegalRole(seller?.sellerLegalRole) ===
    MARKETPLACE_SELLER_ROLE
  );
}

export function isPlatformOperatorSeller(seller) {
  return (
    normalizeSellerLegalRole(seller?.sellerLegalRole) === PLATFORM_OPERATOR_ROLE
  );
}

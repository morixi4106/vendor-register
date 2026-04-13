export const PRICE_SYNC_STATUS = {
  CALCULATED_NOT_APPLIED: 'calculated_not_applied',
  APPLIED: 'applied',
  INVALID: 'invalid',
  APPLY_FAILED: 'apply_failed',
};

function createPriceError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'PriceCalculationError';
  error.code = code;
  error.details = details;
  error.isPriceCalculationError = true;
  return error;
}

export function createPriceCalculationError(code, message, details = {}) {
  return createPriceError(code, message, details);
}

export function getEffectivePriceSyncStatus(product) {
  if (product?.priceSyncStatus) {
    return product.priceSyncStatus;
  }

  if (product?.priceSnapshotJson || product?.calculatedAt) {
    return PRICE_SYNC_STATUS.APPLIED;
  }

  return PRICE_SYNC_STATUS.CALCULATED_NOT_APPLIED;
}

export function getAdminPriceSyncLabel(status) {
  switch (status) {
    case PRICE_SYNC_STATUS.APPLIED:
      return 'Applied';
    case PRICE_SYNC_STATUS.INVALID:
      return 'Invalid';
    case PRICE_SYNC_STATUS.APPLY_FAILED:
      return 'Apply failed';
    case PRICE_SYNC_STATUS.CALCULATED_NOT_APPLIED:
    default:
      return 'Calculated, not applied';
  }
}

export function getVendorPriceSyncLabel(status) {
  switch (status) {
    case PRICE_SYNC_STATUS.APPLIED:
      return '価格反映済み';
    case PRICE_SYNC_STATUS.INVALID:
      return '価格要確認';
    case PRICE_SYNC_STATUS.APPLY_FAILED:
      return '反映失敗';
    case PRICE_SYNC_STATUS.CALCULATED_NOT_APPLIED:
    default:
      return '価格未反映';
  }
}

export function normalizePriceSyncFailure(error) {
  const message = error instanceof Error ? error.message : 'Price apply failed';

  if (error?.isPriceCalculationError) {
    return {
      code: error.code || 'price_calculation_error',
      status: PRICE_SYNC_STATUS.INVALID,
      message,
      needsReconnect: false,
    };
  }

  if (
    message.includes('pricing.cost_amount is empty') ||
    message.includes('costAmount must be a valid number') ||
    message.includes('costAmount must be 0 or greater') ||
    message.includes('dutyRate must be 0 or greater') ||
    message.includes('Invalid fxRate')
  ) {
    return {
      code: 'price_calculation_error',
      status: PRICE_SYNC_STATUS.INVALID,
      message,
      needsReconnect: false,
    };
  }

  if (
    message.includes('Invalid API key or access token') ||
    message.includes('Offline session not found') ||
    message.includes('401')
  ) {
    return {
      code: 'shopify_auth_error',
      status: PRICE_SYNC_STATUS.APPLY_FAILED,
      message: 'Shopify authentication is required',
      needsReconnect: true,
    };
  }

  if (
    message.includes('productVariantsBulkUpdate failed') ||
    message.includes('Shopify GraphQL request failed') ||
    message.includes('Shopify GraphQL errors') ||
    message.includes('Product not found on Shopify') ||
    message.includes('Variant not found') ||
    message.includes('Local product not found')
  ) {
    return {
      code: 'shopify_apply_error',
      status: PRICE_SYNC_STATUS.APPLY_FAILED,
      message,
      needsReconnect: false,
    };
  }

  return {
    code: 'price_apply_error',
    status: PRICE_SYNC_STATUS.APPLY_FAILED,
    message,
    needsReconnect: false,
  };
}

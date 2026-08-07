export const SELLER_STATUSES = ["pending", "active", "review", "restricted", "banned"];
export const SELLER_VERIFICATION_STATUSES = ["NONE", "PHONE_REQUIRED", "PHONE_VERIFIED", "DOCUMENT_REQUIRED", "DOCUMENT_PENDING", "VERIFIED", "REJECTED", "SUSPENDED"];
export const DOCUMENT_VERIFICATION_STATUSES = ["NONE", "PENDING", "VERIFIED", "REJECTED"];
export const SELLER_EU_STATUSES = ["DISABLED", "SELF_CERT_REQUIRED", "PHONE_REQUIRED", "ALLOWED_UNDER_SMALL_PLATFORM_POLICY", "FULL_KYBC_REQUIRED", "FULL_KYBC_APPROVED", "SUSPENDED"];
export const PAYOUT_RUN_STATUSES = ["draft", "approved", "processing", "reconciliation_required", "executed", "returned", "failed"];
export const PAYOUT_TRANSFER_METHODS = ["manual_bank_transfer", "wise_api", "stripe_connect_payout"];
export const SALES_CREDIT_OFFSET_STATUSES = ["authorized", "captured", "released", "refunded", "expired"];
export const ORDER_STATUSES = ["draft", "payment_intent_created", "paid", "refunded", "disputed", "failed"];
export const LEDGER_ENTRY_TYPES = ["charge", "shopify_order_paid", "shopify_order_cancelled", "application_fee", "application_fee_refund", "refund", "direct_customer_refund", "dispute_created", "dispute_updated", "dispute_closed", "dispute_funds_withdrawn", "dispute_funds_reinstated", "ledger_adjustment", "case_adjustment", "payout_created", "payout_paid", "payout_returned", "payout_failed", "sales_credit_offset_captured", "sales_credit_offset_refund_reversal"];
export const DEFAULT_ORDER_CURRENCY = "jpy";
export const SALES_CREDIT_SUPPORTED_CURRENCY = DEFAULT_ORDER_CURRENCY;
export const DEFAULT_SALES_CREDIT_HOLD_DAYS = 45;
export const DEFAULT_SALES_CREDIT_RISK_BUFFER_BPS = 0;
export const DEFAULT_SALES_CREDIT_LOCK_MINUTES = 30;
export const SALES_CREDIT_PAYMENT_RISK_CLASSES = Object.freeze({
  CARD_3DS_AUTHENTICATED: "card_3ds_authenticated",
  NON_CARD_CONFIRMED: "non_card_confirmed",
  SALES_CREDIT_RESTORED: "sales_credit_restored",
  CARD_UNVERIFIED: "card_unverified",
  UNKNOWN: "unknown"
});
export const SALES_CREDIT_PAYMENT_RISK_RATE_BPS = Object.freeze({
  [SALES_CREDIT_PAYMENT_RISK_CLASSES.CARD_3DS_AUTHENTICATED]: 10000,
  [SALES_CREDIT_PAYMENT_RISK_CLASSES.NON_CARD_CONFIRMED]: 10000,
  [SALES_CREDIT_PAYMENT_RISK_CLASSES.SALES_CREDIT_RESTORED]: 10000,
  [SALES_CREDIT_PAYMENT_RISK_CLASSES.CARD_UNVERIFIED]: 0,
  [SALES_CREDIT_PAYMENT_RISK_CLASSES.UNKNOWN]: 0
});

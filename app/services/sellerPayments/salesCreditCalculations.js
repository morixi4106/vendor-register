import { DEFAULT_SALES_CREDIT_HOLD_DAYS, DEFAULT_SALES_CREDIT_RISK_BUFFER_BPS, SALES_CREDIT_PAYMENT_RISK_CLASSES, SALES_CREDIT_PAYMENT_RISK_RATE_BPS } from "./constants.js";
import { clampBasisPoints, clampInteger, isPlainObject, normalizeText, subtractDays } from "./values.js";
export const SELLER_PAYOUT_LEDGER_ENTRY_SIGNS = Object.freeze({
  shopify_order_paid: 1,
  shopify_order_cancelled: -1,
  charge: 1,
  application_fee: -1,
  application_fee_refund: 1,
  refund: -1,
  dispute_created: -1,
  dispute_funds_reinstated: 1,
  ledger_adjustment: 1,
  case_adjustment: -1,
  payout_paid: -1,
  payout_returned: 1,
  sales_credit_offset_captured: -1,
  sales_credit_offset_refund_reversal: 1
});
export const SELLER_SALES_CREDIT_ENTRY_SIGNS = Object.freeze({
  ...SELLER_PAYOUT_LEDGER_ENTRY_SIGNS,
  ledger_adjustment: 0
});
const IMMEDIATE_MATURE_SALES_CREDIT_ENTRY_TYPES = new Set(["sales_credit_offset_refund_reversal", "dispute_funds_reinstated", "payout_returned"]);
export const SALES_CREDIT_OFFSET_LOCK_STATUSES = new Set(["authorized"]);
export const SALES_CREDIT_PAYOUT_LOCK_STATUSES = new Set(["draft", "approved", "processing", "reconciliation_required"]);
export function calculateSellerPayoutableLedgerBalance(entries = []) {
  if (!Array.isArray(entries)) return 0;
  return entries.reduce((total, entry) => {
    const sign = SELLER_PAYOUT_LEDGER_ENTRY_SIGNS[entry?.entryType] || 0;
    return sign === 0 ? total : total + sign * clampInteger(entry?.amount);
  }, 0);
}
export function getLedgerEntryMetadata(entry) {
  return isPlainObject(entry?.metadataJson) ? entry.metadataJson : {};
}
export function calculateSellerSalesCreditAvailability(entries = [], {
  offsetLocks = [],
  payoutRuns = [],
  now = new Date(),
  holdDays = DEFAULT_SALES_CREDIT_HOLD_DAYS,
  riskBufferBps = DEFAULT_SALES_CREDIT_RISK_BUFFER_BPS
} = {}) {
  const normalizedNow = now instanceof Date ? now : new Date(now);
  const effectiveNow = Number.isNaN(normalizedNow.getTime()) ? new Date() : normalizedNow;
  const maturityCutoff = subtractDays(effectiveNow, clampInteger(holdDays));
  const normalizedRiskBufferBps = clampInteger(riskBufferBps);
  let maturedSalesAmount = 0;
  let grossMaturedSalesAmount = 0;
  let ineligibleMaturedSalesAmount = 0;
  let pendingSalesAmount = 0;
  let deductionAmount = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const sign = SELLER_SALES_CREDIT_ENTRY_SIGNS[entry?.entryType] || 0;
    const amount = clampInteger(entry?.amount);
    if (sign > 0) {
      const occurredAt = entry?.occurredAt ? new Date(entry.occurredAt) : effectiveNow;
      const forceMature = IMMEDIATE_MATURE_SALES_CREDIT_ENTRY_TYPES.has(entry?.entryType);
      if (forceMature || !Number.isNaN(occurredAt.getTime()) && occurredAt <= maturityCutoff) {
        const riskProfile = getSalesCreditEntryRiskProfile(entry);
        const eligibleAmount = Math.floor(amount * riskProfile.rateBps / 10000);
        grossMaturedSalesAmount += amount;
        maturedSalesAmount += eligibleAmount;
        ineligibleMaturedSalesAmount += Math.max(0, amount - eligibleAmount);
      } else {
        pendingSalesAmount += amount;
      }
    } else if (sign < 0) {
      deductionAmount += amount;
    }
  }
  const riskBufferAmount = Math.ceil(pendingSalesAmount * normalizedRiskBufferBps / 10000);
  const pendingRiskReserveAmount = pendingSalesAmount + riskBufferAmount;
  const offsetLockedAmount = sumActiveSalesCreditOffsetLocks(offsetLocks, effectiveNow);
  const payoutLockedAmount = sumPayoutRunLocks(payoutRuns);
  const totalLedgerBalance = calculateSellerPayoutableLedgerBalance(entries);
  const grossAvailableAmount = maturedSalesAmount - deductionAmount - offsetLockedAmount - payoutLockedAmount;
  const cappedByLedgerAmount = totalLedgerBalance - offsetLockedAmount - payoutLockedAmount;
  const availableAmount = Math.max(0, Math.min(grossAvailableAmount, cappedByLedgerAmount));
  return {
    availableAmount,
    totalLedgerBalance,
    maturedSalesAmount,
    grossMaturedSalesAmount,
    ineligibleMaturedSalesAmount,
    pendingSalesAmount,
    riskBufferAmount,
    pendingRiskReserveAmount,
    deductionAmount,
    offsetLockedAmount,
    payoutLockedAmount,
    holdDays: clampInteger(holdDays),
    riskBufferBps: normalizedRiskBufferBps,
    maturityCutoff
  };
}
function getSalesCreditEntryRiskProfile(entry) {
  if (IMMEDIATE_MATURE_SALES_CREDIT_ENTRY_TYPES.has(entry?.entryType)) {
    return {
      riskClass: SALES_CREDIT_PAYMENT_RISK_CLASSES.SALES_CREDIT_RESTORED,
      rateBps: SALES_CREDIT_PAYMENT_RISK_RATE_BPS[SALES_CREDIT_PAYMENT_RISK_CLASSES.SALES_CREDIT_RESTORED]
    };
  }
  const metadata = getLedgerEntryMetadata(entry);
  const riskClass = normalizeText(metadata.salesCreditPaymentRiskClass) || normalizeText(metadata.paymentRiskClass) || SALES_CREDIT_PAYMENT_RISK_CLASSES.UNKNOWN;
  const configuredRate = SALES_CREDIT_PAYMENT_RISK_RATE_BPS[riskClass];
  const rateBps = configuredRate == null ? clampBasisPoints(metadata.salesCreditPaymentRiskRateBps, 0) : configuredRate;
  return {
    riskClass,
    rateBps: clampBasisPoints(rateBps, 0)
  };
}
function isActiveSalesCreditOffsetLock(offset, now) {
  if (!SALES_CREDIT_OFFSET_LOCK_STATUSES.has(offset?.status)) return false;
  if (!offset?.expiresAt) return true;
  return new Date(offset.expiresAt).getTime() > now.getTime();
}
function sumActiveSalesCreditOffsetLocks(offsets = [], now = new Date()) {
  if (!Array.isArray(offsets)) return 0;
  return offsets.reduce((total, offset) => isActiveSalesCreditOffsetLock(offset, now) ? total + clampInteger(offset?.amount) : total, 0);
}
function sumPayoutRunLocks(payoutRuns = []) {
  if (!Array.isArray(payoutRuns)) return 0;
  return payoutRuns.reduce((total, payoutRun) => SALES_CREDIT_PAYOUT_LOCK_STATUSES.has(payoutRun?.status) ? total + clampInteger(payoutRun?.amount) : total, 0);
}

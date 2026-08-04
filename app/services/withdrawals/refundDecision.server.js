import prisma from "../../db.server.js";
import { normalizeCurrencyCode, normalizeText, parseOptionalMoneyAmount } from "./common.js";
const REFUND_DECISION_STATUSES = new Set(["UNDECIDED", "FULL_REFUND", "PARTIAL_REFUND", "NO_REFUND", "RETURN_PENDING"]);
const RETURN_SHIPPING_PAYERS = new Set(["UNDECIDED", "CUSTOMER", "STORE", "LEGAL_STORE"]);
export function normalizeWithdrawalRefundDecisionFormData(formData) {
  const refundDecisionStatus = String(formData.get("refundDecisionStatus") || "UNDECIDED").trim().toUpperCase();
  const returnShippingPayer = String(formData.get("returnShippingPayer") || "UNDECIDED").trim().toUpperCase();
  const refundCurrencyCode = normalizeCurrencyCode(formData.get("refundCurrencyCode"));
  const refundItemAmount = parseOptionalMoneyAmount(formData.get("refundItemAmount"), refundCurrencyCode);
  const refundInitialShippingAmount = parseOptionalMoneyAmount(formData.get("refundInitialShippingAmount"), refundCurrencyCode);
  const refundDeductionAmount = parseOptionalMoneyAmount(formData.get("refundDeductionAmount"), refundCurrencyCode);
  const refundDecisionReason = normalizeText(formData.get("refundDecisionReason"));
  const refundDecisionNotes = normalizeText(formData.get("refundDecisionNotes"));
  const errors = {};
  if (!REFUND_DECISION_STATUSES.has(refundDecisionStatus)) {
    errors.refundDecisionStatus = "invalid_refund_decision_status";
  }
  if (!RETURN_SHIPPING_PAYERS.has(returnShippingPayer)) {
    errors.returnShippingPayer = "invalid_return_shipping_payer";
  }
  if (refundItemAmount.invalid) {
    errors.refundItemAmount = "invalid_amount";
  }
  if (refundInitialShippingAmount.invalid) {
    errors.refundInitialShippingAmount = "invalid_amount";
  }
  if (refundDeductionAmount.invalid) {
    errors.refundDeductionAmount = "invalid_amount";
  }
  const itemAmount = refundItemAmount.value;
  const initialShippingAmount = refundInitialShippingAmount.value;
  const deductionAmount = refundDeductionAmount.value;
  const hasAnyAmount = itemAmount !== null || initialShippingAmount !== null || deductionAmount !== null;
  let refundTotalAmount = null;
  if (refundDecisionStatus === "NO_REFUND") {
    refundTotalAmount = 0;
  } else if (hasAnyAmount) {
    refundTotalAmount = Math.max(0, (itemAmount || 0) + (initialShippingAmount || 0) - (deductionAmount || 0));
  }
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    values: {
      refundDecisionStatus,
      refundItemAmount: itemAmount,
      refundInitialShippingAmount: initialShippingAmount,
      refundDeductionAmount: deductionAmount,
      refundTotalAmount,
      refundCurrencyCode,
      returnShippingPayer,
      refundDecisionReason,
      refundDecisionNotes
    }
  };
}
export async function updateWithdrawalRefundDecision({
  id,
  formData,
  changedBy = "admin",
  prismaClient = prisma
} = {}) {
  const normalized = normalizeWithdrawalRefundDecisionFormData(formData);
  if (!normalized.ok) {
    return {
      ok: false,
      status: 400,
      error: "invalid_refund_decision",
      errors: normalized.errors
    };
  }
  const current = await prismaClient.withdrawalRequest.findUnique({
    where: {
      id
    }
  });
  if (!current) {
    return {
      ok: false,
      status: 404,
      error: "not_found"
    };
  }
  const values = normalized.values;
  const now = new Date();
  const updated = await prismaClient.$transaction(async tx => {
    const next = await tx.withdrawalRequest.update({
      where: {
        id
      },
      data: {
        ...values,
        refundDecisionUpdatedAt: now,
        refundDecisionUpdatedBy: changedBy
      }
    });
    await tx.withdrawalRequestStatusHistory.create({
      data: {
        withdrawalRequestId: id,
        fromStatus: current.status,
        toStatus: current.status,
        changedBy,
        reason: "refund_decision_updated",
        metadataJson: {
          refundDecision: values
        }
      }
    });
    return next;
  });
  return {
    ok: true,
    withdrawalRequest: updated
  };
}

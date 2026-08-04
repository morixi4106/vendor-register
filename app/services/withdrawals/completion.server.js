import prisma from "../../db.server.js";
import { WITHDRAWAL_STATUSES } from "../../utils/withdrawalStatus.js";
import { isAllowedWithdrawalStatusTransition, normalizeCurrencyCode, normalizeText, parseOptionalMoneyAmount } from "./common.js";
const COMPLETION_STATUSES = new Set(["UNDECIDED", "REFUNDED", "PARTIALLY_REFUNDED", "CANCELLED", "NO_REFUND_CLOSED", "REJECTED_CLOSED", "MANUAL_CLOSED"]);
export function normalizeWithdrawalCompletionFormData(formData) {
  const completionStatus = String(formData.get("completionStatus") || "UNDECIDED").trim().toUpperCase();
  const completionAction = normalizeText(formData.get("completionAction"));
  const completionShopifyRefundId = normalizeText(formData.get("completionShopifyRefundId"));
  const completionShopifyCancelId = normalizeText(formData.get("completionShopifyCancelId"));
  const completionCurrencyCode = normalizeCurrencyCode(formData.get("completionCurrencyCode"));
  const completionRefundedAmount = parseOptionalMoneyAmount(formData.get("completionRefundedAmount"), completionCurrencyCode);
  const completionRefundedShipping = parseOptionalMoneyAmount(formData.get("completionRefundedShipping"), completionCurrencyCode);
  const completionNotes = normalizeText(formData.get("completionNotes"));
  const errors = {};
  if (!COMPLETION_STATUSES.has(completionStatus)) {
    errors.completionStatus = "invalid_completion_status";
  }
  if (completionRefundedAmount.invalid) {
    errors.completionRefundedAmount = "invalid_amount";
  }
  if (completionRefundedShipping.invalid) {
    errors.completionRefundedShipping = "invalid_amount";
  }
  if (["REFUNDED", "PARTIALLY_REFUNDED"].includes(completionStatus) && completionRefundedAmount.value === null) {
    errors.completionRefundedAmount = "required_for_refunded_completion";
  }
  if (["NO_REFUND_CLOSED", "REJECTED_CLOSED"].includes(completionStatus) && !completionAction && !completionNotes) {
    errors.completionNotes = "reason_required_for_closed_completion";
  }
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    values: {
      completionStatus,
      completionAction,
      completionShopifyRefundId,
      completionShopifyCancelId,
      completionRefundedAmount: ["NO_REFUND_CLOSED", "REJECTED_CLOSED"].includes(completionStatus) && completionRefundedAmount.value === null ? 0 : completionRefundedAmount.value,
      completionRefundedShipping: completionRefundedShipping.value,
      completionCurrencyCode,
      completionNotes
    }
  };
}
export async function updateWithdrawalCompletionRecord({
  id,
  formData,
  changedBy = "admin",
  prismaClient = prisma
} = {}) {
  const normalized = normalizeWithdrawalCompletionFormData(formData);
  if (!normalized.ok) {
    return {
      ok: false,
      status: 400,
      error: "invalid_completion_record",
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
  const currentCompletionStatus = String(current.completionStatus || "UNDECIDED").toUpperCase();
  if (currentCompletionStatus !== "UNDECIDED" && values.completionStatus === "UNDECIDED") {
    return {
      ok: false,
      status: 400,
      error: "completion_reset_not_allowed"
    };
  }
  const now = new Date();
  const nextStatus = mapCompletionStatusToWithdrawalStatus(values.completionStatus, current.status);
  if (!isAllowedWithdrawalStatusTransition(current.status, nextStatus)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_completion_status_transition"
    };
  }
  const shouldMarkCompleted = values.completionStatus !== "UNDECIDED";
  const updated = await prismaClient.$transaction(async tx => {
    const next = await tx.withdrawalRequest.update({
      where: {
        id
      },
      data: {
        ...values,
        status: nextStatus,
        completedAt: shouldMarkCompleted ? current.completedAt || now : null,
        completionRecordedAt: shouldMarkCompleted ? now : null,
        completionRecordedBy: shouldMarkCompleted ? changedBy : null
      }
    });
    await tx.withdrawalRequestStatusHistory.create({
      data: {
        withdrawalRequestId: id,
        fromStatus: current.status,
        toStatus: nextStatus,
        changedBy,
        reason: "completion_recorded",
        metadataJson: {
          completion: values
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
function mapCompletionStatusToWithdrawalStatus(completionStatus, currentStatus) {
  switch (String(completionStatus || "UNDECIDED").toUpperCase()) {
    case "REFUNDED":
    case "PARTIALLY_REFUNDED":
      return WITHDRAWAL_STATUSES.REFUNDED;
    case "CANCELLED":
      return WITHDRAWAL_STATUSES.CANCELLED;
    case "NO_REFUND_CLOSED":
    case "REJECTED_CLOSED":
      return WITHDRAWAL_STATUSES.REJECTED;
    case "MANUAL_CLOSED":
    case "UNDECIDED":
    default:
      return currentStatus || WITHDRAWAL_STATUSES.UNDER_REVIEW;
  }
}

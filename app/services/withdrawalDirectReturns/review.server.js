import prisma from "../../db.server.js";
import { TERMINAL_OUTCOMES, jsonObject, recomputeWithdrawalV2State, text } from "./common.js";
export async function updateWithdrawalGroupReview({
  returnGroupId,
  values,
  changedBy = "admin",
  vendorStoreId = null,
  allowFinancialDecision = true,
  prismaClient = prisma
} = {}) {
  const group = await prismaClient.withdrawalReturnGroup.findFirst({
    where: {
      id: text(returnGroupId),
      ...(vendorStoreId ? {
        vendorStoreId: text(vendorStoreId)
      } : {})
    },
    include: {
      lines: true
    }
  });
  if (!group) return {
    ok: false,
    status: 404,
    error: "return_group_not_found"
  };
  const allowed = {
    evidenceStatus: new Set(["NOT_SUBMITTED", "SUBMITTED", "ACCEPTED", "REJECTED"]),
    receiptStatus: new Set(["NOT_RECEIVED", "PARTIALLY_RECEIVED", "RECEIVED"]),
    inspectionStatus: new Set(["NOT_INSPECTED", "IN_PROGRESS", "INSPECTED", "VALUE_REDUCTION_REVIEW"]),
    ...(allowFinancialDecision ? {
      refundDecisionStatus: new Set(["UNDECIDED", "FULL_REFUND", "PARTIAL_REFUND", "NO_REFUND"]),
      outcomeStatus: new Set(["UNDECIDED", "FULL_REFUND", "PARTIAL_REFUND", "NO_REFUND", "CANCELLED"])
    } : {})
  };
  const data = {};
  for (const [key, options] of Object.entries(allowed)) {
    const value = text(values[key]).toUpperCase();
    if (value && options.has(value)) data[key] = value;
  }
  if (allowFinancialDecision) {
    const itemRefundBaseAmount = Math.max(0, Number(values.itemRefundBaseAmount ?? group.itemRefundBaseAmount));
    const deductionAmount = Math.max(0, Number(values.deductionAmount ?? group.deductionAmount));
    if (deductionAmount > 0 && !text(values.deductionReason)) {
      return {
        ok: false,
        status: 400,
        error: "deduction_reason_required"
      };
    }
    data.itemRefundBaseAmount = itemRefundBaseAmount;
    data.deductionAmount = deductionAmount;
    data.itemRefundNetAmount = Math.max(0, itemRefundBaseAmount - deductionAmount);
    data.plannedRefundAmount = data.itemRefundNetAmount;
  }
  data.metadataJson = {
    ...jsonObject(group.metadataJson),
    deductionReason: text(values.deductionReason) || null,
    reviewNotes: text(values.reviewNotes) || null,
    reviewedBy: changedBy,
    reviewedAt: new Date().toISOString()
  };
  if (TERMINAL_OUTCOMES.has(data.outcomeStatus)) data.completedAt = new Date();
  const lineReviews = Array.isArray(values.lineReviews) ? values.lineReviews : [];
  await prismaClient.$transaction(async tx => {
    await tx.withdrawalReturnGroup.update({
      where: {
        id: group.id
      },
      data
    });
    for (const review of lineReviews) {
      const line = group.lines.find(item => item.id === text(review.id));
      if (!line) continue;
      const receivedQuantity = Math.max(0, Math.min(Number(line.instructedQuantity || 0), Number(review.receivedQuantity || 0)));
      const missingQuantity = Math.max(0, Number(line.instructedQuantity || 0) - receivedQuantity);
      const conditionStatus = text(review.conditionStatus).toUpperCase();
      const allowedConditions = new Set(["UNDECIDED", "UNUSED_OK", "OPENED_OK", "USED_REVIEW", "DIRTY_REVIEW", "DAMAGED_REVIEW", "EXEMPT_REVIEW"]);
      await tx.withdrawalReturnGroupLine.update({
        where: {
          id: line.id
        },
        data: {
          receivedQuantity,
          missingQuantity,
          ...(allowedConditions.has(conditionStatus) ? {
            conditionStatus
          } : {}),
          conditionNotes: text(review.conditionNotes) || null
        }
      });
    }
  });
  await recomputeWithdrawalV2State(group.withdrawalRequestId, prismaClient);
  return {
    ok: true
  };
}
export async function updateWithdrawalContractShippingDecision({
  withdrawalContractId,
  status,
  amount,
  reason = null,
  changedBy = "admin",
  prismaClient = prisma
} = {}) {
  const contract = await prismaClient.withdrawalContract.findUnique({
    where: {
      id: text(withdrawalContractId)
    }
  });
  if (!contract) return {
    ok: false,
    status: 404,
    error: "withdrawal_contract_not_found"
  };
  const normalizedStatus = text(status).toUpperCase();
  if (!["UNDECIDED", "REFUND_STANDARD", "NOT_REFUNDABLE", "ALREADY_ALLOCATED"].includes(normalizedStatus)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_shipping_refund_status"
    };
  }
  const shippingAmount = Math.max(0, Math.trunc(Number(amount || 0)));
  await prismaClient.withdrawalContract.update({
    where: {
      id: contract.id
    },
    data: {
      initialShippingRefundStatus: normalizedStatus,
      initialShippingRefundAmount: shippingAmount,
      initialShippingRefundReason: text(reason) || null,
      metadataJson: {
        ...jsonObject(contract.metadataJson),
        shippingDecisionBy: changedBy,
        shippingDecisionAt: new Date().toISOString()
      }
    }
  });
  await recomputeWithdrawalV2State(contract.withdrawalRequestId, prismaClient);
  return {
    ok: true
  };
}
export async function releaseWithdrawalLineReservations({
  withdrawalRequestId,
  requestedLineIds = null,
  prismaClient = prisma
} = {}) {
  const where = {
    withdrawalRequestId,
    ...(Array.isArray(requestedLineIds) && requestedLineIds.length ? {
      id: {
        in: requestedLineIds
      }
    } : {})
  };
  const lines = await prismaClient.withdrawalRequestedLine.findMany({
    where
  });
  await prismaClient.$transaction(lines.map(line => prismaClient.withdrawalRequestedLine.update({
    where: {
      id: line.id
    },
    data: {
      releasedQuantity: Math.max(line.releasedQuantity, line.reservedQuantity - line.approvedQuantity)
    }
  })));
  return {
    ok: true,
    releasedLineCount: lines.length
  };
}

import prisma from "../../db.server.js";
import { WITHDRAWAL_STATUSES } from "../../utils/withdrawalStatus.js";
import { isAllowedWithdrawalStatusTransition } from "./common.js";
export async function updateWithdrawalStatus({
  id,
  toStatus,
  changedBy = "admin",
  reason = null,
  metadataJson = null,
  adminNotes = null,
  rejectionReason = null,
  prismaClient = prisma
} = {}) {
  const nextStatus = String(toStatus || "").trim().toUpperCase();
  if (!Object.values(WITHDRAWAL_STATUSES).includes(nextStatus)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_status"
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
  if (!isAllowedWithdrawalStatusTransition(current.status, nextStatus)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_status_transition"
    };
  }
  if ([WITHDRAWAL_STATUSES.REJECTED, WITHDRAWAL_STATUSES.EXPIRED].includes(nextStatus) && !reason && !rejectionReason) {
    return {
      ok: false,
      status: 400,
      error: "reason_required_for_closing_status"
    };
  }
  const now = new Date();
  const data = {
    status: nextStatus
  };
  if (typeof adminNotes === "string") {
    data.adminNotes = adminNotes;
  }
  if (nextStatus === WITHDRAWAL_STATUSES.REJECTED) {
    data.rejectedAt = now;
    data.rejectionReason = rejectionReason || reason || current.rejectionReason;
    data.decisionSentAt = now;
  }
  if (nextStatus === WITHDRAWAL_STATUSES.APPROVED || nextStatus === WITHDRAWAL_STATUSES.REFUND_PENDING) {
    data.decisionSentAt = now;
  }
  if (nextStatus === WITHDRAWAL_STATUSES.REFUNDED || nextStatus === WITHDRAWAL_STATUSES.CANCELLED) {
    data.completedAt = now;
  }
  if (nextStatus === WITHDRAWAL_STATUSES.RETURN_REQUESTED && String(current.returnRequirementStatus || "UNDECIDED").toUpperCase() === "UNDECIDED") {
    data.returnRequirementStatus = "WAITING";
    data.returnInfoUpdatedAt = now;
    data.returnInfoUpdatedBy = changedBy;
  }
  if (nextStatus === WITHDRAWAL_STATUSES.RETURN_RECEIVED && !["RECEIVED", "CONDITION_CHECKED"].includes(String(current.returnRequirementStatus || "UNDECIDED").toUpperCase())) {
    data.returnRequirementStatus = "RECEIVED";
    data.returnReceivedAt = current.returnReceivedAt || now;
    data.returnInfoUpdatedAt = now;
    data.returnInfoUpdatedBy = changedBy;
  }
  const updated = await prismaClient.$transaction(async tx => {
    const next = await tx.withdrawalRequest.update({
      where: {
        id
      },
      data
    });
    await tx.withdrawalRequestStatusHistory.create({
      data: {
        withdrawalRequestId: id,
        fromStatus: current.status,
        toStatus: nextStatus,
        changedBy,
        reason,
        metadataJson
      }
    });
    return next;
  });
  return {
    ok: true,
    withdrawalRequest: updated
  };
}

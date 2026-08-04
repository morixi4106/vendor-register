import prisma from "../../db.server.js";
import { URL_PATTERN, normalizeText, parseDateInput } from "./common.js";
const RETURN_REQUIREMENT_STATUSES = new Set(["UNDECIDED", "NOT_REQUIRED", "REQUIRED", "WAITING", "IN_TRANSIT", "RECEIVED", "CONDITION_CHECKED"]);
const RETURN_CONDITION_STATUSES = new Set(["UNDECIDED", "NOT_APPLICABLE", "UNUSED_OK", "OPENED_OK", "USED_REVIEW", "DIRTY_REVIEW", "DAMAGED_REVIEW", "EXEMPT_REVIEW"]);
export function normalizeWithdrawalReturnInfoFormData(formData) {
  const returnRequirementStatus = String(formData.get("returnRequirementStatus") || "UNDECIDED").trim().toUpperCase();
  const returnConditionStatus = String(formData.get("returnConditionStatus") || "UNDECIDED").trim().toUpperCase();
  const returnTrackingCompany = normalizeText(formData.get("returnTrackingCompany"));
  const returnTrackingNumber = normalizeText(formData.get("returnTrackingNumber"));
  const returnTrackingUrl = normalizeText(formData.get("returnTrackingUrl"));
  const returnReceivedAt = parseDateInput(formData.get("returnReceivedAt"));
  const returnConditionNotes = normalizeText(formData.get("returnConditionNotes"));
  const errors = {};
  if (!RETURN_REQUIREMENT_STATUSES.has(returnRequirementStatus)) {
    errors.returnRequirementStatus = "invalid_return_requirement_status";
  }
  if (!RETURN_CONDITION_STATUSES.has(returnConditionStatus)) {
    errors.returnConditionStatus = "invalid_return_condition_status";
  }
  if (returnTrackingUrl && !URL_PATTERN.test(returnTrackingUrl)) {
    errors.returnTrackingUrl = "invalid_return_tracking_url";
  }
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    values: {
      returnRequirementStatus,
      returnTrackingCompany,
      returnTrackingNumber,
      returnTrackingUrl,
      returnReceivedAt,
      returnConditionStatus,
      returnConditionNotes,
      returnProofJson: buildReturnProofJson({
        returnTrackingCompany,
        returnTrackingNumber,
        returnTrackingUrl,
        returnReceivedAt
      })
    }
  };
}
export async function updateWithdrawalReturnInfo({
  id,
  formData,
  changedBy = "admin",
  prismaClient = prisma
} = {}) {
  const normalized = normalizeWithdrawalReturnInfoFormData(formData);
  if (!normalized.ok) {
    return {
      ok: false,
      status: 400,
      error: "invalid_return_info",
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
        returnInfoUpdatedAt: now,
        returnInfoUpdatedBy: changedBy
      }
    });
    await tx.withdrawalRequestStatusHistory.create({
      data: {
        withdrawalRequestId: id,
        fromStatus: current.status,
        toStatus: current.status,
        changedBy,
        reason: "return_info_updated",
        metadataJson: {
          returnInfo: values
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
function buildReturnProofJson({
  returnTrackingCompany,
  returnTrackingNumber,
  returnTrackingUrl,
  returnReceivedAt
}) {
  const hasProof = returnTrackingCompany || returnTrackingNumber || returnTrackingUrl || returnReceivedAt;
  if (!hasProof) {
    return null;
  }
  return {
    trackingCompany: returnTrackingCompany,
    trackingNumber: returnTrackingNumber,
    trackingUrl: returnTrackingUrl,
    receivedAt: returnReceivedAt?.toISOString?.() || null,
    recordedAt: new Date().toISOString()
  };
}

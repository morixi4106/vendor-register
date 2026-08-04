import prisma from "../../db.server.js";
import { WITHDRAWAL_STATUSES } from "../../utils/withdrawalStatus.js";
import { hashPrivateIdentifier } from "../../utils/privacyHash.server.js";
import { URL_PATTERN, getClientIp, hashReturnProofToken, normalizeText } from "./common.js";
const RETURN_PROOF_OPEN_STATUSES = new Set([WITHDRAWAL_STATUSES.REQUESTED, WITHDRAWAL_STATUSES.ACKNOWLEDGED, WITHDRAWAL_STATUSES.UNDER_REVIEW, WITHDRAWAL_STATUSES.APPROVED, WITHDRAWAL_STATUSES.RETURN_REQUESTED, WITHDRAWAL_STATUSES.RETURN_RECEIVED, WITHDRAWAL_STATUSES.REFUND_PENDING]);
export async function findWithdrawalReturnProofRequest({
  requestId,
  token,
  prismaClient = prisma
} = {}) {
  const id = normalizeText(requestId);
  const rawToken = normalizeText(token);
  if (!id || !rawToken) {
    return {
      ok: false,
      status: 404,
      error: "invalid_return_proof_link"
    };
  }
  const withdrawalRequest = await prismaClient.withdrawalRequest.findFirst({
    where: {
      id,
      returnProofTokenHash: hashReturnProofToken(rawToken)
    }
  });
  if (!withdrawalRequest) {
    return {
      ok: false,
      status: 404,
      error: "invalid_return_proof_link"
    };
  }
  if (withdrawalRequest.returnProofTokenExpiresAt && new Date(withdrawalRequest.returnProofTokenExpiresAt).getTime() < Date.now()) {
    return {
      ok: false,
      status: 410,
      error: "return_proof_link_expired",
      withdrawalRequest
    };
  }
  if (!RETURN_PROOF_OPEN_STATUSES.has(withdrawalRequest.status)) {
    return {
      ok: false,
      status: 410,
      error: "withdrawal_request_closed",
      withdrawalRequest
    };
  }
  return {
    ok: true,
    withdrawalRequest
  };
}
export async function submitWithdrawalReturnProof({
  requestId,
  token,
  formData,
  request = null,
  prismaClient = prisma
} = {}) {
  const lookup = await findWithdrawalReturnProofRequest({
    requestId,
    token,
    prismaClient
  });
  if (!lookup.ok) {
    return lookup;
  }
  const current = lookup.withdrawalRequest;
  const returnTrackingCompany = normalizeText(formData.get("returnTrackingCompany"));
  const returnTrackingNumber = normalizeText(formData.get("returnTrackingNumber"));
  const returnTrackingUrl = normalizeText(formData.get("returnTrackingUrl"));
  const customerMemo = normalizeText(formData.get("customerMemo"));
  const errors = {};
  if (!returnTrackingNumber && !returnTrackingUrl) {
    errors.returnTrackingNumber = "tracking_required";
  }
  if (returnTrackingUrl && !URL_PATTERN.test(returnTrackingUrl)) {
    errors.returnTrackingUrl = "invalid_return_tracking_url";
  }
  if (Object.keys(errors).length > 0) {
    return {
      ok: false,
      status: 400,
      error: "invalid_return_proof",
      errors,
      withdrawalRequest: current
    };
  }
  const now = new Date();
  const returnRequirementStatus = ["RECEIVED", "CONDITION_CHECKED"].includes(String(current.returnRequirementStatus || "").toUpperCase()) ? current.returnRequirementStatus : "IN_TRANSIT";
  const previousProof = current.returnProofJson && typeof current.returnProofJson === "object" ? current.returnProofJson : {};
  const returnProofJson = {
    ...previousProof,
    trackingCompany: returnTrackingCompany,
    trackingNumber: returnTrackingNumber,
    trackingUrl: returnTrackingUrl,
    customerMemo,
    submittedBy: "customer",
    submittedAt: now.toISOString(),
    ipHash: hashPrivateIdentifier(getClientIp(request)),
    userAgentHash: hashPrivateIdentifier(request?.headers?.get("user-agent") || null)
  };
  const updated = await prismaClient.$transaction(async tx => {
    const next = await tx.withdrawalRequest.update({
      where: {
        id: current.id
      },
      data: {
        returnRequirementStatus,
        returnTrackingCompany,
        returnTrackingNumber,
        returnTrackingUrl,
        returnProofJson,
        returnProofSubmittedAt: now,
        returnInfoUpdatedAt: now,
        returnInfoUpdatedBy: "customer"
      }
    });
    await tx.withdrawalRequestStatusHistory.create({
      data: {
        withdrawalRequestId: current.id,
        fromStatus: current.status,
        toStatus: current.status,
        changedBy: "customer",
        reason: "return_proof_submitted",
        metadataJson: {
          returnProof: returnProofJson
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

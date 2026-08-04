import prisma from "../../db.server.js";
import { WITHDRAWAL_ELIGIBILITY_STATUSES } from "../../utils/withdrawalStatus.js";
import { isWithdrawalIdentityReviewStatus, sendWithdrawalVendorNotificationEmails } from "./common.js";
export async function approveWithdrawalIdentityReview({
  withdrawalRequestId,
  changedBy = "admin",
  prismaClient = prisma
} = {}) {
  const current = await prismaClient.withdrawalRequest.findUnique({
    where: {
      id: String(withdrawalRequestId || "")
    }
  });
  if (!current) {
    return {
      ok: false,
      status: 404,
      error: "withdrawal_request_not_found"
    };
  }
  if (!isWithdrawalIdentityReviewStatus(current.eligibilityStatus)) {
    return {
      ok: false,
      status: 409,
      error: "identity_review_not_required"
    };
  }
  if (!current.shopifyOrderId && !current.marketplaceOrderId) {
    return {
      ok: false,
      status: 409,
      error: "verified_order_required"
    };
  }
  await prismaClient.$transaction(async tx => {
    await tx.withdrawalRequest.update({
      where: {
        id: current.id
      },
      data: {
        eligibilityStatus: WITHDRAWAL_ELIGIBILITY_STATUSES.PENDING_REVIEW,
        progressStatus: "PENDING",
        v2ReviewReason: null
      }
    });
    await tx.withdrawalRequestStatusHistory.create({
      data: {
        withdrawalRequestId: current.id,
        fromStatus: current.status,
        toStatus: current.status,
        changedBy,
        reason: "identity_verified",
        metadataJson: {
          previousEligibilityStatus: current.eligibilityStatus,
          nextEligibilityStatus: WITHDRAWAL_ELIGIBILITY_STATUSES.PENDING_REVIEW
        }
      }
    });
  });
  const {
    initializeWithdrawalDirectReturnWorkflow
  } = await import("../withdrawalDirectReturns.server.js");
  const directReturnResult = await initializeWithdrawalDirectReturnWorkflow({
    withdrawalRequestId: current.id,
    prismaClient
  });
  if (!directReturnResult.ok) {
    return {
      ok: false,
      status: directReturnResult.status || 409,
      error: directReturnResult.error || directReturnResult.reason
    };
  }
  const vendorNotificationResult = await sendWithdrawalVendorNotificationEmails({
    withdrawalRequestId: current.id,
    prismaClient
  });
  return {
    ok: true,
    directReturnResult,
    vendorNotificationResult
  };
}

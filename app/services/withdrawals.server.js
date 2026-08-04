export {
  buildWithdrawalIdempotencyKey,
  createWithdrawalRequestFromForm,
  getShopDomainFromRequest,
  hashWithdrawalReceiptToken,
  normalizeWithdrawalFormData,
} from "./withdrawals/submission.server.js";

export {
  ensureWithdrawalReturnProofToken,
  evaluateWithdrawalEligibility,
  findOrderForWithdrawal,
  isWithdrawalIdentityReviewStatus,
  sendWithdrawalAcknowledgementEmail,
  sendWithdrawalEmail,
  sendWithdrawalVendorNotificationEmails,
} from "./withdrawals/common.js";

export {
  findWithdrawalReturnProofRequest,
  submitWithdrawalReturnProof,
} from "./withdrawals/returnProof.server.js";

export {
  normalizeWithdrawalRefundDecisionFormData,
  updateWithdrawalRefundDecision,
} from "./withdrawals/refundDecision.server.js";

export {
  normalizeWithdrawalCompletionFormData,
  updateWithdrawalCompletionRecord,
} from "./withdrawals/completion.server.js";

export {
  normalizeWithdrawalReturnInfoFormData,
  updateWithdrawalReturnInfo,
} from "./withdrawals/returnInfo.server.js";

export {
  getWithdrawalShopifyLiveOrderStatus,
} from "./withdrawals/orderLookup.server.js";

export {
  approveWithdrawalIdentityReview,
} from "./withdrawals/identity.server.js";

export {
  sendWithdrawalCompletionEmail,
  sendWithdrawalReturnInstructionsEmail,
  sendWithdrawalStatusEmail,
} from "./withdrawals/notifications.server.js";

export {
  updateWithdrawalStatus,
} from "./withdrawals/lifecycle.server.js";

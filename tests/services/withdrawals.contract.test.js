import assert from "node:assert/strict";
import test from "node:test";

const EXPECTED_EXPORTS = [
  "approveWithdrawalIdentityReview",
  "buildWithdrawalIdempotencyKey",
  "createWithdrawalRequestFromForm",
  "ensureWithdrawalReturnProofToken",
  "evaluateWithdrawalEligibility",
  "findOrderForWithdrawal",
  "findWithdrawalReturnProofRequest",
  "getShopDomainFromRequest",
  "getWithdrawalShopifyLiveOrderStatus",
  "hashWithdrawalReceiptToken",
  "isWithdrawalIdentityReviewStatus",
  "normalizeWithdrawalCompletionFormData",
  "normalizeWithdrawalFormData",
  "normalizeWithdrawalRefundDecisionFormData",
  "normalizeWithdrawalReturnInfoFormData",
  "sendWithdrawalAcknowledgementEmail",
  "sendWithdrawalCompletionEmail",
  "sendWithdrawalEmail",
  "sendWithdrawalReturnInstructionsEmail",
  "sendWithdrawalStatusEmail",
  "sendWithdrawalVendorNotificationEmails",
  "submitWithdrawalReturnProof",
  "updateWithdrawalCompletionRecord",
  "updateWithdrawalRefundDecision",
  "updateWithdrawalReturnInfo",
  "updateWithdrawalStatus",
].sort();

test("withdrawals compatibility facade keeps its public API", async () => {
  const module = await import("../../app/services/withdrawals.server.js");

  assert.deepEqual(Object.keys(module).sort(), EXPECTED_EXPORTS);
});

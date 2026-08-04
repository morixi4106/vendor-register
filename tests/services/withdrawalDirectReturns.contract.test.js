import assert from "node:assert/strict";
import test from "node:test";

const EXPECTED_EXPORTS = [
  "RETURN_ADDRESS_STATUSES",
  "RETURN_DISPOSITIONS",
  "WITHDRAWAL_CONTRACT_MODES",
  "__testables",
  "activateVendorReturnAddress",
  "activateWithdrawalWorkflowPolicy",
  "buildDirectReturnInstructionEmail",
  "buildDirectReturnStoreNotificationEmail",
  "confirmWithdrawalPartialLineMapping",
  "createReturnInstruction",
  "deriveReturnGroupState",
  "deriveWithdrawalAggregate",
  "findWithdrawalGroupByToken",
  "getActiveWithdrawalWorkflowPolicy",
  "getReturnProofPublicUrl",
  "getVendorReturnAddressState",
  "getWithdrawalV2Detail",
  "initializeWithdrawalDirectReturnWorkflow",
  "issueWithdrawalGroupAccessToken",
  "recomputeWithdrawalV2State",
  "reconcileWithdrawalCancellationWebhook",
  "reconcileWithdrawalRefundWebhook",
  "recordWithdrawalActualRefundEvent",
  "releaseWithdrawalLineReservations",
  "returnAddressFromFormData",
  "saveVendorReturnAddressDraft",
  "submitWithdrawalGroupShipment",
  "updateWithdrawalContractShippingDecision",
  "updateWithdrawalGroupReview",
  "upsertWithdrawalWorkflowPolicy",
].sort();

test("direct returns compatibility facade keeps its public API", async () => {
  const module = await import(
    "../../app/services/withdrawalDirectReturns.server.js"
  );

  assert.deepEqual(Object.keys(module).sort(), EXPECTED_EXPORTS);
});

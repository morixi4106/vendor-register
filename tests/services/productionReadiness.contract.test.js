import assert from "node:assert/strict";
import test from "node:test";

const EXPECTED_EXPORTS = [
  "buildLaunchIntegrityChecks",
  "buildMarketplaceGovernanceChecks",
  "buildWithdrawalOperationChecks",
  "buildWithdrawalWorkerHeartbeatCheck",
  "getProductionReadiness",
  "includeCheckoutGateInProductionReadiness",
  "includeCheckoutValidationInProductionReadiness",
  "inspectDirectReturnReadiness",
  "inspectLaunchIntegrity",
  "inspectProductShippingProfiles",
  "inspectStripeEnvironment",
  "inspectWithdrawalOperations",
  "inspectWithdrawalWorkerHeartbeat",
  "loadLaunchIntegritySellerRows",
  "summarizeProductionReadinessChecks",
].sort();

test("production readiness compatibility facade keeps its public API", async () => {
  const module = await import(
    "../../app/services/productionReadiness.server.js"
  );

  assert.deepEqual(Object.keys(module).sort(), EXPECTED_EXPORTS);
});

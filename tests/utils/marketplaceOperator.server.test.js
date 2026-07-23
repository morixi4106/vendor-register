import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETPLACE_OPERATOR_ROLES,
  resolveProductionReadinessOperatorRole,
} from "../../app/utils/marketplaceOperatorRoles.js";

test("production readiness routes high-risk intents to explicit roles", () => {
  assert.equal(
    resolveProductionReadinessOperatorRole(
      "activate_emergency_checkout_hold",
    ),
    MARKETPLACE_OPERATOR_ROLES.INCIDENT_COMMANDER,
  );
  assert.equal(
    resolveProductionReadinessOperatorRole("release_emergency_checkout_hold"),
    MARKETPLACE_OPERATOR_ROLES.RECOVERY_APPROVER,
  );
  assert.equal(
    resolveProductionReadinessOperatorRole("activate_checkout_validation"),
    MARKETPLACE_OPERATOR_ROLES.RELEASE_MANAGER,
  );
  assert.equal(
    resolveProductionReadinessOperatorRole("record_operational_attestation"),
    MARKETPLACE_OPERATOR_ROLES.COMPLIANCE_REVIEWER,
  );
});

test("production readiness keeps ordinary maintenance under admin", () => {
  assert.equal(
    resolveProductionReadinessOperatorRole("register_carrier"),
    MARKETPLACE_OPERATOR_ROLES.ADMIN,
  );
});

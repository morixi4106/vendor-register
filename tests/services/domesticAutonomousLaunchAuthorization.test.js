import assert from "node:assert/strict";
import test from "node:test";

import {
  DOMESTIC_AUTONOMOUS_LAUNCH_AUTHORIZATION,
  inspectDomesticAutonomousLaunchAuthorization,
} from "../../app/services/domesticAutonomousLaunchAuthorization.js";
import { buildOperationalReadinessChecks } from "../../app/services/operationalReadinessChecks.js";

const NOW = new Date("2026-09-29T00:00:00.000Z");

function authorizedEnv(overrides = {}) {
  return {
    PLATFORM_DIRECT_CHECKOUT_MODE: "SHOPIFY_STANDARD_DIRECT",
    DOMESTIC_AUTONOMOUS_LAUNCH_ENABLED: "true",
    DOMESTIC_AUTONOMOUS_LAUNCH_AUTHORIZATION,
    DOMESTIC_AUTONOMOUS_LAUNCH_SCOPE: "DOMESTIC_PLATFORM_DIRECT_ONLY",
    DOMESTIC_AUTONOMOUS_LAUNCH_AUTHORIZED_AT: "2026-09-29T00:00:00.000Z",
    DOMESTIC_AUTONOMOUS_LAUNCH_EXPIRES_AT: "2026-12-28T00:00:00.000Z",
    PRODUCTION_INTEGRITY_MONITOR_ENABLED: "true",
    ...overrides,
  };
}

function readinessRow(key, { status = "PENDING", ready = false } = {}) {
  return {
    ready,
    reason: ready ? null : "missing",
    definition: { key, label: key, supplemental: false },
    attestation: { status },
    effectiveAttestation: null,
  };
}

test("domestic autonomous launch authorization is explicit and time-bound", () => {
  const active = inspectDomesticAutonomousLaunchAuthorization(
    authorizedEnv(),
    NOW,
  );
  assert.equal(active.active, true);
  assert.equal(active.enabled, true);
  assert.equal(active.scopeMatches, true);
  assert.equal(active.monitorEnabled, true);
  assert.equal(active.checkoutMode.standardDirectReady, true);

  const expired = inspectDomesticAutonomousLaunchAuthorization(
    authorizedEnv({
      DOMESTIC_AUTONOMOUS_LAUNCH_EXPIRES_AT: "2026-09-28T23:59:59.000Z",
    }),
    NOW,
  );
  assert.equal(expired.active, false);
  assert.equal(expired.reason, "authorization_window_invalid");

  const marketplaceEnabled = inspectDomesticAutonomousLaunchAuthorization(
    authorizedEnv({ DOMESTIC_MARKETPLACE_PILOT_ENABLED: "true" }),
    NOW,
  );
  assert.equal(marketplaceEnabled.active, false);
  assert.equal(
    marketplaceEnabled.reason,
    "third_party_commerce_must_be_disabled",
  );

  const missingMonitor = inspectDomesticAutonomousLaunchAuthorization(
    authorizedEnv({ PRODUCTION_INTEGRITY_MONITOR_ENABLED: "false" }),
    NOW,
  );
  assert.equal(missingMonitor.active, false);
  assert.equal(missingMonitor.reason, "production_monitor_required");
});

test("authorization converts only fixed pending attestations to non-blocking warnings", () => {
  const checks = buildOperationalReadinessChecks({
    inspection: {
      rows: [
        readinessRow("LEGAL_DISCLOSURES_REVIEWED"),
        readinessRow("SOME_FUTURE_REQUIRED_CHECK"),
      ],
    },
    control: { checkoutHold: false, checkoutControlState: "IDLE" },
    env: authorizedEnv(),
    now: NOW,
  });

  const accepted = checks.find((check) =>
    check.id.endsWith("legal_disclosures_reviewed"),
  );
  const unknown = checks.find((check) =>
    check.id.endsWith("some_future_required_check"),
  );
  assert.equal(accepted.status, "warning");
  assert.equal(accepted.releaseBlocking, false);
  assert.equal(accepted.releaseDisposition, "owner_risk_accepted");
  assert.equal(unknown.status, "fail");
  assert.notEqual(unknown.releaseBlocking, false);
});

test("failed attestations cannot be risk accepted", () => {
  const [failed] = buildOperationalReadinessChecks({
    inspection: {
      rows: [
        readinessRow("LEGAL_DISCLOSURES_REVIEWED", { status: "FAILED" }),
      ],
    },
    control: { checkoutHold: false, checkoutControlState: "IDLE" },
    env: authorizedEnv(),
    now: NOW,
  });
  assert.equal(failed.status, "fail");
  assert.notEqual(failed.releaseBlocking, false);
});

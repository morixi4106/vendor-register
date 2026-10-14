import assert from "node:assert/strict";
import test from "node:test";
import { buildLaunchMonitorStatus } from "../../app/services/launchMonitorStatus.js";
import { inspectLaunchMonitorStatus } from "../../app/services/launchMonitorStatus.server.js";

const NOW = new Date("2026-10-14T08:00:00Z");
const before = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
function fixture() {
  return {
    now: NOW,
    env: {
      LAUNCH_MONITOR_ENABLED: "true",
      PRODUCTION_INTEGRITY_MONITOR_ENABLED: "true",
    },
    notification: {
      ready: true,
      status: "VERIFIED",
      humanVerifiedAt: before(10),
      providerEvent: "delivered",
    },
    catalogHeartbeat: { lastSucceededAt: before(5), lastFailedAt: before(10) },
    monitorMetadata: {
      lastCheckedAt: before(1),
      lastHeavyCheckedAt: before(5),
      lastExternalCheckedAt: before(2),
      lastOverallStatus: "healthy",
      lastReport: { checks: [{ id: "database_connection", severity: "ok" }] },
    },
  };
}

test("empty history and inactive settings never look verified, fresh or publishable", () => {
  const status = buildLaunchMonitorStatus({ now: NOW });
  assert.equal(status.notification.ready, false);
  assert.equal(status.catalog.status, "critical");
  assert.equal(status.monitoring.current.code, "disabled");
  assert.equal(status.publication.status, "waiting");
  assert.equal(status.configuration.maintenanceAuthorized, false);
  assert.equal(Object.hasOwn(status.publication, "canGoLive"), false);
});

test("valid receipt and current successful records are displayed without inventing publication permission", () => {
  const status = buildLaunchMonitorStatus(fixture());
  assert.equal(status.notification.ready, true);
  assert.equal(status.catalog.ageMinutes, 5);
  assert.equal(status.monitoring.current.status, "ok");
  assert.equal(status.publication.code, "monitor_issues_clear");
  assert.equal(Object.hasOwn(status.publication, "ready"), false);
});

test("missing, failed, stale, future and invalid sync records cannot be presented as healthy", () => {
  for (const [heartbeat, expected] of [
    [null, "success_missing_or_invalid"],
    [{ lastSucceededAt: "invalid" }, "success_missing_or_invalid"],
    [
      { lastSucceededAt: new Date(NOW.getTime() + 1).toISOString() },
      "success_missing_or_invalid",
    ],
    [
      { lastSucceededAt: before(5), lastFailedAt: before(1) },
      "latest_run_failed",
    ],
    [
      { lastSucceededAt: before(5), lastFailedAt: "invalid" },
      "latest_run_failed",
    ],
    [{ lastSucceededAt: before(30) }, "warning_stale"],
    [{ lastSucceededAt: before(180) }, "critical_stale"],
  ]) {
    const status = buildLaunchMonitorStatus({
      ...fixture(),
      catalogHeartbeat: heartbeat,
    });
    assert.equal(status.catalog.code, expected);
    assert.notEqual(status.catalog.status, "ok");
  }
  assert.equal(
    buildLaunchMonitorStatus({ ...fixture(), catalogAvailable: false }).catalog
      .code,
    "unavailable",
  );
  assert.equal(
    buildLaunchMonitorStatus({
      ...fixture(),
      env: { SHOPIFY_PRODUCT_CATALOG_SYNC_WARNING_MINUTES: "200" },
    }).catalog.code,
    "timing_invalid",
  );
});

test("all three monitor clocks must be fresh; a completed old window does not imply a healthy current report", () => {
  for (const [field, value] of [
    ["lastCheckedAt", before(15)],
    ["lastHeavyCheckedAt", before(30)],
    ["lastExternalCheckedAt", before(30)],
    ["lastCheckedAt", "invalid"],
    ["lastExternalCheckedAt", new Date(NOW.getTime() + 1).toISOString()],
  ]) {
    const input = fixture();
    input.monitorMetadata[field] = value;
    input.monitorMetadata.completedAt = before(50);
    const status = buildLaunchMonitorStatus(input);
    assert.equal(status.publication.code, "report_stale");
    assert.notEqual(status.publication.status, "ok");
  }
});

test("warnings, password protection and incomplete report shapes remain unresolved", () => {
  const input = fixture();
  input.monitorMetadata.lastReport.checks.push({
    id: "official_storefront",
    severity: "critical",
  });
  input.monitorMetadata.lastReport.checks.push({
    id: "operational_attestation_admin_mfa_access_reviewed",
    severity: "warning",
  });
  let status = buildLaunchMonitorStatus(input);
  assert.equal(status.publication.status, "critical");
  assert.equal(status.publication.criticalCount, 1);
  assert.equal(status.publication.warningCount, 1);
  for (const checks of [[], [null], [{ severity: "unknown" }]]) {
    input.monitorMetadata.lastReport.checks = checks;
    status = buildLaunchMonitorStatus(input);
    assert.equal(status.publication.code, "report_missing_or_invalid");
  }
});

test("provider events alone, expired proof and failed proof do not replace human receipt confirmation", () => {
  for (const notification of [
    { status: "PENDING", ready: false, providerEvent: "delivered" },
    {
      status: "VERIFIED",
      ready: false,
      humanVerifiedAt: before(10),
      providerEvent: "delivered",
    },
    { status: "DELIVERY_FAILED", ready: false, humanVerifiedAt: before(10) },
    { status: "SEND_FAILED", ready: false },
    { status: "VERIFIED", ready: true, humanVerifiedAt: "invalid" },
    {
      status: "VERIFIED",
      ready: true,
      humanVerifiedAt: new Date(NOW.getTime() + 1).toISOString(),
    },
  ]) {
    const status = buildLaunchMonitorStatus({ ...fixture(), notification });
    assert.equal(status.notification.ready, false);
    assert.notEqual(status.notification.status, "ok");
  }
});

test("diagnostics contain only allowlisted fields, not raw report details, receipt codes or environment secrets", () => {
  const input = fixture();
  input.env.ADMIN_EMAIL = "private@example.test";
  input.env.PRIVACY_HASH_SECRET = "private-secret";
  input.notification.codeHash = "private-code-hash";
  input.notification.providerEvent = "private@example.test";
  input.monitorMetadata.lastReport.checks[0].detail = "private@example.test";
  input.catalogHeartbeat.metadataJson = { body: "private payload" };
  const output = JSON.stringify(buildLaunchMonitorStatus(input));
  for (const secret of [
    "private@example.test",
    "private-secret",
    "private-code-hash",
    "private payload",
  ])
    assert.ok(!output.includes(secret));
});

test("the inspector is read-only, reuses loaded status and excludes catalog metadata at the database boundary", async () => {
  const input = fixture();
  const reads = [];
  const prismaClient = {
    operationalHeartbeat: {
      findUnique: async (query) => {
        reads.push(query);
        return input.catalogHeartbeat;
      },
      upsert: () => assert.fail("Status reads must never create proof"),
      updateMany: () => assert.fail("Status reads must never update proof"),
    },
  };
  const status = await inspectLaunchMonitorStatus({
    ...input,
    prismaClient,
    monitorHeartbeat: { metadataJson: input.monitorMetadata },
  });
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].select, {
    lastSucceededAt: true,
    lastFailedAt: true,
  });
  assert.equal(status.catalog.status, "ok");
  prismaClient.operationalHeartbeat.findUnique = async () => {
    throw new Error("private database error");
  };
  const unavailable = await inspectLaunchMonitorStatus({
    prismaClient,
    env: input.env,
    now: NOW,
  });
  assert.equal(unavailable.notification.code, "unavailable");
  assert.equal(unavailable.catalog.code, "unavailable");
  assert.equal(unavailable.publication.status, "waiting");
  assert.ok(!JSON.stringify(unavailable).includes("private database error"));
});

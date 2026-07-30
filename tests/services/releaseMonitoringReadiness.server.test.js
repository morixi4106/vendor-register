import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReleaseMonitoringChecks,
  inspectReleaseMonitoringReadiness,
  recordSaleEligibilityWatchdogHeartbeat,
} from "../../app/services/releaseMonitoringReadiness.server.js";

const NOW = new Date("2026-07-30T12:00:00.000Z");
const ENV = {
  LAUNCH_MONITOR_ENABLED: "true",
  SALE_ELIGIBILITY_WATCHDOG_TOKEN: "w".repeat(32),
};

test("release monitoring is ready only after fresh GitHub full runs", async () => {
  const inspection = await inspectReleaseMonitoringReadiness({
    prismaClient: fakePrisma(healthyRows()),
    env: ENV,
    now: NOW,
  });

  assert.equal(inspection.monitor.ready, true);
  assert.equal(inspection.watchdog.ready, true);
  assert.deepEqual(
    buildReleaseMonitoringChecks(inspection).map((check) => check.status),
    ["pass", "pass"],
  );
});

test("the Render monitor endpoint is release-blocking when disabled", async () => {
  const inspection = await inspectReleaseMonitoringReadiness({
    prismaClient: fakePrisma(healthyRows()),
    env: { ...ENV, LAUNCH_MONITOR_ENABLED: "false" },
    now: NOW,
  });

  assert.equal(inspection.monitor.ready, false);
  assert.equal(inspection.monitor.reason, "monitor_endpoint_disabled");
  assert.equal(buildReleaseMonitoringChecks(inspection)[0].status, "fail");
});

test("repository schedule flags must be proven by the GitHub agent heartbeat", async () => {
  const rows = healthyRows();
  rows[0].metadataJson.lastReport.agent.schedulerEnabled = false;
  rows[1].metadataJson.schedulerEnabled = false;

  const inspection = await inspectReleaseMonitoringReadiness({
    prismaClient: fakePrisma(rows),
    env: ENV,
    now: NOW,
  });

  assert.equal(inspection.monitor.reason, "monitor_schedule_disabled");
  assert.equal(inspection.watchdog.reason, "watchdog_schedule_disabled");
});

test("password-only Critical proves prelaunch wiring but is not public GREEN", async () => {
  const rows = healthyRows();
  rows[0].metadataJson.lastOverallStatus = "critical";
  rows[0].metadataJson.lastNotifiedAt = "2026-07-30T11:58:00.000Z";
  rows[0].metadataJson.lastReport = {
    checkMode: "full",
    overallStatus: "critical",
    criticalCount: 1,
    warningCount: 0,
    agent: { source: "github_actions", schedulerEnabled: false },
    checks: [
      {
        id: "official_storefront",
        severity: "critical",
        errorCode: "password_page",
      },
    ],
  };

  const inspection = await inspectReleaseMonitoringReadiness({
    prismaClient: fakePrisma(rows),
    env: ENV,
    now: NOW,
  });

  assert.equal(inspection.monitor.prelaunchPasswordProbePassed, true);
  assert.equal(inspection.monitor.ready, false);
  assert.equal(inspection.monitor.reason, "storefront_password_protected");
});

test("validation-only watchdog heartbeat cannot satisfy release readiness", async () => {
  const rows = healthyRows();
  rows[1].metadataJson.mode = "validation";
  rows[1].metadataJson.status = "validated";
  rows[1].metadataJson.action = "validated";

  const inspection = await inspectReleaseMonitoringReadiness({
    prismaClient: fakePrisma(rows),
    env: ENV,
    now: NOW,
  });

  assert.equal(inspection.watchdog.ready, false);
  assert.equal(inspection.watchdog.reason, "watchdog_live_run_missing");
});

test("watchdog heartbeat stores no credentials and records run provenance", async () => {
  let saved = null;
  await recordSaleEligibilityWatchdogHeartbeat(
    {
      status: "healthy",
      mode: "live",
      action: "none",
      protected: false,
      source: "github_actions",
      credentialValidation: true,
      schedulerEnabled: true,
      runId: "987",
    },
    {
      now: NOW,
      prismaClient: {
        operationalHeartbeat: {
          async upsert(args) {
            saved = args;
            return args.create;
          },
        },
      },
    },
  );

  assert.equal(saved.create.metadataJson.runId, "987");
  assert.equal(saved.create.metadataJson.credentialValidation, true);
  assert.equal(saved.create.metadataJson.schedulerEnabled, true);
  assert.equal(JSON.stringify(saved).includes("secret"), false);
});

function healthyRows() {
  return [
    {
      key: "production_integrity_monitor",
      metadataJson: {
        lastCheckedAt: "2026-07-30T11:58:00.000Z",
        lastOverallStatus: "healthy",
        lastReport: {
          checkMode: "full",
          overallStatus: "healthy",
          criticalCount: 0,
          warningCount: 0,
          agent: { source: "github_actions", schedulerEnabled: true },
          checks: [],
        },
      },
    },
    {
      key: "sale_eligibility_watchdog",
      metadataJson: {
        checkedAt: "2026-07-30T11:59:00.000Z",
        mode: "live",
        status: "healthy",
        action: "none",
        source: "github_actions",
        credentialValidation: true,
        schedulerEnabled: true,
      },
    },
  ];
}

function fakePrisma(rows) {
  return {
    operationalHeartbeat: {
      async findMany() {
        return rows;
      },
    },
  };
}

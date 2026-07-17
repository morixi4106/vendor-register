import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireLaunchMonitorRunLock,
  buildReport,
  collectLaunchMonitorReport,
  evaluateExternalPublicSnapshot,
  evaluateRenderSnapshot,
  readLaunchMonitorDeadmanState,
  releaseLaunchMonitorRunLock,
  resolveNotificationKind,
  sanitizeLaunchMonitorResult,
} from "../../app/services/launchMonitor.server.js";

const NOW = new Date("2026-07-18T00:00:00.000Z");

test("evaluateRenderSnapshot marks 5xx and app errors as critical", () => {
  const view = evaluateRenderSnapshot({
    requests: {
      serverErrors: 2,
      unauthorized: 0,
      forbidden: 0,
      rateLimited: 0,
    },
    appErrors: 1,
    queryErrors: [],
  });
  assert.equal(find(view, "render_http_5xx").severity, "critical");
  assert.equal(find(view, "render_app_errors").severity, "critical");
});

test("evaluateRenderSnapshot applies warning and critical thresholds", () => {
  const view = evaluateRenderSnapshot({
    requests: { unauthorized: 12, forbidden: 8, rateLimited: 5 },
  });
  assert.equal(
    find(view, "render_auth_rejections").severity,
    "warning",
  );
  assert.equal(find(view, "render_rate_limits").severity, "warning");

  {
    const view = evaluateRenderSnapshot({
      requests: { unauthorized: 100, forbidden: 0, rateLimited: 25 },
    });
    assert.equal(
      find(view, "render_auth_rejections").severity,
      "critical",
    );
    assert.equal(find(view, "render_rate_limits").severity, "critical");
  }
});

test("external probes fail closed for wrong redirects and password pages", () => {
  const checks = evaluateExternalPublicSnapshot({
    appRoot: { ok: false, code: "unexpected_redirect" },
    storefront: { ok: false, code: "password_page" },
  });
  assert.equal(find(checks, "public_root_redirect").severity, "critical");
  assert.equal(find(checks, "official_storefront").severity, "critical");
});

test("buildReport prioritizes critical over warning", () => {
  const report = buildReport({
    now: NOW,
    checks: [
      { id: "one", severity: "warning", detail: "warning" },
      { id: "two", severity: "critical", detail: "critical" },
      { id: "three", severity: "ok", detail: "ok" },
    ],
  });
  assert.equal(report.overallStatus, "critical");
  assert.equal(report.criticalCount, 1);
  assert.equal(report.warningCount, 1);
});

test("collectLaunchMonitorReport is healthy when shared checks are healthy", async () => {
  const report = await collectReport();
  assert.equal(report.overallStatus, "healthy");
  assert.equal(report.checkMode, "full");
  assert.equal(
    find(report.checks, "withdrawal_email_worker_heartbeat").severity,
    "ok",
  );
  assert.equal(
    find(report.checks, "seller_order_unresolved_shadow_checks").severity,
    "ok",
  );
});

test("DB failure is critical while independent checks still finish", async () => {
  const prismaClient = basePrisma();
  prismaClient.$queryRaw = async () => {
    throw Object.assign(new Error("secret connection text"), { code: "P1001" });
  };
  const report = await collectReport({ prismaClient });
  assert.equal(report.overallStatus, "critical");
  assert.equal(find(report.checks, "database_connection").errorCode, "p1001");
  assert.ok(find(report.checks, "contact_inquiry_spike"));
});

test("dead letters and stale outbox processing are critical through shared readiness logic", async () => {
  const report = await collectReport({
    withdrawal: withdrawalOperations({
      outboxDeadLetterCount: 1,
      outboxStaleProcessingCount: 1,
    }),
  });
  assert.equal(
    find(report.checks, "withdrawal_email_outbox").severity,
    "critical",
  );
});

test("seller-order differences and production ledger repairs are critical", async () => {
  const report = await collectReport({
    integrity: launchIntegrity({
      sellerOrderShadow: { available: true, unresolvedCount: 1 },
      ledgerRepairs: { available: true, productionCount: 1, testCount: 0 },
    }),
  });
  assert.equal(
    find(report.checks, "seller_order_unresolved_shadow_checks").severity,
    "critical",
  );
  assert.equal(
    find(report.checks, "seller_ledger_repair_candidates").severity,
    "critical",
  );
});

test("test-store-only ledger repair is warning and test payout is critical", async () => {
  const warningReport = await collectReport({
    integrity: launchIntegrity({
      ledgerRepairs: { available: true, productionCount: 0, testCount: 2 },
    }),
  });
  assert.equal(
    find(warningReport.checks, "seller_ledger_repair_candidates").severity,
    "warning",
  );

  const criticalReport = await collectReport({
    integrity: launchIntegrity({
      testStores: { count: 2, pendingPayoutRunCount: 1 },
    }),
  });
  assert.equal(
    find(criticalReport.checks, "test_store_pending_payout_runs").severity,
    "critical",
  );
});

test("contact inquiry thresholds move from healthy to warning to critical", async () => {
  for (const [count, expected] of [
    [9, "ok"],
    [10, "warning"],
    [30, "critical"],
  ]) {
    const prismaClient = basePrisma(count);
    const report = await collectReport({ prismaClient });
    assert.equal(
      find(report.checks, "contact_inquiry_spike").severity,
      expected,
    );
  }
});

test("light runs reuse the latest heavy result instead of reporting recovery", async () => {
  const previousHeavyChecks = [
    {
      id: "seller_order_unresolved_shadow_checks",
      severity: "critical",
      detail: "still unresolved",
      errorCode: null,
      count: 1,
    },
  ];
  const report = await collectReport({
    runHeavyChecks: false,
    previousHeavyChecks,
  });
  assert.equal(report.checkMode, "light");
  assert.equal(
    find(report.checks, "seller_order_unresolved_shadow_checks").severity,
    "critical",
  );
});

test("notification policy suppresses repeats, escalates, reminds, and recovers", () => {
  const warning = reportWithStatus("warning");
  const critical = reportWithStatus("critical");
  const healthy = reportWithStatus("healthy");
  assert.equal(
    resolveNotificationKind({ report: healthy, previousStatus: "", now: NOW }),
    "started",
  );
  assert.equal(
    resolveNotificationKind({
      report: warning,
      previousStatus: "warning",
      previousFingerprint: "same",
      currentFingerprint: "same",
      lastNotifiedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      now: NOW,
    }),
    null,
  );
  assert.equal(
    resolveNotificationKind({
      report: warning,
      previousStatus: "warning",
      previousFingerprint: "same",
      currentFingerprint: "same",
      lastNotifiedAt: new Date(NOW.getTime() - 121 * 60 * 1000),
      now: NOW,
    }),
    "alert",
  );
  assert.equal(
    resolveNotificationKind({
      report: critical,
      previousStatus: "warning",
      previousFingerprint: "same",
      currentFingerprint: "same",
      lastNotifiedAt: NOW,
      now: NOW,
    }),
    "alert",
  );
  assert.equal(
    resolveNotificationKind({
      report: healthy,
      previousStatus: "critical",
      now: NOW,
    }),
    "recovered",
  );
});

test("public response is minimal and excludes details and raw errors", () => {
  const result = sanitizeLaunchMonitorResult(
    {
      ok: true,
      active: true,
      report: {
        checkedAt: NOW,
        overallStatus: "critical",
        checks: [
          {
            id: "database_connection",
            severity: "critical",
            detail: "customer@example.com secret address",
            errorCode: "P1001",
            count: 1,
          },
        ],
      },
    },
    { env: { RENDER_GIT_COMMIT: "abc123" }, durationMs: 42 },
  );
  assert.deepEqual(Object.keys(result.checks[0]).sort(), [
    "code",
    "count",
    "id",
    "status",
  ]);
  assert.equal(JSON.stringify(result).includes("customer@example.com"), false);
  assert.equal(result.commit, "abc123");
});

test("deadman reports healthy, stale, and completed monitor state", async () => {
  const prismaClient = {
    operationalHeartbeat: {
      findUnique: async () => ({
        metadataJson: {
          active: true,
          lastCheckedAt: new Date(NOW.getTime() - 5 * 60 * 1000),
        },
      }),
    },
  };
  assert.equal(
    (await readLaunchMonitorDeadmanState({ prismaClient, now: NOW })).status,
    "healthy",
  );
  prismaClient.operationalHeartbeat.findUnique = async () => ({
    metadataJson: {
      active: true,
      lastCheckedAt: new Date(NOW.getTime() - 16 * 60 * 1000),
    },
  });
  assert.equal(
    (await readLaunchMonitorDeadmanState({ prismaClient, now: NOW })).status,
    "stale",
  );
  prismaClient.operationalHeartbeat.findUnique = async () => ({
    metadataJson: { active: false, completedAt: NOW },
  });
  assert.equal(
    (await readLaunchMonitorDeadmanState({ prismaClient, now: NOW })).status,
    "completed",
  );
});

test("monitor run lock rejects concurrent runs and can be released", async () => {
  let row = null;
  const prismaClient = {
    operationalHeartbeat: {
      upsert: async ({ create }) => {
        row ||= { ...create };
        return row;
      },
      updateMany: async ({ where, data }) => {
        const cutoff = where?.OR?.[1]?.lastStartedAt?.lt;
        const eligible =
          !where.OR ||
          row.lastStartedAt === null ||
          new Date(row.lastStartedAt) < cutoff;
        if (!eligible) return { count: 0 };
        row = { ...row, ...data };
        return { count: 1 };
      },
    },
  };
  assert.equal(
    await acquireLaunchMonitorRunLock({ prismaClient, now: NOW }),
    true,
  );
  assert.equal(
    await acquireLaunchMonitorRunLock({ prismaClient, now: NOW }),
    false,
  );
  await releaseLaunchMonitorRunLock({ prismaClient, now: NOW });
  assert.equal(
    await acquireLaunchMonitorRunLock({
      prismaClient,
      now: new Date(NOW.getTime() + 1_000),
    }),
    true,
  );
});

async function collectReport({
  prismaClient = basePrisma(),
  withdrawal = withdrawalOperations(),
  integrity = launchIntegrity(),
  runHeavyChecks = true,
  previousHeavyChecks = [],
} = {}) {
  return collectLaunchMonitorReport({
    renderSnapshot: healthySnapshot(),
    prismaClient,
    env: {
      WITHDRAWAL_OUTBOX_WORKER_TOKEN: "configured",
      MULTI_SELLER_STOREFRONT_CHECKOUT_ENABLED: "true",
    },
    now: NOW,
    startedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    runHeavyChecks,
    previousHeavyChecks,
    dependencies: {
      inspectWithdrawalOperations: async () => withdrawal,
      inspectWithdrawalWorkerHeartbeat: async () => integrity.heartbeat,
      loadLaunchIntegritySellerRows: async () => [],
      inspectLaunchIntegrity: async () => integrity,
    },
  });
}

function basePrisma(contactCount = 0) {
  return {
    $queryRaw: async () => [{ "?column?": 1 }],
    contactInquiry: { count: async () => contactCount },
  };
}

function healthySnapshot() {
  return {
    requests: {
      serverErrors: 0,
      unauthorized: 0,
      forbidden: 0,
      rateLimited: 0,
    },
    appErrors: 0,
    queryErrors: [],
    publicEndpoints: {
      appRoot: { ok: true, code: "http_302" },
      storefront: { ok: true, code: "brand_marker_found" },
    },
  };
}

function withdrawalOperations(overrides = {}) {
  return {
    available: true,
    error: null,
    openCount: 0,
    deadlineExpiredCount: 0,
    deadlineSoonCount: 0,
    emailFailedCount: 0,
    outboxPendingCount: 0,
    outboxDeadLetterCount: 0,
    outboxFailedDueCount: 0,
    outboxStaleProcessingCount: 0,
    processingIssueCount: 0,
    refundDecisionMissingCount: 0,
    refundCompletionMismatchCount: 0,
    returnInstructionMissingCount: 0,
    vendorNotificationMissingCount: 0,
    completionNotificationMissingCount: 0,
    rejectedWithoutReasonCount: 0,
    shopifyExternalRecordMissingCount: 0,
    legacyLocaleMissingCount: 0,
    publishedLegalBundleCount: 1,
    ...overrides,
  };
}

function launchIntegrity(overrides = {}) {
  return {
    heartbeat: {
      available: true,
      row: { lastSucceededAt: NOW },
      error: null,
      minutesSinceSuccess: 0,
      stale: false,
      failureUnresolved: false,
    },
    sellerOrderShadow: { available: true, unresolvedCount: 0 },
    ledgerRepairs: { available: true, productionCount: 0, testCount: 0 },
    testStores: { count: 2, pendingPayoutRunCount: 0 },
    ...overrides,
  };
}

function reportWithStatus(overallStatus) {
  return { overallStatus, checks: [] };
}

function find(checks, id) {
  const check = checks.find((candidate) => candidate.id === id);
  assert.ok(check, `missing check: ${id}`);
  return check;
}

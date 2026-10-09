import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { inspectMaintenanceReadiness } from "../../app/services/maintenanceReadiness.server.js";

const NOW = new Date("2026-10-10T01:00:00Z");
function fixture() {
  const env = {
    AUTONOMOUS_MAINTENANCE_AUTHORIZATION:
      "OWNER_APPROVED_ROUTINE_DEV_PATCHES_V1",
    SHOPIFY_PRIMARY_SHOP_DOMAIN: "test.myshopify.com",
    RENDER_GIT_COMMIT: "a".repeat(40),
    SHOPIFY_APP_VERSION: "test-version",
    PRODUCTION_INTEGRITY_MONITOR_ENABLED: "true",
    LAUNCH_MONITOR_ENABLED: "true",
    LAUNCH_MONITOR_DELIVERY_PROOF_REQUIRED: "true",
    MAINTENANCE_BACKUP_CHECK_ENABLED: "true",
    MAINTENANCE_SCHEDULER: "render",
    LAUNCH_MONITOR_RENDER_TOKEN: "render-".repeat(6),
    LAUNCH_MONITOR_TOKEN: "github-".repeat(6),
    PRIVACY_HASH_SECRET: "secret-".repeat(6),
    RESEND_API_KEY: "fake",
    MAIL_FROM: "sender@example.test",
    ADMIN_EMAIL: "receiver@example.test",
  };
  const monitor = {
    metadataJson: {
      lastOverallStatus: "healthy",
      lastCheckedAt: NOW.toISOString(),
      lastHeavyCheckedAt: NOW.toISOString(),
      lastExternalCheckedAt: NOW.toISOString(),
      lastReport: {
        checks: [{ id: "render_backup_recovery", severity: "ok" }],
      },
    },
  };
  const receipt = {
    metadataJson: {
      status: "VERIFIED",
      humanVerifiedAt: NOW.toISOString(),
      verifiedBy: "operator",
      sentAt: NOW.toISOString(),
      routingFingerprint: crypto
        .createHmac("sha256", env.PRIVACY_HASH_SECRET)
        .update(JSON.stringify([env.MAIL_FROM, env.ADMIN_EMAIL]))
        .digest("hex"),
      providerEvent: "delivered",
      providerCheckedAt: NOW.toISOString(),
    },
  };
  const prismaClient = {
    operationalHeartbeat: {
      findUnique: async ({ where }) =>
        where.key === "production_integrity_monitor"
          ? monitor
          : where.key === "launch_monitor_notification_receipt"
            ? receipt
            : null,
    },
    productionTransactionProbe: { count: async () => 0 },
    $queryRaw: async () => [{ migration_name: "20261008090000_test" }],
  };
  return {
    env,
    monitor,
    receipt,
    options: {
      env,
      prismaClient,
      now: NOW,
      migrationNames: ["20261008090000_test"],
    },
  };
}
test("automatic maintenance requires explicit authorization, fresh checks, receipt, schema and no active transaction", async () => {
  assert.equal(
    (await inspectMaintenanceReadiness(fixture().options)).ready,
    true,
  );
  for (const change of [
    (f) => delete f.env.AUTONOMOUS_MAINTENANCE_AUTHORIZATION,
    (f) => delete f.env.RENDER_GIT_COMMIT,
    (f) => (f.env.LAUNCH_MONITOR_DELIVERY_PROOF_REQUIRED = "false"),
    (f) => (f.monitor.metadataJson.lastOverallStatus = "warning"),
    (f) => (f.monitor.metadataJson.lastCheckedAt = "invalid"),
    (f) => (f.monitor.metadataJson.lastHeavyCheckedAt = "invalid"),
    (f) => (f.monitor.metadataJson.lastHeavyCheckedAt = "2026-10-10T00:00:00Z"),
    (f) => (f.receipt.metadataJson.status = "PENDING"),
    (f) => (f.env.MAINTENANCE_BACKUP_CHECK_ENABLED = "false"),
    (f) => (f.env.LAUNCH_MONITOR_RENDER_TOKEN = f.env.LAUNCH_MONITOR_TOKEN),
    (f) => (f.monitor.metadataJson.lastExternalCheckedAt = "invalid"),
    (f) => (f.monitor.metadataJson.lastReport.checks = []),
    (f) =>
      (f.options.prismaClient.productionTransactionProbe.count = async () => 1),
    (f) => (f.options.prismaClient.$queryRaw = async () => []),
    (f) =>
      (f.options.prismaClient.$queryRaw = async () => {
        throw new Error("private database error");
      }),
  ]) {
    const f = fixture();
    change(f);
    const result = await inspectMaintenanceReadiness(f.options);
    assert.equal(result.ready, false);
    assert.ok(!JSON.stringify(result).includes("private database error"));
  }
});

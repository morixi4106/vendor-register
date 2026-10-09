import fs from "node:fs";
import path from "node:path";
import prisma from "../db.server.js";
import { getMonitorReceiptStatus } from "./monitorNotification.server.js";

export async function inspectMaintenanceReadiness({
  prismaClient = prisma,
  env = process.env,
  now = new Date(),
  migrationNames,
} = {}) {
  const reasons = [];
  if (
    env.AUTONOMOUS_MAINTENANCE_AUTHORIZATION !==
    "OWNER_APPROVED_ROUTINE_DEV_PATCHES_V1"
  )
    reasons.push("maintenance_not_authorized");
  if (
    !env.SHOPIFY_PRIMARY_SHOP_DOMAIN ||
    !/^[0-9a-f]{40}$/.test(env.RENDER_GIT_COMMIT || "") ||
    !env.SHOPIFY_APP_VERSION
  )
    reasons.push("release_not_configured");
  if (
    env.PRODUCTION_INTEGRITY_MONITOR_ENABLED !== "true" ||
    env.LAUNCH_MONITOR_ENABLED !== "true" ||
    env.LAUNCH_MONITOR_DELIVERY_PROOF_REQUIRED !== "true"
  )
    reasons.push("monitor_not_required");
  if (env.MAINTENANCE_BACKUP_CHECK_ENABLED !== "true")
    reasons.push("backup_not_required");
  if (
    env.MAINTENANCE_SCHEDULER !== "render" ||
    String(env.LAUNCH_MONITOR_RENDER_TOKEN || "").length < 32 ||
    String(env.LAUNCH_MONITOR_TOKEN || "").length < 32 ||
    env.LAUNCH_MONITOR_RENDER_TOKEN === env.LAUNCH_MONITOR_TOKEN
  )
    reasons.push("monitor_credentials_not_separated");
  try {
    const monitor = await prismaClient.operationalHeartbeat.findUnique({
      where: { key: "production_integrity_monitor" },
    });
    const m = monitor?.metadataJson;
    const age = now - new Date(m?.lastCheckedAt || 0);
    const heavyAge = now - new Date(m?.lastHeavyCheckedAt || 0);
    const externalAge = now - new Date(m?.lastExternalCheckedAt || 0);
    if (
      m?.lastOverallStatus !== "healthy" ||
      !Number.isFinite(age) ||
      age < 0 ||
      age >= 15 * 60_000 ||
      !Number.isFinite(heavyAge) ||
      heavyAge < 0 ||
      heavyAge >= 30 * 60_000
    )
      reasons.push("monitor_not_healthy_or_fresh");
    if (
      !Number.isFinite(externalAge) ||
      externalAge < 0 ||
      externalAge >= 30 * 60_000
    )
      reasons.push("external_monitor_not_fresh");
    if (
      !m?.lastReport?.checks?.some(
        (check) =>
          check.id === "render_backup_recovery" && check.severity === "ok",
      )
    )
      reasons.push("backup_not_verified");
    if (!(await getMonitorReceiptStatus({ prismaClient, env, now })).ready)
      reasons.push("notification_not_verified");
    const pending = await prismaClient.productionTransactionProbe.count({
      where: {
        shopDomain: env.SHOPIFY_PRIMARY_SHOP_DOMAIN,
        status: {
          in: [
            "AWAITING_ORDER",
            "AWAITING_SETTLEMENT",
            "AWAITING_PAYOUT_EVIDENCE",
            "AWAITING_REFUND_RESERVE_CONFIRMATION",
            "AWAITING_REFUND",
          ],
        },
      },
    });
    if (pending !== 0) reasons.push("transaction_probe_pending");
    const expected =
      migrationNames ||
      fs
        .readdirSync(path.resolve("prisma/migrations"))
        .filter((name) => /^\d+_/.test(name));
    const applied =
      await prismaClient.$queryRaw`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    if (
      !expected.length ||
      expected.some(
        (name) => !applied.some((row) => row.migration_name === name),
      )
    )
      reasons.push("migration_pending");
  } catch {
    reasons.push("maintenance_state_unavailable");
  }
  return {
    schemaVersion: 1,
    ready: reasons.length === 0,
    reasons,
    renderCommit: env.RENDER_GIT_COMMIT || null,
    shopifyAppVersion: env.SHOPIFY_APP_VERSION || null,
  };
}

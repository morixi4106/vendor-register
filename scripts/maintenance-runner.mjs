import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendMaintenanceFallback } from "./maintenance-alert.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TASKS = Object.freeze([
  "shopify-product-catalog-sync-agent.mjs",
  "shopify-order-integrity-agent.mjs",
  "launch-monitor-agent.mjs",
  "launch-monitor-deadman.mjs",
]);

export function runMaintenance({
  env = process.env,
  runImpl = spawnSync,
} = {}) {
  if (env.MAINTENANCE_RUNNER_ENABLED !== "true")
    return { ok: true, enabled: false };
  if (env.MAINTENANCE_SCHEDULER !== "render")
    throw new Error("maintenance_scheduler_not_authorized");
  const results = TASKS.map((task) => {
    const result = runImpl(
      process.execPath,
      [path.join(ROOT, "scripts", task)],
      {
        cwd: ROOT,
        env: { ...env, LAUNCH_MONITOR_SOURCE: "render" },
        timeout: 180_000,
        stdio: "inherit",
        windowsHide: true,
      },
    );
    return { task, ok: !result.error && result.status === 0 };
  });
  return { ok: results.every((r) => r.ok), enabled: true, results };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (
      process.argv.length > 3 ||
      (process.argv[2] && process.argv[2] !== "--notification-test")
    )
      throw new Error("unexpected_maintenance_arguments");
    if (process.argv[2] === "--notification-test") {
      const receipt = await sendMaintenanceFallback({ notificationTest: true });
      if (!receipt.sent) throw new Error("notification_test_not_sent");
      console.log(JSON.stringify(receipt));
    } else {
      const result = runMaintenance();
      if (!result.ok) {
        result.fallback = await sendMaintenanceFallback({
          tasks: result.results.filter((r) => !r.ok).map((r) => r.task),
        }).catch(() => ({ sent: false, reason: "fallback_failed" }));
      }
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    }
  } catch {
    console.error("maintenance_runner_failed");
    process.exitCode = 1;
  }
}

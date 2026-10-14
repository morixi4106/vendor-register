import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendMaintenanceFallback } from "./maintenance-alert.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const MAINTENANCE_TASK_BUDGET_MS = 420_000;
export const MAINTENANCE_FALLBACK_BUDGET_MS = 45_000;
const TASKS = Object.freeze([
  { file: "shopify-product-catalog-sync-agent.mjs", timeout: 90_000 },
  { file: "shopify-order-integrity-agent.mjs", timeout: 120_000 },
  { file: "launch-monitor-agent.mjs", timeout: 150_000 },
  { file: "launch-monitor-deadman.mjs", timeout: 45_000 },
]);

export function runMaintenance({
  env = process.env,
  runImpl = spawnSync,
  clock = () => performance.now(),
} = {}) {
  if (env.MAINTENANCE_RUNNER_ENABLED !== "true")
    return { ok: true, enabled: false };
  if (env.MAINTENANCE_SCHEDULER !== "render")
    throw new Error("maintenance_scheduler_not_authorized");
  const startedAt = clock();
  const results = TASKS.map(({ file: task, timeout: taskTimeout }, index) => {
    // Reserve time for later integrity and deadman checks even after a slow sync.
    const reserved = TASKS.slice(index + 1).reduce(
      (sum, next) => sum + next.timeout,
      0,
    );
    const remaining = MAINTENANCE_TASK_BUDGET_MS - (clock() - startedAt);
    const timeout = Math.floor(Math.min(taskTimeout, remaining - reserved));
    if (!(timeout > 0))
      return { task, ok: false, reason: "run_budget_exhausted", durationMs: 0 };
    const taskStartedAt = clock();
    try {
      const result = runImpl(
        process.execPath,
        [path.join(ROOT, "scripts", task)],
        {
          cwd: ROOT,
          env: { ...env, LAUNCH_MONITOR_SOURCE: "render" },
          timeout,
          killSignal: "SIGKILL",
          stdio: "inherit",
          windowsHide: true,
        },
      );
      const ok = !result.error && result.status === 0;
      return {
        task,
        ok,
        reason: ok
          ? null
          : result.error?.code === "ETIMEDOUT"
            ? "task_timeout"
            : "task_failed",
        durationMs: Math.max(0, Math.floor(clock() - taskStartedAt)),
      };
    } catch {
      return {
        task,
        ok: false,
        reason: "task_spawn_failed",
        durationMs: Math.max(0, Math.floor(clock() - taskStartedAt)),
      };
    }
  });
  return {
    ok: results.every((r) => r.ok),
    enabled: true,
    results,
    durationMs: Math.max(0, Math.floor(clock() - startedAt)),
  };
}

export async function runMaintenanceCycle({
  env = process.env,
  runImpl = spawnSync,
  clock = () => performance.now(),
  fallbackImpl = sendMaintenanceFallback,
} = {}) {
  const result = runMaintenance({ env, runImpl, clock });
  if (!result.ok) {
    try {
      result.fallback = await fallbackImpl({
        env,
        tasks: result.results.filter((r) => !r.ok).map((r) => r.task),
        signal: AbortSignal.timeout(MAINTENANCE_FALLBACK_BUDGET_MS),
      });
    } catch {
      result.fallback = { sent: false, reason: "fallback_failed" };
    }
  }
  return result;
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
      const result = await runMaintenanceCycle();
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    }
  } catch {
    console.error("maintenance_runner_failed");
    process.exitCode = 1;
  }
}

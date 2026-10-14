import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  MAINTENANCE_TASK_BUDGET_MS,
  MAINTENANCE_FALLBACK_BUDGET_MS,
  runMaintenance,
  runMaintenanceCycle,
} from "../../scripts/maintenance-runner.mjs";

const ENV = {
  MAINTENANCE_RUNNER_ENABLED: "true",
  MAINTENANCE_SCHEDULER: "render",
};

test("maintenance runner is off by default and rejects an unapproved scheduler", () => {
  assert.equal(runMaintenance({ env: {} }).enabled, false);
  assert.throws(
    () => runMaintenance({ env: { MAINTENANCE_RUNNER_ENABLED: "true" } }),
    /not_authorized/,
  );
});
test("maintenance tasks are fixed, serial and bounded; later checks continue after failures", () => {
  const calls = [];
  const result = runMaintenance({
    env: {
      MAINTENANCE_RUNNER_ENABLED: "true",
      MAINTENANCE_SCHEDULER: "render",
    },
    runImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: calls.length === 1 ? 1 : 0 };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 4);
  assert.ok(
    calls.every(
      (c) =>
        c.options.timeout <= 150_000 &&
        c.options.killSignal === "SIGKILL" &&
        c.options.env.LAUNCH_MONITOR_SOURCE === "render",
    ),
  );
  assert.ok(
    calls.reduce((sum, c) => sum + c.options.timeout, 0) <=
      MAINTENANCE_TASK_BUDGET_MS,
  );
  assert.ok(
    MAINTENANCE_TASK_BUDGET_MS + MAINTENANCE_FALLBACK_BUDGET_MS < 8 * 60_000,
  );
  assert.equal(
    runMaintenance({
      env: {
        MAINTENANCE_RUNNER_ENABLED: "true",
        MAINTENANCE_SCHEDULER: "render",
      },
      runImpl: () => ({ status: 0 }),
    }).ok,
    true,
  );
});

test("timeouts and thrown spawn errors cannot stop subsequent monitoring or leak raw errors", () => {
  let time = 0;
  const calls = [];
  const result = runMaintenance({
    env: ENV,
    clock: () => time,
    runImpl: (command, args, options) => {
      calls.push(args[0]);
      time += options.timeout;
      if (calls.length === 1)
        return {
          error: { code: "ETIMEDOUT", message: "secret payload" },
          status: null,
        };
      if (calls.length === 2) throw new Error("secret payload");
      return { status: 0 };
    },
  });
  assert.equal(calls.length, 4);
  assert.equal(result.ok, false);
  assert.equal(result.results[0].reason, "task_timeout");
  assert.equal(result.results[1].reason, "task_spawn_failed");
  assert.ok(result.results.slice(2).every((r) => r.ok));
  assert.ok(result.durationMs < MAINTENANCE_TASK_BUDGET_MS);
  assert.ok(!JSON.stringify(result).includes("secret payload"));
});

test("a real timed-out child is killed and subsequent checks still complete", () => {
  let calls = 0;
  const result = runMaintenance({
    env: ENV,
    runImpl: (command, args, options) => {
      const source =
        ++calls === 1
          ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
          : "";
      return spawnSync(command, ["-e", source], { ...options, timeout: 200 });
    },
  });
  assert.equal(calls, 4);
  assert.equal(result.results[0].reason, "task_timeout");
  assert.ok(result.results.slice(1).every((r) => r.ok));
});

test("the global deadline reserves later checks and never starts a process with an exhausted budget", () => {
  let reads = 0;
  const calls = [];
  const result = runMaintenance({
    env: ENV,
    clock: () => (++reads === 1 ? 0 : 110_000),
    runImpl: (command, args, options) => {
      calls.push({ args, timeout: options.timeout });
      return { status: 0 };
    },
  });
  assert.equal(result.results[0].reason, "run_budget_exhausted");
  assert.equal(calls.length, 3);
  assert.ok(calls[0].args[0].endsWith("shopify-order-integrity-agent.mjs"));
  assert.equal(calls[0].timeout, 115_000);
  reads = 0;
  const exhausted = runMaintenance({
    env: ENV,
    clock: () => (++reads === 1 ? 0 : 500_000),
    runImpl: () => assert.fail("No task may start after the deadline"),
  });
  assert.equal(exhausted.ok, false);
  assert.ok(
    exhausted.results.every((r) => r.reason === "run_budget_exhausted"),
  );
});

test("fallback follows all fixed tasks, uses the caller environment and reports its own failure", async () => {
  const calls = [];
  const result = await runMaintenanceCycle({
    env: ENV,
    runImpl: () => {
      calls.push("task");
      return { status: calls.length === 1 ? 1 : 0 };
    },
    fallbackImpl: async ({ env, tasks, signal }) => {
      assert.equal(calls.length, 4);
      assert.equal(env, ENV);
      assert.deepEqual(tasks, ["shopify-product-catalog-sync-agent.mjs"]);
      assert.ok(signal instanceof AbortSignal);
      throw new Error("private provider error");
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.fallback, { sent: false, reason: "fallback_failed" });
  assert.ok(!JSON.stringify(result).includes("private provider error"));
  for (const env of [{}, ENV]) {
    const clean = await runMaintenanceCycle({
      env,
      runImpl: () => ({ status: 0 }),
      fallbackImpl: () =>
        assert.fail("No alert for an inactive or successful cycle"),
    });
    assert.equal(clean.ok, true);
  }
});

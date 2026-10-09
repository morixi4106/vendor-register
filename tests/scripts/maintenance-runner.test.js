import assert from "node:assert/strict";
import test from "node:test";
import { runMaintenance } from "../../scripts/maintenance-runner.mjs";

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
        c.options.timeout === 180_000 &&
        c.options.env.LAUNCH_MONITOR_SOURCE === "render",
    ),
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

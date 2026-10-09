import assert from "node:assert/strict";
import test from "node:test";
import { sendMaintenanceFallback } from "../../scripts/maintenance-alert.mjs";

test("fallback alerts are opt-in, contain no raw logs and are deduplicated", async () => {
  assert.equal((await sendMaintenanceFallback({ env: {} })).reason, "disabled");
  const env = {
    MAINTENANCE_ALERTS_ENABLED: "true",
    GITHUB_REPOSITORY: "owner/repo",
    MAINTENANCE_GITHUB_ALERT_TOKEN: "test-token-".repeat(4),
  };
  await assert.rejects(
    sendMaintenanceFallback({
      env: { ...env, GITHUB_REPOSITORY: "bad/repo/path" },
    }),
    /not_configured/,
  );
  await assert.rejects(
    sendMaintenanceFallback({ env, tasks: ["arbitrary-private-log"] }),
    /tasks_invalid/,
  );
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => (options.method === "POST" ? { number: 42 } : []),
    };
  };
  const result = await sendMaintenanceFallback({
    env,
    tasks: ["launch-monitor-agent.mjs"],
    fetchImpl,
  });
  assert.equal(result.issue, 42);
  assert.ok(
    !calls[1].options.body.includes(env.MAINTENANCE_GITHUB_ALERT_TOKEN),
  );
  assert.ok(calls[1].options.body.includes("/ack-maintenance"));
  const now = new Date();
  const suppressed = await sendMaintenanceFallback({
    env,
    now,
    fetchImpl: async () => ({
      ok: true,
      json: async () => [
        {
          number: 42,
          body: "<!-- maintenance-render-runner -->",
          updated_at: now.toISOString(),
        },
      ],
    }),
  });
  assert.equal(suppressed.reason, "deduplicated");
  await assert.rejects(
    sendMaintenanceFallback({ env, fetchImpl: async () => ({ ok: false }) }),
    /request_failed/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { buildLaunchMonitorGuide } from "../../app/services/launchMonitorGuide.js";

test("disabled monitor guides the operator through launch preparation", () => {
  const guide = buildLaunchMonitorGuide({ enabled: false });
  assert.equal(guide.tone, "waiting");
  assert.deepEqual(
    guide.steps.map((step) => step.id),
    ["production-readiness", "open-storefront", "activate-monitor"],
  );
});

test("critical checks produce ordered deterministic actions", () => {
  const guide = buildLaunchMonitorGuide({
    enabled: true,
    metadata: {
      lastCheckedAt: "2026-07-18T00:00:00.000Z",
      lastReport: {
        checks: [
          { id: "contact_inquiry_spike", severity: "warning" },
          { id: "withdrawal_email_outbox", severity: "critical" },
        ],
      },
    },
  });
  assert.equal(guide.tone, "critical");
  assert.equal(guide.steps[0].id, "withdrawal_email_outbox");
  assert.equal(guide.steps[0].href, "/app/withdrawals");
});

test("healthy and completed campaigns do not invent repair work", () => {
  const healthy = buildLaunchMonitorGuide({
    enabled: true,
    metadata: {
      lastCheckedAt: "2026-07-18T00:00:00.000Z",
      lastReport: { checks: [{ id: "database_connection", severity: "ok" }] },
    },
  });
  assert.equal(healthy.tone, "healthy");
  assert.equal(healthy.steps.length, 0);

  const completed = buildLaunchMonitorGuide({
    enabled: false,
    metadata: { completedAt: "2026-07-21T00:00:00.000Z" },
  });
  assert.equal(completed.tone, "healthy");
  assert.equal(completed.steps[0].href, "/app/production-readiness");
});

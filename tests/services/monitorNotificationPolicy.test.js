import assert from "node:assert/strict";
import test from "node:test";
import {
  automaticMonitorNotificationsEnabled,
  resolveMonitorNotificationMode,
} from "../../app/services/monitorNotificationPolicy.js";

test("live automatic notifications need exact explicit opt-in", () => {
  for (const mode of [
    undefined,
    "",
    "prelaunch",
    "paused",
    "LIVE",
    "invalid",
    true,
  ])
    assert.equal(
      automaticMonitorNotificationsEnabled({
        LAUNCH_MONITOR_NOTIFICATION_MODE: mode,
      }),
      false,
    );
  assert.equal(resolveMonitorNotificationMode({}), "prelaunch");
  assert.equal(
    resolveMonitorNotificationMode({
      LAUNCH_MONITOR_NOTIFICATION_MODE: "invalid",
    }),
    "paused",
  );
  assert.equal(
    automaticMonitorNotificationsEnabled({
      LAUNCH_MONITOR_NOTIFICATION_MODE: "live",
    }),
    true,
  );
});

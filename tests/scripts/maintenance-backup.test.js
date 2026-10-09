import assert from "node:assert/strict";
import test from "node:test";
import { inspectBackupAvailability } from "../../scripts/maintenance-backup.mjs";

test("backup checks are read-only and never download or claim a tested restore", async () => {
  const env = {
    MAINTENANCE_BACKUP_CHECK_ENABLED: "true",
    RENDER_POSTGRES_ID: "dpg-example-a",
    RENDER_API_KEY: "fake",
  };
  const now = new Date("2026-10-10T00:00:00Z");
  const result = await inspectBackupAvailability({
    env,
    now,
    fetchImpl: async (url, options) => {
      assert.equal(options.method, "GET");
      assert.ok(url.endsWith("/recovery"));
      return {
        ok: true,
        json: async () => ({
          recoveryStatus: "AVAILABLE",
          startsAt: "2026-10-07T00:00:00Z",
          downloadUrl: "private",
        }),
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.windowHours, 72);
  assert.equal(result.restorationTested, false);
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.equal((await inspectBackupAvailability({ env: {} })).ok, false);
  assert.equal(
    (
      await inspectBackupAvailability({
        env: { ...env, RENDER_POSTGRES_ID: "../../bad" },
      })
    ).ok,
    false,
  );
  for (const data of [
    { recoveryStatus: "UNAVAILABLE", startsAt: "2026-10-07T00:00:00Z" },
    { recoveryStatus: "AVAILABLE", startsAt: "invalid" },
    { recoveryStatus: "AVAILABLE", startsAt: "2026-10-10T00:00:00Z" },
  ])
    assert.equal(
      (
        await inspectBackupAvailability({
          env,
          now,
          fetchImpl: async () => ({ ok: true, json: async () => data }),
        })
      ).ok,
      false,
    );
  assert.equal(
    (
      await inspectBackupAvailability({
        env,
        fetchImpl: async () => {
          throw new Error("secret");
        },
      })
    ).code,
    "backup_check_unavailable",
  );
});

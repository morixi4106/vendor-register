import assert from "node:assert/strict";
import test from "node:test";
import {
  acknowledgeMonitorIncident,
  confirmMonitorReceipt,
  getMonitorAcknowledgement,
  getMonitorReceiptStatus,
  MONITOR_ACK_KEY,
  MONITOR_NOTIFICATION_KEY,
  refreshMonitorReceipt,
  sendMonitorReceiptTest,
  recordMonitorMailAccepted,
} from "../../app/services/monitorNotification.server.js";

const NOW = new Date("2026-10-10T01:00:00Z");
const ENV = {
  PRIVACY_HASH_SECRET: "receipt-secret-".repeat(4),
  RESEND_API_KEY: "test-key",
  MAIL_FROM: "sender@example.test",
  ADMIN_EMAIL: "recipient@example.test",
};
function fixture() {
  const rows = new Map();
  const sent = [];
  let event = "delivered";
  const client = {
    operationalHeartbeat: {
      async upsert({ where, create }) {
        if (!rows.has(where.key)) rows.set(where.key, structuredClone(create));
        return structuredClone(rows.get(where.key));
      },
      async findUnique({ where }) {
        return structuredClone(rows.get(where.key) || null);
      },
      async updateMany({ where, data }) {
        const row = rows.get(where.key);
        if (
          !row ||
          JSON.stringify(row.metadataJson) !==
            JSON.stringify(where.metadataJson.equals)
        )
          return { count: 0 };
        rows.set(where.key, { ...row, ...structuredClone(data) });
        return { count: 1 };
      },
    },
  };
  const options = {
    prismaClient: client,
    env: ENV,
    now: NOW,
    sendImpl: async (message) => {
      sent.push(message);
      return { data: { id: "message-1" } };
    },
    getEmailImpl: async (id) => ({
      data: {
        id,
        last_event: event,
        to: ["private@example.test"],
        html: "private body",
      },
    }),
  };
  return {
    rows,
    sent,
    options,
    setEvent: (value) => {
      event = value;
    },
    code: () => sent[0].text.match(/code: (\d{6})/)[1],
  };
}

test("send acceptance and provider delivery are not human receipt proof", async () => {
  const f = fixture();
  await sendMonitorReceiptTest(f.options);
  assert.equal((await getMonitorReceiptStatus(f.options)).ready, false);
  await refreshMonitorReceipt(f.options);
  assert.equal((await getMonitorReceiptStatus(f.options)).ready, false);
  await confirmMonitorReceipt({
    ...f.options,
    code: f.code(),
    actor: "operator-1",
  });
  assert.equal((await getMonitorReceiptStatus(f.options)).ready, true);
  const stored = JSON.stringify([...f.rows.values()]);
  for (const value of [
    f.code(),
    ENV.ADMIN_EMAIL,
    ENV.PRIVACY_HASH_SECRET,
    "private body",
    "private@example.test",
  ])
    assert.ok(!stored.includes(value));
});

test("old delivered messages cannot masquerade as fresh delivery; a new proof can replace a failed route", async () => {
  const f = fixture();
  await sendMonitorReceiptTest(f.options);
  await refreshMonitorReceipt(f.options);
  await confirmMonitorReceipt({
    ...f.options,
    actor: "operator",
    code: f.code(),
  });
  const later = new Date(NOW.getTime() + 9 * 86400_000);
  await refreshMonitorReceipt({ ...f.options, now: later });
  assert.equal(
    (await getMonitorReceiptStatus({ ...f.options, now: later })).ready,
    false,
  );
  await recordMonitorMailAccepted({
    ...f.options,
    messageId: "later-message",
    now: new Date(NOW.getTime() + 86400_000),
  });
  f.setEvent("bounced");
  await refreshMonitorReceipt({
    ...f.options,
    now: new Date(NOW.getTime() + 86400_000),
  });
  assert.equal((await getMonitorReceiptStatus(f.options)).ready, false);
  await sendMonitorReceiptTest({ ...f.options, now: later });
  f.setEvent("delivered");
  await refreshMonitorReceipt({ ...f.options, now: later });
  await confirmMonitorReceipt({
    ...f.options,
    now: later,
    actor: "operator",
    code: f.sent.at(-1).text.match(/code: (\d{6})/)[1],
  });
  assert.equal(
    (await getMonitorReceiptStatus({ ...f.options, now: later })).ready,
    true,
  );
});

test("wrong confirmation codes are bounded and cannot be replayed", async () => {
  const f = fixture();
  await sendMonitorReceiptTest(f.options);
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      confirmMonitorReceipt({ ...f.options, actor: "operator", code: "bad" }),
      /invalid/,
    );
  await assert.rejects(
    confirmMonitorReceipt({ ...f.options, actor: "operator", code: f.code() }),
    /unavailable/,
  );
});

test("confirmation expires after seven days and requires an actor", async () => {
  const f = fixture();
  await sendMonitorReceiptTest(f.options);
  await assert.rejects(
    confirmMonitorReceipt({ ...f.options, code: f.code() }),
    /actor_required/,
  );
  await assert.rejects(
    confirmMonitorReceipt({
      ...f.options,
      code: f.code(),
      actor: "operator",
      now: new Date(NOW.getTime() + 7 * 86400_000),
    }),
    /unavailable/,
  );
});

test("a routing change invalidates a previously confirmed receipt", async () => {
  const f = fixture();
  await sendMonitorReceiptTest(f.options);
  await refreshMonitorReceipt(f.options);
  await confirmMonitorReceipt({
    ...f.options,
    actor: "operator",
    code: f.code(),
  });
  assert.equal(
    (
      await getMonitorReceiptStatus({
        ...f.options,
        env: { ...ENV, ADMIN_EMAIL: "changed@example.test" },
      })
    ).ready,
    false,
  );
  await assert.rejects(
    confirmMonitorReceipt({ ...f.options, actor: "operator", code: f.code() }),
    /unavailable/,
  );
});

test("delivery failure is sticky even if a later event says delivered", async () => {
  const f = fixture();
  await sendMonitorReceiptTest(f.options);
  await refreshMonitorReceipt(f.options);
  await confirmMonitorReceipt({
    ...f.options,
    actor: "operator",
    code: f.code(),
  });
  f.setEvent("bounced");
  await refreshMonitorReceipt(f.options);
  f.setEvent("delivered");
  await refreshMonitorReceipt(f.options);
  assert.equal(
    (await getMonitorReceiptStatus(f.options)).status,
    "DELIVERY_FAILED",
  );
});

test("provider outages and wrong message IDs cannot prove delivery", async () => {
  const f = fixture();
  await sendMonitorReceiptTest(f.options);
  await confirmMonitorReceipt({
    ...f.options,
    code: f.code(),
    actor: "operator",
  });
  await refreshMonitorReceipt({
    ...f.options,
    getEmailImpl: async () => {
      throw new Error("secret provider error");
    },
  });
  assert.equal((await getMonitorReceiptStatus(f.options)).ready, false);
  await refreshMonitorReceipt({
    ...f.options,
    getEmailImpl: async () => ({
      data: { id: "other", last_event: "delivered" },
    }),
  });
  assert.equal((await getMonitorReceiptStatus(f.options)).ready, false);
});

test("concurrent sends reserve one challenge and enforce the cooldown", async () => {
  const f = fixture();
  const results = await Promise.allSettled([
    sendMonitorReceiptTest(f.options),
    sendMonitorReceiptTest(f.options),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.sent.length, 1);
  await assert.rejects(sendMonitorReceiptTest(f.options), /rate_limited/);
});

test("provider send failures are redacted and do not leave a success receipt", async () => {
  const f = fixture();
  await assert.rejects(
    sendMonitorReceiptTest({
      ...f.options,
      sendImpl: async () => ({ error: { message: "SECRET" } }),
    }),
    /notification_test_send_failed/,
  );
  assert.equal(
    f.rows.get(MONITOR_NOTIFICATION_KEY).metadataJson.status,
    "SEND_FAILED",
  );
  assert.equal((await getMonitorReceiptStatus(f.options)).ready, false);
});

test("acknowledgement starts the seven-day response window but never extends it", async () => {
  const f = fixture();
  const incidentKey = "a".repeat(24);
  f.rows.set("production_integrity_monitor", {
    metadataJson: {
      incidentKey,
      currentStatus: "critical",
      firstDetectedAt: NOW.toISOString(),
    },
  });
  const result = await acknowledgeMonitorIncident({
    ...f.options,
    actor: "operator",
    incidentKey,
  });
  assert.equal(result.responseDueAt, "2026-10-17T01:00:00.000Z");
  await acknowledgeMonitorIncident({
    ...f.options,
    actor: "operator",
    incidentKey,
    now: new Date(NOW.getTime() + 86400_000),
  });
  assert.equal(
    f.rows.get(MONITOR_ACK_KEY).metadataJson.responseDueAt,
    result.responseDueAt,
  );
  assert.equal(
    (
      await getMonitorAcknowledgement({
        ...f.options,
        incidentKey,
        now: new Date(result.responseDueAt),
      })
    ).overdue,
    true,
  );
  assert.equal(
    (
      await getMonitorAcknowledgement({
        ...f.options,
        incidentKey: "b".repeat(24),
      })
    ).acknowledged,
    false,
  );
  await assert.rejects(
    acknowledgeMonitorIncident({
      ...f.options,
      actor: "operator",
      incidentKey: "b".repeat(24),
    }),
    /changed/,
  );
  f.rows.get("production_integrity_monitor").metadataJson.firstDetectedAt =
    "2026-10-20T00:00:00Z";
  assert.equal(
    (await getMonitorAcknowledgement({ ...f.options, incidentKey }))
      .acknowledged,
    false,
  );
});

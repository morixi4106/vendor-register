import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Webhook } from "standardwebhooks";

import { handleMonitorDeliveryWebhook } from "../../app/services/monitorDeliveryWebhook.server.js";

const SECRET = "whsec_" + crypto.randomBytes(32).toString("base64");
const ENV = { RESEND_MONITOR_WEBHOOK_SECRET: SECRET };
function signed(event, { timestamp = new Date(), payload } = {}) {
  const body = payload || JSON.stringify(event);
  const id = "evt-unit-test";
  return new Request("https://example.test/webhooks/monitor-delivery", {
    method: "POST",
    body,
    headers: {
      "svix-id": id,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": new Webhook(SECRET).sign(id, timestamp, body),
    },
  });
}
const EVENT = {
  type: "email.delivered",
  data: {
    email_id: "message-1",
    to: ["private@example.test"],
    subject: "private subject",
  },
};

test("the existing Resend SDK verifies signatures and passes only minimal event data", async () => {
  let captured;
  const result = await handleMonitorDeliveryWebhook(signed(EVENT), {
    env: ENV,
    recordImpl: async (input) => {
      captured = input;
      return { applied: true };
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(Object.keys(captured).sort(), [
    "env",
    "messageId",
    "providerEvent",
    "webhookId",
  ]);
  assert.equal(captured.providerEvent, "delivered");
  assert.ok(!JSON.stringify(captured).includes("private@example.test"));
  assert.ok(!JSON.stringify(captured).includes("private subject"));
});

test("missing, tampered, wrong-key and expired signatures never reach the DB", async () => {
  const missing = new Request("https://example.test", {
    method: "POST",
    body: JSON.stringify(EVENT),
  });
  const tampered = signed(EVENT);
  tampered.headers.set("svix-signature", "v1,invalid");
  const old = signed(EVENT, { timestamp: new Date(Date.now() - 10 * 60_000) });
  for (const request of [missing, tampered, old]) {
    const result = await handleMonitorDeliveryWebhook(request, {
      env: ENV,
      recordImpl: () => assert.fail("Unverified event cannot touch the DB"),
    });
    assert.equal(result.status, 401);
  }
  assert.equal(
    (
      await handleMonitorDeliveryWebhook(signed(EVENT), {
        env: {
          RESEND_MONITOR_WEBHOOK_SECRET:
            "whsec_" + crypto.randomBytes(32).toString("base64"),
        },
        recordImpl: () => assert.fail("Wrong key cannot touch the DB"),
      })
    ).status,
    401,
  );
});

test("disabled endpoints and unsupported methods fail closed", async () => {
  const options = {
    env: {},
    recordImpl: () => assert.fail("No database changes"),
  };
  assert.equal(
    (await handleMonitorDeliveryWebhook(signed(EVENT), options)).status,
    503,
  );
  assert.equal(
    (
      await handleMonitorDeliveryWebhook(
        new Request("https://example.test"),
        options,
      )
    ).status,
    405,
  );
});

test("non-monitor events are ignored and malformed email IDs are rejected", async () => {
  const options = {
    env: ENV,
    recordImpl: () => assert.fail("No database changes"),
  };
  assert.equal(
    (
      await handleMonitorDeliveryWebhook(
        signed({ type: "contact.created", data: {} }),
        options,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await handleMonitorDeliveryWebhook(
        signed({ type: "email.delivered", data: { email_id: "bad/id" } }),
        options,
      )
    ).status,
    400,
  );
});

test("oversized bodies are stopped before signature verification", async () => {
  await assert.rejects(
    handleMonitorDeliveryWebhook(
      signed(EVENT, { payload: "x".repeat(64_001) }),
      {
        env: ENV,
        verifyImpl: () => assert.fail("Oversized request cannot be verified"),
      },
    ),
    (error) => error instanceof Response && error.status === 413,
  );
});

test("sending races and DB conflicts return retryable failures without private errors", async () => {
  for (const recordImpl of [
    async () => ({ retry: true }),
    async () => {
      throw new Error("private database failure");
    },
  ]) {
    const response = await handleMonitorDeliveryWebhook(signed(EVENT), {
      env: ENV,
      recordImpl,
    });
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes("private database failure"));
  }
});

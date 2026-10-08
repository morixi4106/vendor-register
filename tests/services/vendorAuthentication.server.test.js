import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeVendorLoginCode,
  findVendorAdminSession,
  hashVendorSessionToken,
  issueVendorLoginCode,
} from "../../app/services/vendorAuthentication.server.js";

const env = { PRIVACY_HASH_SECRET: "b".repeat(64) };
const now = new Date("2026-10-08T00:00:00Z");

function fakeAuthDatabase() {
  const challenges = [],
    sessions = [];
  const database = {
    vendorLoginCode: {
      updateMany: async ({ where, data }) => {
        const rows = challenges.filter(
          (row) =>
            (!where.id || row.id === where.id) &&
            (!where.vendorId || row.vendorId === where.vendorId) &&
            row.usedAt == null &&
            (where.attempts == null || row.attempts === where.attempts) &&
            (!where.expiresAt || row.expiresAt > where.expiresAt.gt),
        );
        for (const row of rows) {
          if (data.usedAt) row.usedAt = data.usedAt;
          if (data.attempts) row.attempts += data.attempts.increment;
        }
        return { count: rows.length };
      },
      create: async ({ data }) => {
        const row = {
          id: String(challenges.length + 1),
          usedAt: null,
          ...data,
        };
        challenges.push(row);
        return row;
      },
      findFirst: async ({ where }) => {
        const row = challenges.findLast(
          (item) =>
            item.vendorId === where.vendorId &&
            item.email === where.email &&
            item.usedAt == null &&
            item.expiresAt > where.expiresAt.gt &&
            item.attempts < where.attempts.lt,
        );
        return row ? { ...row } : null;
      },
    },
    vendorAdminSession: {
      create: async ({ data }) => {
        sessions.push(data);
        return data;
      },
      findUnique: async ({ where }) =>
        sessions.find((row) => row.sessionToken === where.sessionToken),
    },
    $transaction: async (callback) => callback(database),
  };
  return { database, challenges, sessions };
}

test("verification codes and emails are hashed; concurrent use creates one session", async () => {
  const { database, challenges, sessions } = fakeAuthDatabase();
  const options = {
    vendorId: "vendor",
    email: "test@example.com",
    prismaClient: database,
    env,
    now,
  };
  const challenge = await issueVendorLoginCode(options);
  assert.ok(!JSON.stringify(challenges).includes("test@example.com"));
  assert.notEqual(challenges[0].code, challenge.code);
  const results = await Promise.all([
    consumeVendorLoginCode({ ...options, code: challenge.code }),
    consumeVendorLoginCode({ ...options, code: challenge.code }),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(sessions.length, 1);
  const result = results.find(Boolean);
  assert.notEqual(sessions[0].sessionToken, result.sessionToken);
  assert.equal(
    sessions[0].sessionToken,
    hashVendorSessionToken(result.sessionToken),
  );
  assert.equal(
    (
      await findVendorAdminSession(result.sessionToken, {
        prismaClient: database,
        now,
      })
    ).vendorId,
    "vendor",
  );
});

test("five incorrect attempts revoke the code, even when the next attempt is correct", async () => {
  const { database, challenges } = fakeAuthDatabase();
  const options = {
    vendorId: "vendor",
    email: "test@example.com",
    prismaClient: database,
    env,
    now,
  };
  const issued = await issueVendorLoginCode(options);
  const wrong = issued.code === "100000" ? "100001" : "100000";
  for (let attempt = 0; attempt < 5; attempt++)
    assert.equal(
      await consumeVendorLoginCode({ ...options, code: wrong }),
      null,
    );
  assert.equal(challenges[0].attempts, 5);
  assert.ok(challenges[0].usedAt);
  assert.equal(
    await consumeVendorLoginCode({ ...options, code: issued.code }),
    null,
  );
});

test("resending invalidates earlier codes; expiry and another email fail closed", async () => {
  const { database, challenges } = fakeAuthDatabase();
  const options = {
    vendorId: "vendor",
    email: "test@example.com",
    prismaClient: database,
    env,
    now,
  };
  await issueVendorLoginCode(options);
  const current = await issueVendorLoginCode(options);
  assert.ok(challenges[0].usedAt);
  assert.equal(
    await consumeVendorLoginCode({
      ...options,
      email: "other@example.com",
      code: current.code,
    }),
    null,
  );
  assert.equal(
    await consumeVendorLoginCode({
      ...options,
      code: current.code,
      now: new Date(now.getTime() + 10 * 60_000),
    }),
    null,
  );
});

test("invalid and expired session tokens cannot load a session", async () => {
  const { database, sessions } = fakeAuthDatabase();
  const token = "a".repeat(64);
  sessions.push({
    sessionToken: hashVendorSessionToken(token),
    expiresAt: now,
  });
  assert.equal(
    await findVendorAdminSession(token, { prismaClient: database, now }),
    null,
  );
  assert.equal(
    await findVendorAdminSession("short-token", {
      prismaClient: database,
      now,
    }),
    null,
  );
});

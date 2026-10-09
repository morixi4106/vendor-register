import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "@shopify/shopify-api";
import { EncryptedPrismaSessionStorage } from "../../app/utils/encryptedSessionStorage.server.js";

test("Shopify sessions encrypt tokens at rest without changing the SDK session contract", async () => {
  const previous = process.env.PRIVACY_ENCRYPTION_KEY;
  process.env.PRIVACY_ENCRYPTION_KEY = "d".repeat(64);
  const rows = new Map();
  try {
    const storage = new EncryptedPrismaSessionStorage(
      {
        session: {
          count: async () => 0,
          upsert: async ({ where, create }) => rows.set(where.id, create),
          findUnique: async ({ where }) => rows.get(where.id),
          findMany: async () => [...rows.values()],
        },
      },
      { connectionRetries: 1, connectionRetryIntervalMs: 1 },
    );
    const session = new Session({
      id: "offline_shop.myshopify.com",
      shop: "shop.myshopify.com",
      state: "state",
      isOnline: false,
      accessToken: "secret-access-token",
      refreshToken: "secret-refresh-token",
      refreshTokenExpires: new Date("2027-01-01T00:00:00Z"),
      scope: "read_orders",
    });
    await storage.storeSession(session);
    assert.equal(session.accessToken, "secret-access-token");
    assert.ok(
      !JSON.stringify([...rows.values()]).includes("secret-access-token"),
    );
    assert.equal(
      (await storage.loadSession(session.id)).accessToken,
      "secret-access-token",
    );
    assert.equal(
      (await storage.findSessionsByShop(session.shop))[0].refreshToken,
      "secret-refresh-token",
    );
    assert.equal((await storage.loadSession(session.id)).scope, "read_orders");
  } finally {
    if (previous == null) delete process.env.PRIVACY_ENCRYPTION_KEY;
    else process.env.PRIVACY_ENCRYPTION_KEY = previous;
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  getPrivacyContactChannel,
  recordPrivacyContactChannel,
  runPrivacyMaintenance,
  protectLegacyVendorContacts,
} from "../../app/services/privacyOperations.server.js";
import { decryptPrivateValue } from "../../app/utils/privateData.server.js";

test("legacy protection encrypts bounded batches without deleting financial records", async () => {
  const env = {
    PRIVACY_ENCRYPTION_KEY: "a".repeat(64),
    PRIVACY_HASH_SECRET: "b".repeat(64),
  };
  const values = {
    vendorStore: {
      id: "store",
      email: "owner@example.com",
      ownerName: "Owner",
      phone: "123",
      address: "Private address",
      note: null,
      updatedAt: new Date(),
    },
    vendor: {
      id: "vendor",
      managementEmail: "owner@example.com",
      updatedAt: new Date(),
    },
    session: {
      id: "offline_shop",
      accessToken: "offline-access-token",
      refreshToken: "refresh-token",
    },
    contactInquiry: {
      id: "inquiry",
      name: "Buyer",
      email: "buyer@example.com",
      phone: null,
      message: "Private message",
      replyText: "Reply",
    },
    marketplaceOrder: {
      id: "order",
      buyerEmail: "buyer@example.com",
      buyerName: "Buyer",
      totalAmount: 1650,
    },
  };
  const writes = {};
  const prismaClient = Object.fromEntries(
    Object.entries(values).map(([model, row]) => [
      model,
      {
        findMany: async ({ take }) => {
          assert.equal(take, 200);
          return [row];
        },
        updateMany: async (args) => {
          writes[model] = args;
          return { count: model === "vendor" ? 0 : 1 };
        },
      },
    ]),
  );
  prismaClient.$transaction = async (callback, options) => {
    assert.equal(options.isolationLevel, "Serializable");
    return callback(prismaClient);
  };
  const result = await protectLegacyVendorContacts({
    prismaClient,
    env,
    limit: 1000,
  });
  assert.equal(result.protectedStores, 1);
  assert.equal(result.protectedVendors, 0);
  assert.equal(result.protectedOrderContacts, 1);
  assert.equal(
    writes.vendorStore.where.updatedAt,
    values.vendorStore.updatedAt,
  );
  assert.equal(
    decryptPrivateValue(writes.session.data.accessToken, { env }),
    values.session.accessToken,
  );
  assert.equal(
    decryptPrivateValue(writes.contactInquiry.data.message, { env }),
    "Private message",
  );
  assert.equal(
    decryptPrivateValue(writes.marketplaceOrder.data.buyerEmail, { env }),
    "buyer@example.com",
  );
  assert.deepEqual(Object.keys(writes.marketplaceOrder.data).sort(), [
    "buyerEmail",
    "buyerName",
  ]);
});

test("legacy contact intake remains active until both handoff checks are explicitly confirmed", async () => {
  let state = null;
  const prismaClient = {
    operationalHeartbeat: {
      findUnique: async () => state,
      upsert: async ({ create }) => {
        state = create;
      },
    },
  };
  assert.equal(await getPrivacyContactChannel({ prismaClient }), "LEGACY");
  assert.equal(
    (
      await recordPrivacyContactChannel(
        { provider: "SHOPIFY_INBOX", actor: "owner", inboxVerified: true },
        { prismaClient },
      )
    ).ok,
    false,
  );
  assert.equal(state, null);
  assert.equal(
    (
      await recordPrivacyContactChannel(
        {
          provider: "SHOPIFY_INBOX",
          actor: "owner",
          inboxVerified: true,
          contactPageVerified: true,
        },
        { prismaClient },
      )
    ).ok,
    true,
  );
  assert.equal(
    await getPrivacyContactChannel({ prismaClient }),
    "SHOPIFY_INBOX",
  );
});

test("automatic cleanup only deletes expired credentials; inquiry deletion requires explicit mode", async () => {
  let inquiryQueries = 0;
  const deletions = [];
  const prismaClient = {
    operationalHeartbeat: {
      findUnique: async () => null,
      upsert: async () => {},
    },
    vendorLoginCode: {
      findMany: async () => [{ id: "expired-code" }],
      deleteMany: async (args) => {
        deletions.push(args);
        return { count: 1 };
      },
    },
    vendorAdminSession: {
      findMany: async () => [{ id: "expired-session" }],
      deleteMany: async (args) => {
        deletions.push(args);
        return { count: 1 };
      },
    },
    contactInquiry: {
      findMany: async (args) => {
        inquiryQueries++;
        assert.equal(args.where.retentionHold, false);
        assert.equal(args.where.status, "RESOLVED");
        assert.equal(args.take, 200);
        return [{ id: "old-resolved" }];
      },
      deleteMany: async (args) => {
        assert.equal(args.where.retentionHold, false);
        assert.equal(args.where.status, "RESOLVED");
        return { count: 1 };
      },
    },
    $transaction: async (callback) => callback(prismaClient),
  };
  const now = new Date("2026-10-08T12:00:00Z");
  const automatic = await runPrivacyMaintenance({ prismaClient, now });
  assert.equal(automatic.deletedInquiries, 0);
  assert.equal(inquiryQueries, 0);
  assert.equal(
    deletions[0].where.expiresAt.lt.toISOString(),
    "2026-10-08T12:00:00.000Z",
  );
  const approved = await runPrivacyMaintenance({
    prismaClient,
    now,
    pruneResolvedInquiries: true,
  });
  assert.equal(approved.deletedInquiries, 1);
  assert.equal(inquiryQueries, 1);
});

test("daily cleanup skips duplicate automatic runs", async () => {
  const now = new Date();
  const prismaClient = {
    operationalHeartbeat: {
      findUnique: async () => ({ lastSucceededAt: now }),
    },
    $transaction: async (callback) => callback(prismaClient),
  };
  assert.equal(
    (await runPrivacyMaintenance({ prismaClient, now })).skipped,
    true,
  );
});

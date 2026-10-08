import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptPrivateValue,
  encryptPrivateValue,
  omitContactCopies,
  protectContactInquiry,
  protectVendorManagementEmail,
  protectVendorStoreContact,
  readContactInquiry,
  readVendorContacts,
  vendorEmailLookupWhere,
} from "../../app/utils/privateData.server.js";

const env = {
  PRIVACY_ENCRYPTION_KEY: "a".repeat(64),
  PRIVACY_HASH_SECRET: "b".repeat(64),
};

test("private envelopes round-trip Unicode, use independent nonces and reject modification", () => {
  const value = "東京都 テスト名 test@example.com";
  const first = encryptPrivateValue(value, { env });
  assert.notEqual(first, encryptPrivateValue(value, { env }));
  assert.ok(!first.includes("test@example.com"));
  assert.equal(decryptPrivateValue(first, { env }), value);
  const modified = Buffer.from(first.slice("private:v1:".length), "base64url");
  modified[28] ^= 1;
  assert.throws(
    () =>
      decryptPrivateValue("private:v1:" + modified.toString("base64url"), {
        env,
      }),
    /private_data_unavailable/,
  );
  assert.throws(
    () =>
      decryptPrivateValue(first, {
        env: { ...env, PRIVACY_ENCRYPTION_KEY: "c".repeat(64) },
      }),
    /private_data_unavailable/,
  );
  assert.throws(
    () => encryptPrivateValue(value, { env: {} }),
    /privacy_encryption_key_missing/,
  );
  assert.equal(decryptPrivateValue(value), value);
});

test("protected vendor records support email lookup without exposing private fields publicly", () => {
  const store = protectVendorStoreContact(
    {
      storeName: "Store",
      ownerName: "Owner",
      email: "owner@example.com",
      phone: "123",
      address: "Private address",
      note: "Private note",
      publicAddress: "Public address",
    },
    { env },
  );
  const vendor = protectVendorManagementEmail("OWNER@example.com", { env });
  const hydrated = readVendorContacts(
    { ...vendor, vendorStore: store },
    { env },
  );
  assert.equal(hydrated.managementEmail, "owner@example.com");
  assert.equal(hydrated.vendorStore.address, "Private address");
  assert.equal(hydrated.vendorStore.publicAddress, "Public address");
  assert.equal(hydrated.vendorStore.storeName, "Store");
  assert.ok(!Object.hasOwn(hydrated.vendorStore, "emailLookupHash"));
  assert.equal(
    vendorEmailLookupWhere("owner@example.com", { management: true, env }).OR[0]
      .managementEmailLookupHash,
    vendor.managementEmailLookupHash,
  );
});

test("inquiries are encrypted at rest and order evidence drops duplicate contact fields", () => {
  const row = {
    id: "case",
    name: "Name",
    email: "name@example.com",
    phone: null,
    message: "Personal message",
    replyText: "Reply",
    status: "OPEN",
  };
  const protectedRow = protectContactInquiry(row, { env });
  assert.ok(!JSON.stringify(protectedRow).includes("Personal message"));
  assert.deepEqual(readContactInquiry(protectedRow, { env }), row);
  const snapshot = omitContactCopies({
    buyerEmail: "name@example.com",
    buyerName: "Name",
    shippingAddress: { address1: "Street" },
    shopifyOrderId: "order",
    totalAmount: 1650,
    currencyCode: "JPY",
  });
  assert.deepEqual(snapshot, {
    shopifyOrderId: "order",
    totalAmount: 1650,
    currencyCode: "JPY",
  });
});

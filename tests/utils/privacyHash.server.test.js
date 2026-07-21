import assert from "node:assert/strict";
import test from "node:test";

import {
  getPrivacyHashSecret,
  hashPrivateIdentifier,
} from "../../app/utils/privacyHash.server.js";

test("hashPrivateIdentifier creates a stable keyed hash without exposing the source", () => {
  const env = { PRIVACY_HASH_SECRET: "test-secret-with-more-than-thirty-two-characters" };
  const first = hashPrivateIdentifier("203.0.113.8", { env });
  const second = hashPrivateIdentifier("203.0.113.8", { env });

  assert.equal(first, second);
  assert.equal(first.length, 64);
  assert.equal(first.includes("203.0.113.8"), false);
});

test("privacy hash secret prefers the dedicated secret", () => {
  const dedicated = "dedicated-secret-with-at-least-32-characters";
  assert.equal(
    getPrivacyHashSecret({
      PRIVACY_HASH_SECRET: dedicated,
      SHOPIFY_API_SECRET: "shopify-secret-with-at-least-32-characters",
    }),
    dedicated,
  );
});

test("privacy hash secret ignores weak candidates and uses a strong fallback", () => {
  const fallback = "shopify-secret-with-at-least-32-characters";
  assert.equal(
    getPrivacyHashSecret({
      PRIVACY_HASH_SECRET: "too-short",
      SHOPIFY_API_SECRET: fallback,
    }),
    fallback,
  );
});

test("hashPrivateIdentifier fails closed when no secret is available", () => {
  assert.throws(
    () => hashPrivateIdentifier("203.0.113.8", { env: {} }),
    /privacy_hash_secret_missing/,
  );
});

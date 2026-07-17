import assert from "node:assert/strict";
import test from "node:test";

import {
  requireBearerToken,
  requirePostRequest,
  secureStringEqual,
} from "../../app/utils/internalRouteSecurity.server.js";

test("protected internal routes require POST", () => {
  assert.throws(
    () =>
      requirePostRequest(
        new Request("https://example.test", { method: "GET" }),
      ),
    (error) => error instanceof Response && error.status === 405,
  );
});

test("protected internal routes reject missing configuration", () => {
  assert.throws(
    () =>
      requireBearerToken(
        new Request("https://example.test", { method: "POST" }),
        "short",
      ),
    (error) => error instanceof Response && error.status === 503,
  );
});

test("protected internal routes compare bearer tokens and reject invalid values", () => {
  const token = "a-valid-monitor-token-that-is-longer-than-32";
  const request = new Request("https://example.test", {
    method: "POST",
    headers: { Authorization: "Bearer wrong-token" },
  });
  assert.throws(
    () => requireBearerToken(request, token),
    (error) => error instanceof Response && error.status === 401,
  );
  assert.equal(secureStringEqual(token, token), true);
  assert.equal(secureStringEqual(token, `${token}x`), false);
});

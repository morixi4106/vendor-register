import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPrivateResponseHeaders,
  privateDocumentHeaders,
} from "../../app/utils/privateHeaders.js";

test("private pages preserve authentication error headers and multiple session cookies", () => {
  const errorHeaders = new Headers({ "WWW-Authenticate": "Bearer" });
  errorHeaders.append("Set-Cookie", "first=one; HttpOnly");
  errorHeaders.append("Set-Cookie", "second=two; HttpOnly");
  const headers = privateDocumentHeaders({
    parentHeaders: new Headers({ "X-Parent": "kept" }),
    errorHeaders,
  });
  assert.equal(headers.get("WWW-Authenticate"), "Bearer");
  assert.equal(headers.get("X-Parent"), "kept");
  assert.equal(headers.getSetCookie().length, 2);
  assert.equal(headers.get("Cache-Control"), "private, no-store, max-age=0");
  assert.equal(headers.get("Referrer-Policy"), "no-referrer");
});

test("private document and data requests never retain a public cache policy", () => {
  for (const pathname of [
    "/app/privacy",
    "/app/privacy.data",
    "/vendor/orders.data",
    "/vendor/products/new",
    "/vendor/reports/monthly",
    "/apps/vendors/dashboard",
  ]) {
    const headers = new Headers({
      "Cache-Control": "public, max-age=300",
      "Set-Cookie": "session=kept",
    });
    applyPrivateResponseHeaders(
      headers,
      `https://example.test${pathname}?vendorId=private`,
    );
    assert.equal(headers.get("Cache-Control"), "private, no-store, max-age=0");
    assert.equal(headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(headers.get("Set-Cookie"), "session=kept");
  }
});

test("public storefront and catalog routes keep their existing cache policy", () => {
  for (const pathname of [
    "/vendor/public-store",
    "/apps/vendors/public-store",
    "/api/public-stores",
  ]) {
    const headers = new Headers({ "Cache-Control": "public, max-age=300" });
    applyPrivateResponseHeaders(headers, `https://example.test${pathname}`);
    assert.equal(headers.get("Cache-Control"), "public, max-age=300");
  }
});

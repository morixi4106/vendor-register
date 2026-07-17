import crypto from "node:crypto";

import { json } from "@remix-run/node";

export function readBearerToken(request) {
  return String(request?.headers?.get?.("authorization") || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

export function secureStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return (
    leftBuffer.length > 0 &&
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function requireBearerToken(
  request,
  expectedToken,
  { missingConfiguration = "worker_token_not_configured" } = {},
) {
  const expected = String(expectedToken || "").trim();
  if (expected.length < 32) {
    throw json(
      { ok: false, error: missingConfiguration },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!secureStringEqual(readBearerToken(request), expected)) {
    throw json(
      { ok: false, error: "unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export function requirePostRequest(request) {
  if (String(request?.method || "GET").toUpperCase() !== "POST") {
    throw json(
      { ok: false, error: "method_not_allowed" },
      {
        status: 405,
        headers: { Allow: "POST", "Cache-Control": "no-store" },
      },
    );
  }
}

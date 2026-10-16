import {
  requirePostRequest,
  secureStringEqual,
} from "../utils/internalRouteSecurity.server.js";
import { readBoundedRequestBody } from "../utils/requestBody.server.js";
import { consumePublicEndpointRateLimit } from "./publicEndpointRateLimit.server.js";
import {
  canonicalProof,
  proofError,
  ID,
} from "../utils/internationalProofContract.js";

const TOKENS = Object.freeze({
  publisher: "INTERNATIONAL_PROOF_PUBLISHER_INGEST_TOKEN",
  deployment: "INTERNATIONAL_PROOF_DEPLOYMENT_RUNNER_TOKEN",
  observer: "INTERNATIONAL_PROOF_OBSERVER_TOKEN",
});
export function authenticateInternationalRunner(
  request,
  purpose,
  env = process.env,
) {
  requirePostRequest(request);
  const expected = env[TOKENS[purpose]];
  const shopDomain = env.SHOPIFY_PRIMARY_SHOP_DOMAIN;
  const appId = env.SHOPIFY_API_KEY;
  if (
    !expected ||
    !/^[a-f0-9]{64}$/.test(expected) ||
    !ID.test(appId || "") ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain || "")
  )
    throw proofError("international_runner_unconfigured", 503);
  const otherSecrets = Object.entries(env).filter(
    ([key, value]) =>
      key !== TOKENS[purpose] &&
      /(?:TOKEN|SECRET|PRIVATE_KEY|ENCRYPTION_KEY|HASH_KEY)$/.test(key) &&
      typeof value === "string" &&
      value.length >= 32,
  );
  if (otherSecrets.some(([, value]) => secureStringEqual(expected, value)))
    throw proofError("international_runner_unconfigured", 503);
  const header = request.headers.get("authorization") || "";
  if (
    !/^Bearer [a-f0-9]{64}$/.test(header) ||
    !secureStringEqual(header.slice(7), expected)
  )
    throw proofError("unauthorized", 401);
  return { shopDomain, appId, principalId: `system:international-${purpose}` };
}

// Canonical JSON has one representation, so duplicate keys cannot be smuggled
// through JSON.parse's last-key-wins behavior. Our fixed agent uses this format.
export async function readInternationalRunnerJson(request) {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    throw proofError("international_json_required", 415);
  const bytes = await readBoundedRequestBody(request, 32000);
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(source);
    if (source !== canonicalProof(value)) throw new Error();
    return value;
  } catch {
    throw proofError("international_input_invalid", 400);
  }
}
export async function limitInternationalRequests(
  prismaClient,
  principal,
  purpose,
  limit = 60,
) {
  const result = await consumePublicEndpointRateLimit({
    prismaClient,
    endpoint: `international:${purpose}`,
    key: `${principal.shopDomain}:${principal.principalId || principal.actorKey}`,
    windowMs: 60000,
    limit,
  });
  if (!result.ok)
    throw Object.assign(proofError("international_rate_limited", 429), {
      retryAfter: result.retryAfterSeconds,
    });
}
export function requireInternationalAdminMutation(request, env = process.env) {
  requirePostRequest(request);
  let origin;
  try {
    origin = new URL(env.SHOPIFY_APP_URL || env.APP_URL).origin;
  } catch {
    throw proofError("international_admin_unconfigured", 503);
  }
  const supplied = request.headers.get("origin");
  if (
    (supplied && supplied !== origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw proofError("international_origin_forbidden", 403);
  if (
    !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
      request.headers.get("authorization") || "",
    )
  )
    throw proofError("international_session_token_required", 401);
}
export function internationalJson(value, status = 200, extra = {}) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store", ...extra },
  });
}
export function internationalErrorResponse(error) {
  if (error instanceof Response && [401, 403, 405, 413].includes(error.status))
    return internationalJson(
      { ok: false, code: `international_request_${error.status}` },
      error.status,
      error.headers.get("Allow") ? { Allow: error.headers.get("Allow") } : {},
    );
  const known =
    /^international_[a-z0-9_]+$/.test(error?.code || "") ||
    error?.code === "unauthorized";
  return internationalJson(
    {
      ok: false,
      code: known ? error.code : "international_service_unavailable",
    },
    known &&
      [400, 401, 403, 409, 413, 415, 422, 429, 503].includes(error.status)
      ? error.status
      : 503,
    error?.retryAfter ? { "Retry-After": String(error.retryAfter) } : {},
  );
}

import crypto from "node:crypto";

import {
  CHECKOUT_VALIDATION_LIVE_PROBE_KEY,
  isCompleteCheckoutValidationLiveProbe,
} from "./operationalReadiness.server.js";
import {
  SALE_ELIGIBILITY_POLICY_VERSION,
  SALE_ELIGIBILITY_PROJECTION_SCHEMA_VERSION,
} from "./saleEligibility.server.js";
import { MARKETPLACE_PURCHASE_CONTROL_FUNCTION_HANDLE } from "./shopifyCheckoutValidation.server.js";

export const MARKETPLACE_PURCHASE_CONTROL_FUNCTION_UID =
  "078e786b-ef41-b43e-c173-b38649de9b2fc2d4c1d1";
export const MARKETPLACE_PURCHASE_CONTROL_API_VERSION = "2026-04";
export const PRODUCTION_SCHEMA_MIGRATION_VERSION = "20260724143000";

export function getProductionProbeSigningSecret(env = process.env) {
  const secret = clean(env.PRODUCTION_PROBE_SIGNING_SECRET);
  return secret.length >= 32 ? secret : null;
}

export function buildProductionReleaseExpectation({
  env = process.env,
  checkoutValidation = null,
} = {}) {
  const renderCommit = clean(env.RENDER_GIT_COMMIT || env.GIT_COMMIT);
  const shopifyAppVersion = clean(env.SHOPIFY_APP_VERSION);
  return {
    configured: Boolean(renderCommit && shopifyAppVersion),
    releaseId:
      renderCommit && shopifyAppVersion
        ? `${renderCommit.slice(0, 12)}:${shopifyAppVersion}`
        : null,
    renderCommit,
    migrationVersion: PRODUCTION_SCHEMA_MIGRATION_VERSION,
    shopifyAppVersion,
    shopDomain: clean(
      env.SHOPIFY_PRIMARY_SHOP_DOMAIN || env.SHOPIFY_SHOP,
    ).toLowerCase(),
    functionHandle: MARKETPLACE_PURCHASE_CONTROL_FUNCTION_HANDLE,
    functionUid: MARKETPLACE_PURCHASE_CONTROL_FUNCTION_UID,
    functionId:
      clean(checkoutValidation?.validation?.shopifyFunction?.id) || null,
    functionApiVersion:
      clean(checkoutValidation?.validation?.shopifyFunction?.apiVersion) ||
      MARKETPLACE_PURCHASE_CONTROL_API_VERSION,
    validationId: clean(checkoutValidation?.validation?.id) || null,
    policyVersion: SALE_ELIGIBILITY_POLICY_VERSION,
    projectionSchemaVersion: SALE_ELIGIBILITY_PROJECTION_SCHEMA_VERSION,
  };
}

export function createProductionProbeChallenge(
  { expected, shopDomain, actorKey, now = new Date(), ttlMinutes = 120 },
  { env = process.env } = {},
) {
  const secret = getProductionProbeSigningSecret(env);
  if (!secret) return null;
  const payload = {
    v: 1,
    nonce: crypto.randomBytes(24).toString("base64url"),
    shopDomain: clean(shopDomain).toLowerCase(),
    actorKey: clean(actorKey),
    releaseFingerprint: releaseFingerprint(expected),
    issuedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + Math.max(5, Number(ttlMinutes) || 120) * 60_000,
    ).toISOString(),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    token: `${encoded}.${signProbeChallenge(encoded, secret)}`,
    expiresAt: payload.expiresAt,
    nonce: payload.nonce,
  };
}

export function verifyProductionProbeChallenge(
  token,
  { expected, shopDomain, actorKey, now = new Date() },
  { env = process.env } = {},
) {
  const secret = getProductionProbeSigningSecret(env);
  const [encoded, providedSignature, extra] = String(token || "").split(".");
  if (!secret || !encoded || !providedSignature || extra) {
    return { ok: false, reason: "live_probe_challenge_invalid" };
  }
  if (!secureEqual(providedSignature, signProbeChallenge(encoded, secret))) {
    return { ok: false, reason: "live_probe_challenge_invalid" };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "live_probe_challenge_invalid" };
  }
  const expiresAt = new Date(payload?.expiresAt);
  const valid = Boolean(
    payload?.v === 1 &&
    clean(payload?.nonce) &&
    clean(payload?.shopDomain).toLowerCase() ===
      clean(shopDomain).toLowerCase() &&
    clean(payload?.actorKey) === clean(actorKey) &&
    clean(payload?.releaseFingerprint) === releaseFingerprint(expected) &&
    Number.isFinite(expiresAt.getTime()) &&
    expiresAt.getTime() > now.getTime(),
  );
  return valid
    ? { ok: true, payload }
    : { ok: false, reason: "live_probe_challenge_expired_or_mismatched" };
}

export function inspectProductionReleaseEvidence({
  operationalReadiness,
  expected,
} = {}) {
  const row = operationalReadiness?.rows?.find(
    (entry) => entry.definition?.key === CHECKOUT_VALIDATION_LIVE_PROBE_KEY,
  );
  const metadata = row?.attestation?.metadataJson || {};
  const manifest = metadata.releaseManifest || {};
  const mismatches = [];

  if (!expected?.configured) mismatches.push("release_environment_missing");
  if (!row?.ready) mismatches.push("live_probe_attestation_missing");
  if (!isCompleteCheckoutValidationLiveProbe(metadata)) {
    mismatches.push("live_probe_scenarios_incomplete");
  }
  for (const key of [
    "releaseId",
    "renderCommit",
    "migrationVersion",
    "shopifyAppVersion",
    "functionHandle",
    "functionUid",
    "functionId",
    "functionApiVersion",
    "validationId",
    "policyVersion",
    "shopDomain",
  ]) {
    if (clean(manifest[key]) !== clean(expected?.[key])) {
      mismatches.push(`${key}_mismatch`);
    }
  }
  if (
    Number(manifest.projectionSchemaVersion) !==
    Number(expected?.projectionSchemaVersion)
  ) {
    mismatches.push("projectionSchemaVersion_mismatch");
  }

  return {
    ready: mismatches.length === 0,
    row: row || null,
    expected,
    manifest,
    probes: metadata.probes || {},
    mismatches,
  };
}

function releaseFingerprint(expected) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        releaseId: clean(expected?.releaseId),
        renderCommit: clean(expected?.renderCommit),
        migrationVersion: clean(expected?.migrationVersion),
        shopifyAppVersion: clean(expected?.shopifyAppVersion),
        shopDomain: clean(expected?.shopDomain).toLowerCase(),
        functionHandle: clean(expected?.functionHandle),
        functionUid: clean(expected?.functionUid),
        functionId: clean(expected?.functionId),
        functionApiVersion: clean(expected?.functionApiVersion),
        validationId: clean(expected?.validationId),
        policyVersion: clean(expected?.policyVersion),
        projectionSchemaVersion: Number(expected?.projectionSchemaVersion),
      }),
    )
    .digest("hex");
}

function signProbeChallenge(encoded, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return (
    leftBuffer.length > 0 &&
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function clean(value) {
  return String(value || "").trim();
}

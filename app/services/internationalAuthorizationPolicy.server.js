import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  internationalLocalDate,
  normalizeInternationalScope,
  internationalScopeHash,
} from "./internationalGateProjection.server.js";
import { requireInternationalCurrencies } from "../utils/internationalCurrencyPolicy.js";

export const INTERNATIONAL_DEPLOYMENT_EVIDENCE_KEY =
  "INTERNATIONAL_CHECKOUT_DEPLOYMENT_VERIFIED";
export const INTERNATIONAL_RELEASE_EVIDENCE_KEY =
  "INTERNATIONAL_CHECKOUT_RELEASE_VERIFIED";
export const INTERNATIONAL_SYSTEM_EVIDENCE_KEYS = Object.freeze([
  INTERNATIONAL_DEPLOYMENT_EVIDENCE_KEY,
  INTERNATIONAL_RELEASE_EVIDENCE_KEY,
]);
export const PREVIEW_TTL_MS = 10 * 60000;
export const VERIFICATION_LEASE_MS = 5 * 60000;

// A source capability, not an environment flag. 4C has not shipped.
export function inspectInternationalAuthorizationCapability() {
  return { ready: false, reason: "international_verification_not_implemented" };
}

export function authorizationError(code, status = 409) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

export function assertInternationalShop(shopDomain) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain || ""))
    throw authorizationError("international_shop_invalid", 422);
}

export function hashInternationalSecret(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function newInternationalSecret() {
  return randomBytes(32).toString("hex");
}

export function matchesInternationalSecret(secret, hash) {
  if (
    !/^[a-f0-9]{64}$/.test(secret || "") ||
    !/^[a-f0-9]{64}$/.test(hash || "")
  )
    return false;
  return timingSafeEqual(
    Buffer.from(hashInternationalSecret(secret), "hex"),
    Buffer.from(hash, "hex"),
  );
}

export function effectiveAuthorizationPurpose(input) {
  return input.purpose === "RESUME" ? input.resumePurpose : input.purpose;
}

export function normalizeInternationalAuthorization(input) {
  if (!input || Buffer.byteLength(JSON.stringify(input)) > 32000)
    throw authorizationError("international_authorization_input_invalid", 422);
  const keys = [
    "purpose",
    "resumePurpose",
    "verificationKind",
    "scope",
    "currencies",
    "expiresAt",
  ];
  if (Object.keys(input).some((key) => !keys.includes(key)))
    throw authorizationError("international_authorization_input_invalid", 422);
  const purpose = input.purpose;
  if (
    !["VERIFY", "SALE", "RESUME"].includes(purpose) ||
    (purpose === "RESUME"
      ? !["VERIFY", "SALE"].includes(input.resumePurpose)
      : input.resumePurpose != null)
  )
    throw authorizationError(
      "international_authorization_purpose_invalid",
      422,
    );
  const effectivePurpose = effectiveAuthorizationPurpose(input);
  if (
    effectivePurpose === "VERIFY"
      ? !["NON_FINANCIAL", "FINANCIAL"].includes(input.verificationKind)
      : input.verificationKind != null
  )
    throw authorizationError("international_verification_kind_invalid", 422);
  const currencies = requireInternationalCurrencies(input.currencies);
  const requestedExpiresAt = new Date(input.expiresAt);
  if (
    typeof input.expiresAt !== "string" ||
    !Number.isFinite(requestedExpiresAt.getTime())
  )
    throw authorizationError("international_expiry_invalid", 422);
  const scope = normalizeInternationalScope(input.scope);
  return {
    purpose,
    resumePurpose: input.resumePurpose || null,
    verificationKind: input.verificationKind || null,
    scope,
    scopeHash: internationalScopeHash(scope, currencies),
    currencies,
    requestedExpiresAt,
  };
}

export function authorizationExpiry(input, context, now) {
  const deadlines = [input.requestedExpiresAt, context.expiresAt];
  if (effectiveAuthorizationPurpose(input) === "VERIFY")
    deadlines.push(new Date(now.getTime() + 48 * 3600000));
  if (
    deadlines.some(
      (date) => !date || !Number.isFinite(new Date(date).getTime()),
    )
  )
    throw authorizationError("international_expiry_invalid", 422);
  const expiresAt = new Date(
    Math.min(...deadlines.map((date) => new Date(date).getTime())),
  );
  if (
    expiresAt <= now ||
    internationalLocalDate(expiresAt, context.shopTimezone) <=
      internationalLocalDate(now, context.shopTimezone)
  )
    throw authorizationError("international_expiry_window_empty", 422);
  return expiresAt;
}

export async function internationalAuthorizationTransaction(client, callback) {
  if (typeof client?.$transaction !== "function")
    throw authorizationError("international_transaction_required", 503);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await client.$transaction(
        async (tx) => {
          const [row] = await tx.$queryRaw`SELECT clock_timestamp() AS now`;
          return callback(tx, new Date(row.now));
        },
        { isolationLevel: "Serializable", timeout: 15000 },
      );
    } catch (error) {
      if (error?.code !== "P2034" || attempt === 2) throw error;
    }
  }
}

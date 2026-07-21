import crypto from "node:crypto";

function normalizeValue(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function getPrivacyHashSecret(env = process.env) {
  const candidates = [
    env.PRIVACY_HASH_SECRET,
    env.SHOPIFY_API_SECRET,
    env.WITHDRAWAL_RECEIPT_TOKEN_SECRET,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeValue(candidate);
    if (normalized && normalized.length >= 32) return normalized;
  }

  return null;
}

export function hashPrivateIdentifier(value, { env = process.env } = {}) {
  const normalized = normalizeValue(value);
  if (!normalized) return null;

  const secret = getPrivacyHashSecret(env);
  if (!secret) {
    throw new Error("privacy_hash_secret_missing");
  }

  return crypto
    .createHmac("sha256", secret)
    .update(normalized)
    .digest("hex");
}

import { createHash, createPublicKey, sign, verify } from "node:crypto";
import { isInternationalPolicyPair } from "./internationalCurrencyPolicy.js";

export const PROOF_REPOSITORY = "morixi4106/vendor-register";
export const PROOF_WORKFLOW =
  ".github/workflows/international-proof-artifact.yml";
export const PROOF_VERSION = "international-proof-v1";
export const PROOF_VALIDITY = "international-proof-validity-v1";
export const PROOF_SCHEMA_MIGRATION_VERSION = "20261017000000";
export const CHECKOUT_CONTRACT_PATHS = Object.freeze([
  "app/services/internationalCheckoutInventory.server.js",
  "app/services/internationalCheckoutPlan.server.js",
  "app/services/internationalTransactionSnapshot.server.js",
  "app/utils/internationalCheckoutVerification.js",
  "app/utils/internationalCurrencyPolicy.js",
]);

export function validateCheckoutVerifier(value) {
  shape(value, ["v", "level", "scenarioVersion", "verifierVersion", "files", "digest"]);
  if (value.v !== "international-checkout-verifier-v1" || value.level !== "CONTRACT_ONLY" ||
      value.scenarioVersion !== "international-checkout-cases-v1" ||
      value.verifierVersion !== "international-checkout-contract-v1" ||
      !Array.isArray(value.files) || value.files.length !== CHECKOUT_CONTRACT_PATHS.length) throw proofError();
  for (const [index, file] of value.files.entries()) {
    shape(file, ["path", "size", "sha256"]);
    if (file.path !== CHECKOUT_CONTRACT_PATHS[index] || !Number.isSafeInteger(file.size) ||
        file.size < 1 || file.size > 65536 || !HASH.test(file.sha256)) throw proofError();
  }
  if (proofHash(value.files) !== value.digest) throw proofError();
  return value;
}
export const DEPLOYMENT_CASES = Object.freeze([
  "artifact",
  "receipt",
  "active-release",
  "validation",
  "closed-readback",
  "sales-surfaces",
]);
export const HASH = /^[a-f0-9]{64}$/;
export const SHA = /^[a-f0-9]{40}$/;
export const ID = /^[A-Za-z0-9_-]{1,128}$/;
export const FUNCTION_HANDLE = "marketplace-purchase-control";
export const FUNCTION_UID = "078e786b-ef41-b43e-c173-b38649de9b2fc2d4c1d1";

export function proofError(
  code = "international_artifact_untrusted",
  status = 422,
) {
  return Object.assign(new Error(code), { code, status });
}
export function canonicalProof(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalProof).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalProof(value[k])}`)
      .join(",")}}`;
  if (
    value === undefined ||
    (typeof value === "number" && !Number.isFinite(value))
  )
    throw proofError();
  return JSON.stringify(value);
}
export const proofHash = (value) =>
  byteHash(Buffer.from(canonicalProof(value)));
export const byteHash = (value) =>
  createHash("sha256").update(value).digest("hex");
export function shape(value, keys, limit = 262144) {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Buffer.byteLength(JSON.stringify(value)) > limit ||
    Object.keys(value).sort().join("|") !== [...keys].sort().join("|")
  )
    throw proofError();
  return value;
}
export function proofDate(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw proofError();
  return new Date(value);
}
export function safeProofPath(value) {
  if (
    typeof value !== "string" ||
    value.length > 240 ||
    !/^[A-Za-z0-9_./-]+$/.test(value) ||
    value.startsWith("/") ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) ||
          part.endsWith("."),
      )
  )
    throw proofError();
  return value;
}
export function validateManifest(m) {
  shape(m, [
    "v",
    "repository",
    "repositoryId",
    "workflow",
    "workflowId",
    "workflowDigest",
    "headSha",
    "runId",
    "runAttempt",
    "event",
    "channel",
    "createdAt",
    "lockDigest",
    "nodeVersion",
    "cliVersion",
    "checks",
    "caseIds",
    "casesHash",
    "testDigest",
    "function",
    "files",
    "deploymentDigest",
    ...(m?.function?.policy === "international-sale-2026-10-v2" ? ["checkoutVerifier"] : []),
  ]);
  if (
    m.v !== PROOF_VERSION ||
    m.repository !== PROOF_REPOSITORY ||
    m.workflow !== PROOF_WORKFLOW ||
    !SHA.test(m.headSha) ||
    ![
      m.workflowDigest,
      m.lockDigest,
      m.casesHash,
      m.testDigest,
      m.deploymentDigest,
    ].every((v) => HASH.test(v)) ||
    ![m.repositoryId, m.workflowId, m.runId, m.runAttempt].every(
      (v) => Number.isSafeInteger(v) && v > 0,
    ) ||
    !["production", "candidate"].includes(m.channel) ||
    !["workflow_dispatch", "pull_request"].includes(m.event) ||
    !/^24\./.test(m.nodeVersion) ||
    m.cliVersion !== "4.5.2" ||
    !Array.isArray(m.caseIds) ||
    !m.caseIds.length ||
    m.caseIds.length > 256 ||
    m.caseIds.some((id) => typeof id !== "string" || id.length > 240) ||
    new Set(m.caseIds).size !== m.caseIds.length ||
    proofHash([...m.caseIds].sort()) !== m.casesHash
  )
    throw proofError();
  proofDate(m.createdAt);
  shape(m.checks, ["quality", "postgres"]);
  for (const check of Object.values(m.checks)) {
    shape(check, ["runId", "runAttempt"]);
    if (
      ![check.runId, check.runAttempt].every(
        (v) => Number.isSafeInteger(v) && v > 0,
      )
    )
      throw proofError();
  }
  shape(m.function, [
    "handle",
    "uid",
    "apiVersion",
    "target",
    "export",
    "wasm",
    "query",
    "schema",
    "policy",
    "projectionVersion",
  ]);
  if (
    m.function.handle !== FUNCTION_HANDLE ||
    m.function.uid !== FUNCTION_UID ||
    m.function.apiVersion !== "2026-04" ||
    m.function.target !== "cart.validations.generate.run" ||
    m.function.export !== "cart-validations-generate-run" ||
    !isInternationalPolicyPair(m.function.policy, m.function.projectionVersion)
  )
    throw proofError();
  if (m.function.policy === "international-sale-2026-10-v2") validateCheckoutVerifier(m.checkoutVerifier);
  if (!Array.isArray(m.files) || !m.files.length || m.files.length > 1999)
    throw proofError();
  const names = new Set();
  let size = 0;
  for (const file of m.files) {
    shape(file, ["path", "size", "sha256"]);
    safeProofPath(file.path);
    if (
      file.path !== "shopify.app.production.toml" &&
      !/^extensions\/(account-home-entry|account-home-page|marketplace-purchase-control)\/(?:shopify\.extension\.toml|schema\.graphql|manifest\.json|(?:src|dist|locales)\/[A-Za-z0-9_./-]+\.(?:js|jsx|json|graphql|wasm|map))$/.test(
        file.path,
      )
    )
      throw proofError();
    if (
      names.has(file.path.toLowerCase()) ||
      !HASH.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    )
      throw proofError();
    names.add(file.path.toLowerCase());
    size += file.size;
  }
  if (
    size > 128 * 1024 * 1024 ||
    proofHash(m.files) !== m.deploymentDigest ||
    [m.function.wasm, m.function.query, m.function.schema].some(
      (name) => !m.files.some((f) => f.path === name),
    ) ||
    !m.files.some((f) => f.path === "shopify.app.production.toml")
  )
    throw proofError();
  return m;
}

// Trust roots are installed with reviewed code, never supplied by a receipt or env.
export const INTERNATIONAL_PROOF_TRUST = Object.freeze({
  publisher: Object.freeze([]),
  observer: Object.freeze([]),
  checkoutVerifier: Object.freeze([]),
});
export function signProofPayload(purpose, payload, keyId, privateKey) {
  return {
    keyId,
    payload,
    signature: sign(
      null,
      Buffer.from(`${PROOF_VERSION}:${purpose}\n${canonicalProof(payload)}`),
      privateKey,
    ).toString("base64"),
  };
}
export function verifyProofSignature(
  envelope,
  purpose,
  now,
  trust = INTERNATIONAL_PROOF_TRUST,
) {
  shape(envelope, ["keyId", "payload", "signature"]);
  if (
    !ID.test(envelope.keyId) ||
    typeof envelope.signature !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)
  )
    throw proofError("international_receipt_untrusted");
  const key = trust[purpose]?.find((row) => row.id === envelope.keyId);
  if (
    !key ||
    key.revokedAt ||
    proofDate(key.notBefore) > now ||
    proofDate(key.notAfter) <= now
  )
    throw proofError("international_receipt_untrusted");
  try {
    const publicKey = createPublicKey(key.publicKey);
    if (
      publicKey.asymmetricKeyType !== "ed25519" ||
      !verify(
        null,
        Buffer.from(
          `${PROOF_VERSION}:${purpose}\n${canonicalProof(envelope.payload)}`,
        ),
        publicKey,
        Buffer.from(envelope.signature, "base64"),
      )
    )
      throw proofError();
  } catch {
    throw proofError("international_receipt_untrusted");
  }
  return envelope.payload;
}
export function validateReceipt(
  envelope,
  { manifest, archiveHash, shopDomain, now, trust },
) {
  const p = verifyProofSignature(envelope, "publisher", now, trust);
  shape(p, [
    "v",
    "id",
    "approvalId",
    "purpose",
    "shopDomain",
    "appId",
    "headSha",
    "runId",
    "runAttempt",
    "artifactId",
    "contentDigest",
    "archiveDigest",
    "deploymentDigest",
    "versionId",
    "versionTag",
    "startedAt",
    "completedAt",
    "executeBefore",
    "allowedUseUntil",
    "web",
    "cron",
    "migrationVersion",
  ]);
  if (
    p.v !== PROOF_VERSION ||
    ![p.id, p.approvalId, p.appId, p.versionId, p.versionTag].every((v) =>
      ID.test(v),
    ) ||
    p.purpose !== "RELEASE" ||
    p.shopDomain !== shopDomain ||
    p.headSha !== manifest.headSha ||
    p.runId !== manifest.runId ||
    p.runAttempt !== manifest.runAttempt ||
    !Number.isSafeInteger(p.artifactId) ||
    p.artifactId < 1 ||
    p.contentDigest !== proofHash(manifest) ||
    p.archiveDigest !== archiveHash ||
    p.deploymentDigest !== manifest.deploymentDigest ||
    proofDate(p.startedAt) > proofDate(p.executeBefore) ||
    proofDate(p.completedAt) < proofDate(p.startedAt) ||
    proofDate(p.completedAt) > now ||
    proofDate(p.allowedUseUntil) <= now ||
    !/^\d{14}$/.test(p.migrationVersion)
  )
    throw proofError("international_deployment_unverified");
  for (const service of [p.web, p.cron]) {
    shape(service, ["serviceId", "deployId", "commit", "status"]);
    if (
      !ID.test(service.serviceId) ||
      !ID.test(service.deployId) ||
      service.commit !== p.headSha ||
      service.status !== "live"
    )
      throw proofError("international_deployment_unverified");
  }
  return p;
}
export function validateObservation(
  envelope,
  { receipt, runId, nonceHash, now, maxAgeMs = 60000, trust },
) {
  shape(envelope, ["keyId", "payload", "signature"], 32768);
  const p = verifyProofSignature(envelope, "observer", now, trust);
  shape(p, [
    "v",
    "runId",
    "receiptId",
    "shopDomain",
    "appId",
    "versionId",
    "versionTag",
    "web",
    "cron",
    "sequence",
    "nonceHash",
    "observedAt",
    "expiresAt",
  ]);
  if (
    p.v !== PROOF_VERSION ||
    p.runId !== runId ||
    p.receiptId !== receipt.id ||
    p.shopDomain !== receipt.shopDomain ||
    p.appId !== receipt.appId ||
    p.versionId !== receipt.versionId ||
    p.versionTag !== receipt.versionTag ||
    proofHash(p.web) !== proofHash(receipt.web) ||
    proofHash(p.cron) !== proofHash(receipt.cron) ||
    !Number.isSafeInteger(p.sequence) ||
    p.sequence < 1 ||
    !HASH.test(p.nonceHash) ||
    (nonceHash && p.nonceHash !== nonceHash) ||
    proofDate(p.observedAt) > now ||
    now - proofDate(p.observedAt) > maxAgeMs ||
    proofDate(p.expiresAt) <= now ||
    proofDate(p.expiresAt) - proofDate(p.observedAt) > 900000
  )
    throw proofError("international_deployment_unverified");
  return p;
}

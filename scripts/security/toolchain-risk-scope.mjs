import { hashDependencyPathLines } from "./package-lock-graph.mjs";

export const BRACES_ADVISORY_ID = "GHSA-VFJ7-8CJW-P6XM";
export const BRACES_RISK_RELATIVE_PATH =
  "security/risk-decisions/GHSA-vfj7-8cjw-p6xm.json";
export const LEGACY_RISK_RELATIVE_PATH =
  "security/risk-decisions/GHSA-mh99-v99m-4gvg.json";
export const BRACES_MAX_DURATION_MS = 14 * 86400_000;
const SHA = /^[A-F0-9]{64}$/;
const INTEGRITY =
  "sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==";

export function isBracesRisk(risk) {
  return (
    risk?.advisoryId === BRACES_ADVISORY_ID && risk.packageName === "braces"
  );
}
export function riskRelativePath(risk) {
  if (isBracesRisk(risk)) return BRACES_RISK_RELATIVE_PATH;
  if (
    risk?.advisoryId === "GHSA-MH99-V99M-4GVG" &&
    risk.packageName === "brace-expansion"
  )
    return LEGACY_RISK_RELATIVE_PATH;
  throw new Error("unsupported_risk_identity");
}

function utc(value) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(value || ""))
  )
    return null;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
    ? parsed
    : null;
}

export function validateBracesRiskDefinition(
  risk,
  { now = new Date(), platform = process.platform } = {},
) {
  if (!risk || typeof risk !== "object")
    return { ok: false, errors: ["risk_definition_missing"] };
  const errors = [];
  if (risk?.status !== "accepted") errors.push("risk_not_accepted");
  if (!isBracesRisk(risk)) errors.push("advisory_mismatch");
  if (
    JSON.stringify(risk.allowedVersions) !== '["3.0.3"]' ||
    risk.packageIntegrity !== INTEGRITY
  )
    errors.push("version_mismatch");
  if (
    risk.requiredParent?.packageName !== "micromatch" ||
    JSON.stringify(risk.requiredParent.allowedVersions) !== '["4.0.8"]' ||
    risk.requiredParent.expectedPhysicalInstallCount !== 1
  )
    errors.push("parent_package_definition_invalid");
  const proposed = utc(risk.proposedAt);
  const expires = utc(risk.expiresAt);
  if (!proposed || proposed > now) errors.push("risk_proposal_time_invalid");
  if (
    !proposed ||
    !expires ||
    expires <= proposed ||
    expires - proposed > BRACES_MAX_DURATION_MS
  )
    errors.push("expiry_exceeds_policy");
  else if (now >= expires) errors.push("risk_expired");
  if (risk.status === "accepted") {
    const accepted = utc(risk.acceptedAt);
    if (
      !accepted ||
      !proposed ||
      accepted < proposed ||
      accepted > now ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{1,38}$/.test(String(risk.acceptedBy || ""))
    )
      errors.push("acceptance_metadata_invalid");
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
        String(risk.reviewedRepository || ""),
      ) ||
      !Number.isSafeInteger(risk.reviewedPullRequest) ||
      risk.reviewedPullRequest < 1 ||
      !/^[a-f0-9]{40}$/.test(String(risk.reviewedCommitSha || "")) ||
      !/^[1-9]\d*$/.test(String(risk.reviewedCiRunId || "")) ||
      !/^[1-9]\d*$/.test(String(risk.acceptanceCommentId || ""))
    )
      errors.push("acceptance_provenance_invalid");
  }
  if (
    JSON.stringify(risk.upstreamUrls) !==
    JSON.stringify([
      "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
      "https://github.com/micromatch/braces/issues/70",
    ])
  )
    errors.push("upstream_urls_invalid");
  const lines = risk.approvedPathLines;
  if (
    !Array.isArray(lines) ||
    !lines.length ||
    risk.approvedPathCount !== lines.length ||
    JSON.stringify(lines) !==
      JSON.stringify(
        [...new Set(lines)].sort((a, b) => a.localeCompare(b, "en")),
      ) ||
    hashDependencyPathLines(lines) !== risk.approvedPathSetSha256
  )
    errors.push("path_fingerprint_invalid");
  const evidence = risk.artifactEvidenceSha256ByPlatform;
  if (
    !evidence ||
    JSON.stringify(Object.keys(evidence).sort()) !== '["linux","win32"]' ||
    !Object.values(evidence).every((value) => SHA.test(String(value || ""))) ||
    !SHA.test(String(risk.buildControlSha256 || "")) ||
    !SHA.test(String(risk.lockfileSha256 || "")) ||
    !SHA.test(String(risk.runtimeManifestSha256 || "")) ||
    !SHA.test(String(risk.runtimeLockfileSha256 || "")) ||
    String(risk.rationale || "").trim().length < 40
  )
    errors.push("risk_evidence_invalid");
  if (!["linux", "win32"].includes(platform))
    errors.push("risk_evidence_platform_unsupported");
  return { ok: errors.length === 0, errors };
}

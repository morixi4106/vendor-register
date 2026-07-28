import { collectLeafAdvisories, extractAdvisoryId } from "./audit-report.mjs";
import {
  enumerateDependencyPaths,
  hashDependencyPathLines,
  packageLocationsByName,
} from "./package-lock-graph.mjs";

export const REACT_ROUTER_EXCEPTION_EXPIRES_AT = "2026-09-30T23:59:59.999Z";
export const TOOLCHAIN_EXCEPTION_MAX_EXPIRES_AT = "2026-08-27T23:59:59.999Z";

const REACT_ROUTER_PACKAGES = new Set([
  "@remix-run/react",
  "react-router",
  "react-router-dom",
]);
const REACT_ROUTER_ADVISORIES = new Set([
  "GHSA-WRJC-X8RR-H8H6",
  "GHSA-337J-9HXR-RHXG",
  "GHSA-JJMJ-JMHJ-QWJ2",
]);
const NEVER_ALLOW_SEVERITIES = new Set(["high", "critical"]);

const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ARTIFACT_EVIDENCE_PLATFORMS = ["linux", "win32"];
const SHA256_PATTERN = /^[A-F0-9]{64}$/;

function parseUtcTimestamp(value) {
  if (!UTC_TIMESTAMP_PATTERN.test(String(value || ""))) return null;
  const parsed = new Date(value);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString() !== String(value)
  ) {
    return null;
  }
  return parsed;
}

function timestampIsExpired(timestamp, now) {
  const date = parseUtcTimestamp(timestamp);
  return !date || now.getTime() >= date.getTime();
}

function evaluateReactRouterException(packageName, vulnerability, report, now) {
  if (timestampIsExpired(REACT_ROUTER_EXCEPTION_EXPIRES_AT, now)) return false;
  if (
    String(vulnerability?.severity || "").toLowerCase() !== "moderate" ||
    !REACT_ROUTER_PACKAGES.has(packageName)
  ) {
    return false;
  }

  const leaf = collectLeafAdvisories(report, packageName);
  if (leaf.errors.length > 0 || leaf.advisories.length === 0) return false;

  return leaf.advisories.every(
    (advisory) =>
      advisory.advisoryId && REACT_ROUTER_ADVISORIES.has(advisory.advisoryId),
  );
}

export function evaluateRuntimeAudit(
  report,
  runtimeVulnerabilities,
  { now = new Date(), unresolvedAuditPackages = [] } = {},
) {
  const allowed = [];
  const blocking = unresolvedAuditPackages.map((packageName) => ({
    code: "audit_nodes_missing",
    packageName,
    severity: "unknown",
  }));

  for (const [packageName, vulnerability] of Object.entries(
    runtimeVulnerabilities || {},
  )) {
    const severity = String(vulnerability?.severity || "unknown").toLowerCase();
    if (NEVER_ALLOW_SEVERITIES.has(severity)) {
      blocking.push({
        code: "runtime_high_or_critical",
        packageName,
        severity,
      });
      continue;
    }

    if (evaluateReactRouterException(packageName, vulnerability, report, now)) {
      allowed.push({
        packageName,
        severity,
      });
      continue;
    }

    blocking.push({
      code: "runtime_advisory_not_allowed",
      packageName,
      severity,
    });
  }

  return {
    allowed,
    blocking,
    exceptionExpiresAt: REACT_ROUTER_EXCEPTION_EXPIRES_AT,
    ok: blocking.length === 0,
  };
}

function validUpstreamUrls(urls) {
  if (!Array.isArray(urls) || urls.length !== 2) return false;

  let functionIssue = false;
  let uiCommunityTopic = false;
  for (const value of urls) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return false;
    }

    if (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com" &&
      /^\/Shopify\/shopify-function-javascript\/issues\/\d+\/?$/i.test(
        url.pathname,
      )
    ) {
      functionIssue = true;
      continue;
    }

    if (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "community.shopify.dev" &&
      /^\/t\/[^/]+\/\d+\/?$/.test(url.pathname)
    ) {
      uiCommunityTopic = true;
      continue;
    }

    return false;
  }

  return functionIssue && uiCommunityTopic;
}

export function validateToolchainRiskDefinition(
  risk,
  { now = new Date(), platform = process.platform } = {},
) {
  const errors = [];
  if (!risk || typeof risk !== "object") {
    return { ok: false, errors: ["risk_definition_missing"] };
  }
  if (risk.status !== "accepted") errors.push("risk_not_accepted");
  if (
    risk.status === "accepted" &&
    (typeof risk.acceptedBy !== "string" ||
      risk.acceptedBy.trim().length < 2 ||
      !parseUtcTimestamp(risk.acceptedAt) ||
      parseUtcTimestamp(risk.acceptedAt).getTime() > now.getTime())
  ) {
    errors.push("acceptance_metadata_invalid");
  }
  if (risk.advisoryId !== "GHSA-MH99-V99M-4GVG") {
    errors.push("advisory_mismatch");
  }
  if (risk.packageName !== "brace-expansion") {
    errors.push("package_mismatch");
  }
  if (
    !Array.isArray(risk.allowedVersions) ||
    risk.allowedVersions.length !== 1 ||
    risk.allowedVersions[0] !== "2.1.2"
  ) {
    errors.push("version_mismatch");
  }
  if (
    risk.requiredParent?.packageName !== "minimatch" ||
    !Array.isArray(risk.requiredParent?.allowedVersions) ||
    risk.requiredParent.allowedVersions.length !== 1 ||
    risk.requiredParent.allowedVersions[0] !== "9.0.9" ||
    risk.requiredParent.expectedPhysicalInstallCount !== 1
  ) {
    errors.push("parent_package_definition_invalid");
  }
  if (!validUpstreamUrls(risk.upstreamUrls)) {
    errors.push("upstream_urls_invalid");
  }

  const expiresAt = parseUtcTimestamp(risk.expiresAt);
  const maximum = parseUtcTimestamp(TOOLCHAIN_EXCEPTION_MAX_EXPIRES_AT);
  if (!expiresAt || expiresAt.getTime() > maximum.getTime()) {
    errors.push("expiry_exceeds_policy");
  } else if (timestampIsExpired(risk.expiresAt, now)) {
    errors.push("risk_expired");
  }

  if (
    !Array.isArray(risk.approvedPathLines) ||
    risk.approvedPathLines.length < 1 ||
    !Number.isInteger(risk.approvedPathCount) ||
    risk.approvedPathCount !== risk.approvedPathLines.length ||
    !/^[A-F0-9]{64}$/.test(String(risk.approvedPathSetSha256 || "")) ||
    hashDependencyPathLines(risk.approvedPathLines) !==
      risk.approvedPathSetSha256 ||
    JSON.stringify(risk.approvedPathLines) !==
      JSON.stringify(
        [...new Set(risk.approvedPathLines.map(String))].sort((left, right) =>
          left.localeCompare(right, "en"),
        ),
      )
  ) {
    errors.push("path_fingerprint_invalid");
  }
  const evidenceByPlatform = risk.artifactEvidenceSha256ByPlatform;
  const evidenceKeys =
    evidenceByPlatform &&
    typeof evidenceByPlatform === "object" &&
    !Array.isArray(evidenceByPlatform)
      ? Object.keys(evidenceByPlatform).sort()
      : [];
  const validEvidenceMap =
    JSON.stringify(evidenceKeys) ===
      JSON.stringify(ARTIFACT_EVIDENCE_PLATFORMS) &&
    evidenceKeys.every((key) =>
      SHA256_PATTERN.test(String(evidenceByPlatform[key] || "")),
    );
  if (
    typeof risk.rationale !== "string" ||
    risk.rationale.trim().length < 40 ||
    !validEvidenceMap
  ) {
    errors.push("risk_evidence_invalid");
  } else if (!evidenceByPlatform[platform]) {
    errors.push("risk_evidence_platform_unsupported");
  }

  return {
    errors,
    ok: errors.length === 0,
  };
}

export function evaluateToolchainAudit({
  artifactReport,
  lockfile,
  nonRuntimeVulnerabilities,
  now = new Date(),
  platform = process.platform,
  report,
  risk,
}) {
  const blocking = [];
  const warnings = [];
  const candidates = Object.entries(nonRuntimeVulnerabilities || {}).filter(
    ([, vulnerability]) =>
      NEVER_ALLOW_SEVERITIES.has(
        String(vulnerability?.severity || "").toLowerCase(),
      ),
  );

  if (candidates.length === 0) {
    return {
      accepted: [],
      blocking,
      ok: true,
      riskValidation: validateToolchainRiskDefinition(risk, { now, platform }),
      warnings,
    };
  }

  const riskValidation = validateToolchainRiskDefinition(risk, {
    now,
    platform,
  });
  if (!riskValidation.ok) {
    for (const error of riskValidation.errors) {
      blocking.push({
        code: error,
        packageName: risk?.packageName || null,
        severity: "high",
      });
    }
  }

  for (const [packageName, vulnerability] of candidates) {
    const leaf = collectLeafAdvisories(report, packageName);
    if (leaf.errors.length > 0) {
      blocking.push({
        code: "advisory_chain_unresolved",
        packageName,
        severity: vulnerability.severity,
      });
      continue;
    }
    const highOrCriticalLeafAdvisories = leaf.advisories.filter((advisory) =>
      NEVER_ALLOW_SEVERITIES.has(advisory.severity),
    );
    if (
      highOrCriticalLeafAdvisories.length === 0 ||
      highOrCriticalLeafAdvisories.some(
        (advisory) =>
          advisory.advisoryId !== risk?.advisoryId ||
          advisory.name !== risk?.packageName,
      )
    ) {
      blocking.push({
        code: "unexpected_high_or_critical",
        packageName,
        severity: vulnerability.severity,
      });
    }
  }

  const installedLocations = packageLocationsByName(
    lockfile,
    risk?.packageName || "",
  );
  if (installedLocations.length !== 1) {
    blocking.push({
      code: "installed_package_count_changed",
      packageName: risk?.packageName || null,
      severity: "high",
    });
  } else {
    const installedVersion =
      lockfile.packages[installedLocations[0]]?.version || null;
    if (!risk?.allowedVersions?.includes(installedVersion)) {
      blocking.push({
        code: "installed_version_changed",
        packageName: risk?.packageName || null,
        severity: "high",
      });
    }
  }

  const parentPackageName = risk?.requiredParent?.packageName || "";
  const parentLocations = packageLocationsByName(lockfile, parentPackageName);
  if (
    parentLocations.length !==
    risk?.requiredParent?.expectedPhysicalInstallCount
  ) {
    blocking.push({
      code: "parent_package_count_changed",
      packageName: parentPackageName || null,
      severity: "high",
    });
  } else if (
    parentLocations.some(
      (location) =>
        !risk?.requiredParent?.allowedVersions?.includes(
          lockfile.packages[location]?.version,
        ),
    )
  ) {
    blocking.push({
      code: "parent_package_version_changed",
      packageName: parentPackageName || null,
      severity: "high",
    });
  }

  let pathReport;
  try {
    pathReport = enumerateDependencyPaths(lockfile, {
      targetName: risk?.packageName || "",
      targetVersion: risk?.allowedVersions?.[0] || null,
    });
  } catch {
    pathReport = null;
    blocking.push({
      code: "dependency_path_enumeration_failed",
      packageName: risk?.packageName || null,
      severity: "high",
    });
  }

  if (pathReport) {
    if (pathReport.unresolvedRequiredEdges.length > 0) {
      blocking.push({
        code: "dependency_graph_unresolved",
        packageName: risk?.packageName || null,
        severity: "high",
      });
    }
    const approvedPaths = new Set(risk?.approvedPathLines || []);
    const addedPaths = pathReport.pathLines.filter(
      (line) => !approvedPaths.has(line),
    );
    if (addedPaths.length > 0) {
      blocking.push({
        code: "dependency_paths_added",
        count: addedPaths.length,
        packageName: risk?.packageName || null,
        severity: "high",
      });
    }
    if (
      addedPaths.length === 0 &&
      approvedPaths.size > pathReport.pathLines.length
    ) {
      warnings.push({
        code: "dependency_paths_reduced",
        count: approvedPaths.size - pathReport.pathLines.length,
        packageName: risk?.packageName || null,
        severity: "warning",
      });
    }
    if (
      pathReport.paths.length === 0 &&
      installedLocations.length > 0 &&
      candidates.length > 0
    ) {
      blocking.push({
        code: "vulnerable_package_unreachable_from_entries",
        packageName: risk?.packageName || null,
        severity: "high",
      });
    }
    if (
      pathReport.paths.some(
        (dependencyPath) => dependencyPath.scope === "root-production",
      )
    ) {
      blocking.push({
        code: "root_runtime_path_detected",
        packageName: risk?.packageName || null,
        severity: "critical",
      });
    }
    if (
      pathReport.paths.some(
        (dependencyPath) =>
          dependencyPath.nodes.some((node) => node.extraneous) ||
          (() => {
            const match = dependencyPath.scope.match(
              /^workspace(?:-development)?:(.+)$/,
            );
            return match
              ? lockfile.packages?.[match[1]]?.extraneous === true
              : false;
          })(),
      )
    ) {
      blocking.push({
        code: "extraneous_dependency_path_detected",
        packageName: risk?.packageName || null,
        severity: "high",
      });
    }
  }

  if (!artifactReport?.ok) {
    blocking.push({
      code: "artifact_verification_failed",
      packageName: risk?.packageName || null,
      severity: "critical",
    });
  } else if (artifactReport.targetMatches?.length > 0) {
    blocking.push({
      code: "target_found_in_artifact",
      packageName: risk?.packageName || null,
      severity: "critical",
    });
  } else if (
    SHA256_PATTERN.test(
      String(risk?.artifactEvidenceSha256ByPlatform?.[platform] || ""),
    ) &&
    String(risk.artifactEvidenceSha256ByPlatform[platform]) !==
      String(artifactReport.artifactSetSha256 || "")
  ) {
    blocking.push({
      code: "evidence_artifact_hash_mismatch",
      packageName: risk?.packageName || null,
      severity: "high",
    });
  }

  const uniqueBlocking = [
    ...new Map(
      blocking.map((item) => [
        `${item.code}:${item.packageName}:${item.severity}`,
        item,
      ]),
    ).values(),
  ];

  return {
    accepted:
      uniqueBlocking.length === 0
        ? candidates.map(([packageName, vulnerability]) => ({
            packageName,
            severity: vulnerability.severity,
          }))
        : [],
    blocking: uniqueBlocking,
    ok: uniqueBlocking.length === 0,
    pathReport,
    riskValidation,
    warnings,
  };
}

export function advisoryIdsForVulnerability(vulnerability) {
  return (Array.isArray(vulnerability?.via) ? vulnerability.via : [])
    .filter((item) => item && typeof item === "object")
    .map((item) => extractAdvisoryId(item.url))
    .filter(Boolean);
}

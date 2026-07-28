const GHSA_PATTERN = /GHSA-[a-z0-9-]+/i;

export const DEFAULT_AUDIT_REPORT_LIMITS = Object.freeze({
  maxAdvisories: 20_000,
  maxDepth: 256,
  maxNodeReferences: 100_000,
  maxVulnerabilities: 20_000,
});

function mergeLimits(overrides = {}) {
  const limits = { ...DEFAULT_AUDIT_REPORT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Audit report limit ${name} is invalid.`);
    }
  }
  return limits;
}

export function extractAdvisoryId(url) {
  const match = String(url || "").match(GHSA_PATTERN);
  return match ? match[0].toUpperCase() : null;
}

export function collectLeafAdvisories(report, packageName, { limits } = {}) {
  const effectiveLimits = mergeLimits(limits);
  const vulnerabilities =
    report?.vulnerabilities && typeof report.vulnerabilities === "object"
      ? report.vulnerabilities
      : {};
  if (
    Object.keys(vulnerabilities).length > effectiveLimits.maxVulnerabilities
  ) {
    return {
      advisories: [],
      errors: ["npm audit vulnerability count exceeded the safety limit."],
    };
  }
  const advisories = new Map();
  const errors = [];
  const visited = new Set();
  const active = new Set();
  let advisoryLimitExceeded = false;

  const visit = (name, depth = 1) => {
    if (advisoryLimitExceeded) return;
    if (depth > effectiveLimits.maxDepth) {
      errors.push(`npm audit dependency depth exceeded at ${name}.`);
      return;
    }
    if (active.has(name)) {
      errors.push(`Circular npm audit dependency link detected at ${name}.`);
      return;
    }
    if (visited.has(name)) return;
    visited.add(name);

    const vulnerability = vulnerabilities[name];
    if (!vulnerability || !Array.isArray(vulnerability.via)) {
      errors.push(`npm audit dependency link ${name} is missing.`);
      return;
    }

    active.add(name);
    for (const via of vulnerability.via) {
      if (typeof via === "string") {
        visit(via, depth + 1);
        continue;
      }
      if (!via || typeof via !== "object") {
        errors.push(`npm audit entry ${name} contains an invalid via value.`);
        continue;
      }

      const advisoryId = extractAdvisoryId(via.url);
      if (!advisoryId) {
        errors.push(`npm audit advisory for ${name} has no GHSA identifier.`);
        continue;
      }

      advisories.set(`${advisoryId}:${via.name || name}`, {
        advisoryId,
        dependency: via.dependency || via.name || name,
        name: via.name || name,
        range: via.range || null,
        severity: String(
          via.severity || vulnerability.severity || "unknown",
        ).toLowerCase(),
        title: via.title || null,
        url: via.url || null,
      });
      if (advisories.size > effectiveLimits.maxAdvisories) {
        errors.push("npm audit advisory count exceeded the safety limit.");
        advisoryLimitExceeded = true;
        break;
      }
    }
    active.delete(name);
  };

  visit(packageName);

  return {
    advisories: [...advisories.values()].sort((left, right) =>
      `${left.advisoryId}:${left.name}`.localeCompare(
        `${right.advisoryId}:${right.name}`,
      ),
    ),
    errors: [...new Set(errors)].sort(),
  };
}

export function vulnerabilityNodeLocations(vulnerability) {
  return Array.isArray(vulnerability?.nodes)
    ? [...new Set(vulnerability.nodes.map(String))].sort()
    : [];
}

export function splitAuditVulnerabilitiesByReachability(
  report,
  reachableLocations,
  { limits } = {},
) {
  const effectiveLimits = mergeLimits(limits);
  const vulnerabilities =
    report?.vulnerabilities && typeof report.vulnerabilities === "object"
      ? report.vulnerabilities
      : {};
  if (
    Object.keys(vulnerabilities).length > effectiveLimits.maxVulnerabilities
  ) {
    return {
      nonRuntime: {},
      runtime: {},
      unresolved: ["__audit_report_limit_exceeded__"],
    };
  }
  const runtime = {};
  const nonRuntime = {};
  const unresolved = [];
  let nodeReferenceCount = 0;

  for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
    const nodes = vulnerabilityNodeLocations(vulnerability);
    nodeReferenceCount += nodes.length;
    if (nodeReferenceCount > effectiveLimits.maxNodeReferences) {
      unresolved.push("__audit_node_reference_limit_exceeded__");
      break;
    }
    if (nodes.length === 0) {
      unresolved.push(packageName);
      continue;
    }

    const hasRuntimeNode = nodes.some((location) =>
      reachableLocations.has(location),
    );
    (hasRuntimeNode ? runtime : nonRuntime)[packageName] = vulnerability;
  }

  return {
    nonRuntime,
    runtime,
    unresolved: unresolved.sort(),
  };
}

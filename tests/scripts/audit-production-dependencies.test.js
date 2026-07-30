import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  advisoryIdsForVulnerability,
  evaluateRuntimeAudit,
  evaluateToolchainAudit,
  validateToolchainRiskDefinition,
} from "../../scripts/security/audit-policy.mjs";
import {
  enumerateDependencyPaths,
  hashDependencyPathLines,
  packageLocationsByName,
} from "../../scripts/security/package-lock-graph.mjs";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIRECTORY, "..", "..");
const LOCKFILE = JSON.parse(
  fs.readFileSync(path.join(REPOSITORY_ROOT, "package-lock.json"), "utf8"),
);
const RISK = JSON.parse(
  fs.readFileSync(
    path.join(
      REPOSITORY_ROOT,
      "security",
      "risk-decisions",
      "GHSA-mh99-v99m-4gvg.json",
    ),
    "utf8",
  ),
);
const APPROVED_PATH_LINES = fs
  .readFileSync(path.join(REPOSITORY_ROOT, RISK.approvedPathsFile), "utf8")
  .split("\n");

function acceptedRisk(overrides = {}) {
  return {
    ...RISK,
    acceptanceCommentId: "987654321",
    acceptedAt: "2026-07-28T00:00:00.000Z",
    acceptedBy: "security-owner",
    approvedPathLines: APPROVED_PATH_LINES,
    reviewedCiRunId: "30380150062",
    reviewedCommitSha: "a".repeat(40),
    reviewedPullRequest: 2,
    reviewedRepository: "morixi4106/vendor-register",
    status: "accepted",
    upstreamUrls: [
      "https://github.com/Shopify/shopify-function-javascript/issues/123",
      "https://community.shopify.dev/t/dependency-security-report/456",
    ],
    ...overrides,
  };
}

function braceAuditReport() {
  return {
    vulnerabilities: {
      "brace-expansion": {
        severity: "high",
        via: [
          {
            dependency: "brace-expansion",
            name: "brace-expansion",
            range: "<=5.0.7",
            severity: "high",
            url: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
          },
        ],
        nodes: ["node_modules/brace-expansion"],
      },
      minimatch: {
        severity: "high",
        via: ["brace-expansion"],
        nodes: ["node_modules/minimatch"],
      },
    },
  };
}

function artifactReport(overrides = {}) {
  return {
    artifactSetSha256: RISK.artifactEvidenceSha256ByPlatform[process.platform],
    ok: true,
    targetMatches: [],
    ...overrides,
  };
}

function evaluateToolchain({
  lockfile = LOCKFILE,
  report = braceAuditReport(),
  risk = acceptedRisk(),
  artifacts = artifactReport(),
  now = new Date("2026-07-28T00:00:00.000Z"),
  platform = process.platform,
} = {}) {
  return evaluateToolchainAudit({
    artifactReport: artifacts,
    lockfile,
    nonRuntimeVulnerabilities: report.vulnerabilities,
    now,
    platform,
    report,
    risk,
  });
}

function clone(value) {
  return structuredClone(value);
}

test("locks the complete known brace-expansion path set", () => {
  const report = enumerateDependencyPaths(LOCKFILE, {
    targetName: "brace-expansion",
    targetVersion: "2.1.2",
  });

  assert.equal(report.paths.length, 125);
  assert.equal(report.pathSetSha256, RISK.approvedPathSetSha256);
  assert.equal(report.unresolvedRequiredEdges.length, 0);
  assert.equal(
    report.paths.filter((item) => item.scope === "root-production").length,
    0,
  );
  assert.equal(
    report.paths.filter((item) => item.nodes.some((node) => node.extraneous))
      .length,
    0,
  );
});

test("identifies one physical brace-expansion installation", () => {
  assert.deepEqual(packageLocationsByName(LOCKFILE, "brace-expansion"), [
    "node_modules/brace-expansion",
  ]);
  assert.equal(
    LOCKFILE.packages["node_modules/brace-expansion"].version,
    "2.1.2",
  );
});

test("accepts the exact non-runtime toolchain risk fixture", () => {
  const result = evaluateToolchain();
  assert.equal(result.ok, true);
  assert.equal(result.accepted.length, 2);
  assert.deepEqual(result.blocking, []);
});

test("accepts a strict subset of approved paths and warns about reduction", () => {
  const lockfile = clone(LOCKFILE);
  delete lockfile.packages[""].devDependencies.eslint;

  const result = evaluateToolchain({ lockfile });
  assert.equal(result.ok, true);
  assert.ok(
    result.warnings.some(
      (item) => item.code === "dependency_paths_reduced" && item.count > 0,
    ),
  );
});

test("requires no toolchain exception when the advisory disappears", () => {
  const result = evaluateToolchain({
    report: {
      vulnerabilities: {},
    },
    risk: {
      status: "proposed",
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.accepted, []);
});

test("accepts a propagated high whose only high leaf is the exact risk", () => {
  const report = braceAuditReport();
  report.vulnerabilities["build-parent"] = {
    severity: "high",
    via: ["brace-expansion", "moderate-build-tool"],
    nodes: ["node_modules/build-parent"],
  };
  report.vulnerabilities["moderate-build-tool"] = {
    severity: "moderate",
    via: [
      {
        dependency: "moderate-build-tool",
        name: "moderate-build-tool",
        severity: "moderate",
        url: "https://github.com/advisories/GHSA-1111-2222-3333",
      },
    ],
    nodes: ["node_modules/moderate-build-tool"],
  };

  const result = evaluateToolchain({ report });
  assert.equal(result.ok, true);
  assert.ok(
    result.accepted.some((item) => item.packageName === "build-parent"),
  );
});

test("blocks an advisory mismatch", () => {
  const report = braceAuditReport();
  report.vulnerabilities["brace-expansion"].via[0].url =
    "https://github.com/advisories/GHSA-aaaa-bbbb-cccc";

  const result = evaluateToolchain({ report });
  assert.equal(result.ok, false);
  assert.ok(
    result.blocking.some((item) => item.code === "unexpected_high_or_critical"),
  );
});

test("fails closed when an advisory chain cannot be resolved", () => {
  const report = braceAuditReport();
  report.vulnerabilities["brace-expansion"].via = ["missing-leaf"];
  const result = evaluateToolchain({ report });
  assert.equal(result.ok, false);
  assert.ok(
    result.blocking.some((item) => item.code === "advisory_chain_unresolved"),
  );
});

test("blocks an installed version mismatch", () => {
  const lockfile = clone(LOCKFILE);
  lockfile.packages["node_modules/brace-expansion"].version = "2.1.3";

  const result = evaluateToolchain({ lockfile });
  assert.equal(result.ok, false);
  assert.ok(
    result.blocking.some((item) => item.code === "installed_version_changed"),
  );
});

test("blocks a minimatch parent version mismatch", () => {
  const lockfile = clone(LOCKFILE);
  lockfile.packages["node_modules/minimatch"].version = "9.0.10";

  const result = evaluateToolchain({ lockfile });
  assert.equal(result.ok, false);
  assert.ok(
    result.blocking.some(
      (item) => item.code === "parent_package_version_changed",
    ),
  );
});

test("blocks an additional physical minimatch installation", () => {
  const lockfile = clone(LOCKFILE);
  lockfile.packages["node_modules/example/node_modules/minimatch"] = {
    version: "9.0.9",
  };

  const result = evaluateToolchain({ lockfile });
  assert.equal(result.ok, false);
  assert.ok(
    result.blocking.some(
      (item) => item.code === "parent_package_count_changed",
    ),
  );
});

test("blocks missing vulnerable and parent package installations", () => {
  const lockfile = clone(LOCKFILE);
  delete lockfile.packages["node_modules/brace-expansion"];
  delete lockfile.packages["node_modules/minimatch"];
  const result = evaluateToolchain({ lockfile });
  assert.equal(result.ok, false);
  assert.ok(
    result.blocking.some(
      (item) => item.code === "installed_package_count_changed",
    ),
  );
  assert.ok(
    result.blocking.some(
      (item) => item.code === "parent_package_count_changed",
    ),
  );
});

test("blocks a newly introduced dependency path", () => {
  const lockfile = clone(LOCKFILE);
  lockfile.packages[""].devDependencies["new-security-tool"] = "1.0.0";
  lockfile.packages["node_modules/new-security-tool"] = {
    version: "1.0.0",
    dependencies: {
      "brace-expansion": "2.1.2",
    },
  };

  const result = evaluateToolchain({ lockfile });
  assert.equal(result.ok, false);
  assert.ok(
    result.blocking.some((item) => item.code === "dependency_paths_added"),
  );
});

test("blocks unresolved required dependency graph edges", () => {
  const lockfile = clone(LOCKFILE);
  delete lockfile.packages["node_modules/balanced-match"];
  const result = evaluateToolchain({ lockfile });
  assert.equal(result.ok, false);
  assert.ok(
    result.blocking.some((item) => item.code === "dependency_graph_unresolved"),
  );
});

test("blocks dependency path enumeration failures", () => {
  const lockfile = clone(LOCKFILE);
  lockfile.packages["node_modules/brace-expansion"].dependencies = [];
  const result = evaluateToolchain({ lockfile });
  assert.equal(result.ok, false);
  assert.ok(
    result.blocking.some(
      (item) => item.code === "dependency_path_enumeration_failed",
    ),
  );
});

test("blocks a root runtime path even if its advisory is otherwise known", () => {
  const lockfile = clone(LOCKFILE);
  lockfile.packages[""].dependencies["runtime-security-tool"] = "1.0.0";
  lockfile.packages["node_modules/runtime-security-tool"] = {
    version: "1.0.0",
    dependencies: {
      "brace-expansion": "2.1.2",
    },
  };

  const result = evaluateToolchain({ lockfile });
  assert.equal(result.ok, false);
  assert.ok(
    result.blocking.some((item) => item.code === "root_runtime_path_detected"),
  );
});

test("blocks a new high severity advisory", () => {
  const report = braceAuditReport();
  report.vulnerabilities["new-tool"] = {
    severity: "high",
    via: [
      {
        dependency: "new-tool",
        name: "new-tool",
        severity: "high",
        url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
      },
    ],
    nodes: ["node_modules/new-tool"],
  };

  const result = evaluateToolchain({ report });
  assert.equal(result.ok, false);
  assert.ok(result.blocking.some((item) => item.packageName === "new-tool"));
});

test("blocks toolchain content found in a deployable artifact", () => {
  const result = evaluateToolchain({
    artifacts: artifactReport({
      ok: false,
      targetMatches: [
        {
          artifact: "build/server/index.js",
          evidence: "content",
          target: "brace-expansion",
        },
      ],
    }),
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.blocking.some(
      (item) => item.code === "artifact_verification_failed",
    ),
  );
});

test("warns when the clean audited artifact set changed since review", () => {
  const result = evaluateToolchain({
    artifacts: artifactReport({
      artifactSetSha256: "A".repeat(64),
    }),
  });
  assert.equal(result.ok, true);
  assert.ok(
    result.warnings.some(
      (item) => item.code === "artifact_set_changed_since_review",
    ),
  );
  assert.equal(result.blocking.length, 0);
});

test("checks artifact evidence before upstream reporting and acceptance", () => {
  const result = evaluateToolchain({
    artifacts: artifactReport({
      artifactSetSha256: "A".repeat(64),
    }),
    risk: {
      ...acceptedRisk(),
      acceptedAt: null,
      acceptedBy: null,
      status: "proposed",
      upstreamUrls: [],
    },
  });
  for (const code of [
    "risk_not_accepted",
    "upstream_urls_invalid",
  ]) {
    assert.ok(
      result.blocking.some((item) => item.code === code),
      code,
    );
  }
  assert.ok(
    result.warnings.some(
      (item) => item.code === "artifact_set_changed_since_review",
    ),
  );
});

test("binds artifact evidence to an explicitly supported build platform", () => {
  for (const platform of ["linux", "win32"]) {
    const result = evaluateToolchain({
      artifacts: artifactReport({
        artifactSetSha256: RISK.artifactEvidenceSha256ByPlatform[platform],
      }),
      platform,
    });
    assert.equal(result.ok, true, platform);
  }

  const unsupported = evaluateToolchain({
    artifacts: artifactReport({
      artifactSetSha256: "A".repeat(64),
    }),
    platform: "darwin",
  });
  assert.equal(unsupported.ok, false);
  assert.ok(
    unsupported.blocking.some(
      (item) => item.code === "risk_evidence_platform_unsupported",
    ),
  );
  assert.equal(
    unsupported.warnings.some(
      (item) => item.code === "artifact_set_changed_since_review",
    ),
    false,
  );
});

test("blocks target matches even when the artifact scanner reports ok", () => {
  const result = evaluateToolchain({
    artifacts: artifactReport({
      ok: true,
      targetMatches: [
        {
          artifact: "build/server/index.js",
          evidence: "content",
          target: "minimatch",
        },
      ],
    }),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.blocking.some((item) => item.code === "target_found_in_artifact"),
  );
});

test("blocks missing upstream tracking URLs", () => {
  const result = evaluateToolchain({
    risk: acceptedRisk({ upstreamUrls: [] }),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.blocking.some((item) => item.code === "upstream_urls_invalid"),
  );
});

test("validates upstream URL schemes, hosts, paths, roles, and uniqueness", () => {
  const invalidSets = [
    null,
    [],
    ["https://github.com/Shopify/shopify-function-javascript/issues/123"],
    [
      "http://github.com/Shopify/shopify-function-javascript/issues/123",
      "https://community.shopify.dev/t/topic/456",
    ],
    [
      "https://example.test/Shopify/shopify-function-javascript/issues/123",
      "https://community.shopify.dev/t/topic/456",
    ],
    [
      "https://github.com/Shopify/other/issues/123",
      "https://community.shopify.dev/t/topic/456",
    ],
    [
      "https://github.com/Shopify/shopify-function-javascript/issues/123",
      "https://community.shopify.dev/category/topic",
    ],
    [
      "https://github.com/Shopify/shopify-function-javascript/issues/123",
      "https://github.com/Shopify/shopify-function-javascript/issues/456",
    ],
    [
      "https://community.shopify.dev/t/topic/123",
      "https://community.shopify.dev/t/topic/456",
    ],
  ];
  for (const upstreamUrls of invalidSets) {
    const result = validateToolchainRiskDefinition(
      acceptedRisk({ upstreamUrls }),
      { now: new Date("2026-07-28T00:00:00.000Z") },
    );
    assert.equal(result.ok, false, JSON.stringify(upstreamUrls));
    assert.ok(result.errors.includes("upstream_urls_invalid"));
  }

  const reversed = validateToolchainRiskDefinition(
    acceptedRisk({
      upstreamUrls: [
        "https://community.shopify.dev/t/topic/456",
        "https://github.com/Shopify/shopify-function-javascript/issues/123",
      ],
    }),
    { now: new Date("2026-07-28T00:00:00.000Z") },
  );
  assert.equal(reversed.ok, true);
});

test("blocks an expired risk acceptance", () => {
  const result = evaluateToolchain({
    now: new Date("2026-08-28T00:00:00.000Z"),
  });
  assert.equal(result.ok, false);
  assert.ok(result.blocking.some((item) => item.code === "risk_expired"));
});

test("blocks extending the risk beyond the policy maximum", () => {
  const validation = validateToolchainRiskDefinition(
    acceptedRisk({ expiresAt: "2026-08-28T00:00:00.000Z" }),
    { now: new Date("2026-07-28T00:00:00.000Z") },
  );
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("expiry_exceeds_policy"));
});

test("uses exact UTC expiry boundaries", () => {
  const oneMillisecondBefore = evaluateToolchain({
    now: new Date("2026-08-27T23:59:59.998Z"),
  });
  assert.equal(oneMillisecondBefore.ok, true);

  const exact = evaluateToolchain({
    now: new Date("2026-08-27T23:59:59.999Z"),
  });
  assert.equal(exact.ok, false);
  assert.ok(exact.blocking.some((item) => item.code === "risk_expired"));

  const oneMillisecondAfter = evaluateToolchain({
    now: new Date("2026-08-28T00:00:00.000Z"),
  });
  assert.equal(oneMillisecondAfter.ok, false);
  assert.ok(
    oneMillisecondAfter.blocking.some((item) => item.code === "risk_expired"),
  );
});

test("rejects non-UTC, invalid, and future acceptance timestamps", () => {
  for (const expiresAt of [
    "2026-08-27",
    "2026-08-27T23:59:59.999",
    "2026-08-27T23:59:60.000Z",
  ]) {
    const validation = validateToolchainRiskDefinition(
      acceptedRisk({ expiresAt }),
      { now: new Date("2026-07-28T00:00:00.000Z") },
    );
    assert.equal(validation.ok, false, expiresAt);
    assert.ok(validation.errors.includes("expiry_exceeds_policy"));
  }

  const futureAcceptance = validateToolchainRiskDefinition(
    acceptedRisk({ acceptedAt: "2026-07-29T00:00:00.000Z" }),
    { now: new Date("2026-07-28T00:00:00.000Z") },
  );
  assert.equal(futureAcceptance.ok, false);
  assert.ok(futureAcceptance.errors.includes("acceptance_metadata_invalid"));
});

test("validates every risk identity and evidence field", () => {
  assert.deepEqual(validateToolchainRiskDefinition(null).errors, [
    "risk_definition_missing",
  ]);

  const validation = validateToolchainRiskDefinition(
    acceptedRisk({
      acceptedAt: null,
      acceptedBy: "",
      advisoryId: "GHSA-AAAA-BBBB-CCCC",
      allowedVersions: ["1.0.0"],
      approvedPathCount: 0,
      approvedPathLines: ["duplicate", "duplicate"],
      approvedPathSetSha256: "invalid",
      artifactEvidenceSha256ByPlatform: {
        linux: "invalid",
        win32: "invalid",
      },
      packageName: "other",
      rationale: "short",
      requiredParent: {},
      upstreamUrls: ["not-a-url", "https://example.test/topic"],
    }),
    { now: new Date("2026-07-28T00:00:00.000Z") },
  );
  assert.equal(validation.ok, false);
  for (const code of [
    "acceptance_metadata_invalid",
    "advisory_mismatch",
    "package_mismatch",
    "version_mismatch",
    "parent_package_definition_invalid",
    "upstream_urls_invalid",
    "path_fingerprint_invalid",
    "risk_evidence_invalid",
  ]) {
    assert.ok(validation.errors.includes(code), code);
  }
});

test("validates acceptance metadata branches independently", () => {
  const variants = [
    { acceptedBy: null },
    { acceptedBy: "x" },
    { acceptedAt: "invalid" },
    { acceptedAt: "2026-07-29T00:00:00.000Z" },
  ];
  for (const overrides of variants) {
    const validation = validateToolchainRiskDefinition(
      acceptedRisk(overrides),
      { now: new Date("2026-07-28T00:00:00.000Z") },
    );
    assert.equal(validation.ok, false);
    assert.ok(
      validation.errors.includes("acceptance_metadata_invalid"),
      JSON.stringify(overrides),
    );
  }
});

test("validates acceptance provenance branches independently", () => {
  const variants = [
    { reviewedRepository: null },
    { reviewedRepository: "invalid" },
    { reviewedPullRequest: null },
    { reviewedPullRequest: 0 },
    { reviewedPullRequest: "2" },
    { reviewedCommitSha: null },
    { reviewedCommitSha: "A".repeat(40) },
    { reviewedCommitSha: "a".repeat(39) },
    { reviewedCiRunId: null },
    { reviewedCiRunId: "0" },
    { reviewedCiRunId: 30380150062 },
    { acceptanceCommentId: null },
    { acceptanceCommentId: "0" },
    { acceptanceCommentId: 987654321 },
  ];
  for (const overrides of variants) {
    const validation = validateToolchainRiskDefinition(
      acceptedRisk(overrides),
      { now: new Date("2026-07-28T00:00:00.000Z") },
    );
    assert.equal(validation.ok, false);
    assert.ok(
      validation.errors.includes("acceptance_provenance_invalid"),
      JSON.stringify(overrides),
    );
  }
});

test("validates version, parent, path, and evidence branches independently", () => {
  const reversedPaths = [...APPROVED_PATH_LINES].reverse();
  const duplicatePaths = [APPROVED_PATH_LINES[0], APPROVED_PATH_LINES[0]];
  const variants = [
    [{ allowedVersions: null }, "version_mismatch"],
    [{ allowedVersions: [] }, "version_mismatch"],
    [{ allowedVersions: ["2.1.2", "2.1.3"] }, "version_mismatch"],
    [{ requiredParent: null }, "parent_package_definition_invalid"],
    [
      {
        requiredParent: {
          ...RISK.requiredParent,
          packageName: "other",
        },
      },
      "parent_package_definition_invalid",
    ],
    [
      {
        requiredParent: {
          ...RISK.requiredParent,
          allowedVersions: null,
        },
      },
      "parent_package_definition_invalid",
    ],
    [
      {
        requiredParent: {
          ...RISK.requiredParent,
          allowedVersions: ["9.0.9", "9.0.10"],
        },
      },
      "parent_package_definition_invalid",
    ],
    [
      {
        requiredParent: {
          ...RISK.requiredParent,
          allowedVersions: ["9.0.8"],
        },
      },
      "parent_package_definition_invalid",
    ],
    [
      {
        requiredParent: {
          ...RISK.requiredParent,
          allowedVersions: [],
        },
      },
      "parent_package_definition_invalid",
    ],
    [
      {
        requiredParent: {
          ...RISK.requiredParent,
          expectedPhysicalInstallCount: 2,
        },
      },
      "parent_package_definition_invalid",
    ],
    [{ approvedPathLines: null }, "path_fingerprint_invalid"],
    [
      {
        approvedPathCount: 0,
        approvedPathLines: [],
        approvedPathSetSha256: hashDependencyPathLines([]),
      },
      "path_fingerprint_invalid",
    ],
    [{ approvedPathCount: "125" }, "path_fingerprint_invalid"],
    [{ approvedPathCount: 124 }, "path_fingerprint_invalid"],
    [{ approvedPathSetSha256: "A".repeat(64) }, "path_fingerprint_invalid"],
    [
      {
        approvedPathLines: reversedPaths,
        approvedPathSetSha256: hashDependencyPathLines(reversedPaths),
      },
      "path_fingerprint_invalid",
    ],
    [
      {
        approvedPathCount: duplicatePaths.length,
        approvedPathLines: duplicatePaths,
        approvedPathSetSha256: hashDependencyPathLines(duplicatePaths),
      },
      "path_fingerprint_invalid",
    ],
    [{ rationale: null }, "risk_evidence_invalid"],
    [{ rationale: 42 }, "risk_evidence_invalid"],
    [{ rationale: "short" }, "risk_evidence_invalid"],
    [{ artifactEvidenceSha256ByPlatform: null }, "risk_evidence_invalid"],
    [
      {
        artifactEvidenceSha256ByPlatform: {
          linux: "invalid",
          win32: "A".repeat(64),
        },
      },
      "risk_evidence_invalid",
    ],
    [
      {
        artifactEvidenceSha256ByPlatform: {
          darwin: "A".repeat(64),
          linux: "B".repeat(64),
          win32: "C".repeat(64),
        },
      },
      "risk_evidence_invalid",
    ],
  ];

  for (const [overrides, code] of variants) {
    const validation = validateToolchainRiskDefinition(
      acceptedRisk(overrides),
      { now: new Date("2026-07-28T00:00:00.000Z") },
    );
    assert.equal(validation.ok, false, JSON.stringify(overrides));
    assert.ok(validation.errors.includes(code), JSON.stringify(overrides));
  }
});

test("rejects normalized invalid acceptance and expiry timestamps", () => {
  const invalidAcceptance = validateToolchainRiskDefinition(
    acceptedRisk({
      acceptedAt: "2026-02-30T00:00:00.000Z",
    }),
    { now: new Date("2026-07-28T00:00:00.000Z") },
  );
  assert.equal(invalidAcceptance.ok, false);
  assert.ok(invalidAcceptance.errors.includes("acceptance_metadata_invalid"));

  const missingExpiry = validateToolchainRiskDefinition(
    acceptedRisk({
      expiresAt: null,
    }),
    { now: new Date("2026-07-28T00:00:00.000Z") },
  );
  assert.equal(missingExpiry.ok, false);
  assert.ok(missingExpiry.errors.includes("expiry_exceeds_policy"));
});

test("reports independent risk, advisory, path, runtime, and artifact failures together", () => {
  const lockfile = clone(LOCKFILE);
  lockfile.packages[""].dependencies["runtime-security-tool"] = "1.0.0";
  lockfile.packages["node_modules/runtime-security-tool"] = {
    dependencies: {
      "brace-expansion": "2.1.2",
    },
    version: "1.0.0",
  };
  lockfile.packages[""].devDependencies["new-security-tool"] = "1.0.0";
  lockfile.packages["node_modules/new-security-tool"] = {
    dependencies: {
      "brace-expansion": "2.1.2",
    },
    version: "1.0.0",
  };
  const report = braceAuditReport();
  report.vulnerabilities["new-high"] = {
    nodes: ["node_modules/new-high"],
    severity: "high",
    via: [
      {
        dependency: "new-high",
        name: "new-high",
        severity: "high",
        url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
      },
    ],
  };

  const result = evaluateToolchain({
    artifacts: artifactReport({
      ok: false,
      targetMatches: [
        {
          artifact: "build/server/index.js",
          evidence: "content",
          target: "minimatch",
        },
      ],
    }),
    lockfile,
    now: new Date("2026-08-28T00:00:00.000Z"),
    report,
    risk: acceptedRisk({
      status: "proposed",
      upstreamUrls: [],
    }),
  });
  const codes = new Set(result.blocking.map((item) => item.code));
  for (const code of [
    "risk_not_accepted",
    "upstream_urls_invalid",
    "risk_expired",
    "unexpected_high_or_critical",
    "dependency_paths_added",
    "root_runtime_path_detected",
    "artifact_verification_failed",
  ]) {
    assert.ok(codes.has(code), code);
  }
});

test("blocks an extraneous dependency path", () => {
  const lockfile = clone(LOCKFILE);
  lockfile.packages["extensions/ghost-tool"] = {
    version: "1.0.0",
    extraneous: true,
    dependencies: {
      "brace-expansion": "2.1.2",
    },
  };

  const result = evaluateToolchain({ lockfile });
  assert.equal(result.ok, false);
  assert.ok(
    result.blocking.some(
      (item) => item.code === "extraneous_dependency_path_detected",
    ),
  );
});

test("blocks a physically installed toolchain package with no entry path", () => {
  const lockfile = {
    lockfileVersion: 3,
    name: "fixture",
    packages: {
      "": {
        dependencies: {},
        devDependencies: {},
        name: "fixture",
        version: "0.0.0",
      },
      "node_modules/brace-expansion": {
        name: "brace-expansion",
        version: "2.1.2",
      },
      "node_modules/minimatch": {
        dependencies: {
          "brace-expansion": "2.1.2",
        },
        name: "minimatch",
        version: "9.0.9",
      },
    },
    version: "0.0.0",
  };
  const result = evaluateToolchain({ lockfile });
  assert.equal(result.ok, false);
  assert.ok(
    result.blocking.some(
      (item) => item.code === "vulnerable_package_unreachable_from_entries",
    ),
  );
});

test("reports moderate-only and missing toolchain advisory leaves", () => {
  const moderateOnly = braceAuditReport();
  moderateOnly.vulnerabilities["brace-expansion"].via[0].severity = "moderate";
  const moderateResult = evaluateToolchain({ report: moderateOnly });
  assert.equal(moderateResult.ok, false);
  assert.ok(
    moderateResult.blocking.some(
      (item) => item.code === "unexpected_high_or_critical",
    ),
  );

  const missingVia = braceAuditReport();
  missingVia.vulnerabilities["brace-expansion"].via = null;
  const missingResult = evaluateToolchain({ report: missingVia });
  assert.equal(missingResult.ok, false);
  assert.ok(
    missingResult.blocking.some(
      (item) => item.code === "advisory_chain_unresolved",
    ),
  );
});

function knownRuntimeReport() {
  return {
    vulnerabilities: {
      "@remix-run/react": {
        severity: "moderate",
        via: ["react-router", "react-router-dom"],
      },
      "react-router": {
        severity: "moderate",
        via: [
          {
            dependency: "react-router",
            name: "react-router",
            severity: "moderate",
            url: "https://github.com/advisories/GHSA-wrjc-x8rr-h8h6",
          },
          {
            dependency: "react-router",
            name: "react-router",
            severity: "moderate",
            url: "https://github.com/advisories/GHSA-337j-9hxr-rhxg",
          },
        ],
      },
      "react-router-dom": {
        severity: "moderate",
        via: [
          {
            dependency: "react-router-dom",
            name: "react-router-dom",
            severity: "moderate",
            url: "https://github.com/advisories/GHSA-jjmj-jmhj-qwj2",
          },
          "react-router",
        ],
      },
    },
  };
}

test("preserves only the documented React Router moderate exception", () => {
  const report = knownRuntimeReport();
  const result = evaluateRuntimeAudit(report, report.vulnerabilities, {
    now: new Date("2026-07-28T00:00:00.000Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.allowed.length, 3);
});

test("never accepts a runtime high severity advisory", () => {
  const report = knownRuntimeReport();
  report.vulnerabilities["react-router"].severity = "high";

  const result = evaluateRuntimeAudit(report, report.vulnerabilities, {
    now: new Date("2026-07-28T00:00:00.000Z"),
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.blocking.some((item) => item.code === "runtime_high_or_critical"),
  );
});

test("blocks unresolved and undocumented runtime advisories", () => {
  const result = evaluateRuntimeAudit(
    {
      vulnerabilities: {
        unknown: {
          severity: "moderate",
          via: [],
        },
      },
    },
    {
      unknown: {
        severity: "moderate",
        via: [],
      },
    },
    {
      now: new Date("2026-07-28T00:00:00.000Z"),
      unresolvedAuditPackages: ["missing-node"],
    },
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.blocking.some((item) => item.code === "audit_nodes_missing"),
  );
  assert.ok(
    result.blocking.some(
      (item) => item.code === "runtime_advisory_not_allowed",
    ),
  );
});

test("expires the React Router exception", () => {
  const report = knownRuntimeReport();
  const result = evaluateRuntimeAudit(report, report.vulnerabilities, {
    now: new Date("2026-10-01T00:00:00.000Z"),
  });

  assert.equal(result.ok, false);
});

test("rejects known runtime packages with empty, broken, or unidentified leaves", () => {
  const variants = [
    {
      vulnerabilities: {
        "react-router": {
          severity: "moderate",
          via: [],
        },
      },
    },
    {
      vulnerabilities: {
        "react-router": {
          severity: "moderate",
          via: ["missing-leaf"],
        },
      },
    },
    {
      vulnerabilities: {
        "react-router": {
          severity: "moderate",
          via: [
            {
              name: "react-router",
              severity: "moderate",
              url: "not-an-advisory-url",
            },
          ],
        },
      },
    },
  ];

  for (const report of variants) {
    const result = evaluateRuntimeAudit(report, report.vulnerabilities, {
      now: new Date("2026-07-28T00:00:00.000Z"),
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.blocking.some(
        (item) => item.code === "runtime_advisory_not_allowed",
      ),
    );
  }
});

test("handles empty runtime input and rejects non-moderate known packages", () => {
  const empty = evaluateRuntimeAudit({}, null, {
    now: new Date("2026-07-28T00:00:00.000Z"),
  });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.allowed, []);

  const report = {
    vulnerabilities: {
      "react-router": {
        severity: null,
        via: [],
      },
    },
  };
  const unknownSeverity = evaluateRuntimeAudit(report, report.vulnerabilities, {
    now: new Date("2026-07-28T00:00:00.000Z"),
  });
  assert.equal(unknownSeverity.ok, false);
  assert.ok(
    unknownSeverity.blocking.some(
      (item) =>
        item.code === "runtime_advisory_not_allowed" &&
        item.severity === "unknown",
    ),
  );
});

test("extracts direct advisory IDs and ignores string links", () => {
  assert.deepEqual(
    advisoryIdsForVulnerability({
      via: [
        "child",
        {
          url: "https://github.com/advisories/GHSA-abcd-1234-efgh",
        },
        {
          url: "invalid",
        },
        null,
      ],
    }),
    ["GHSA-ABCD-1234-EFGH"],
  );
  assert.deepEqual(advisoryIdsForVulnerability({ via: null }), []);
});

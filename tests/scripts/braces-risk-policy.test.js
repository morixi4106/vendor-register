import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import {
  validateToolchainRiskDefinition,
  evaluateToolchainAudit,
} from "../../scripts/security/audit-policy.mjs";
import {
  BRACES_ADVISORY_ID,
  validateBracesRiskDefinition,
  riskRelativePath,
  activeRiskRelativePath,
  BRACES_CONDITIONS,
  BRACES_CONDITION_POLICY,
  BRACES_CONDITION_RISK_PATH,
} from "../../scripts/security/toolchain-risk-scope.mjs";
import { enumerateDependencyPaths } from "../../scripts/security/package-lock-graph.mjs";
import {
  validateAcceptedRiskProvenance,
  expectedAcceptanceComment,
  riskCoreSha256,
} from "../../scripts/security/risk-acceptance-provenance.mjs";
import { evaluateProductionAuditReport } from "../../scripts/audit-production-dependencies.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const lock = JSON.parse(
  fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
);
const paths = enumerateDependencyPaths(lock, {
  targetName: "braces",
  targetVersion: "3.0.3",
});

test("condition-bound acceptance is a distinct proposal, not an extension of the dated exception", () => {
  const conditional = risk({
    policy: BRACES_CONDITION_POLICY,
    conditions: BRACES_CONDITIONS,
  });
  delete conditional.expiresAt;
  assert.equal(riskRelativePath(conditional), BRACES_CONDITION_RISK_PATH);
  assert.equal(
    activeRiskRelativePath({
      BUILD_TOOLCHAIN_RISK_POLICY: BRACES_CONDITION_POLICY,
    }),
    BRACES_CONDITION_RISK_PATH,
  );
  assert.throws(
    () => activeRiskRelativePath({ BUILD_TOOLCHAIN_RISK_POLICY: "unknown" }),
    /unsupported/,
  );
  assert.equal(
    validateBracesRiskDefinition(conditional, {
      now: new Date("2027-01-01T00:00:00.000Z"),
    }).ok,
    true,
  );
  const proposed = validateBracesRiskDefinition(
    { ...conditional, status: "proposed" },
    { now: NOW },
  );
  assert.deepEqual(proposed.errors, ["risk_not_accepted"]);
  for (const change of [
    { expiresAt: "2027-01-01T00:00:00.000Z" },
    { conditions: {} },
    { conditions: { ...BRACES_CONDITIONS, ownerResponseDays: 30 } },
    { policy: "unknown" },
  ])
    assert.equal(
      validateBracesRiskDefinition({ ...conditional, ...change }, { now: NOW })
        .ok,
      false,
    );
  const updatedReport = structuredClone(report);
  updatedReport.vulnerabilities.braces.via[0].cvss = {
    vectorString: BRACES_CONDITIONS.advisoryVector,
  };
  const updatedLock = structuredClone(lock);
  updatedLock.packages[""].version = "unrelated-metadata";
  assert.equal(
    evaluate(conditional, updatedLock, {
      report: updatedReport,
      artifactReport: {
        ok: true,
        targetMatches: [],
        artifactSetSha256: "F".repeat(64),
      },
    }).ok,
    true,
  );
  updatedReport.vulnerabilities.braces.via[0].cvss.vectorString =
    "CVSS:3.1/C:H/I:H/A:H";
  assert.equal(
    evaluate(conditional, updatedLock, { report: updatedReport }).ok,
    false,
  );
  assert.equal(evaluate(conditional, updatedLock).ok, false);
  updatedLock.packages["node_modules/braces"].integrity = "tampered";
  assert.equal(
    evaluate(conditional, updatedLock, { report: updatedReport }).ok,
    false,
  );
});
const NOW = new Date("2026-10-10T00:00:00.000Z");
function risk(overrides = {}) {
  return {
    status: "accepted",
    advisoryId: BRACES_ADVISORY_ID,
    packageName: "braces",
    allowedVersions: ["3.0.3"],
    packageIntegrity: lock.packages["node_modules/braces"].integrity,
    requiredParent: {
      packageName: "micromatch",
      allowedVersions: ["4.0.8"],
      expectedPhysicalInstallCount: 1,
    },
    approvedPathLines: paths.pathLines,
    approvedPathCount: paths.pathLines.length,
    approvedPathSetSha256: paths.pathSetSha256,
    lockfileSha256: crypto
      .createHash("sha256")
      .update(JSON.stringify(lock))
      .digest("hex")
      .toUpperCase(),
    proposedAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-23T00:00:00.000Z",
    acceptedAt: "2026-10-09T01:00:00.000Z",
    acceptedBy: "reviewer",
    reviewedRepository: "owner/repo",
    reviewedPullRequest: 39,
    reviewedCommitSha: "a".repeat(40),
    reviewedCiRunId: "123",
    acceptanceCommentId: "456",
    artifactEvidenceSha256ByPlatform: {
      linux: "A".repeat(64),
      win32: "B".repeat(64),
    },
    buildControlSha256: "C".repeat(64),
    runtimeManifestSha256: "D".repeat(64),
    runtimeLockfileSha256: "E".repeat(64),
    upstreamUrls: [
      "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
      "https://github.com/micromatch/braces/issues/70",
    ],
    rationale:
      "Reviewed fixture only: isolated bounded compilation and verified runtime separation; not an actual approval.",
    ...overrides,
  };
}
const report = {
  vulnerabilities: {
    braces: {
      severity: "high",
      via: [
        {
          name: "braces",
          severity: "high",
          url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
        },
      ],
      nodes: ["node_modules/braces"],
    },
    micromatch: {
      severity: "high",
      via: ["braces"],
      nodes: ["node_modules/micromatch"],
    },
  },
};
function evaluate(r = risk(), l = lock, extra = {}) {
  return evaluateToolchainAudit({
    artifactReport: {
      ok: true,
      targetMatches: [],
      artifactSetSha256: "A".repeat(64),
    },
    lockfile: l,
    nonRuntimeVulnerabilities: report.vulnerabilities,
    report,
    now: NOW,
    platform: "linux",
    risk: r,
    ...extra,
  });
}

test("braces proposal does not become an exception until explicit acceptance", () => {
  assert.deepEqual(
    validateToolchainRiskDefinition(risk({ status: "proposed" }), {
      now: NOW,
      platform: "linux",
    }).errors,
    ["risk_not_accepted"],
  );
  assert.equal(evaluate(risk({ status: "proposed" })).ok, false);
  assert.equal(evaluate().ok, true);
});

test("production audit also requires verified build isolation and runtime installation evidence", () => {
  const r = risk();
  for (const buildControlEvidence of [undefined, { ok: false }, { ok: true }]) {
    const result = evaluateProductionAuditReport(report, {
      risk: r,
      lockfile: lock,
      now: NOW,
      artifactReport: {
        ok: true,
        targetMatches: [],
        artifactSetSha256: r.artifactEvidenceSha256ByPlatform[process.platform],
      },
      buildControlEvidence,
    });
    assert.equal(result.ok, buildControlEvidence?.ok === true);
    assert.equal(
      result.checks.buildIsolationAndRuntimePackage,
      buildControlEvidence?.ok === true ? "passed" : "failed",
    );
  }
});

test("braces risk has an exact identity, integrity, parent and maximum duration", () => {
  const cases = [
    { allowedVersions: ["3.0.4"] },
    { packageIntegrity: "different" },
    { requiredParent: { packageName: "other" } },
    { expiresAt: "2026-10-23T00:00:00.001Z" },
    { proposedAt: "2026-10-11T00:00:00.000Z" },
    { acceptedAt: "2026-10-08T00:00:00.000Z" },
    { upstreamUrls: ["http://example.test"] },
    { approvedPathLines: [] },
    { buildControlSha256: null },
    { artifactEvidenceSha256ByPlatform: { linux: null, win32: null } },
    { reviewedCommitSha: "invalid" },
    { acceptedBy: "bad actor" },
  ];
  for (const change of cases)
    assert.equal(
      validateBracesRiskDefinition(risk(change), {
        now: NOW,
        platform: "linux",
      }).ok,
      false,
      JSON.stringify(change),
    );
  assert.equal(
    validateBracesRiskDefinition(risk(), {
      now: new Date("2026-10-23T00:00:00.000Z"),
      platform: "linux",
    }).ok,
    false,
  );
  assert.equal(
    validateBracesRiskDefinition(risk(), { now: NOW, platform: "darwin" }).ok,
    false,
  );
  assert.throws(
    () => riskRelativePath({ advisoryId: "other" }),
    /unsupported_risk_identity/,
  );
});

test("changed lock metadata, paths or artifacts invalidate accepted braces evidence", () => {
  const changed = structuredClone(lock);
  changed.packages["node_modules/braces"].integrity = "changed";
  assert.ok(
    evaluate(risk(), changed).blocking.some(
      (row) => row.code === "reviewed_dependency_integrity_changed",
    ),
  );
  assert.equal(
    evaluate(risk(), lock, {
      artifactReport: {
        ok: true,
        targetMatches: [],
        artifactSetSha256: "F".repeat(64),
      },
    }).ok,
    false,
  );
  assert.equal(
    evaluate(risk({ approvedPathLines: paths.pathLines.slice(1) })).ok,
    false,
  );
});

test("another High/Critical leaf cannot be accepted through the braces parent", () => {
  const changed = structuredClone(report);
  changed.vulnerabilities.other = {
    severity: "critical",
    via: [
      {
        name: "other",
        severity: "critical",
        url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
      },
    ],
    nodes: ["node_modules/other"],
  };
  changed.vulnerabilities.micromatch.via.push("other");
  const result = evaluate(risk(), lock, {
    report: changed,
    nonRuntimeVulnerabilities: changed.vulnerabilities,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.accepted, []);
});

test("braces acceptance remains bound to its own PR, owner comment and reviewed evidence", () => {
  const r = risk();
  const input = {
    risk: r,
    isReviewedCommitAncestor: true,
    current: {
      changedPaths: [riskRelativePath(r)],
      enforceAcceptanceOnlyDiff: true,
      headSha: "b".repeat(40),
      now: NOW,
      pullRequestNumber: 39,
      repository: "owner/repo",
    },
    evidence: {
      schemaVersion: 1,
      repository: r.reviewedRepository,
      pullRequestNumber: 39,
      runId: "123",
      headSha: r.reviewedCommitSha,
      auditOk: false,
      riskStatus: "proposed",
      riskCoreSha256: riskCoreSha256(r),
      errors: ["risk_not_accepted"],
      checks: {
        riskAcceptance: "failed",
        buildIsolationAndRuntimePackage: "passed",
      },
      artifactCount: 150,
      artifactSetSha256: "A".repeat(64),
      productionSbomComponentCount: 140,
    },
    reviewRun: {
      id: 123,
      repository: { full_name: r.reviewedRepository },
      head_sha: r.reviewedCommitSha,
      event: "pull_request",
      status: "completed",
      conclusion: "failure",
      name: "Quality checks",
      pull_requests: [{ number: 39 }],
      updated_at: "2026-10-09T00:10:00.000Z",
    },
    acceptanceComment: {
      id: 456,
      issue_url: "https://api.github.com/repos/owner/repo/issues/39",
      user: { login: "reviewer" },
      author_association: "OWNER",
      body: expectedAcceptanceComment(r),
      created_at: "2026-10-09T00:20:00.000Z",
    },
  };
  assert.equal(validateAcceptedRiskProvenance(input).ok, true);
  const changed = structuredClone(input);
  changed.current.changedPaths.push("server.mjs");
  assert.equal(validateAcceptedRiskProvenance(changed).ok, false);
  const old = structuredClone(input);
  old.current.changedPaths = [
    "security/risk-decisions/GHSA-mh99-v99m-4gvg.json",
  ];
  assert.equal(validateAcceptedRiskProvenance(old).ok, false);
  const forged = structuredClone(input);
  forged.acceptanceComment.user.login = "different";
  assert.equal(validateAcceptedRiskProvenance(forged).ok, false);
});

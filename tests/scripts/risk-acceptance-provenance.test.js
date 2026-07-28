import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRiskReviewEvidence,
  collectGitEvidence,
  collectRiskStatusAtCommit,
  emitWorkflowOutputs,
  expectedAcceptanceComment,
  reviewArtifactName,
  riskCore,
  riskCoreSha256,
  validateAcceptedRiskProvenance,
  verifyAcceptedRiskProvenance,
  writeRiskReviewEvidence,
} from "../../scripts/security/risk-acceptance-provenance.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..", "..");
const REVIEWED_SHA = "a".repeat(40);
const CURRENT_SHA = "b".repeat(40);

function acceptedRisk(overrides = {}) {
  return {
    acceptanceCommentId: "987654321",
    acceptedAt: "2026-07-28T00:30:00.000Z",
    acceptedBy: "morixi4106",
    advisoryId: "GHSA-MH99-V99M-4GVG",
    allowedVersions: ["2.1.2"],
    artifactEvidenceSha256ByPlatform: {
      linux: "A".repeat(64),
      win32: "B".repeat(64),
    },
    expiresAt: "2026-08-27T23:59:59.999Z",
    packageName: "brace-expansion",
    rationale:
      "Reviewed build-tool-only dependency with artifact and path evidence.",
    reviewedCiRunId: "30380150062",
    reviewedCommitSha: REVIEWED_SHA,
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

function reviewEvidence(risk = acceptedRisk(), overrides = {}) {
  return {
    artifactCount: 136,
    artifactSetSha256: "C".repeat(64),
    auditOk: false,
    checkedOutSha: "d".repeat(40),
    checks: {
      artifactReachability: "passed",
      riskAcceptance: "failed",
      upstreamUrls: "passed",
    },
    errors: ["risk_not_accepted"],
    generatedAt: "2026-07-28T00:09:00.000Z",
    headSha: risk.reviewedCommitSha,
    productionSbomComponentCount: 84,
    pullRequestNumber: risk.reviewedPullRequest,
    repository: risk.reviewedRepository,
    riskCoreSha256: riskCoreSha256(risk),
    riskStatus: "proposed",
    runId: risk.reviewedCiRunId,
    schemaVersion: 1,
    ...overrides,
  };
}

function reviewRun(risk = acceptedRisk(), overrides = {}) {
  return {
    conclusion: "failure",
    event: "pull_request",
    head_sha: risk.reviewedCommitSha,
    id: Number(risk.reviewedCiRunId),
    name: "Quality checks",
    pull_requests: [{ number: risk.reviewedPullRequest }],
    repository: { full_name: risk.reviewedRepository },
    status: "completed",
    updated_at: "2026-07-28T00:10:00.000Z",
    ...overrides,
  };
}

function approvalComment(risk = acceptedRisk(), overrides = {}) {
  return {
    author_association: "OWNER",
    body: expectedAcceptanceComment(risk),
    created_at: "2026-07-28T00:20:00.000Z",
    id: Number(risk.acceptanceCommentId),
    issue_url: `https://api.github.com/repos/${risk.reviewedRepository}/issues/${risk.reviewedPullRequest}`,
    user: { login: risk.acceptedBy },
    ...overrides,
  };
}

function currentContext(overrides = {}) {
  return {
    changedPaths: ["security/risk-decisions/GHSA-mh99-v99m-4gvg.json"],
    enforceAcceptanceOnlyDiff: true,
    headSha: CURRENT_SHA,
    now: new Date("2026-07-28T01:00:00.000Z"),
    pullRequestNumber: 2,
    repository: "morixi4106/vendor-register",
    ...overrides,
  };
}

function writeTemporaryJson(value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "risk-provenance-"));
  const filePath = path.join(directory, "value.json");
  fs.writeFileSync(filePath, JSON.stringify(value));
  return {
    directory,
    filePath,
  };
}

test("builds stable risk core hashes without acceptance metadata", () => {
  const risk = acceptedRisk();
  const core = riskCore(risk);
  assert.equal(core.status, undefined);
  assert.equal(core.acceptedBy, undefined);
  assert.equal(core.reviewedCommitSha, undefined);
  assert.equal(core.packageName, "brace-expansion");
  assert.equal(
    riskCoreSha256(risk),
    riskCoreSha256({
      ...risk,
      acceptanceCommentId: "1",
      acceptedAt: "2026-07-29T00:00:00.000Z",
      acceptedBy: "another-owner",
      reviewedCiRunId: "1",
      reviewedCommitSha: "f".repeat(40),
      reviewedPullRequest: 99,
      reviewedRepository: "owner/other",
      status: "proposed",
    }),
  );
  assert.notEqual(
    riskCoreSha256(risk),
    riskCoreSha256({ ...risk, expiresAt: "2026-08-26T00:00:00.000Z" }),
  );
  assert.deepEqual(riskCore(null), {});
  assert.equal(riskCoreSha256(null), riskCoreSha256({}));
});

test("builds review evidence from audit results", () => {
  const risk = acceptedRisk({ status: "proposed" });
  const evidence = buildRiskReviewEvidence({
    artifactReport: {
      artifactSetSha256: "D".repeat(64),
      artifacts: [{ path: "build/server/index.js" }],
    },
    env: {
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "123",
      GITHUB_SHA: "e".repeat(40),
      RISK_REVIEW_HEAD_SHA: "f".repeat(40),
      RISK_REVIEW_PR_NUMBER: "7",
    },
    evaluation: {
      checks: { riskAcceptance: "failed" },
      errors: ["upstream_urls_invalid", "risk_not_accepted"],
      ok: false,
    },
    now: new Date("2026-07-28T00:00:00.000Z"),
    npmTreeReport: {
      summary: { productionSbomComponentCount: 84 },
    },
    risk,
  });
  assert.equal(evidence.repository, "owner/repo");
  assert.equal(evidence.pullRequestNumber, 7);
  assert.equal(evidence.runId, "123");
  assert.equal(evidence.artifactCount, 1);
  assert.deepEqual(evidence.errors, [
    "risk_not_accepted",
    "upstream_urls_invalid",
  ]);

  const missing = buildRiskReviewEvidence({ risk: {} });
  assert.equal(missing.pullRequestNumber, null);
  assert.equal(missing.artifactCount, null);
  assert.equal(missing.productionSbomComponentCount, null);

  const unsafeInteger = buildRiskReviewEvidence({
    env: { RISK_REVIEW_PR_NUMBER: "999999999999999999999" },
    risk: {},
  });
  assert.equal(unsafeInteger.pullRequestNumber, null);
});

test("writes evidence only below the repository audit directory", () => {
  const relative = path.join(
    REPOSITORY_ROOT,
    ".audit",
    `risk-provenance-${process.pid}`,
    "evidence.json",
  );
  try {
    assert.equal(
      writeRiskReviewEvidence({ ok: true }, { outputPath: relative }),
      relative,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(relative, "utf8")), {
      ok: true,
    });
    assert.throws(
      () =>
        writeRiskReviewEvidence(
          { ok: true },
          { outputPath: path.join(os.tmpdir(), "outside.json") },
        ),
      /outside \.audit/,
    );
    assert.throws(
      () =>
        writeRiskReviewEvidence(
          { ok: true },
          { outputPath: path.join(REPOSITORY_ROOT, ".audit") },
        ),
      /outside \.audit/,
    );
  } finally {
    fs.rmSync(path.dirname(relative), { force: true, recursive: true });
  }
});

test("formats artifact names and explicit acceptance comments", () => {
  const risk = acceptedRisk();
  assert.equal(
    reviewArtifactName(risk.reviewedCiRunId),
    "production-audit-review-evidence-30380150062",
  );
  assert.throws(() => reviewArtifactName("0"), /invalid/);
  assert.throws(() => reviewArtifactName(), /invalid/);
  assert.match(
    expectedAcceptanceComment(risk),
    /^\/accept-toolchain-risk GHSA-MH99-V99M-4GVG\n/,
  );
  assert.match(expectedAcceptanceComment(risk), /reviewed-commit: a{40}/);
});

test("accepts a complete immutable review provenance chain", () => {
  const risk = acceptedRisk();
  const result = validateAcceptedRiskProvenance({
    acceptanceComment: approvalComment(risk),
    current: currentContext(),
    evidence: reviewEvidence(risk),
    isReviewedCommitAncestor: true,
    reviewRun: reviewRun(risk),
    risk,
  });
  assert.deepEqual(result, {
    errors: [],
    ok: true,
  });

  const mainPush = validateAcceptedRiskProvenance({
    acceptanceComment: approvalComment(risk),
    current: currentContext({
      changedPaths: ["app/routes/app.jsx"],
      enforceAcceptanceOnlyDiff: false,
    }),
    evidence: reviewEvidence(risk),
    isReviewedCommitAncestor: true,
    reviewRun: reviewRun(risk),
    risk,
  });
  assert.equal(mainPush.ok, true);

  const fallbackRunTimestamp = validateAcceptedRiskProvenance({
    acceptanceComment: approvalComment(risk),
    current: currentContext(),
    evidence: reviewEvidence(risk),
    isReviewedCommitAncestor: true,
    reviewRun: reviewRun(risk, {
      run_completed_at: "2026-07-28T00:10:00.000Z",
      updated_at: null,
    }),
    risk,
  });
  assert.equal(fallbackRunTimestamp.ok, true);

  const futurePullRequest = validateAcceptedRiskProvenance({
    acceptanceComment: approvalComment(risk),
    current: currentContext({
      changedPaths: ["app/routes/app.jsx"],
      enforceAcceptanceOnlyDiff: false,
      pullRequestNumber: 3,
    }),
    evidence: reviewEvidence(risk),
    isReviewedCommitAncestor: true,
    reviewRun: reviewRun(risk),
    risk,
  });
  assert.equal(futurePullRequest.ok, true);
});

test("rejects every broken review provenance boundary", () => {
  const risk = acceptedRisk();
  const variants = [
    {
      code: "acceptance_review_target_invalid",
      current: currentContext({ repository: "other/repo" }),
    },
    {
      code: "acceptance_review_target_invalid",
      isReviewedCommitAncestor: false,
    },
    {
      code: "acceptance_diff_not_metadata_only",
      current: currentContext({ changedPaths: ["app/root.jsx"] }),
    },
    {
      code: "acceptance_diff_not_metadata_only",
      current: currentContext({ changedPaths: [] }),
    },
    {
      code: "acceptance_diff_not_metadata_only",
      current: currentContext({
        changedPaths: [
          "security/risk-decisions/GHSA-mh99-v99m-4gvg.json",
          "app/root.jsx",
        ],
      }),
    },
    {
      code: "reviewed_ci_run_invalid",
      reviewRun: reviewRun(risk, { conclusion: "success" }),
    },
    {
      code: "reviewed_audit_evidence_invalid",
      evidence: reviewEvidence(risk, {
        errors: ["risk_not_accepted", "unexpected_failure"],
      }),
    },
    {
      acceptanceComment: approvalComment(risk, { body: "approved" }),
      code: "acceptance_comment_invalid",
    },
    {
      acceptanceComment: approvalComment(risk, {
        issue_url:
          "https://api.github.com/repos/morixi4106/vendor-register/issues/99",
      }),
      code: "acceptance_comment_invalid",
    },
    {
      acceptanceComment: approvalComment(risk, {
        issue_url: "not-a-url",
      }),
      code: "acceptance_comment_invalid",
    },
    {
      acceptanceComment: approvalComment(risk, {
        created_at: "2026-07-28T00:05:00.000Z",
      }),
      code: "acceptance_timeline_invalid",
    },
  ];
  for (const variant of variants) {
    const result = validateAcceptedRiskProvenance({
      acceptanceComment: variant.acceptanceComment || approvalComment(risk),
      current: variant.current || currentContext(),
      evidence: variant.evidence || reviewEvidence(risk),
      isReviewedCommitAncestor: variant.isReviewedCommitAncestor ?? true,
      reviewRun: variant.reviewRun || reviewRun(risk),
      risk,
    });
    assert.equal(result.ok, false, variant.code);
    assert.ok(result.errors.includes(variant.code), variant.code);
  }
});

test("rejects mutated review run, evidence, and approver fields", () => {
  const risk = acceptedRisk();
  const variants = [
    {
      code: "acceptance_review_target_invalid",
      current: currentContext({ headSha: risk.reviewedCommitSha }),
    },
    {
      code: "acceptance_review_target_invalid",
      current: currentContext({ headSha: "invalid" }),
    },
    {
      code: "acceptance_review_target_invalid",
      current: currentContext({ pullRequestNumber: 3 }),
    },
    {
      code: "reviewed_ci_run_invalid",
      reviewRun: reviewRun(risk, { id: 1 }),
    },
    {
      code: "reviewed_ci_run_invalid",
      reviewRun: reviewRun(risk, {
        repository: { full_name: "other/repo" },
      }),
    },
    {
      code: "reviewed_ci_run_invalid",
      reviewRun: reviewRun(risk, { head_sha: "c".repeat(40) }),
    },
    {
      code: "reviewed_ci_run_invalid",
      reviewRun: reviewRun(risk, { event: "push" }),
    },
    {
      code: "reviewed_ci_run_invalid",
      reviewRun: reviewRun(risk, { status: "in_progress" }),
    },
    {
      code: "reviewed_ci_run_invalid",
      reviewRun: reviewRun(risk, { name: "Other workflow" }),
    },
    {
      code: "reviewed_ci_run_invalid",
      reviewRun: reviewRun(risk, { pull_requests: null }),
    },
    {
      code: "reviewed_ci_run_invalid",
      reviewRun: reviewRun(risk, { pull_requests: [{ number: 99 }] }),
    },
    {
      code: "reviewed_audit_evidence_invalid",
      evidence: reviewEvidence(risk, { auditOk: true }),
    },
    {
      code: "reviewed_audit_evidence_invalid",
      evidence: reviewEvidence(risk, { schemaVersion: 2 }),
    },
    {
      code: "reviewed_audit_evidence_invalid",
      evidence: reviewEvidence(risk, { repository: "other/repo" }),
    },
    {
      code: "reviewed_audit_evidence_invalid",
      evidence: reviewEvidence(risk, { pullRequestNumber: 99 }),
    },
    {
      code: "reviewed_audit_evidence_invalid",
      evidence: reviewEvidence(risk, { runId: "1" }),
    },
    {
      code: "reviewed_audit_evidence_invalid",
      evidence: reviewEvidence(risk, { headSha: "c".repeat(40) }),
    },
    {
      code: "reviewed_audit_evidence_invalid",
      evidence: reviewEvidence(risk, { riskStatus: "accepted" }),
    },
    {
      code: "reviewed_audit_evidence_invalid",
      evidence: reviewEvidence(risk, { riskCoreSha256: "D".repeat(64) }),
    },
    {
      code: "reviewed_audit_evidence_invalid",
      evidence: reviewEvidence(risk, { checks: {} }),
    },
    {
      code: "reviewed_audit_evidence_invalid",
      evidence: reviewEvidence(risk, {
        checks: {
          artifactReachability: "failed",
          riskAcceptance: "failed",
        },
      }),
    },
    {
      code: "reviewed_audit_evidence_invalid",
      evidence: reviewEvidence(risk, {
        checks: { riskAcceptance: "failed" },
      }),
    },
    {
      code: "reviewed_audit_evidence_invalid",
      evidence: reviewEvidence(risk, { artifactCount: 0 }),
    },
    {
      code: "reviewed_audit_evidence_invalid",
      evidence: reviewEvidence(risk, { artifactCount: 1.5 }),
    },
    {
      code: "reviewed_audit_evidence_invalid",
      evidence: reviewEvidence(risk, { artifactSetSha256: "invalid" }),
    },
    {
      code: "reviewed_audit_evidence_invalid",
      evidence: reviewEvidence(risk, { artifactSetSha256: null }),
    },
    {
      code: "reviewed_audit_evidence_invalid",
      evidence: reviewEvidence(risk, { productionSbomComponentCount: 0 }),
    },
    {
      code: "reviewed_audit_evidence_invalid",
      evidence: reviewEvidence(risk, { productionSbomComponentCount: 1.5 }),
    },
    {
      acceptanceComment: approvalComment(risk, { id: 1 }),
      code: "acceptance_comment_invalid",
    },
    {
      acceptanceComment: approvalComment(risk, {
        author_association: "CONTRIBUTOR",
      }),
      code: "acceptance_comment_invalid",
    },
    {
      acceptanceComment: approvalComment(risk, {
        user: { login: "another-user" },
      }),
      code: "acceptance_comment_invalid",
    },
    {
      acceptanceComment: approvalComment(risk, { body: null }),
      code: "acceptance_comment_invalid",
    },
    {
      acceptanceComment: approvalComment(risk, { created_at: "invalid" }),
      code: "acceptance_timeline_invalid",
    },
    {
      code: "acceptance_timeline_invalid",
      reviewRun: reviewRun(risk, { updated_at: "invalid" }),
    },
    {
      code: "acceptance_timeline_invalid",
      current: currentContext({
        now: new Date("2026-07-28T00:25:00.000Z"),
      }),
    },
    {
      acceptanceComment: approvalComment(risk, {
        created_at: "2026-07-28T00:40:00.000Z",
      }),
      code: "acceptance_timeline_invalid",
    },
    {
      code: "acceptance_timeline_invalid",
      risk: acceptedRisk({ acceptedAt: "invalid" }),
    },
  ];

  for (const variant of variants) {
    const variantRisk = variant.risk || risk;
    const result = validateAcceptedRiskProvenance({
      acceptanceComment:
        variant.acceptanceComment || approvalComment(variantRisk),
      current: variant.current || currentContext(),
      evidence: variant.evidence || reviewEvidence(variantRisk),
      isReviewedCommitAncestor: true,
      reviewRun: variant.reviewRun || reviewRun(variantRisk),
      risk: variantRisk,
    });
    assert.equal(result.ok, false, variant.code);
    assert.ok(result.errors.includes(variant.code), variant.code);
  }

  const empty = validateAcceptedRiskProvenance();
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.errors, [
    "acceptance_comment_invalid",
    "acceptance_review_target_invalid",
    "acceptance_timeline_invalid",
    "reviewed_audit_evidence_invalid",
    "reviewed_ci_run_invalid",
  ]);
});

test("emits safe workflow outputs for proposed and accepted risks", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "risk-outputs-"));
  const outputPath = path.join(directory, "output.txt");
  try {
    emitWorkflowOutputs({
      env: { GITHUB_OUTPUT: outputPath },
      risk: { status: "proposed" },
    });
    assert.equal(fs.readFileSync(outputPath, "utf8"), "accepted=false\n");

    fs.writeFileSync(outputPath, "");
    emitWorkflowOutputs({
      env: { GITHUB_OUTPUT: outputPath },
      risk: acceptedRisk(),
    });
    const output = fs.readFileSync(outputPath, "utf8");
    assert.match(output, /^accepted=true$/m);
    assert.match(output, /^reviewed_run_id=30380150062$/m);
    assert.match(output, /^reviewed_pull_request=2$/m);
    assert.match(
      output,
      /^reviewed_artifact_name=production-audit-review-evidence-30380150062$/m,
    );

    assert.throws(
      () =>
        emitWorkflowOutputs({
          env: {},
          risk: { status: "proposed" },
        }),
      /GITHUB_OUTPUT/,
    );
    assert.throws(
      () =>
        emitWorkflowOutputs({
          env: { GITHUB_OUTPUT: outputPath },
          risk: acceptedRisk({ reviewedPullRequest: 0 }),
        }),
      /pull request number is invalid/,
    );
    assert.throws(
      () =>
        emitWorkflowOutputs({
          env: { GITHUB_OUTPUT: outputPath },
          risk: acceptedRisk({ reviewedCiRunId: "not-a-run" }),
        }),
      /CI run ID is invalid/,
    );
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("verifies accepted provenance through bounded GitHub API reads", async () => {
  const risk = acceptedRisk();
  const riskFile = writeTemporaryJson(risk);
  const evidenceFile = writeTemporaryJson(reviewEvidence(risk));
  const requested = [];
  const fetchImpl = async (url, options) => {
    requested.push({ options, url });
    const value = url.includes("/actions/runs/")
      ? reviewRun(risk)
      : approvalComment(risk);
    return {
      ok: true,
      json: async () => value,
      status: 200,
    };
  };
  try {
    const result = await verifyAcceptedRiskProvenance({
      collectGit: () => ({
        changedPaths: ["security/risk-decisions/GHSA-mh99-v99m-4gvg.json"],
        isReviewedCommitAncestor: true,
      }),
      collectRiskStatus: () => "proposed",
      env: {
        GITHUB_API_URL: "https://api.github.test",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REPOSITORY: risk.reviewedRepository,
        GITHUB_TOKEN: "g".repeat(40),
        RISK_CURRENT_BASE_SHA: "c".repeat(40),
        RISK_CURRENT_HEAD_SHA: CURRENT_SHA,
        RISK_CURRENT_PR_NUMBER: "2",
      },
      evidencePath: evidenceFile.filePath,
      fetchImpl,
      now: new Date("2026-07-28T01:00:00.000Z"),
      riskPath: riskFile.filePath,
    });
    assert.deepEqual(result, { ok: true, skipped: false });
    assert.equal(requested.length, 2);
    assert.ok(
      requested.every(
        ({ options }) =>
          options.headers.Authorization === `Bearer ${"g".repeat(40)}`,
      ),
    );

    const futurePullRequest = await verifyAcceptedRiskProvenance({
      collectGit: () => ({
        changedPaths: ["app/root.jsx"],
        isReviewedCommitAncestor: true,
      }),
      collectRiskStatus: () => "accepted",
      env: {
        GITHUB_API_URL: "https://api.github.test",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REPOSITORY: risk.reviewedRepository,
        GITHUB_TOKEN: "g".repeat(40),
        RISK_CURRENT_BASE_SHA: "c".repeat(40),
        RISK_CURRENT_HEAD_SHA: CURRENT_SHA,
        RISK_CURRENT_PR_NUMBER: "3",
      },
      evidencePath: evidenceFile.filePath,
      fetchImpl,
      now: new Date("2026-07-28T01:00:00.000Z"),
      riskPath: riskFile.filePath,
    });
    assert.deepEqual(futurePullRequest, { ok: true, skipped: false });

    let collectedBaseStatus = false;
    const mainPush = await verifyAcceptedRiskProvenance({
      collectGit: () => ({
        changedPaths: ["app/root.jsx"],
        isReviewedCommitAncestor: true,
      }),
      collectRiskStatus: () => {
        collectedBaseStatus = true;
        return "accepted";
      },
      env: {
        GITHUB_API_URL: "https://api.github.test",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REPOSITORY: risk.reviewedRepository,
        GITHUB_TOKEN: "g".repeat(40),
        RISK_CURRENT_HEAD_SHA: CURRENT_SHA,
        RISK_CURRENT_PR_NUMBER: "2",
      },
      evidencePath: evidenceFile.filePath,
      fetchImpl,
      now: new Date("2026-07-28T01:00:00.000Z"),
      riskPath: riskFile.filePath,
    });
    assert.deepEqual(mainPush, { ok: true, skipped: false });
    assert.equal(collectedBaseStatus, false);

    await assert.rejects(
      () =>
        verifyAcceptedRiskProvenance({
          env: {},
          evidencePath: evidenceFile.filePath,
          riskPath: riskFile.filePath,
        }),
      /context is incomplete/,
    );
  } finally {
    fs.rmSync(riskFile.directory, { force: true, recursive: true });
    fs.rmSync(evidenceFile.directory, { force: true, recursive: true });
  }
});

test("skips unaccepted provenance and fails closed on GitHub errors", async () => {
  const proposedFile = writeTemporaryJson({ status: "proposed" });
  try {
    assert.deepEqual(
      await verifyAcceptedRiskProvenance({
        env: {},
        riskPath: proposedFile.filePath,
      }),
      { ok: true, skipped: true },
    );
  } finally {
    fs.rmSync(proposedFile.directory, { force: true, recursive: true });
  }

  const risk = acceptedRisk();
  const riskFile = writeTemporaryJson(risk);
  const evidenceFile = writeTemporaryJson(reviewEvidence(risk));
  try {
    await assert.rejects(
      () =>
        verifyAcceptedRiskProvenance({
          collectGit: () => ({
            changedPaths: [],
            isReviewedCommitAncestor: true,
          }),
          collectRiskStatus: () => "proposed",
          env: {
            GITHUB_EVENT_NAME: "pull_request",
            GITHUB_REPOSITORY: risk.reviewedRepository,
            GITHUB_TOKEN: "g".repeat(40),
            RISK_CURRENT_BASE_SHA: "c".repeat(40),
            RISK_CURRENT_HEAD_SHA: CURRENT_SHA,
            RISK_CURRENT_PR_NUMBER: "2",
          },
          evidencePath: evidenceFile.filePath,
          fetchImpl: async () => ({
            ok: false,
            status: 404,
          }),
          riskPath: riskFile.filePath,
        }),
      /HTTP 404/,
    );
  } finally {
    fs.rmSync(riskFile.directory, { force: true, recursive: true });
    fs.rmSync(evidenceFile.directory, { force: true, recursive: true });
  }
});

test("fails closed for missing, unsafe, and malformed provenance JSON", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "risk-json-safety-"));
  const missing = path.join(directory, "missing.json");
  const empty = path.join(directory, "empty.json");
  const invalid = path.join(directory, "invalid.json");
  const notAFile = path.join(directory, "directory.json");
  const oversized = path.join(directory, "oversized.json");
  fs.writeFileSync(empty, "");
  fs.writeFileSync(invalid, "{");
  fs.writeFileSync(oversized, " ".repeat(1024 * 1024 + 1));
  fs.mkdirSync(notAFile);
  try {
    await assert.rejects(
      () => verifyAcceptedRiskProvenance({ riskPath: missing }),
      /is missing/,
    );
    await assert.rejects(
      () => verifyAcceptedRiskProvenance({ riskPath: empty }),
      /not a safe JSON file/,
    );
    await assert.rejects(
      () => verifyAcceptedRiskProvenance({ riskPath: notAFile }),
      /not a safe JSON file/,
    );
    await assert.rejects(
      () => verifyAcceptedRiskProvenance({ riskPath: invalid }),
      /invalid JSON/,
    );
    await assert.rejects(
      () => verifyAcceptedRiskProvenance({ riskPath: oversized }),
      /not a safe JSON file/,
    );
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("surfaces semantic provenance failures after successful API reads", async () => {
  const risk = acceptedRisk();
  const riskFile = writeTemporaryJson(risk);
  const evidenceFile = writeTemporaryJson(reviewEvidence(risk));
  try {
    await assert.rejects(
      () =>
        verifyAcceptedRiskProvenance({
          collectGit: () => ({
            changedPaths: ["app/root.jsx"],
            isReviewedCommitAncestor: true,
          }),
          collectRiskStatus: () => "proposed",
          env: {
            GITHUB_EVENT_NAME: "pull_request",
            GITHUB_REPOSITORY: risk.reviewedRepository,
            GITHUB_TOKEN: "g".repeat(40),
            RISK_CURRENT_BASE_SHA: "c".repeat(40),
            RISK_CURRENT_HEAD_SHA: CURRENT_SHA,
            RISK_CURRENT_PR_NUMBER: "2",
          },
          evidencePath: evidenceFile.filePath,
          fetchImpl: async (url) => ({
            ok: true,
            json: async () =>
              url.includes("/actions/runs/")
                ? reviewRun(risk)
                : approvalComment(risk),
            status: 200,
          }),
          now: new Date("2026-07-28T01:00:00.000Z"),
          riskPath: riskFile.filePath,
        }),
      /acceptance_diff_not_metadata_only/,
    );
  } finally {
    fs.rmSync(riskFile.directory, { force: true, recursive: true });
    fs.rmSync(evidenceFile.directory, { force: true, recursive: true });
  }
});

test("collects changed paths only from reviewed commit ancestry", () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
  assert.deepEqual(collectGitEvidence(head, head), {
    changedPaths: [],
    isReviewedCommitAncestor: true,
  });
  assert.throws(() => collectGitEvidence("not-a-sha", head), /ancestry/);
  const parent = execFileSync("git", ["rev-parse", "HEAD^"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
  assert.equal(
    collectGitEvidence(head, parent).isReviewedCommitAncestor,
    false,
  );
  assert.equal(collectRiskStatusAtCommit(head), "proposed");
  assert.throws(
    () => collectRiskStatusAtCommit("not-a-sha"),
    /base SHA is invalid/,
  );
  assert.throws(() => collectRiskStatusAtCommit(), /base SHA is invalid/);
  const root = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
  if (root !== head) {
    assert.throws(
      () => collectRiskStatusAtCommit(root),
      /could not read the base risk definition/,
    );
  }
});

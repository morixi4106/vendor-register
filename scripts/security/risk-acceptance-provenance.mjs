import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..", "..");
const RISK_RELATIVE_PATH = "security/risk-decisions/GHSA-mh99-v99m-4gvg.json";
const RISK_PATH = path.join(REPOSITORY_ROOT, RISK_RELATIVE_PATH);
const REVIEW_EVIDENCE_PATH = path.join(
  REPOSITORY_ROOT,
  ".audit",
  "reviewed",
  "production-audit-review-evidence.json",
);
const REVIEW_EVIDENCE_FILE_NAME = "production-audit-review-evidence.json";
const REVIEW_ARTIFACT_PREFIX = "production-audit-review-evidence";
const MAX_JSON_BYTES = 1024 * 1024;
const GIT_COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const POSITIVE_INTEGER_STRING_PATTERN = /^[1-9]\d*$/;
const ACCEPTANCE_FIELDS = new Set([
  "acceptanceCommentId",
  "acceptedAt",
  "acceptedBy",
  "reviewedCiRunId",
  "reviewedCommitSha",
  "reviewedPullRequest",
  "reviewedRepository",
  "status",
]);
const APPROVER_ASSOCIATIONS = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);

function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

export function riskCore(risk) {
  return Object.fromEntries(
    Object.entries(risk || {}).filter(
      ([key]) => !ACCEPTANCE_FIELDS.has(key) && key !== "approvedPathLines",
    ),
  );
}

export function riskCoreSha256(risk) {
  return sha256(canonicalize(riskCore(risk)));
}

function positiveInteger(value) {
  const normalized = String(value || "");
  if (!POSITIVE_INTEGER_STRING_PATTERN.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function reviewArtifactName(runId) {
  if (!POSITIVE_INTEGER_STRING_PATTERN.test(String(runId || ""))) {
    throw new Error("reviewed CI run ID is invalid");
  }
  return `${REVIEW_ARTIFACT_PREFIX}-${runId}`;
}

export function buildRiskReviewEvidence({
  artifactReport,
  env = process.env,
  evaluation,
  npmTreeReport,
  now = new Date(),
  risk,
} = {}) {
  return {
    schemaVersion: 1,
    repository: String(env.GITHUB_REPOSITORY || "") || null,
    pullRequestNumber: positiveInteger(env.RISK_REVIEW_PR_NUMBER),
    runId: String(env.GITHUB_RUN_ID || "") || null,
    headSha: String(env.RISK_REVIEW_HEAD_SHA || "") || null,
    checkedOutSha: String(env.GITHUB_SHA || "") || null,
    generatedAt: now.toISOString(),
    auditOk: evaluation?.ok === true,
    errors: [...(evaluation?.errors || [])].sort(),
    checks: evaluation?.checks || {},
    riskStatus: String(risk?.status || ""),
    riskCoreSha256: riskCoreSha256(risk),
    artifactCount: Array.isArray(artifactReport?.artifacts)
      ? artifactReport.artifacts.length
      : null,
    artifactSetSha256: String(artifactReport?.artifactSetSha256 || "") || null,
    productionSbomComponentCount:
      npmTreeReport?.summary?.productionSbomComponentCount ?? null,
  };
}

export function writeRiskReviewEvidence(
  evidence,
  {
    outputPath = path.join(
      REPOSITORY_ROOT,
      ".audit",
      REVIEW_EVIDENCE_FILE_NAME,
    ),
  } = {},
) {
  const resolved = path.resolve(outputPath);
  const relative = path.relative(REPOSITORY_ROOT, resolved);
  if (
    !relative.startsWith(`.audit${path.sep}`) ||
    relative.split(path.sep).includes("..")
  ) {
    throw new Error("Risk review evidence path is outside .audit.");
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
    mode: 0o600,
  });
  return resolved;
}

export function expectedAcceptanceComment(risk) {
  return [
    `/accept-toolchain-risk ${risk.advisoryId}`,
    `repository: ${risk.reviewedRepository}`,
    `pull-request: #${risk.reviewedPullRequest}`,
    `reviewed-commit: ${risk.reviewedCommitSha}`,
    `reviewed-ci-run: ${risk.reviewedCiRunId}`,
    `expires-at: ${risk.expiresAt}`,
  ].join("\n");
}

function validTimestamp(value) {
  const parsed = new Date(String(value || ""));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function commentBelongsToReviewedPullRequest(comment, risk) {
  try {
    const issueUrl = new URL(String(comment?.issue_url || ""));
    return (
      issueUrl.pathname ===
      `/repos/${risk.reviewedRepository}/issues/${risk.reviewedPullRequest}`
    );
  } catch {
    return false;
  }
}

export function validateAcceptedRiskProvenance({
  acceptanceComment,
  current,
  evidence,
  isReviewedCommitAncestor,
  reviewRun,
  risk,
} = {}) {
  const errors = [];
  const changedPaths = uniqueSorted(current?.changedPaths || []);
  const acceptedAt = validTimestamp(risk?.acceptedAt);
  const commentCreatedAt = validTimestamp(acceptanceComment?.created_at);
  const runCompletedAt = validTimestamp(
    reviewRun?.updated_at || reviewRun?.run_completed_at,
  );

  if (
    risk?.status !== "accepted" ||
    risk?.reviewedRepository !== current?.repository ||
    risk?.reviewedCommitSha === current?.headSha ||
    !GIT_COMMIT_SHA_PATTERN.test(String(current?.headSha || "")) ||
    isReviewedCommitAncestor !== true ||
    (current?.enforceAcceptanceOnlyDiff === true &&
      risk?.reviewedPullRequest !== current?.pullRequestNumber)
  ) {
    errors.push("acceptance_review_target_invalid");
  }
  if (
    current?.enforceAcceptanceOnlyDiff === true &&
    (changedPaths.length !== 1 || changedPaths[0] !== RISK_RELATIVE_PATH)
  ) {
    errors.push("acceptance_diff_not_metadata_only");
  }
  if (
    String(reviewRun?.id || "") !== String(risk?.reviewedCiRunId || "") ||
    reviewRun?.repository?.full_name !== risk?.reviewedRepository ||
    reviewRun?.head_sha !== risk?.reviewedCommitSha ||
    reviewRun?.event !== "pull_request" ||
    reviewRun?.status !== "completed" ||
    reviewRun?.conclusion !== "failure" ||
    reviewRun?.name !== "Quality checks" ||
    !Array.isArray(reviewRun?.pull_requests) ||
    !reviewRun.pull_requests.some(
      (item) => item?.number === risk?.reviewedPullRequest,
    )
  ) {
    errors.push("reviewed_ci_run_invalid");
  }
  const checks = evidence?.checks || {};
  const nonAcceptanceChecks = Object.entries(checks).filter(
    ([name]) => name !== "riskAcceptance",
  );
  if (
    evidence?.schemaVersion !== 1 ||
    evidence?.repository !== risk?.reviewedRepository ||
    evidence?.pullRequestNumber !== risk?.reviewedPullRequest ||
    String(evidence?.runId || "") !== String(risk?.reviewedCiRunId || "") ||
    evidence?.headSha !== risk?.reviewedCommitSha ||
    evidence?.auditOk !== false ||
    evidence?.riskStatus !== "proposed" ||
    evidence?.riskCoreSha256 !== riskCoreSha256(risk) ||
    JSON.stringify(evidence?.errors) !==
      JSON.stringify(["risk_not_accepted"]) ||
    checks.riskAcceptance !== "failed" ||
    nonAcceptanceChecks.length === 0 ||
    nonAcceptanceChecks.some(([, status]) => status !== "passed") ||
    !Number.isInteger(evidence?.artifactCount) ||
    evidence.artifactCount < 1 ||
    !/^[A-F0-9]{64}$/.test(String(evidence?.artifactSetSha256 || "")) ||
    !Number.isInteger(evidence?.productionSbomComponentCount) ||
    evidence.productionSbomComponentCount < 1
  ) {
    errors.push("reviewed_audit_evidence_invalid");
  }
  if (
    String(acceptanceComment?.id || "") !==
      String(risk?.acceptanceCommentId || "") ||
    !commentBelongsToReviewedPullRequest(acceptanceComment, risk) ||
    acceptanceComment?.user?.login !== risk?.acceptedBy ||
    !APPROVER_ASSOCIATIONS.has(acceptanceComment?.author_association) ||
    String(acceptanceComment?.body || "")
      .replaceAll("\r\n", "\n")
      .trim() !== expectedAcceptanceComment(risk)
  ) {
    errors.push("acceptance_comment_invalid");
  }
  if (
    !acceptedAt ||
    !commentCreatedAt ||
    !runCompletedAt ||
    runCompletedAt.getTime() > commentCreatedAt.getTime() ||
    commentCreatedAt.getTime() > acceptedAt.getTime() ||
    acceptedAt.getTime() > current.now.getTime()
  ) {
    errors.push("acceptance_timeline_invalid");
  }

  return {
    errors: uniqueSorted(errors),
    ok: errors.length === 0,
  };
}

function readBoundedJson(filePath, description) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch {
    throw new Error(`${description} is missing.`);
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size < 1 ||
    stats.size > MAX_JSON_BYTES
  ) {
    throw new Error(`${description} is not a safe JSON file.`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`${description} contains invalid JSON.`);
  }
}

function runGit(args) {
  return spawnSync("git", args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    shell: false,
  });
}

export function collectGitEvidence(reviewedCommitSha, currentHeadSha) {
  const ancestor = runGit([
    "merge-base",
    "--is-ancestor",
    reviewedCommitSha,
    currentHeadSha,
  ]);
  if (ancestor.error || ![0, 1].includes(ancestor.status)) {
    throw new Error("Git could not verify the reviewed commit ancestry.");
  }

  const diff = runGit([
    "diff",
    "--name-only",
    "-z",
    `${reviewedCommitSha}..${currentHeadSha}`,
  ]);
  if (diff.error || diff.status !== 0) {
    throw new Error("Git could not inspect the post-review diff.");
  }
  return {
    changedPaths: diff.stdout.split("\0").filter(Boolean),
    isReviewedCommitAncestor: ancestor.status === 0,
  };
}

export function collectRiskStatusAtCommit(commitSha) {
  if (!GIT_COMMIT_SHA_PATTERN.test(String(commitSha || ""))) {
    throw new Error("Current pull request base SHA is invalid.");
  }

  const commit = runGit(["cat-file", "-e", `${commitSha}^{commit}`]);
  if (commit.error || commit.status !== 0) {
    throw new Error("Git could not inspect the pull request base commit.");
  }

  const listing = runGit([
    "ls-tree",
    "-z",
    "--name-only",
    "--full-tree",
    commitSha,
    "--",
    RISK_RELATIVE_PATH,
  ]);
  if (listing.error || listing.status !== 0) {
    throw new Error("Git could not inspect the base risk definition.");
  }
  const listedPaths = listing.stdout.split("\0").filter(Boolean);
  if (listedPaths.length === 0) return "absent";
  if (
    listedPaths.length !== 1 ||
    listedPaths[0].replaceAll("\\", "/") !== RISK_RELATIVE_PATH
  ) {
    throw new Error("Git returned an unexpected base risk definition path.");
  }

  const shown = runGit(["show", `${commitSha}:${RISK_RELATIVE_PATH}`]);
  if (
    shown.error ||
    shown.status !== 0 ||
    Buffer.byteLength(shown.stdout, "utf8") > MAX_JSON_BYTES
  ) {
    throw new Error("Git could not read the base risk definition.");
  }
  try {
    return String(JSON.parse(shown.stdout)?.status || "");
  } catch {
    throw new Error("Base risk definition contains invalid JSON.");
  }
}

async function fetchGitHubJson(url, token, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "vendor-register-risk-provenance",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `GitHub API request failed with HTTP ${response.status}.`,
      );
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyAcceptedRiskProvenance({
  collectGit = collectGitEvidence,
  collectRiskStatus = collectRiskStatusAtCommit,
  evidencePath = REVIEW_EVIDENCE_PATH,
  env = process.env,
  fetchImpl = fetch,
  now = new Date(),
  riskPath = RISK_PATH,
} = {}) {
  const risk = readBoundedJson(riskPath, "Toolchain risk definition");
  if (risk.status !== "accepted") {
    return {
      ok: true,
      skipped: true,
    };
  }

  const repository = String(env.GITHUB_REPOSITORY || "");
  const token = String(env.GITHUB_TOKEN || "");
  const apiUrl = String(env.GITHUB_API_URL || "https://api.github.com");
  const currentHeadSha = String(env.RISK_CURRENT_HEAD_SHA || "");
  const currentPullRequest = positiveInteger(env.RISK_CURRENT_PR_NUMBER);
  const isPullRequest = env.GITHUB_EVENT_NAME === "pull_request";
  const currentBaseSha = String(env.RISK_CURRENT_BASE_SHA || "");
  if (
    repository !== risk.reviewedRepository ||
    token.length < 20 ||
    !GIT_COMMIT_SHA_PATTERN.test(currentHeadSha) ||
    !currentPullRequest ||
    (isPullRequest && !GIT_COMMIT_SHA_PATTERN.test(currentBaseSha))
  ) {
    throw new Error("Current GitHub review context is incomplete.");
  }

  const git = collectGit(risk.reviewedCommitSha, currentHeadSha);
  const baseRiskStatus = isPullRequest
    ? collectRiskStatus(currentBaseSha)
    : null;
  const [reviewRun, acceptanceComment] = await Promise.all([
    fetchGitHubJson(
      `${apiUrl}/repos/${repository}/actions/runs/${risk.reviewedCiRunId}`,
      token,
      fetchImpl,
    ),
    fetchGitHubJson(
      `${apiUrl}/repos/${repository}/issues/comments/${risk.acceptanceCommentId}`,
      token,
      fetchImpl,
    ),
  ]);
  const evidence = readBoundedJson(
    evidencePath,
    "Reviewed production audit evidence",
  );
  const result = validateAcceptedRiskProvenance({
    acceptanceComment,
    current: {
      changedPaths: git.changedPaths,
      enforceAcceptanceOnlyDiff: isPullRequest && baseRiskStatus !== "accepted",
      headSha: currentHeadSha,
      now,
      pullRequestNumber: currentPullRequest,
      repository,
    },
    evidence,
    isReviewedCommitAncestor: git.isReviewedCommitAncestor,
    reviewRun,
    risk,
  });
  if (!result.ok) {
    throw new Error(
      `Accepted risk provenance failed: ${result.errors.join(", ")}`,
    );
  }
  return {
    ok: true,
    skipped: false,
  };
}

function appendWorkflowOutput(name, value, env = process.env) {
  const outputPath = String(env.GITHUB_OUTPUT || "");
  if (!outputPath) throw new Error("GITHUB_OUTPUT is not available.");
  fs.appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
}

export function emitWorkflowOutputs({
  env = process.env,
  risk = readBoundedJson(RISK_PATH, "Toolchain risk definition"),
} = {}) {
  const accepted = risk.status === "accepted";
  const reviewedArtifactName = accepted
    ? reviewArtifactName(risk.reviewedCiRunId)
    : null;
  const reviewedPullRequest = accepted
    ? positiveInteger(risk.reviewedPullRequest)
    : null;
  if (accepted && !reviewedPullRequest) {
    throw new Error("reviewed pull request number is invalid");
  }
  appendWorkflowOutput("accepted", accepted ? "true" : "false", env);
  if (accepted) {
    appendWorkflowOutput("reviewed_run_id", risk.reviewedCiRunId, env);
    appendWorkflowOutput(
      "reviewed_pull_request",
      String(reviewedPullRequest),
      env,
    );
    appendWorkflowOutput("reviewed_artifact_name", reviewedArtifactName, env);
  }
  return {
    accepted,
  };
}

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

/* node:coverage disable */
if (isMainModule) {
  const command = process.argv[2];
  try {
    if (command === "emit-workflow-outputs") {
      emitWorkflowOutputs();
    } else if (command === "verify") {
      const result = await verifyAcceptedRiskProvenance();
      console.log(
        result.skipped
          ? "Risk acceptance provenance is not active."
          : "Risk acceptance provenance verified.",
      );
    } else {
      throw new Error("Unknown risk provenance command.");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
/* node:coverage enable */

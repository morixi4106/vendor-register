import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyMaintenanceCandidate } from "./security/maintenance-candidate.mjs";

export async function promoteMaintenance({
  env = process.env,
  event,
  fetchImpl = fetch,
} = {}) {
  if (env.AUTO_MAINTENANCE_MERGE_ENABLED !== "true")
    return { promoted: false, reason: "disabled" };
  const repository = env.GITHUB_REPOSITORY;
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "") ||
    !env.GITHUB_TOKEN
  )
    throw new Error("maintenance_github_not_configured");
  const run = event?.workflow_run;
  if (
    run?.event !== "pull_request" ||
    run.head_repository?.full_name !== repository ||
    run.conclusion !== "success" ||
    run.name !== "Quality checks"
  )
    return { promoted: false, reason: "untrusted_run" };
  const number = run.pull_requests?.[0]?.number;
  if (!Number.isSafeInteger(number) || number <= 0)
    return { promoted: false, reason: "pull_request_missing" };
  async function github(endpoint, options = {}) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}${endpoint}`,
      {
        ...options,
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error("maintenance_github_request_failed");
    return response.json();
  }
  const pr = await github(`/pulls/${number}`);
  if (
    pr.state !== "open" ||
    pr.draft ||
    pr.user?.login !== "dependabot[bot]" ||
    pr.head?.repo?.full_name !== repository ||
    pr.base?.ref !== "main" ||
    pr.head?.sha !== run.head_sha ||
    pr.changed_files > 2
  )
    return { promoted: false, reason: "pull_request_not_allowed" };
  const jobs = await github(`/actions/runs/${run.id}/jobs?per_page=100`);
  const verify = jobs.jobs?.find((j) => j.name === "verify");
  const required = [
    "Test",
    "Enforce production audit coverage",
    "Test checkout validation function",
    "Verify isolated production runtime package",
    "Audit production dependencies",
  ];
  if (
    verify?.conclusion !== "success" ||
    required.some(
      (name) =>
        !verify.steps?.some(
          (s) => s.name === name && s.conclusion === "success",
        ),
    )
  )
    return { promoted: false, reason: "required_checks_not_successful" };
  const files = await github(`/pulls/${number}/files?per_page=100`);
  async function document(ref, name) {
    if (!/^[a-f0-9]{40}$/.test(ref || ""))
      throw new Error("maintenance_ref_invalid");
    const file = await github(`/contents/${name}?ref=${ref}`);
    if (
      file.type !== "file" ||
      file.encoding !== "base64" ||
      file.size > 2_000_000
    )
      throw new Error("maintenance_document_invalid");
    return JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  }
  const beforeManifest = await document(pr.base.sha, "package.json");
  const beforeLock = await document(pr.base.sha, "package-lock.json");
  const afterManifest = await document(pr.head.sha, "package.json");
  const afterLock = await document(pr.head.sha, "package-lock.json");
  const candidate = classifyMaintenanceCandidate({
    paths: files.map((f) => f.filename),
    beforeManifest,
    beforeLock,
    afterManifest,
    afterLock,
  });
  if (!candidate.eligible) return { promoted: false, reason: candidate.reason };
  const url = new URL(
    "/internal/maintenance-readiness",
    env.LAUNCH_MONITOR_URL,
  );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    String(env.MAINTENANCE_GATE_TOKEN || "").length < 32
  )
    throw new Error("maintenance_gate_not_configured");
  const gateResponse = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.MAINTENANCE_GATE_TOKEN}` },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  const gate = await gateResponse.json();
  if (
    !gateResponse.ok ||
    gate.schemaVersion !== 1 ||
    gate.ready !== true ||
    !/^[a-f0-9]{40}$/.test(gate.renderCommit || "")
  )
    return { promoted: false, reason: "production_not_ready" };
  const receiptIssue = Number(env.MAINTENANCE_SECONDARY_RECEIPT_ISSUE);
  if (!Number.isSafeInteger(receiptIssue) || receiptIssue <= 0)
    return { promoted: false, reason: "secondary_receipt_missing" };
  const receipt = await github(`/issues/${receiptIssue}`);
  const receiptComments = await github(
    `/issues/${receiptIssue}/comments?per_page=100`,
  );
  if (
    !receipt.body?.startsWith("<!-- maintenance-render-runner -->") ||
    !receiptComments.some(
      (c) =>
        c.body?.trim() === "/ack-maintenance" &&
        ["OWNER", "MEMBER", "COLLABORATOR"].includes(c.author_association),
    )
  )
    return { promoted: false, reason: "secondary_receipt_unverified" };
  if (gate.renderCommit !== pr.base.sha) {
    const comparison = await github(
      `/compare/${gate.renderCommit}...${pr.base.sha}`,
    );
    if (
      comparison.status !== "ahead" ||
      !comparison.files?.length ||
      comparison.files.length > 2
    )
      return { promoted: false, reason: "live_release_changed" };
    const baseline = classifyMaintenanceCandidate({
      paths: comparison.files.map((f) => f.filename),
      beforeManifest: await document(gate.renderCommit, "package.json"),
      beforeLock: await document(gate.renderCommit, "package-lock.json"),
      afterManifest: beforeManifest,
      afterLock: beforeLock,
      allowBatch: true,
    });
    if (!baseline.eligible)
      return { promoted: false, reason: "live_release_changed" };
  }
  const current = await github(`/pulls/${number}`);
  if (current.head.sha !== pr.head.sha || current.base.sha !== pr.base.sha)
    return { promoted: false, reason: "pull_request_changed" };
  const result = await github(`/pulls/${number}/merge`, {
    method: "PUT",
    body: JSON.stringify({
      sha: pr.head.sha,
      merge_method: "squash",
      commit_title: `chore(deps): routine development patch #${number} [skip render]`,
    }),
  });
  if (result.merged !== true)
    throw new Error("maintenance_merge_not_confirmed");
  return { promoted: true, pullRequest: number, runtimeChanged: false };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const event = JSON.parse(
      fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
    );
    console.log(JSON.stringify(await promoteMaintenance({ event })));
  } catch {
    console.error("maintenance_promotion_failed");
    process.exitCode = 1;
  }
}

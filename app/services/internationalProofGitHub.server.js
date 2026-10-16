import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { readProofArchive } from "../utils/internationalProofArchive.js";
import {
  byteHash,
  proofHash,
  proofError,
  validateManifest,
  PROOF_REPOSITORY,
  PROOF_WORKFLOW,
} from "../utils/internationalProofContract.js";

const blocked = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  blocked.addSubnet(ip, prefix, "ipv4");
for (const [ip, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
])
  blocked.addSubnet(ip, prefix, "ipv6");
export function isPublicProofAddress(address) {
  const type = isIP(address);
  if (type === 6 && address.toLowerCase().startsWith("::ffff:")) return false;
  return Boolean(type && !blocked.check(address, type === 4 ? "ipv4" : "ipv6"));
}
export async function boundedProofBody(response, limit) {
  if (Number(response.headers.get("content-length")) > limit || !response.body)
    throw proofError();
  const chunks = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw proofError();
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
function abortableProofRead(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(proofError("international_artifact_unavailable", 503));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
export function createInternationalProofGitHub({
  token,
  fetchImpl = fetch,
  resolve = lookup,
} = {}) {
  const root = `https://api.github.com/repos/${PROOF_REPOSITORY}`;
  async function request(path, archive = false, { timeoutMs = 30000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw proofError("international_artifact_unavailable", 503);
    const signal = AbortSignal.timeout(
      Math.max(1, Math.min(30000, Math.floor(timeoutMs))),
    );
    let url = new URL(`${root}${path}`);
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (
        url.protocol !== "https:" ||
        url.port ||
        url.username ||
        url.password ||
        !(
          url.hostname === "api.github.com" ||
          (archive &&
            (/^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(url.hostname) ||
              /^[a-z0-9.-]+\.actions\.githubusercontent\.com$/.test(
                url.hostname,
              )))
        )
      )
        throw proofError();
      const addresses = await abortableProofRead(
        resolve(url.hostname, { all: true }),
        signal,
      );
      if (
        !addresses.length ||
        addresses.some((a) => !isPublicProofAddress(a.address))
      )
        throw proofError();
      const headers =
        url.origin === "https://api.github.com"
          ? {
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            }
          : {};
      const response = await fetchImpl(url.href, {
        headers,
        signal,
        redirect: "manual",
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!archive || !location) throw proofError();
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw proofError("international_artifact_unavailable", 503);
      }
      const body = await boundedProofBody(
        response,
        archive ? 64 * 1024 * 1024 : 262144,
      );
      if (archive) return body;
      try {
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(body),
        );
      } catch {
        throw proofError();
      }
    }
    throw proofError();
  }
  return {
    json: (path, options) => request(path, false, options),
    archive: (id, options) =>
      request(`/actions/artifacts/${id}/zip`, true, options),
  };
}

export async function inspectProofArtifactMetadata({
  artifactId,
  manifest,
  now,
  github,
  deadline = Date.now() + 30000,
}) {
  if (!Number.isSafeInteger(artifactId) || artifactId < 1) throw proofError();
  validateManifest(manifest);
  const get = (path) => github.json(path, { timeoutMs: deadline - Date.now() });
  const repo = await get("");
  const workflow = await get(
    `/actions/workflows/${encodeURIComponent(PROOF_WORKFLOW.split("/").at(-1))}`,
  );
  const run = await get(`/actions/runs/${manifest.runId}`);
  const artifact = await get(`/actions/artifacts/${artifactId}`);
  if (
    repo.full_name !== PROOF_REPOSITORY ||
    repo.id !== manifest.repositoryId ||
    typeof repo.private !== "boolean" ||
    workflow.id !== manifest.workflowId ||
    workflow.path !== PROOF_WORKFLOW ||
    workflow.state !== "active" ||
    run.workflow_id !== workflow.id ||
    run.path !== PROOF_WORKFLOW ||
    run.repository?.id !== repo.id ||
    run.head_repository?.id !== repo.id ||
    run.head_sha !== manifest.headSha ||
    run.run_attempt !== manifest.runAttempt ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    manifest.event !== run.event ||
    manifest.channel !== "production" ||
    artifact.id !== artifactId ||
    artifact.workflow_run?.id !== run.id ||
    artifact.workflow_run?.head_sha !== run.head_sha ||
    artifact.name !== `international-proof-${run.id}-${run.run_attempt}` ||
    artifact.expired !== false ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes > 64 * 1024 * 1024 ||
    !Number.isFinite(Date.parse(artifact.expires_at)) ||
    new Date(artifact.expires_at) <= now ||
    !Number.isFinite(Date.parse(artifact.created_at)) ||
    new Date(artifact.created_at) < new Date(run.run_started_at) ||
    new Date(artifact.created_at) > new Date(run.updated_at)
  )
    throw proofError();
  const branch = await get("/branches/main");
  if (branch.protected !== true) throw proofError();
  const content = await get(
    `/contents/${PROOF_WORKFLOW}?ref=${manifest.headSha}`,
  );
  if (
    content.encoding !== "base64" ||
    byteHash(Buffer.from(content.content, "base64")) !== manifest.workflowDigest
  )
    throw proofError();
  for (const [name, path] of [
    ["quality", ".github/workflows/quality.yml"],
    ["postgres", ".github/workflows/international-authorization-postgres.yml"],
  ]) {
    const c = manifest.checks[name];
    const check = await get(`/actions/runs/${c.runId}`);
    if (
      check.path !== path ||
      check.repository?.id !== repo.id ||
      check.head_repository?.id !== repo.id ||
      check.head_sha !== manifest.headSha ||
      check.run_attempt !== c.runAttempt ||
      check.status !== "completed" ||
      check.conclusion !== "success" ||
      !["push", "workflow_dispatch"].includes(check.event) ||
      check.head_branch !== "main"
    )
      throw proofError();
  }
  return {
    reference: `github:${PROOF_REPOSITORY}:${artifactId}`,
    archiveHash: artifact.digest.slice(7),
    expiresAt: new Date(artifact.expires_at),
    observedAt: now,
  };
}
export async function verifyInternationalProofArtifact({
  artifactId,
  now = new Date(),
  github,
}) {
  if (!Number.isSafeInteger(artifactId) || artifactId < 1) throw proofError();
  const deadline = Date.now() + 30000;
  const archive = await github.archive(artifactId, {
    timeoutMs: deadline - Date.now(),
  });
  const files = readProofArchive(archive);
  const raw = files.get("manifest.json");
  if (!raw || raw.length > 262144) throw proofError();
  let manifest;
  try {
    manifest = validateManifest(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
    );
  } catch {
    throw proofError();
  }
  const metadata = await inspectProofArtifactMetadata({
    artifactId,
    manifest,
    now,
    github,
    deadline,
  });
  if (
    byteHash(archive) !== metadata.archiveHash ||
    files.size !== manifest.files.length + 1
  )
    throw proofError();
  for (const row of manifest.files) {
    const value = files.get(row.path);
    if (!value || value.length !== row.size || byteHash(value) !== row.sha256)
      throw proofError();
  }
  return { ...metadata, manifest, contentDigest: proofHash(manifest), files };
}

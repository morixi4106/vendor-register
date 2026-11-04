import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const ADVISORY = "GHSA-g3hv-75wg-m249";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function checkedFile(directory, relative) {
  if (
    typeof relative !== "string" ||
    relative.includes("\\") ||
    path.isAbsolute(relative) ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("minimatch_backport_path_invalid");
  const base = fs.realpathSync(directory);
  const file = path.resolve(base, relative);
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 2 * 1024 * 1024 ||
    fs.realpathSync(file) !== file ||
    path.relative(base, file).startsWith("..")
  )
    throw new Error("minimatch_backport_file_invalid");
  return fs.readFileSync(file);
}

export function readMinimatchPolicy(root = ROOT) {
  const bytes = checkedFile(root, "security/minimatch-backport.json");
  const policy = JSON.parse(bytes);
  if (
    policy.schemaVersion !== 1 ||
    policy.packageName !== "@oja/minimatch" ||
    policy.version !== "9.0.9-oja.1" ||
    policy.advisory !== ADVISORY ||
    policy.upstream?.name !== "minimatch" ||
    policy.upstream.version !== "9.0.9" ||
    policy.upstream.commit !== "8a10e473e2e0ff03c2d4de308f257093af2bce21" ||
    policy.upstream.fixCommit !== "77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8" ||
    policy.upstream.archiveSha256 !==
      "7d28c9a3ef17ce542093c78ec191481503e2711d29db1bd1522062303ab40478" ||
    policy.tarball?.path !== "vendor/minimatch/oja-minimatch-9.0.9-oja.1.tgz" ||
    !HASH.test(policy.tarball.sha256 || "") ||
    !Array.isArray(policy.files) ||
    policy.files.length !== 30 ||
    new Set(policy.files.map((file) => file.path)).size !==
      policy.files.length ||
    policy.files.some((file) => !HASH.test(file.sha256 || "")) ||
    ![
      "package.json",
      "provenance.json",
      "LICENSE",
      "dist/commonjs/index.js",
      "dist/esm/index.js",
    ].every((name) => policy.files.some((file) => file.path === name))
  )
    throw new Error("minimatch_backport_policy_invalid");
  return policy;
}

export function verifyMinimatchDirectory(
  directory,
  policy = readMinimatchPolicy(),
) {
  if (fs.lstatSync(directory).isSymbolicLink())
    throw new Error("minimatch_backport_file_invalid");
  for (const file of policy.files) {
    if (sha(checkedFile(directory, file.path)) !== file.sha256)
      throw new Error("minimatch_backport_digest_mismatch");
  }
  const manifest = JSON.parse(checkedFile(directory, "package.json"));
  const provenance = JSON.parse(checkedFile(directory, "provenance.json"));
  if (
    manifest.name !== policy.packageName ||
    manifest.version !== policy.version ||
    manifest.main !== "./dist/commonjs/index.js" ||
    manifest.exports?.["."]?.import?.default !== "./dist/esm/index.js" ||
    manifest.exports?.["."]?.require?.default !== manifest.main ||
    provenance.status !== "locally-maintained-security-backport" ||
    provenance.advisory !== ADVISORY ||
    provenance.upstreamCommit !== policy.upstream.commit ||
    provenance.upstreamFixCommit !== policy.upstream.fixCommit
  )
    throw new Error("minimatch_backport_identity_mismatch");
  return {
    packageName: manifest.name,
    version: manifest.version,
    verifiedFiles: policy.files.length,
  };
}

export function verifyInstalledMinimatch(root = ROOT) {
  const policy = readMinimatchPolicy(root);
  if (sha(checkedFile(root, policy.tarball.path)) !== policy.tarball.sha256)
    throw new Error("minimatch_backport_archive_mismatch");
  verifyMinimatchDirectory(path.join(root, "vendor/minimatch"), policy);
  const directory = path.join(fs.realpathSync(root), "node_modules/minimatch");
  const verified = verifyMinimatchDirectory(directory, policy);
  const lock = JSON.parse(checkedFile(root, "package-lock.json"));
  const locations = Object.entries(lock.packages).filter(
    ([location, metadata]) =>
      location &&
      (metadata.name === "minimatch" ||
        metadata.name === policy.packageName ||
        location.endsWith("/minimatch")),
  );
  if (
    locations.length !== 1 ||
    locations[0][0] !== "node_modules/minimatch" ||
    locations[0][1].name !== policy.packageName ||
    locations[0][1].version !== policy.version ||
    locations[0][1].resolved !== `file:${policy.tarball.path}`
  )
    throw new Error("minimatch_backport_lock_mismatch");
  const consumers = [];
  for (const [location, metadata] of Object.entries(lock.packages)) {
    if (
      !location ||
      !metadata.dependencies?.minimatch ||
      !fs.existsSync(path.join(root, location))
    )
      continue;
    if (path.isAbsolute(location) || location.split("/").includes(".."))
      throw new Error("minimatch_backport_path_invalid");
    const require = createRequire(path.join(root, location, "package.json"));
    if (
      fs.realpathSync(require.resolve("minimatch/package.json")) !==
        path.join(directory, "package.json") ||
      fs.realpathSync(require.resolve("minimatch")) !==
        path.join(directory, "dist/commonjs/index.js")
    )
      throw new Error("minimatch_backport_consumer_mismatch");
    consumers.push(location);
  }
  if (!consumers.length)
    throw new Error("minimatch_backport_consumers_missing");
  return {
    ...verified,
    consumers,
    policySha256: sha(checkedFile(root, "security/minimatch-backport.json")),
    tarballSha256: policy.tarball.sha256,
    status: "locally-maintained-security-backport",
  };
}

export async function checkMinimatchUpstream(
  policy,
  { fetchImpl = fetch } = {},
) {
  const response = await fetchImpl("https://api.osv.dev/v1/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      package: { ecosystem: "npm", name: policy.upstream.name },
      version: policy.upstream.version,
    }),
  });
  if (!response.ok) throw new Error("minimatch_upstream_audit_unavailable");
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    text += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw new Error("minimatch_upstream_audit_invalid");
  }
  text += decoder.decode();
  const report = JSON.parse(text);
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    report.error ||
    (report.vulns !== undefined && !Array.isArray(report.vulns))
  )
    throw new Error("minimatch_upstream_audit_invalid");
  const advisories = report.vulns || [];
  for (const advisory of advisories) {
    if (advisory?.id !== ADVISORY)
      throw new Error("minimatch_upstream_advisory_unresolved");
    if (advisory.modified !== "2026-10-30T23:15:07.420159385Z")
      throw new Error("minimatch_upstream_advisory_changed");
  }
  return {
    upstreamPackage: policy.upstream.name,
    upstreamVersion: policy.upstream.version,
    observedAdvisories: advisories.map((item) => item.id),
    coveredByVerifiedBackport: advisories.map((item) => item.id),
    observedAt: new Date().toISOString(),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 2)
      throw new Error("unexpected_minimatch_arguments");
    const verified = verifyInstalledMinimatch();
    const upstream = await checkMinimatchUpstream(readMinimatchPolicy());
    const result = {
      ...verified,
      ...upstream,
      registryAuditAloneIsInsufficient: true,
    };
    const directory = path.join(ROOT, ".audit");
    fs.mkdirSync(directory, { recursive: true });
    if (
      fs.lstatSync(directory).isSymbolicLink() ||
      fs.realpathSync(directory) !== path.join(fs.realpathSync(ROOT), ".audit")
    )
      throw new Error("minimatch_evidence_path_invalid");
    const file = path.join(directory, "minimatch-backport-receipt.json");
    if (
      fs.existsSync(file) &&
      (fs.lstatSync(file).isSymbolicLink() || fs.lstatSync(file).nlink !== 1)
    )
      throw new Error("minimatch_evidence_path_invalid");
    fs.writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

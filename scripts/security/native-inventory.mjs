import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const nativeName =
  /\.(exe|node|dll|so|dylib|wasm)$|^(esbuild|javy|function-runner|schema-engine|query-engine)(-|$)/;
const keysAre = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

function within(base, file) {
  const relative = path.relative(base, file);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function hasNativeHeader(bytes) {
  return [
    "4d5a",
    "7f454c46",
    "0061736d",
    "feedface",
    "feedfacf",
    "cefaedfe",
    "cffaedfe",
    "cafebabe",
    "bebafeca",
  ].some(
    (magic) => bytes.subarray(0, magic.length / 2).toString("hex") === magic,
  );
}

export function collectNativeInventory(
  root,
  { platform = process.platform, arch = process.arch } = {},
) {
  const base = fs.realpathSync(root);
  const visited = new Set();
  const artifacts = [];
  const problems = [];
  let entries = 0;
  let bytesRead = 0;
  function walk(directory, depth) {
    if (depth > 40) throw new Error("native_inventory_limit");
    const real = fs.realpathSync(directory);
    if (!within(base, real)) throw new Error("native_inventory_path_escape");
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of fs.readdirSync(real, { withFileTypes: true })) {
      if (++entries > 150_000) throw new Error("native_inventory_limit");
      const file = path.join(real, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(file);
        if (!within(base, target))
          throw new Error("native_inventory_path_escape");
        if (fs.statSync(target).isDirectory()) walk(target, depth + 1);
        else if (nativeName.test(entry.name)) {
          const descriptor = fs.openSync(target, "r");
          try {
            const header = Buffer.alloc(8);
            fs.readSync(descriptor, header, 0, header.length, 0);
            if (hasNativeHeader(header))
              throw new Error("native_inventory_linked_binary");
          } finally {
            fs.closeSync(descriptor);
          }
        }
      } else if (entry.isDirectory()) {
        walk(file, depth + 1);
      } else if (nativeName.test(entry.name)) {
        const stat = fs.lstatSync(file);
        if (
          !stat.isFile() ||
          stat.size > 128 * 1024 * 1024 ||
          artifacts.length >= 256
        )
          throw new Error("native_inventory_limit");
        bytesRead += stat.size;
        if (bytesRead > 512 * 1024 * 1024)
          throw new Error("native_inventory_limit");
        const bytes = fs.readFileSync(file);
        if (!hasNativeHeader(bytes)) {
          if (/\.(exe|node|dll|so|dylib|wasm)$/.test(entry.name))
            problems.push("native_inventory_header_invalid");
          continue;
        }
        const text = bytes.toString("latin1");
        const versionHints = [
          ...new Set(
            text.match(
              /\b(?:wasmtime|cranelift-codegen|rustls|openssl-src)-\d{1,3}\.\d{1,3}\.\d{1,3}\b|\bgo1\.\d{1,3}\.\d{1,3}\b/g,
            ) || [],
          ),
        ].sort();
        artifacts.push({
          path: path.relative(base, file).split(path.sep).join("/"),
          sha256: hash(bytes),
          size: stat.size,
          platform,
          arch,
          versionHints,
        });
      }
    }
  }
  const modules = path.join(base, "node_modules");
  if (!fs.existsSync(modules))
    problems.push("native_inventory_modules_missing");
  else walk(modules, 0);
  return {
    schemaVersion: 1,
    platform,
    arch,
    artifacts: artifacts.sort((a, b) => a.path.localeCompare(b.path)),
    problems,
  };
}

export function evaluateNativeInventory(inventory, root, policy) {
  if (
    !keysAre(inventory, [
      "schemaVersion",
      "platform",
      "arch",
      "artifacts",
      "problems",
    ]) ||
    inventory.schemaVersion !== 1 ||
    !["linux", "win32"].includes(inventory.platform) ||
    inventory.arch !== "x64" ||
    !Array.isArray(inventory.artifacts) ||
    inventory.artifacts.length > 256 ||
    !Array.isArray(inventory.problems) ||
    inventory.problems.some((code) => typeof code !== "string")
  )
    throw new Error("native_inventory_invalid");
  const paths = new Set();
  for (const artifact of inventory.artifacts) {
    if (
      !keysAre(artifact, [
        "path",
        "sha256",
        "size",
        "platform",
        "arch",
        "versionHints",
      ]) ||
      typeof artifact.path !== "string" ||
      !/^(node_modules|extensions)\//.test(artifact.path) ||
      artifact.path.includes("\\") ||
      artifact.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      !SHA256.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 4 ||
      artifact.size > 128 * 1024 * 1024 ||
      artifact.platform !== inventory.platform ||
      artifact.arch !== inventory.arch ||
      !Array.isArray(artifact.versionHints) ||
      artifact.versionHints.some((hint) => typeof hint !== "string") ||
      paths.has(artifact.path)
    )
      throw new Error("native_inventory_artifact_invalid");
    paths.add(artifact.path);
  }
  if (
    !keysAre(policy, ["schemaVersion", "incident", "approvedArtifacts"]) ||
    policy.schemaVersion !== 1 ||
    policy.incident !== "2026-10-runtime" ||
    !Array.isArray(policy.approvedArtifacts) ||
    policy.approvedArtifacts.length > 256
  )
    throw new Error("native_policy_invalid");
  const base = fs.realpathSync(root);
  const approvals = new Map();
  for (const approval of policy.approvedArtifacts) {
    if (
      !keysAre(approval, [
        "sha256",
        "platform",
        "arch",
        "sourceCommit",
        "sbom",
        "sbomSha256",
      ]) ||
      !SHA256.test(approval.sha256) ||
      !SHA256.test(approval.sbomSha256) ||
      !/^[a-f0-9]{40}$/.test(approval.sourceCommit) ||
      !["linux", "win32"].includes(approval.platform) ||
      approval.arch !== "x64" ||
      typeof approval.sbom !== "string" ||
      !/^security\/native-sbom\/[a-z0-9-]+\.json$/.test(approval.sbom)
    )
      throw new Error("native_approval_invalid");
    const file = path.join(base, approval.sbom);
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 5 * 1024 * 1024 ||
      !within(base, fs.realpathSync(file))
    )
      throw new Error("native_sbom_invalid");
    const bytes = fs.readFileSync(file);
    if (hash(bytes) !== approval.sbomSha256)
      throw new Error("native_sbom_digest_mismatch");
    const sbom = JSON.parse(bytes);
    if (
      sbom.bomFormat !== "CycloneDX" ||
      !Array.isArray(sbom.components) ||
      !sbom.components.length ||
      sbom.metadata?.component?.hashes?.find((h) => h.alg === "SHA-256")
        ?.content !== approval.sha256 ||
      !sbom.metadata?.component?.externalReferences?.some(
        (reference) =>
          reference.type === "vcs" &&
          typeof reference.url === "string" &&
          reference.url.startsWith("https://github.com/") &&
          reference.url.endsWith(`/commit/${approval.sourceCommit}`),
      )
    )
      throw new Error("native_sbom_binding_invalid");
    const key = `${approval.platform}/${approval.arch}/${approval.sha256}`;
    if (approvals.has(key)) throw new Error("native_approval_duplicate");
    approvals.set(key, approval);
  }
  const blocking = inventory.problems.map((code) => ({ code }));
  for (const artifact of inventory.artifacts) {
    if (
      !approvals.has(`${artifact.platform}/${artifact.arch}/${artifact.sha256}`)
    )
      blocking.push({
        code: "native_artifact_unreviewed",
        path: artifact.path,
        sha256: artifact.sha256,
        versionHints: artifact.versionHints,
      });
  }
  for (const [role, pattern] of [
    ["prisma-engine", /(?:query_engine|schema-engine)/],
    ["esbuild", /\/@esbuild\//],
    ["function-runner", /\/function-runner[^/]*$/],
    ["javy", /\/javy-[^/]*$/],
  ]) {
    if (!inventory.artifacts.some((a) => pattern.test(a.path)))
      blocking.push({ code: "native_tool_inventory_missing", role });
  }
  return {
    ok: blocking.length === 0,
    complete: blocking.length === 0,
    artifactCount: inventory.artifacts.length,
    blocking,
  };
}

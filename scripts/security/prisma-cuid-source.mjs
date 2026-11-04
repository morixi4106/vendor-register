import fs from "node:fs";
import path from "node:path";
import toml from "toml";
import { downloadRustInput, checkRustSourceTree } from "./rust-toolchain.mjs";

const COMMIT = "dc68c4f47a3dbcd511f605135ac7c948775a3ab9";
const VERSIONS = {
  cuid: "1.3.3",
  "cuid-util": "0.1.1",
  cuid1: "0.1.0",
  cuid2: "0.1.3",
};
const FILES = [
  "Cargo.toml",
  "crates/cuid/Cargo.toml",
  "crates/cuid/src/bin.rs",
  "crates/cuid/src/lib.rs",
  "crates/cuid-util/Cargo.toml",
  "crates/cuid-util/src/lib.rs",
  "crates/cuid1/Cargo.toml",
  "crates/cuid1/src/bin.rs",
  "crates/cuid1/src/counter.rs",
  "crates/cuid1/src/fingerprint.rs",
  "crates/cuid1/src/lib.rs",
  "crates/cuid1/src/random.rs",
  "crates/cuid1/src/text.rs",
  "crates/cuid1/src/time.rs",
  "crates/cuid2/Cargo.toml",
  "crates/cuid2/src/bin.rs",
  "crates/cuid2/src/lib.rs",
];
const HASH = /^[a-f0-9]{64}$/;
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...keys].sort().join();

export function validatePrismaCuidSource(entry) {
  if (
    !exact(entry, [
      "repository",
      "commit",
      "sha256",
      "reviewStatus",
      "patch",
      "packages",
      "sourceFiles",
    ]) ||
    entry.repository !== "prisma/cuid-rust" ||
    entry.commit !== COMMIT ||
    entry.reviewStatus !== "UNREVIEWED" ||
    !HASH.test(entry.sha256 || "") ||
    !exact(entry.patch, ["path", "sha256"]) ||
    entry.patch.path !== "vendor/native/prisma/cuid.patch" ||
    !HASH.test(entry.patch.sha256 || "") ||
    !Array.isArray(entry.packages) ||
    entry.packages.length !== 4 ||
    entry.packages.some((pkg, index) => {
      const [name, upstreamVersion] = Object.entries(VERSIONS)[index];
      return (
        !exact(pkg, ["name", "upstreamVersion", "version"]) ||
        pkg.name !== name ||
        pkg.upstreamVersion !== upstreamVersion ||
        pkg.version !== `${upstreamVersion}+oja.1`
      );
    }) ||
    !Array.isArray(entry.sourceFiles) ||
    entry.sourceFiles.length !== FILES.length ||
    entry.sourceFiles.some(
      (file, index) =>
        !exact(file, ["path", "sha256"]) ||
        file.path !== FILES[index] ||
        !HASH.test(file.sha256 || ""),
    )
  )
    throw new Error("prisma_cuid_policy_invalid");
  return entry;
}

export async function preparePrismaCuidSource(
  root,
  source,
  cache,
  entry,
  execute,
  input,
) {
  input(root, entry.patch);
  const archive = path.join(cache, "cuid-source.tar.gz");
  await downloadRustInput(
    `https://codeload.github.com/${entry.repository}/tar.gz/${entry.commit}`,
    archive,
    entry.sha256,
  );
  const vendor = path.join(source, "vendor");
  const unpacked = path.join(vendor, `cuid-rust-${entry.commit}`);
  const target = path.join(vendor, "cuid");
  if (fs.existsSync(target) || fs.existsSync(unpacked))
    throw new Error("prisma_cuid_source_exists");
  execute("tar", ["-xf", archive, "-C", vendor], root, "cuid-extract");
  checkRustSourceTree(unpacked);
  // Both paths are fixed children of this run's newly created private source tree.
  fs.renameSync(unpacked, target);
  execute(
    "git",
    [
      "-c",
      "core.autocrlf=false",
      "apply",
      "--check",
      path.join(root, entry.patch.path),
    ],
    target,
    "cuid-patch-check",
  );
  execute(
    "git",
    ["-c", "core.autocrlf=false", "apply", path.join(root, entry.patch.path)],
    target,
    "cuid-patch",
  );
}

export function checkPrismaCuidWiring(source, entry, input) {
  const read = (file) =>
    toml.parse(fs.readFileSync(path.join(source, file), "utf8"));
  const workspace = read("Cargo.toml");
  const contract = read("security-contracts/Cargo.toml");
  const vendor = path.join(source, "vendor/cuid");
  for (const file of entry.sourceFiles) input(vendor, file);
  const cuidWorkspace = read("vendor/cuid/Cargo.toml");
  if (
    !workspace.workspace.exclude?.includes("vendor/cuid") ||
    workspace.workspace.dependencies.cuid.path !== "vendor/cuid/crates/cuid" ||
    workspace.workspace.dependencies.cuid.version !== "=1.3.3+oja.1"
  )
    throw new Error("prisma_cuid_wiring_invalid");
  for (const pkg of entry.packages) {
    const manifest = read(`vendor/cuid/crates/${pkg.name}/Cargo.toml`);
    if (
      manifest.package.name !== pkg.name ||
      manifest.package.version !== pkg.version ||
      Object.hasOwn(manifest.dependencies || {}, "base36") ||
      Object.hasOwn(manifest.dependencies || {}, "failure")
    )
      throw new Error("prisma_cuid_wiring_invalid");
    if (pkg.name !== "cuid-util") {
      const getrandom =
        manifest.target?.['cfg(target_arch = "wasm32")']?.dependencies
          ?.getrandom;
      if (
        getrandom?.version !== "=0.2.17" ||
        getrandom.features?.join() !== "js"
      )
        throw new Error("prisma_cuid_wiring_invalid");
    }
    if (pkg.name !== "cuid") {
      const dependency = cuidWorkspace.workspace.dependencies[pkg.name];
      if (
        dependency.path !== `./crates/${pkg.name}` ||
        dependency.version !== `=${pkg.version}`
      )
        throw new Error("prisma_cuid_wiring_invalid");
    }
    if (
      ["cuid", "cuid-util"].includes(pkg.name) &&
      (contract.dependencies[pkg.name]?.path !==
        `../vendor/cuid/crates/${pkg.name}` ||
        contract.dependencies[pkg.name].version !== `=${pkg.version}`)
    )
      throw new Error("prisma_cuid_wiring_invalid");
  }
  return true;
}

export function checkPrismaCuidMetadata(
  metadata,
  source,
  entry,
  { contracts = false } = {},
) {
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const selected = new Map();
  for (const item of entry.packages) {
    const matches = metadata.packages.filter((pkg) => pkg.name === item.name);
    const pkg = matches[0];
    if (
      matches.length !== 1 ||
      pkg.source ||
      pkg.version !== item.version ||
      path.dirname(fs.realpathSync(pkg.manifest_path)) !==
        path.join(fs.realpathSync(source), "vendor/cuid/crates", item.name)
    )
      throw new Error("prisma_cuid_override_unbound");
    selected.set(item.name, pkg);
  }
  for (const [owner, names] of [
    ["cuid", ["cuid1", "cuid2"]],
    ["cuid1", ["cuid-util"]],
    ["cuid2", ["cuid-util"]],
  ]) {
    const node = nodes.get(selected.get(owner).id);
    for (const name of names) {
      const dependency = node?.deps.find(
        (dep) => dep.name === name.replaceAll("-", "_"),
      );
      if (dependency?.pkg !== selected.get(name).id)
        throw new Error("prisma_cuid_resolution_invalid");
    }
  }
  const owners = contracts
    ? ["oja-prisma-source-contracts"]
    : ["query-core", "query-structure"];
  for (const name of owners) {
    const owner = metadata.packages.find(
      (pkg) => pkg.name === name && !pkg.source,
    );
    const dependency = nodes
      .get(owner?.id)
      ?.deps.find((dep) => dep.name === "cuid");
    if (packages.get(dependency?.pkg)?.id !== selected.get("cuid").id)
      throw new Error("prisma_cuid_resolution_invalid");
  }
  if (
    metadata.packages.some((pkg) =>
      ["base36", "failure", "failure_derive"].includes(pkg.name),
    )
  )
    throw new Error("prisma_cuid_obsolete_dependency");
  return true;
}

export function prismaPatchedGitSources(policy) {
  return [
    ...policy.mysqlSources
      .filter((entry) => entry.gitSource)
      .map((entry) => ({
        name: entry.name,
        version: entry.version,
        repository: entry.gitSource.repository,
        commit: entry.gitSource.commit,
        archiveSha256: entry.sha256,
      })),
    ...policy.cuidSource.packages.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      repository: policy.cuidSource.repository,
      commit: policy.cuidSource.commit,
      archiveSha256: policy.cuidSource.sha256,
    })),
  ].map((entry) => ({
    ...entry,
    reason: "git_derived_override_requires_review",
  }));
}

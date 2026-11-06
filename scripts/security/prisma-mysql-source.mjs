import fs from "node:fs";
import path from "node:path";
import toml from "toml";
import { downloadRustInput, checkRustSourceTree } from "./rust-toolchain.mjs";

const HASH = /^[a-f0-9]{64}$/;
const FILES = {
  mysql_async: [
    "Cargo.toml",
    "src/lib.rs",
    "src/conn/stmt_cache.rs",
    "src/conn/mod.rs",
    "src/queryable/stmt.rs",
    "src/oja_security_contracts.rs",
  ],
  mysql_common: [
    "Cargo.toml",
    "build.rs",
    "src/scramble.rs",
    "src/crypto/rsa.rs",
    "src/crypto/der.rs",
    "src/misc/mod.rs",
    "src/value/convert/mod.rs",
    "src/packets/mod.rs",
  ],
};
const VERSIONS = { mysql_async: "0.31.3", mysql_common: "0.29.2" };
const DEPENDENCIES = {
  mysql_async: {
    lru: "0.18.2",
    lexical: "7.0.5",
    mysql_common: "0.29.2+oja.1",
  },
  mysql_common: {
    lexical: "7.0.5",
    sha1: "0.11.0",
    sha2: "0.11.1",
    bindgen: "0.72.1",
  },
};
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...keys].sort().join();

export function validatePrismaMysqlSources(sources) {
  if (!Array.isArray(sources) || sources.length !== 2)
    throw new Error("prisma_mysql_policy_invalid");
  for (const [index, name] of ["mysql_async", "mysql_common"].entries()) {
    const entry = sources[index];
    if (
      !exact(entry, [
        "name",
        "upstreamVersion",
        "version",
        "sha256",
        "patch",
        "sourceFiles",
        "dependencies",
        ...(index === 0 ? ["gitSource"] : []),
      ]) ||
      entry.name !== name ||
      entry.upstreamVersion !== VERSIONS[name] ||
      entry.version !== `${VERSIONS[name]}+oja.1` ||
      !HASH.test(entry.sha256 || "") ||
      !exact(entry.patch, ["path", "sha256"]) ||
      entry.patch.path !== `vendor/native/prisma/${name}.patch` ||
      !HASH.test(entry.patch.sha256 || "") ||
      !exact(entry.dependencies, Object.keys(DEPENDENCIES[name])) ||
      Object.entries(DEPENDENCIES[name]).some(
        ([key, version]) => entry.dependencies[key] !== version,
      ) ||
      !Array.isArray(entry.sourceFiles) ||
      entry.sourceFiles.length !== FILES[name].length ||
      entry.sourceFiles.some(
        (file, i) =>
          !exact(file, ["path", "sha256"]) ||
          file.path !== FILES[name][i] ||
          !HASH.test(file.sha256 || ""),
      )
    )
      throw new Error("prisma_mysql_policy_invalid");
    if (
      index === 0 &&
      (!exact(entry.gitSource, ["repository", "commit", "reviewStatus"]) ||
        entry.gitSource.repository !== "prisma/mysql_async" ||
        entry.gitSource.commit !== "c4c841c9d03e361df7377264a075335a823534ee" ||
        entry.gitSource.reviewStatus !== "UNREVIEWED")
    )
      throw new Error("prisma_mysql_policy_invalid");
  }
  return sources;
}

export async function preparePrismaMysqlSources(
  root,
  source,
  cache,
  sources,
  execute,
  input,
) {
  for (const entry of sources) {
    input(root, entry.patch);
    const name = entry.gitSource
      ? `mysql_async-${entry.gitSource.commit}`
      : `${entry.name}-${entry.upstreamVersion}`;
    const archive = path.join(
      cache,
      entry.gitSource ? "mysql_async-source.tar.gz" : `${name}.crate`,
    );
    const url = entry.gitSource
      ? `https://codeload.github.com/${entry.gitSource.repository}/tar.gz/${entry.gitSource.commit}`
      : `https://static.crates.io/crates/${entry.name}/${name}.crate`;
    await downloadRustInput(url, archive, entry.sha256);
    const vendor = path.join(source, "vendor");
    const target = path.join(vendor, entry.name);
    const unpacked = path.join(vendor, name);
    if (fs.existsSync(target) || fs.existsSync(unpacked))
      throw new Error("prisma_mysql_source_exists");
    execute(
      "tar",
      ["-xf", archive, "-C", vendor],
      root,
      `${entry.name}-extract`,
    );
    checkRustSourceTree(unpacked);
    // Fixed, checked children of this run's fresh private source directory.
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
      `${entry.name}-patch-check`,
    );
    execute(
      "git",
      ["-c", "core.autocrlf=false", "apply", path.join(root, entry.patch.path)],
      target,
      `${entry.name}-patch`,
    );
  }
}

export function checkPrismaMysqlWiring(source, sources, input) {
  const read = (file) =>
    toml.parse(fs.readFileSync(path.join(source, file), "utf8"));
  const workspace = read("Cargo.toml");
  const contract = read("security-contracts/Cargo.toml");
  const [driver, common] = sources;
  for (const entry of sources) {
    for (const file of entry.sourceFiles)
      input(path.join(source, "vendor", entry.name), file);
    if (
      !workspace.workspace.exclude?.includes(`vendor/${entry.name}`) ||
      contract.dependencies[entry.name]?.path !== `../vendor/${entry.name}`
    )
      throw new Error("prisma_mysql_wiring_invalid");
    const manifest = read(`vendor/${entry.name}/Cargo.toml`);
    if (
      manifest.package.name !== entry.name ||
      manifest.package.version !== entry.version
    )
      throw new Error("prisma_mysql_wiring_invalid");
    for (const [name, version] of Object.entries(entry.dependencies)) {
      const dependency =
        name === "bindgen"
          ? manifest["build-dependencies"][name]
          : manifest.dependencies[name];
      if (
        (typeof dependency === "string" ? dependency : dependency?.version) !==
        `=${version}`
      )
        throw new Error("prisma_mysql_wiring_invalid");
    }
  }
  const manifest = read("vendor/mysql_async/Cargo.toml");
  if (
    workspace.workspace.dependencies.mysql_async.path !==
      "vendor/mysql_async" ||
    workspace.workspace.dependencies.mysql_async.version !==
      `=${driver.version}` ||
    workspace.patch?.["crates-io"]?.mysql_common?.path !==
      "vendor/mysql_common" ||
    manifest.dependencies.mysql_common.path !== "../mysql_common" ||
    manifest.dependencies.mysql_common["default-features"] !== false ||
    !manifest.features.default.includes("native-tls-tls") ||
    manifest.features.default.includes("oja-security-contracts") ||
    !Array.isArray(manifest.features["oja-security-contracts"]) ||
    manifest.features["oja-security-contracts"].length ||
    !contract.dependencies.mysql_async.features.includes(
      "oja-security-contracts",
    ) ||
    workspace.workspace.dependencies.mysql_async.features?.includes(
      "oja-security-contracts",
    ) ||
    common.gitSource
  )
    throw new Error("prisma_mysql_wiring_invalid");
  return true;
}

export function checkPrismaMysqlMetadata(
  metadata,
  source,
  sources,
  { contracts = false } = {},
) {
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  for (const entry of sources) {
    const matches = metadata.packages.filter((pkg) => pkg.name === entry.name);
    const pkg = matches[0];
    const node = nodes.get(pkg?.id);
    if (
      matches.length !== 1 ||
      pkg.source ||
      pkg.version !== entry.version ||
      path.dirname(fs.realpathSync(pkg.manifest_path)) !==
        path.join(fs.realpathSync(source), "vendor", entry.name) ||
      node?.features?.includes("test") ||
      node?.features?.includes("nightly") ||
      (entry.name === "mysql_async" &&
        (Boolean(node?.features?.includes("oja-security-contracts")) !==
          contracts ||
          !node.features.includes("native-tls-tls")))
    )
      throw new Error("prisma_mysql_override_unbound");
    for (const [name, version] of Object.entries(entry.dependencies)) {
      const dep = node.deps.find((dep) => dep.name === name);
      const resolved = packages.get(dep?.pkg);
      if (
        resolved?.version !== version ||
        (name !== "mysql_common" &&
          resolved?.source !==
            "registry+https://github.com/rust-lang/crates.io-index")
      )
        throw new Error("prisma_mysql_resolution_invalid");
    }
  }
  for (const name of ["lru", "lexical"]) {
    if (
      metadata.packages.some(
        (pkg) =>
          pkg.name === name && pkg.version !== DEPENDENCIES.mysql_async[name],
      )
    )
      throw new Error("prisma_mysql_resolution_invalid");
  }
  return true;
}

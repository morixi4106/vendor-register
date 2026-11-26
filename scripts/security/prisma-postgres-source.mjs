import fs from "node:fs";
import path from "node:path";
import toml from "toml";
import { downloadRustInput, checkRustSourceTree } from "./rust-toolchain.mjs";

const COMMIT = "d18e6fc2e549887161161025494f1db3b1b26cac";
const ARCHIVE =
  "a05cb06e8c5af5777ab4fb1dd6f21c482a995e484d79d8757ac4cc79f9d837d4";
const VERSIONS = {
  "postgres-protocol": "0.6.8",
  "postgres-types": "0.2.9",
  "postgres-native-tls": "0.5.1",
  "tokio-postgres": "0.7.13",
};
const FIXES = {
  "RUSTSEC-2026-0178": "7a00ffa9ad4d951ec0a4564b52f1780fa9d353c1",
  "RUSTSEC-2026-0179": "d40097a36a85068ea50a3afbf0ce154ba439e7f0",
  "RUSTSEC-2026-0180": "a7cf84b5c46431cbca9d8ff50508c23f446efa7d",
};
const FILES = [
  "Cargo.toml",
  "LICENSE-APACHE",
  "LICENSE-MIT",
  ...Object.keys(VERSIONS).map((name) => `${name}/Cargo.toml`),
  "postgres-protocol/src/authentication/sasl.rs",
  "postgres-protocol/src/types/mod.rs",
  "postgres-protocol/src/message/backend.rs",
  "postgres-types/src/lib.rs",
  "postgres-native-tls/src/lib.rs",
  "tokio-postgres/src/row.rs",
  "tokio-postgres/src/row/oja_security_contracts.rs",
  "tokio-postgres/src/client.rs",
  "tokio-postgres/src/config.rs",
  "tokio-postgres/src/connect_raw.rs",
  "tokio-postgres/src/connect_tls.rs",
  "tokio-postgres/src/query.rs",
  "tokio-postgres/src/simple_query.rs",
  "tokio-postgres/src/statement.rs",
];
const LICENSE_LINKS = [
  "postgres-derive",
  "postgres-native-tls",
  "postgres-openssl",
  "postgres-protocol",
  "postgres-types",
  "postgres",
  "tokio-postgres",
].flatMap((pkg) =>
  ["LICENSE-APACHE", "LICENSE-MIT"].map((name) => `${pkg}/${name}`),
);
const HASH = /^[a-f0-9]{64}$/;
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...keys].sort().join();

export function validatePrismaPostgresSource(entry) {
  if (
    !exact(entry, [
      "repository",
      "commit",
      "sha256",
      "reviewStatus",
      "patch",
      "packages",
      "fixes",
      "sourceFiles",
    ]) ||
    entry.repository !== "prisma/rust-postgres" ||
    entry.commit !== COMMIT ||
    entry.sha256 !== ARCHIVE ||
    entry.reviewStatus !== "UNREVIEWED" ||
    !exact(entry.patch, ["path", "sha256"]) ||
    entry.patch.path !== "vendor/native/prisma/postgres.patch" ||
    !HASH.test(entry.patch.sha256 || "") ||
    !exact(entry.fixes, Object.keys(FIXES)) ||
    Object.entries(FIXES).some(
      ([name, commit]) => entry.fixes[name] !== commit,
    ) ||
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
    throw new Error("prisma_postgres_policy_invalid");
  return entry;
}

export async function preparePrismaPostgresSource(
  root,
  source,
  cache,
  entry,
  execute,
  input,
) {
  validatePrismaPostgresSource(entry);
  input(root, entry.patch);
  const archive = path.join(cache, "postgres-source.tar.gz");
  await downloadRustInput(
    `https://codeload.github.com/${entry.repository}/tar.gz/${entry.commit}`,
    archive,
    entry.sha256,
  );
  const vendor = path.join(source, "vendor"),
    prefix = `rust-postgres-${entry.commit}`;
  const unpacked = path.join(vendor, prefix),
    target = path.join(vendor, "postgres");
  if (fs.existsSync(unpacked) || fs.existsSync(target))
    throw new Error("prisma_postgres_source_exists");
  // The pinned archive has exactly these relative license links. Materialize only
  // these known links as identical regular files on both OSes, never follow links.
  execute(
    "tar",
    [
      "-xf",
      archive,
      "-C",
      vendor,
      ...LICENSE_LINKS.flatMap((file) => ["--exclude", `${prefix}/${file}`]),
    ],
    root,
    "postgres-extract",
  );
  checkRustSourceTree(unpacked);
  for (const file of LICENSE_LINKS)
    fs.copyFileSync(
      path.join(unpacked, path.basename(file)),
      path.join(unpacked, file),
      fs.constants.COPYFILE_EXCL,
    );
  fs.renameSync(unpacked, target);
  for (const check of [true, false])
    execute(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "apply",
        ...(check ? ["--check"] : []),
        path.join(root, entry.patch.path),
      ],
      target,
      `postgres-patch-${check}`,
    );
  checkRustSourceTree(target);
}

export function checkPrismaPostgresWiring(source, entry, input) {
  const read = (relative) =>
    toml.parse(fs.readFileSync(path.join(source, relative), "utf8"));
  const base = path.join(source, "vendor/postgres"),
    workspace = read("Cargo.toml"),
    contract = read("security-contracts/Cargo.toml");
  for (const file of entry.sourceFiles) input(base, file);
  for (const file of LICENSE_LINKS) {
    const stat = fs.lstatSync(path.join(base, file));
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      !fs
        .readFileSync(path.join(base, file))
        .equals(fs.readFileSync(path.join(base, path.basename(file))))
    )
      throw new Error("prisma_postgres_license_invalid");
  }
  if (!workspace.workspace.exclude?.includes("vendor/postgres"))
    throw new Error("prisma_postgres_wiring_invalid");
  for (const pkg of entry.packages) {
    const manifest = read(`vendor/postgres/${pkg.name}/Cargo.toml`);
    const hook = ["postgres-protocol", "tokio-postgres"].includes(pkg.name);
    const dep = contract.dependencies[pkg.name];
    if (
      manifest.package.name !== pkg.name ||
      manifest.package.version !== pkg.version ||
      dep?.path !== `../vendor/postgres/${pkg.name}` ||
      dep.version !== `=${pkg.version}` ||
      Boolean(dep.features?.includes("oja-security-contracts")) !== hook ||
      (hook &&
        (!Array.isArray(manifest.features["oja-security-contracts"]) ||
          manifest.features["oja-security-contracts"].length ||
          manifest.features.default.includes("oja-security-contracts")))
    )
      throw new Error("prisma_postgres_wiring_invalid");
    if (pkg.name !== "postgres-protocol") {
      const dep = workspace.workspace.dependencies[pkg.name];
      if (
        dep?.path !== `vendor/postgres/${pkg.name}` ||
        dep.version !== `=${pkg.version}` ||
        dep.git ||
        dep.features?.includes("oja-security-contracts")
      )
        throw new Error("prisma_postgres_wiring_invalid");
    }
    for (const name of pkg.name === "postgres-native-tls"
      ? ["tokio-postgres"]
      : pkg.name === "postgres-types"
        ? ["postgres-protocol"]
        : pkg.name === "tokio-postgres"
          ? ["postgres-protocol", "postgres-types"]
          : []) {
      const dep = manifest.dependencies[name];
      if (
        dep?.path !== `../${name}` ||
        dep.version !== `=${VERSIONS[name]}+oja.1` ||
        dep.features?.includes("oja-security-contracts")
      )
        throw new Error("prisma_postgres_wiring_invalid");
    }
  }
  return true;
}

export function checkPrismaPostgresMetadata(
  metadata,
  source,
  entry,
  { contracts = false } = {},
) {
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const selected = new Map();
  for (const item of entry.packages) {
    const matches = metadata.packages.filter((pkg) => pkg.name === item.name),
      pkg = matches[0];
    const hook = ["postgres-protocol", "tokio-postgres"].includes(item.name);
    if (
      matches.length !== 1 ||
      pkg.source ||
      pkg.version !== item.version ||
      path.dirname(fs.realpathSync(pkg.manifest_path)) !==
        path.join(fs.realpathSync(source), "vendor/postgres", item.name) ||
      (hook &&
        Boolean(
          nodes.get(pkg.id)?.features?.includes("oja-security-contracts"),
        ) !== contracts)
    )
      throw new Error("prisma_postgres_override_unbound");
    selected.set(item.name, pkg);
  }
  const edges = [
    ["tokio-postgres", ["postgres-protocol", "postgres-types"]],
    ["postgres-types", ["postgres-protocol"]],
    ["postgres-native-tls", ["tokio-postgres"]],
    [
      contracts ? "oja-prisma-source-contracts" : "quaint",
      contracts
        ? Object.keys(VERSIONS)
        : ["tokio-postgres", "postgres-types", "postgres-native-tls"],
    ],
  ];
  for (const [owner, names] of edges) {
    const pkg = metadata.packages.find(
      (pkg) => pkg.name === owner && !pkg.source,
    );
    for (const name of names)
      if (
        nodes
          .get(pkg?.id)
          ?.deps.find((dep) => dep.name === name.replaceAll("-", "_"))?.pkg !==
        selected.get(name).id
      )
        throw new Error("prisma_postgres_resolution_invalid");
  }
  if (
    !nodes
      .get(selected.get("tokio-postgres").id)
      ?.features?.includes("runtime") ||
    !nodes
      .get(selected.get("postgres-native-tls").id)
      ?.features?.includes("runtime")
  )
    throw new Error("prisma_postgres_runtime_missing");
  return true;
}

export async function assessPrismaPostgresIdentities(
  entry,
  { fetchImpl = fetch } = {},
) {
  const response = await fetchImpl("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      queries: entry.packages.map((pkg) => ({
        package: { ecosystem: "crates.io", name: pkg.name },
        version: pkg.upstreamVersion,
      })),
    }),
  });
  if (!response.ok) throw new Error("prisma_postgres_advisory_failed");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("prisma_postgres_advisory_limit");
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Array.isArray(result.results) || result.results.length !== 4)
    throw new Error("prisma_postgres_advisory_incomplete");
  const packages = result.results.map((item, index) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).some(
        (key) => !["vulns", "next_page_token"].includes(key),
      ) ||
      item.next_page_token ||
      (item.vulns !== undefined && !Array.isArray(item.vulns))
    )
      throw new Error("prisma_postgres_advisory_incomplete");
    const matches = (item.vulns || []).map((v) => {
      if (
        !/^(RUSTSEC-\d{4}-\d{4}|GHSA-[a-z0-9-]+|CVE-\d{4}-\d+)$/.test(
          v?.id || "",
        ) ||
        !Number.isFinite(Date.parse(v.modified))
      )
        throw new Error("prisma_postgres_advisory_invalid");
      return { advisory: v.id, modified: v.modified };
    });
    const pkg = entry.packages[index];
    return {
      name: pkg.name,
      upstreamVersion: pkg.upstreamVersion,
      patchedVersion: pkg.version,
      matches,
    };
  });
  return {
    schemaVersion: 1,
    repository: entry.repository,
    commit: entry.commit,
    archiveSha256: entry.sha256,
    patchSha256: entry.patch.sha256,
    scope:
      "Original Git declared versions queried as registry identities only; not fork equivalence, source applicability or patch approval.",
    sourceReviewed: false,
    productionApproved: false,
    sourceAuditOk: false,
    observedAt: new Date().toISOString(),
    packages,
  };
}

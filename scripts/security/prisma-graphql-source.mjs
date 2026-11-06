import fs from "node:fs";
import path from "node:path";
import toml from "toml";
import { downloadRustInput, checkRustSourceTree } from "./rust-toolchain.mjs";

const COMMIT = "6a3f58bd879065588e710cb02b5bd30c1ce182c3";
const FILES = [
  "Cargo.toml",
  "LICENSE-APACHE",
  "LICENSE-MIT",
  "src/lib.rs",
  "src/tokenizer.rs",
  "src/query/grammar.rs",
  "src/schema/grammar.rs",
  "src/oja_security_contracts.rs",
  "src/common.rs",
  "src/oja_string_review.rs",
];
const HASH = /^[a-f0-9]{64}$/;
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...keys].sort().join();

export function validatePrismaGraphqlSource(entry) {
  if (
    !exact(entry, [
      "name",
      "upstreamVersion",
      "version",
      "repository",
      "commit",
      "sha256",
      "reviewStatus",
      "maximumNesting",
      "referenceCommit",
      "patch",
      "sourceFiles",
    ]) ||
    entry.name !== "graphql-parser" ||
    entry.upstreamVersion !== "0.3.0" ||
    entry.version !== "0.3.0+oja.1" ||
    entry.repository !== "prisma/graphql-parser" ||
    entry.commit !== COMMIT ||
    entry.sha256 !==
      "178523e71418f058b4b0eeb829b2c8b36064378d77eb83707130fb2e9916653e" ||
    entry.reviewStatus !== "UNREVIEWED" ||
    entry.maximumNesting !== 50 ||
    entry.referenceCommit !== "d19155f5f9206662964e388e80c68b85f3edb09a" ||
    !exact(entry.patch, ["path", "sha256"]) ||
    entry.patch.path !== "vendor/native/prisma/graphql.patch" ||
    !HASH.test(entry.patch.sha256 || "") ||
    !Array.isArray(entry.sourceFiles) ||
    entry.sourceFiles.length !== FILES.length ||
    entry.sourceFiles.some(
      (f, i) =>
        !exact(f, ["path", "sha256"]) ||
        f.path !== FILES[i] ||
        !HASH.test(f.sha256 || ""),
    )
  )
    throw new Error("prisma_graphql_policy_invalid");
  return entry;
}

export async function preparePrismaGraphqlSource(
  root,
  source,
  cache,
  entry,
  execute,
  input,
) {
  input(root, entry.patch);
  const archive = path.join(cache, "graphql-source.tar.gz");
  await downloadRustInput(
    `https://codeload.github.com/${entry.repository}/tar.gz/${entry.commit}`,
    archive,
    entry.sha256,
  );
  const vendor = path.join(source, "vendor"),
    unpacked = path.join(vendor, `graphql-parser-${COMMIT}`),
    target = path.join(vendor, "graphql");
  if (fs.existsSync(unpacked) || fs.existsSync(target))
    throw new Error("prisma_graphql_source_exists");
  execute("tar", ["-xf", archive, "-C", vendor], root, "graphql-extract");
  checkRustSourceTree(unpacked);
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
      `graphql-patch-${check}`,
    );
}

export function checkPrismaGraphqlWiring(source, entry, input) {
  const vendor = path.join(source, "vendor/graphql");
  for (const file of entry.sourceFiles) input(vendor, file);
  const workspace = toml.parse(
    fs.readFileSync(path.join(source, "Cargo.toml"), "utf8"),
  ).workspace;
  const manifest = toml.parse(
    fs.readFileSync(path.join(vendor, "Cargo.toml"), "utf8"),
  );
  if (
    workspace.exclude?.includes("vendor/graphql") ||
    !workspace.members?.includes("vendor/graphql") ||
    !exact(workspace.dependencies["graphql-parser"], ["path", "version"]) ||
    workspace.dependencies["graphql-parser"].path !== "vendor/graphql" ||
    workspace.dependencies["graphql-parser"].version !== `=${entry.version}` ||
    manifest.package.name !== entry.name ||
    manifest.package.version !== entry.version ||
    manifest.dependencies.combine !== "3.2.0" ||
    manifest.dependencies.indexmap !== "1.5" ||
    manifest.dependencies.thiserror !== "1.0.11" ||
    manifest["dev-dependencies"].pretty_assertions !== "=1.4.1" ||
    manifest.features ||
    !fs
      .readFileSync(path.join(vendor, "src/lib.rs"), "utf8")
      .includes("#[cfg(test)]\nmod oja_security_contracts;") ||
    !fs
      .readFileSync(path.join(vendor, "src/lib.rs"), "utf8")
      .includes("#[cfg(test)]\nmod oja_string_review;")
  )
    throw new Error("prisma_graphql_wiring_invalid");
}

export function checkPrismaGraphqlMetadata(metadata, source, entry) {
  const matches = metadata.packages.filter((p) => p.name === entry.name),
    pkg = matches[0];
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  if (
    matches.length !== 1 ||
    pkg.source ||
    pkg.version !== entry.version ||
    fs.realpathSync(pkg.manifest_path) !==
      path.join(fs.realpathSync(source), "vendor/graphql/Cargo.toml")
  )
    throw new Error("prisma_graphql_metadata_unbound");
  for (const name of ["query-engine", "request-handlers"]) {
    const owner = metadata.packages.find((p) => p.name === name && !p.source);
    if (
      nodes.get(owner?.id)?.deps.find((d) => d.name === "graphql_parser")
        ?.pkg !== pkg.id
    )
      throw new Error("prisma_graphql_consumer_missing");
  }
  const handler = metadata.packages.find(
    (p) => p.name === "request-handlers" && !p.source,
  );
  if (
    !nodes.get(handler?.id)?.features.includes("graphql-protocol") ||
    nodes.get(pkg.id)?.features.length !== 0
  )
    throw new Error("prisma_graphql_features_invalid");
  return true;
}

export function prismaGraphqlArguments() {
  return [
    "test",
    "--locked",
    "--package",
    "graphql-parser",
    "--lib",
    "oja_security_contracts",
  ];
}

export function prismaGraphqlStringArguments() {
  return [
    "test",
    "--locked",
    "--package",
    "graphql-parser",
    "--lib",
    "oja_string_review",
  ];
}

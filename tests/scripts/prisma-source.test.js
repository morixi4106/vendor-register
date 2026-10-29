import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import {
  validatePrismaSourcePolicy,
  prismaSourceInput,
  checkPrismaClientVersion,
  checkPrismaSourceWiring,
  checkPrismaMetadata,
  rustTestTotals,
  prismaSourceReceipt,
} from "../../scripts/security/test-prisma-source.mjs";
import { rustRegistryPackages } from "../../scripts/security/rust-source-audit.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const policy = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, "security/prisma-source-contracts.json"),
    "utf8",
  ),
);
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fixture = (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "prisma-source-test-"),
  );
  assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

test("Prisma recipe binds the source patch and both complete lock graphs", () => {
  assert.equal(validatePrismaSourcePolicy(policy), policy);
  for (const input of [policy.patch, policy.lockfile, policy.contractLockfile])
    assert.ok(prismaSourceInput(ROOT, input).length);
  const whole = rustRegistryPackages(
    prismaSourceInput(ROOT, policy.lockfile).toString("utf8"),
  );
  const contracts = rustRegistryPackages(
    prismaSourceInput(ROOT, policy.contractLockfile).toString("utf8"),
  );
  assert.equal(
    whole.packages.find((pkg) => pkg.name === "lru" && pkg.version === "0.7.8"),
    undefined,
  );
  assert.equal(whole.unresolved.length, 13);
  assert.equal(contracts.packages.length, 15);
  assert.equal(contracts.unresolved.length, 0);
  for (const [name, version] of Object.entries(policy.dependencies))
    assert.ok(
      contracts.packages.some(
        (pkg) => pkg.name === name && pkg.version === version,
      ),
    );
});

test("Prisma client and CLI must match the patched engine recipe without version ranges", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  );
  assert.equal(checkPrismaClientVersion(manifest, policy), true);
  for (const name of ["prisma", "@prisma/client"]) {
    for (const version of ["7.0.0", "^6.19.3", undefined]) {
      const changed = structuredClone(manifest);
      changed.dependencies[name] = version;
      assert.throws(
        () => checkPrismaClientVersion(changed, policy),
        /prisma_source_client_version_mismatch/,
      );
    }
  }
});

test("Prisma recipe rejects version drift, path changes, added settings and missing module bindings", () => {
  for (const change of [
    (p) => {
      p.prismaVersion = "7.0.0";
    },
    (p) => {
      p.dependencies.lru = "0.7.8";
    },
    (p) => {
      p.source.commit = "0".repeat(40);
    },
    (p) => {
      p.patch.path = "../outside.patch";
    },
    (p) => {
      p.contractLockfile.sha256 = "not-a-digest";
    },
    (p) => {
      p.sourceFiles[0].path = "../Cargo.toml";
    },
    (p) => {
      p.sourceFiles.pop();
    },
    (p) => {
      p.productionApproved = true;
    },
  ]) {
    const changed = structuredClone(policy);
    change(changed);
    assert.throws(
      () => validatePrismaSourcePolicy(changed),
      /prisma_source_policy_invalid/,
    );
  }
});

test("Prisma inputs reject traversal, digest mismatch and hard links", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "source.txt"), "safe");
  const entry = { path: "source.txt", sha256: sha("safe") };
  assert.equal(prismaSourceInput(root, entry).toString(), "safe");
  assert.throws(
    () => prismaSourceInput(root, { ...entry, path: "../source.txt" }),
    /prisma_source_path_invalid/,
  );
  assert.throws(
    () => prismaSourceInput(root, { ...entry, sha256: "0".repeat(64) }),
    /prisma_source_digest_mismatch/,
  );
  fs.linkSync(path.join(root, "source.txt"), path.join(root, "linked.txt"));
  assert.throws(
    () => prismaSourceInput(root, entry),
    /prisma_source_path_invalid/,
  );
});

const metadataFixture = (t, contracts) => {
  const source = fixture(t);
  const owners = contracts
    ? ["oja-prisma-source-contracts"]
    : ["query-core", "schema-connector"];
  const packages = owners.map((name) => {
    const directory = path.join(
      source,
      contracts ? "security-contracts" : name,
    );
    fs.mkdirSync(directory);
    const manifest = path.join(directory, "Cargo.toml");
    fs.writeFileSync(manifest, "[package]\n");
    return {
      id: name,
      name,
      version: "0.1.0",
      source: null,
      manifest_path: manifest,
    };
  });
  const nodes = owners.map((name) => ({ id: name, deps: [] }));
  for (const [index, [name, version]] of Object.entries(
    policy.dependencies,
  ).entries()) {
    packages.push({
      id: name,
      name,
      version,
      source: "registry+https://github.com/rust-lang/crates.io-index",
    });
    nodes[contracts ? 0 : index].deps.push({ name, pkg: name });
  }
  return { source, metadata: { packages, resolve: { nodes } } };
};

test("metadata checks actual query-core and migration checksum dependency resolution", (t) => {
  const { source, metadata } = metadataFixture(t, false);
  assert.equal(checkPrismaMetadata(metadata, source, policy), true);
  metadata.packages.find((pkg) => pkg.name === "lru").version = "0.8.1";
  assert.throws(
    () => checkPrismaMetadata(metadata, source, policy),
    /prisma_dependency_resolution_invalid/,
  );
});

test("contract metadata rejects Git dependencies even when pinned", (t) => {
  const { source, metadata } = metadataFixture(t, true);
  assert.equal(
    checkPrismaMetadata(metadata, source, policy, { contracts: true }),
    true,
  );
  metadata.packages.push({
    id: "git",
    name: "unreviewed",
    source: "git+https://github.com/prisma/example#" + "a".repeat(40),
  });
  assert.throws(
    () => checkPrismaMetadata(metadata, source, policy, { contracts: true }),
    /prisma_metadata_source_unpinned/,
  );
});

test("engine metadata keeps pinned upstream Git sources unapproved and rejects floating sources", (t) => {
  const { source, metadata } = metadataFixture(t, false);
  const git = {
    id: "git",
    name: "upstream",
    source:
      "git+https://github.com/prisma/rust-postgres?branch=pgbouncer-mode#" +
      "a".repeat(40),
  };
  metadata.packages.push(git);
  assert.throws(
    () => checkPrismaMetadata(metadata, source, policy),
    /prisma_metadata_source_unpinned/,
  );
  assert.equal(
    checkPrismaMetadata(metadata, source, policy, { gitSources: [git.source] }),
    true,
  );
  git.source =
    "git+https://github.com/prisma/barrel.git?branch=mssql-support#" +
    "b".repeat(40);
  assert.equal(
    checkPrismaMetadata(metadata, source, policy, { gitSources: [git.source] }),
    true,
  );
  git.source =
    "git+https://github.com/prisma/rust-postgres?branch=pgbouncer-mode";
  assert.throws(
    () => checkPrismaMetadata(metadata, source, policy),
    /prisma_metadata_source_unpinned/,
  );
});

test("metadata cannot bind local engine packages outside the extracted source", (t) => {
  const { source, metadata } = metadataFixture(t, false);
  const outside = fixture(t);
  const file = path.join(outside, "Cargo.toml");
  fs.writeFileSync(file, "[package]\n");
  metadata.packages[0].manifest_path = file;
  assert.throws(
    () => checkPrismaMetadata(metadata, source, policy),
    /prisma_metadata_source_escape/,
  );
});

test("module hash verification rejects detached or modified source before compilation", (t) => {
  const source = fixture(t);
  const item = policy.sourceFiles[0];
  fs.writeFileSync(path.join(source, item.path), "changed");
  assert.throws(
    () => checkPrismaSourceWiring(source, policy),
    /prisma_source_digest_mismatch/,
  );
});

test("Rust test receipts reject incomplete, ignored and failed tests", () => {
  assert.deepEqual(
    rustTestTotals("test result: ok. 11 passed; 0 failed; 0 ignored;", 11),
    { passed: 11, failed: 0, ignored: 0, suites: 1 },
  );
  for (const output of [
    "",
    "test result: ok. 10 passed; 0 failed; 0 ignored;",
    "test result: ok. 11 passed; 0 failed; 1 ignored;",
    "test result: ok. 11 passed; 1 failed; 0 ignored;",
    "test result: ok. 11 passed; 0 failed; 0 ignored;\ntest result: FAILED. 0 passed; 1 failed; 0 ignored;",
  ])
    assert.throws(
      () => rustTestTotals(output, 11),
      /prisma_source_tests_incomplete/,
    );
});

test("clean small contract scans never approve the whole engine or erase its findings", () => {
  const engine = {
    packageCount: 640,
    findings: Array(34).fill({}),
    unresolved: Array(13).fill({}),
    sourceAuditOk: false,
  };
  const contracts = {
    packageCount: 15,
    findings: [],
    unresolved: [],
    sourceAuditOk: true,
  };
  const receipt = prismaSourceReceipt(policy, engine, contracts, {
    contracts: { passed: 11 },
  });
  assert.equal(receipt.productionApproved, false);
  assert.equal(receipt.wholeEngineVerified, false);
  assert.equal(receipt.artifactStatus, "NOT_VERIFIED");
  assert.equal(receipt.engineAdvisoryMatches, 34);
  assert.equal(receipt.unreviewedGitSources, 13);
  assert.equal(receipt.engineSourceAuditOk, false);
  assert.equal(receipt.contractSourceAuditOk, true);
  engine.sourceAuditOk = true;
  assert.equal(
    prismaSourceReceipt(policy, engine, contracts).productionApproved,
    false,
  );
});

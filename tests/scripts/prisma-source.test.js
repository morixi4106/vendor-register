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
  prismaUnitArguments,
  prismaCliArguments,
  prismaSourceReceipt,
  prismaContractAssessment,
} from "../../scripts/security/test-prisma-source.mjs";
import { rustRegistryPackages } from "../../scripts/security/rust-source-audit.mjs";
import {
  validatePrismaCuidSource,
  checkPrismaCuidWiring,
} from "../../scripts/security/prisma-cuid-source.mjs";

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
  for (const input of [
    policy.patch,
    policy.lockfile,
    policy.contractLockfile,
    ...policy.overrides.map((entry) => entry.patch),
    ...policy.mysqlSources.map((entry) => entry.patch),
    policy.cuidSource.patch,
  ])
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
  assert.equal(whole.unresolved.length, 8);
  assert.equal(
    whole.unresolved.length +
      policy.mysqlSources.filter((entry) => entry.gitSource).length +
      policy.cuidSource.packages.length,
    13,
  );
  assert.equal(contracts.packages.length, 351);
  assert.equal(contracts.unresolved.length, 0);
  for (const [name, version] of Object.entries(policy.dependencies))
    assert.ok(
      contracts.packages.some(
        (pkg) => pkg.name === name && pkg.version === version,
      ),
    );
  for (const graph of [whole, contracts]) {
    for (const name of ["base36", "base-x", "failure", "failure_derive"])
      assert.equal(
        graph.packages.some((pkg) => pkg.name === name),
        false,
      );
    for (const [name, version] of Object.entries(
      policy.overrides[0].dependencies,
    )) {
      assert.deepEqual(
        graph.packages
          .filter((pkg) => pkg.name === name)
          .map((pkg) => pkg.version),
        [version],
      );
    }
    assert.equal(
      graph.packages.some((pkg) => pkg.name === "mongodb"),
      false,
    );
    for (const [name, version] of Object.entries({
      lru: "0.18.2",
      lexical: "7.0.5",
    })) {
      assert.deepEqual(
        graph.packages
          .filter((pkg) => pkg.name === name)
          .map((pkg) => pkg.version),
        [version],
      );
    }
    for (const name of ["mysql_async", "mysql_common"])
      assert.equal(
        graph.packages.some((pkg) => pkg.name === name),
        false,
      );
  }
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
      p.cliVersion = "3.2.25";
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
    (p) => {
      p.overrides = [];
    },
    (p) => {
      p.overrides[0].upstreamVersion = "3.9.0";
    },
    (p) => {
      p.overrides[0].dependencies.zstd = "0.13.3";
    },
    (p) => {
      p.overrides[0].patch.path = "../mongodb.patch";
    },
    (p) => {
      p.overrides[0].sourceFiles[0].path = "../Cargo.toml";
    },
    (p) => {
      p.overrides[0].sourceFiles.pop();
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
    : [
        "query-core",
        "schema-connector",
        "query-structure",
        "query-engine",
        "schema-engine-cli",
        "prisma-fmt",
      ];
  const packages = owners.map((name) => {
    const directory = path.join(
      source,
      contracts
        ? "security-contracts"
        : {
            "query-engine": "query-engine/query-engine",
            "schema-engine-cli": "schema-engine/cli",
          }[name] || name,
    );
    fs.mkdirSync(directory, { recursive: true });
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
  if (!contracts) {
    packages.push({
      id: "clap",
      name: "clap",
      version: policy.cliVersion,
      source: "registry+https://github.com/rust-lang/crates.io-index",
    });
    nodes.push({ id: "clap", features: ["derive", "env"], deps: [] });
    for (const name of ["query-engine", "schema-engine-cli", "prisma-fmt"])
      nodes
        .find((node) => node.id === name)
        .deps.push({ name: "clap", pkg: "clap" });
  }
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
  const vendor = path.join(source, "vendor", "mongodb");
  fs.mkdirSync(vendor, { recursive: true });
  fs.writeFileSync(path.join(vendor, "Cargo.toml"), "[package]\n");
  packages.push({
    id: "mongodb",
    name: "mongodb",
    version: policy.overrides[0].version,
    source: null,
    manifest_path: path.join(vendor, "Cargo.toml"),
  });
  nodes.push({
    id: "mongodb",
    features: [
      "zstd-compression",
      "zlib-compression",
      "snappy-compression",
      ...(contracts ? ["oja-security-contracts"] : []),
    ],
    deps: [{ name: "zstd", pkg: "zstd" }],
  });
  for (const [name, version] of Object.entries(
    policy.overrides[0].dependencies,
  )) {
    packages.push({
      id: name,
      name,
      version,
      source: "registry+https://github.com/rust-lang/crates.io-index",
    });
  }
  nodes.push({ id: "zstd", deps: [{ name: "zstd_safe", pkg: "zstd-safe" }] });
  for (const entry of policy.mysqlSources) {
    const directory = path.join(source, "vendor", entry.name);
    fs.mkdirSync(directory);
    const manifest = path.join(directory, "Cargo.toml");
    fs.writeFileSync(manifest, "[package]\n");
    packages.push({
      id: entry.name,
      name: entry.name,
      version: entry.version,
      source: null,
      manifest_path: manifest,
    });
    nodes.push({
      id: entry.name,
      features:
        entry.name === "mysql_async"
          ? ["native-tls-tls", ...(contracts ? ["oja-security-contracts"] : [])]
          : [],
      deps: Object.keys(entry.dependencies).map((name) => ({
        name,
        pkg: name,
      })),
    });
    for (const [name, version] of Object.entries(entry.dependencies)) {
      if (name === "mysql_common" || packages.some((pkg) => pkg.name === name))
        continue;
      packages.push({
        id: name,
        name,
        version,
        source: "registry+https://github.com/rust-lang/crates.io-index",
      });
    }
  }
  for (const pkg of policy.cuidSource.packages) {
    const directory = path.join(source, "vendor/cuid/crates", pkg.name);
    fs.mkdirSync(directory, { recursive: true });
    const manifest = path.join(directory, "Cargo.toml");
    fs.writeFileSync(manifest, "[package]\n");
    packages.push({
      id: pkg.name,
      name: pkg.name,
      version: pkg.version,
      source: null,
      manifest_path: manifest,
    });
    const names =
      pkg.name === "cuid"
        ? ["cuid1", "cuid2"]
        : pkg.name === "cuid-util"
          ? []
          : ["cuid-util"];
    nodes.push({
      id: pkg.name,
      deps: names.map((name) => ({
        name: name.replaceAll("-", "_"),
        pkg: name,
      })),
    });
  }
  for (const name of contracts
    ? ["oja-prisma-source-contracts"]
    : ["query-core", "query-structure"])
    nodes
      .find((node) => node.id === name)
      .deps.push({ name: "cuid", pkg: "cuid" });
  return { source, metadata: { packages, resolve: { nodes } } };
};

test("metadata checks actual query-core and migration checksum dependency resolution", (t) => {
  const { source, metadata } = metadataFixture(t, false);
  assert.equal(checkPrismaMetadata(metadata, source, policy), true);
  metadata.packages.find((pkg) => pkg.name === "lru").version = "0.8.1";
  assert.throws(
    () => checkPrismaMetadata(metadata, source, policy),
    /prisma_(dependency|mysql)_resolution_invalid/,
  );
});

test("compression metadata rejects unused overrides, old libraries, detached paths and production test hooks", (t) => {
  for (const change of [
    (m) => {
      m.packages.find((p) => p.name === "mongodb").source =
        "registry+https://github.com/rust-lang/crates.io-index";
    },
    (m) => {
      m.packages.find((p) => p.name === "mongodb").version = "3.9.1";
    },
    (m) => {
      m.packages.find((p) => p.name === "mongodb").manifest_path =
        m.packages[0].manifest_path;
    },
    (m) => {
      m.resolve.nodes
        .find((n) => n.id === "mongodb")
        .features.push("oja-security-contracts");
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "mongodb").features = [
        "zstd-compression",
      ];
    },
    (m) => {
      m.packages.find((p) => p.name === "zstd-safe").version = "7.3.0";
    },
    (m) => {
      m.packages.find((p) => p.name === "zstd").version = "0.13.3";
    },
    (m) => {
      m.packages.push({
        id: "old-zstd",
        name: "zstd",
        version: "0.13.3",
        source: "registry+https://github.com/rust-lang/crates.io-index",
      });
    },
  ]) {
    const { source, metadata } = metadataFixture(t, false);
    change(metadata);
    assert.throws(
      () => checkPrismaMetadata(metadata, source, policy),
      /prisma_(override_unbound|compression_resolution_invalid)/,
    );
  }
});

test("contracts must compile the actual MongoDB library with its explicit test feature", (t) => {
  const { source, metadata } = metadataFixture(t, true);
  assert.equal(
    checkPrismaMetadata(metadata, source, policy, { contracts: true }),
    true,
  );
  metadata.resolve.nodes.find((n) => n.id === "mongodb").features.pop();
  assert.throws(
    () => checkPrismaMetadata(metadata, source, policy, { contracts: true }),
    /prisma_override_unbound/,
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

test("upstream units cover every logical SQL dialect without changing the engine lock or enabling a database", () => {
  const args = prismaUnitArguments();
  assert.ok(args.includes("--locked"));
  assert.ok(args.includes("--lib"));
  const features = args[args.indexOf("--features") + 1].split(",");
  for (const dialect of [
    "postgresql",
    "mysql",
    "mssql",
    "sqlite",
    "cockroachdb",
  ])
    assert.ok(features.includes(`schema-connector/${dialect}`));
  assert.ok(features.includes("query-core/metrics"));
  assert.equal(
    features.some((feature) => feature.includes("native")),
    false,
  );
});

test("CLI metadata binds every real consumer and rejects legacy or detached parser dependencies", (t) => {
  for (const change of [
    (m) => {
      m.packages.find((p) => p.name === "clap").version = "3.2.25";
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "clap").features = ["derive"];
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "schema-engine-cli").deps = [];
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "query-engine").deps[0].pkg = "lru";
    },
    (m) => {
      m.packages.push({
        id: "old",
        name: "structopt",
        version: "0.3.26",
        source: "registry+https://github.com/rust-lang/crates.io-index",
      });
    },
    (m) => {
      m.packages.find((p) => p.name === "prisma-fmt").manifest_path =
        m.packages[0].manifest_path;
    },
  ]) {
    const { source, metadata } = metadataFixture(t, false);
    change(metadata);
    assert.throws(
      () => checkPrismaMetadata(metadata, source, policy),
      /prisma_cli_(resolution_invalid|legacy_resolution)/,
    );
  }
});

test("CLI contracts compile the actual three entry points without selecting database tests", () => {
  const commands = prismaCliArguments();
  assert.deepEqual(
    commands.map((c) => c.minimum),
    [9, 9, 5, 5],
  );
  assert.deepEqual(
    commands.map((c) => c.label),
    ["cli-query", "cli-schema", "cli-fmt", "cli-mssql-numeric"],
  );
  for (const { args } of commands) {
    assert.equal(args[0], "test");
    assert.ok(args.includes("--locked"));
    assert.equal(args.at(-1), "oja_cli_contracts");
    assert.ok(!args.includes("--ignored") && !args.includes("--all-targets"));
  }
  assert.ok(commands[0].args.includes("--lib"));
  for (const { args } of commands.slice(0, 3))
    assert.ok(args.includes("--bin"));
  assert.ok(commands[3].args.includes("mssql-native"));
  const patch = prismaSourceInput(ROOT, policy.patch).toString("utf8");
  assert.ok(patch.includes("SchemaEngineCli::parse()"));
  assert.ok(patch.includes("PrismaOpt::parse()"));
  assert.ok(patch.includes("FmtOpts::parse()"));
  assert.ok(patch.includes("OJA_QUERY_ENV_OK"));
  assert.ok(patch.includes("value_parser = parse_datasource_urls"));
});

test("clean contract registry scans never approve a path-converted Git source or erase findings", () => {
  const engine = {
    packageCount: 640,
    findings: Array(34).fill({}),
    unresolved: Array(8).fill({}),
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
  assert.equal(receipt.unreviewedPatchedGitSources, 5);
  assert.equal(receipt.contractUnreviewedGitSources, 5);
  assert.equal(receipt.contractSourceReviewed, false);
  assert.equal(receipt.engineSourceAuditOk, false);
  assert.equal(receipt.contractSourceAuditOk, false);
  assert.equal(receipt.contractRegistryAuditOk, true);
  engine.sourceAuditOk = true;
  engine.unresolved = [];
  engine.findings = [];
  assert.equal(
    prismaSourceReceipt(policy, engine, contracts).engineSourceAuditOk,
    false,
  );
  assert.equal(
    prismaSourceReceipt(policy, engine, contracts).unreviewedGitSources,
    5,
  );
  assert.equal(
    prismaSourceReceipt(policy, engine, contracts).productionApproved,
    false,
  );
});

test("contract assessments retain unresolved Git provenance even when its Cargo entry becomes a local path", () => {
  const original = { sourceAuditOk: true, findings: [], unresolved: [] };
  const report = prismaContractAssessment(policy, original);
  assert.equal(original.unresolved.length, 0);
  assert.equal(report.registryAuditOk, true);
  assert.equal(report.sourceAuditOk, false);
  assert.equal(report.unresolved.length, 5);
  assert.equal(
    report.unresolved[0].reason,
    "git_derived_override_requires_review",
  );
  assert.equal(
    report.unresolved[0].commit,
    policy.mysqlSources[0].gitSource.commit,
  );
  assert.equal(
    report.unresolved[0].archiveSha256,
    policy.mysqlSources[0].sha256,
  );
  assert.deepEqual(report.findings, []);
  assert.deepEqual(
    report.unresolved.slice(1).map((entry) => entry.name),
    ["cuid", "cuid-util", "cuid1", "cuid2"],
  );
  for (const entry of report.unresolved.slice(1)) {
    assert.equal(entry.commit, policy.cuidSource.commit);
    assert.equal(entry.archiveSha256, policy.cuidSource.sha256);
  }
});

test("CUID policy binds all four original Git packages without granting source review", () => {
  for (const change of [
    (p) => {
      delete p.cuidSource;
    },
    (p) => {
      p.cuidSource.reviewStatus = "REVIEWED";
    },
    (p) => {
      p.cuidSource.commit = "0".repeat(40);
    },
    (p) => {
      p.cuidSource.repository = "unreviewed/cuid-rust";
    },
    (p) => {
      p.cuidSource.packages.pop();
    },
    (p) => {
      p.cuidSource.packages[0].version = "1.3.3";
    },
    (p) => {
      p.cuidSource.patch.path = "../cuid.patch";
    },
    (p) => {
      p.cuidSource.sourceFiles[0].path = "../Cargo.toml";
    },
    (p) => {
      p.cuidSource.sourceFiles.pop();
    },
  ]) {
    const changed = structuredClone(policy);
    change(changed);
    assert.throws(
      () => validatePrismaCuidSource(changed.cuidSource),
      /prisma_cuid_policy_invalid/,
    );
  }
});

test("CUID metadata rejects unused, mismatched, detached and obsolete dependency graphs", (t) => {
  for (const contracts of [false, true]) {
    for (const change of [
      (m) => {
        m.packages.find((p) => p.name === "cuid").source =
          "registry+https://github.com/rust-lang/crates.io-index";
      },
      (m) => {
        m.packages.find((p) => p.name === "cuid1").version = "0.1.0";
      },
      (m) => {
        m.packages.find((p) => p.name === "cuid2").manifest_path =
          m.packages[0].manifest_path;
      },
      (m) => {
        m.resolve.nodes.find((n) => n.id === "cuid").deps.pop();
      },
      (m) => {
        m.resolve.nodes.find((n) => n.id === "cuid1").deps[0].pkg = "cuid2";
      },
      (m) => {
        m.resolve.nodes
          .find(
            (n) =>
              n.id ===
              (contracts ? "oja-prisma-source-contracts" : "query-structure"),
          )
          .deps.find((d) => d.name === "cuid").pkg = "cuid1";
      },
      (m) => {
        m.packages.push({
          id: "old-failure",
          name: "failure",
          version: "0.1.8",
          source: "registry+https://github.com/rust-lang/crates.io-index",
        });
      },
      (m) => {
        m.packages.push({
          id: "old-base36",
          name: "base36",
          version: "0.0.1",
          source: "registry+https://github.com/rust-lang/crates.io-index",
        });
      },
    ]) {
      const { source, metadata } = metadataFixture(t, contracts);
      change(metadata);
      assert.throws(
        () => checkPrismaMetadata(metadata, source, policy, { contracts }),
        /prisma_(cuid_(override_unbound|resolution_invalid|obsolete_dependency)|contract_root_invalid)/,
      );
    }
  }
});

test("CUID manifest wiring preserves the pinned WASM entropy backend and refuses unused overrides", (t) => {
  const source = fixture(t);
  const write = (file, value) => {
    const target = path.join(source, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  };
  const root =
    '[workspace]\nexclude=["vendor/cuid"]\n[workspace.dependencies]\ncuid={path="vendor/cuid/crates/cuid",version="=1.3.3+oja.1"}\n';
  write("Cargo.toml", root);
  write(
    "security-contracts/Cargo.toml",
    '[dependencies]\ncuid={path="../vendor/cuid/crates/cuid",version="=1.3.3+oja.1"}\ncuid-util={path="../vendor/cuid/crates/cuid-util",version="=0.1.1+oja.1"}\n',
  );
  write(
    "vendor/cuid/Cargo.toml",
    "[workspace.dependencies]\n" +
      policy.cuidSource.packages
        .filter((p) => p.name !== "cuid")
        .map(
          (p) =>
            `${p.name}={path="./crates/${p.name}",version="=${p.version}"}\n`,
        )
        .join(""),
  );
  let original;
  for (const pkg of policy.cuidSource.packages) {
    const value =
      `[package]\nname="${pkg.name}"\nversion="${pkg.version}"\n[dependencies]\n` +
      (pkg.name === "cuid-util"
        ? ""
        : '[target.\'cfg(target_arch = "wasm32")\'.dependencies]\ngetrandom={version="=0.2.17",features=["js"]}\n');
    write(`vendor/cuid/crates/${pkg.name}/Cargo.toml`, value);
    if (pkg.name === "cuid1") original = value;
  }
  assert.equal(
    checkPrismaCuidWiring(source, policy.cuidSource, () => {}),
    true,
  );
  for (const value of [
    original.replace('version="=0.2.17"', 'version="0"'),
    original.replace('features=["js"]', "features=[]"),
    original.replace("[dependencies]", '[dependencies]\nbase36="0.0.1"'),
  ]) {
    write("vendor/cuid/crates/cuid1/Cargo.toml", value);
    assert.throws(
      () => checkPrismaCuidWiring(source, policy.cuidSource, () => {}),
      /prisma_cuid_wiring_invalid/,
    );
  }
  write("vendor/cuid/crates/cuid1/Cargo.toml", original);
  write(
    "Cargo.toml",
    root.replace('path="vendor/cuid/crates/cuid"', 'path="unused/cuid"'),
  );
  assert.throws(
    () => checkPrismaCuidWiring(source, policy.cuidSource, () => {}),
    /prisma_cuid_wiring_invalid/,
  );
});

test("MySQL source policy never marks the original Git revision reviewed by changing its location", () => {
  for (const change of [
    (p) => {
      p.mysqlSources.pop();
    },
    (p) => {
      p.mysqlSources[0].gitSource.reviewStatus = "REVIEWED";
    },
    (p) => {
      p.mysqlSources[0].gitSource.commit = "0".repeat(40);
    },
    (p) => {
      p.mysqlSources[0].dependencies.lru = "0.8.1";
    },
    (p) => {
      p.mysqlSources[1].dependencies.lexical = "6.1.1";
    },
    (p) => {
      p.mysqlSources[1].dependencies.bindgen = "0.59.2";
    },
    (p) => {
      p.mysqlSources[0].patch.path = "../outside.patch";
    },
    (p) => {
      p.mysqlSources[1].sourceFiles[0].path = "../Cargo.toml";
    },
    (p) => {
      p.mysqlSources[0].sourceFiles.pop();
    },
  ]) {
    const changed = structuredClone(policy);
    change(changed);
    assert.throws(
      () => validatePrismaSourcePolicy(changed),
      /prisma_mysql_policy_invalid/,
    );
  }
});

test("MySQL metadata refuses old dependencies, unused source overrides and unsafe test feature selection", (t) => {
  for (const change of [
    (m) => {
      m.packages.find((p) => p.name === "mysql_async").source =
        "registry+https://github.com/rust-lang/crates.io-index";
    },
    (m) => {
      m.packages.find((p) => p.name === "mysql_async").version = "0.31.3";
    },
    (m) => {
      m.packages.find((p) => p.name === "mysql_common").manifest_path =
        m.packages[0].manifest_path;
    },
    (m) => {
      m.packages.find((p) => p.name === "lexical").version = "6.1.1";
    },
    (m) => {
      m.packages.find((p) => p.name === "sha1").version = "0.10.7";
    },
    (m) => {
      m.packages.find((p) => p.name === "bindgen").version = "0.59.2";
    },
    (m) => {
      m.resolve.nodes
        .find((n) => n.id === "mysql_async")
        .features.push("oja-security-contracts");
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "mysql_async").features = [];
    },
    (m) => {
      m.resolve.nodes
        .find((n) => n.id === "mysql_common")
        .features.push("test");
    },
    (m) => {
      m.packages.push({
        id: "old-lexical",
        name: "lexical",
        version: "6.1.1",
        source: "registry+https://github.com/rust-lang/crates.io-index",
      });
    },
  ]) {
    const { source, metadata } = metadataFixture(t, false);
    change(metadata);
    assert.throws(
      () => checkPrismaMetadata(metadata, source, policy),
      /prisma_mysql_(override_unbound|resolution_invalid)/,
    );
  }
  const { source, metadata } = metadataFixture(t, true);
  metadata.resolve.nodes.find((n) => n.id === "mysql_async").features.pop();
  assert.throws(
    () => checkPrismaMetadata(metadata, source, policy, { contracts: true }),
    /prisma_mysql_override_unbound/,
  );
});

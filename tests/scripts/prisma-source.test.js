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
  checkPrismaMetadata as checkMetadata,
  rustTestTotals,
  prismaUnitArguments,
  prismaParserTestTotals,
  checkPrismaMaintenanceMetadata,
  prismaPasteTestTotals,
  prismaPostgresTestTotals,
  prismaBenchmarkArguments,
  prismaBenchmarkTotals,
  prismaPasteConsumerArguments,
  prismaCliArguments,
  prismaHttpClientArguments,
  prismaHttpClientCheckArguments,
  prismaHttpServerArguments,
  prismaSourceReceipt,
  prismaContractAssessment,
} from "../../scripts/security/test-prisma-source.mjs";
import { rustRegistryPackages } from "../../scripts/security/rust-source-audit.mjs";
import {
  validatePrismaCuidSource,
  checkPrismaCuidWiring,
} from "../../scripts/security/prisma-cuid-source.mjs";
import {
  validatePrismaWinauthSource,
  checkPrismaWinauthWiring,
  checkPrismaWinauthMetadata,
} from "../../scripts/security/prisma-winauth-source.mjs";
import {
  validatePrismaPostgresSource,
  checkPrismaPostgresWiring,
  checkPrismaPostgresMetadata,
  assessPrismaPostgresIdentities,
} from "../../scripts/security/prisma-postgres-source.mjs";

const TIBERIUS =
  "git+https://github.com/prisma/tiberius?branch=main#35605c90adb38cc107d35c3432fd2643d9d6e1e6";
const checkPrismaMetadata = (metadata, source, recipe, options = {}) =>
  checkMetadata(metadata, source, recipe, {
    ...options,
    gitSources: [TIBERIUS, ...(options.gitSources || [])],
  });

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

test("winauth recipe rejects old random generators, source identity masking and unbound files", () => {
  assert.equal(
    validatePrismaWinauthSource(policy.winauthSource),
    policy.winauthSource,
  );
  for (const change of [
    (p) => {
      p.randVersion = "0.7.3";
    },
    (p) => {
      p.upstreamVersion = "0.0.6";
    },
    (p) => {
      p.version = "0.0.5+oja.1";
    },
    (p) => {
      p.sha256 = "0".repeat(64);
    },
    (p) => {
      p.patch.path = "../winauth.patch";
    },
    (p) => {
      p.sourceFiles.pop();
    },
    (p) => {
      p.sourceFiles[0].path = "../Cargo.toml";
    },
    (p) => {
      p.productionApproved = true;
    },
  ]) {
    const changed = structuredClone(policy.winauthSource);
    change(changed);
    assert.throws(
      () => validatePrismaWinauthSource(changed),
      /prisma_winauth_policy_invalid/,
    );
  }
});

test("winauth patch binds actual parser changes and offline contract entry points", () => {
  const patch = prismaSourceInput(ROOT, policy.winauthSource.patch).toString(
    "utf8",
  );
  assert.deepEqual(
    [...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map((m) => m[1]),
    [
      "Cargo.toml",
      "src/lib.rs",
      "src/oja_security_contracts.rs",
      "src/oja_parser_contracts.rs",
    ],
  );
  assert.ok(patch.includes('+version = "=0.8.8"'));
  assert.equal(patch.includes('+version = "0.7"'), false);
  assert.ok(
    patch.includes(
      "Builder-only: build() would acquire the current Windows account.",
    ),
  );
  for (const graph of [policy.lockfile, policy.contractLockfile]) {
    const resolved = rustRegistryPackages(
      prismaSourceInput(ROOT, graph).toString("utf8"),
    );
    assert.equal(
      resolved.packages.some(
        (p) => p.name === "rand" && p.version.startsWith("0.7."),
      ),
      false,
    );
    assert.equal(
      resolved.packages.some((p) => p.name === "winauth"),
      false,
    );
  }
});

test("parser follow-up retains the original SSPI and cryptographic source bindings", () => {
  const expected = {
    "src/windows.rs":
      "1978af92e9e92ae257d7fa5fc725630c2b27462edb53271427174a42c42dafbf",
    "src/md4.rs":
      "82d883e09865cc2ca456cce2eedd6f4e5330470d65df09635c08d58d7c3e1c84",
    "src/hmac.rs":
      "412511adb6158cbae2e14cb66cf730953ba11d3885d00b012a92c67b7994fb15",
    "src/rc4.rs":
      "29081c5fa027418cfb239f0070c9d050996cd755fd082d3b8da30e8e0e167f0a",
  };
  for (const [file, digest] of Object.entries(expected))
    assert.equal(
      policy.winauthSource.sourceFiles.find((item) => item.path === file)
        ?.sha256,
      digest,
    );
  assert.ok(
    policy.sourceFiles.some(
      (item) =>
        item.path === "security-contracts/src/winauth_parser_contracts.rs",
    ),
  );
  assert.ok(
    policy.winauthSource.sourceFiles.some(
      (item) => item.path === "src/oja_parser_contracts.rs",
    ),
  );
});

test("parser receipts require 24 distinct successful actual-library regressions", () => {
  const lines = Array.from(
    { length: 24 },
    (_, i) => `test winauth_parser_contracts::case_${i} ... ok`,
  );
  assert.deepEqual(prismaParserTestTotals(lines.join("\n")), {
    passed: 24,
    failed: 0,
    ignored: 0,
  });
  for (const output of [
    "",
    lines.slice(1).join("\n"),
    lines.concat(lines[0]).join("\n"),
    lines
      .map((line, i) => (i ? line : line.replace("ok", "ignored")))
      .join("\n"),
    lines
      .map((line, i) => (i ? line : line.replace("ok", "FAILED")))
      .join("\n"),
    lines
      .map((line) => line.replace("winauth_parser_contracts", "unrelated"))
      .join("\n"),
    Array(24).fill(lines[0]).join("\n"),
  ])
    assert.throws(
      () => prismaParserTestTotals(output),
      /prisma_parser_tests_incomplete/,
    );
});

test("Prisma recipe binds the source patch and both complete lock graphs", () => {
  assert.equal(validatePrismaSourcePolicy(policy), policy);
  for (const input of [
    policy.patch,
    policy.lockfile,
    policy.contractLockfile,
    ...policy.overrides.map((entry) => entry.patch),
    ...policy.mysqlSources.map((entry) => entry.patch),
    policy.cuidSource.patch,
    policy.winauthSource.patch,
    policy.postgresSource.patch,
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
  assert.equal(whole.unresolved.length, 4);
  assert.equal(
    whole.unresolved.length +
      policy.mysqlSources.filter((entry) => entry.gitSource).length +
      policy.cuidSource.packages.length +
      policy.postgresSource.packages.length,
    13,
  );
  assert.equal(contracts.packages.length, 368);
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
      p.httpClientVersion = "0.11.27";
    },
    (p) => {
      p.httpServerDependencies.h2 = "0.3.27";
    },
    (p) => {
      p.httpServerDependencies.hyper = "0.14.32";
    },
    (p) => {
      delete p.httpServerDependencies["hyper-util"];
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
        "black-box-tests",
        "query-tests-setup",
        "schema",
        "request-handlers",
        "quaint",
        "query-engine-tests",
        "sql-migration-tests",
      ];
  const packages = owners.map((name) => {
    const directory = path.join(
      source,
      contracts
        ? "security-contracts"
        : {
            "query-engine": "query-engine/query-engine",
            "schema-engine-cli": "schema-engine/cli",
            "black-box-tests": "query-engine/black-box-tests",
            schema: "query-engine/schema",
            "request-handlers": "query-engine/request-handlers",
            "query-engine-tests":
              "query-engine/connector-test-kit-rs/query-engine-tests",
            "sql-migration-tests": "schema-engine/sql-migration-tests",
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
  const registry = "registry+https://github.com/rust-lang/crates.io-index";
  packages.push({
    id: "pastey",
    name: "pastey",
    version: "0.2.3",
    source: registry,
  });
  nodes.push({ id: "pastey", features: [], deps: [] });
  for (const name of contracts
    ? ["oja-prisma-source-contracts"]
    : ["quaint", "query-engine-tests", "sql-migration-tests"])
    nodes
      .find((n) => n.id === name)
      .deps.push({ name: "paste", pkg: "pastey" });
  if (!contracts) {
    for (const name of [
      "codspeed",
      "codspeed-criterion-compat",
      "codspeed-criterion-compat-walltime",
    ])
      packages.push({ id: name, name, version: "6.0.0", source: registry });
    nodes.push({
      id: "codspeed-criterion-compat",
      features: ["plotters", "rayon", "cargo_bench_support"],
      deps: [
        { name: "codspeed", pkg: "codspeed" },
        { name: "criterion", pkg: "codspeed-criterion-compat-walltime" },
      ],
    });
    for (const [name, bench] of [
      ["schema", "schema_builder_bench"],
      ["request-handlers", "query_planning_bench"],
    ]) {
      packages.find((p) => p.name === name).targets = [
        { name: bench, kind: ["bench"] },
      ];
      nodes
        .find((n) => n.id === name)
        .deps.push({
          name: "codspeed_criterion_compat",
          pkg: "codspeed-criterion-compat",
        });
    }
  }
  if (!contracts) {
    packages.push({
      id: "tiberius",
      name: "tiberius",
      version: "0.13.0",
      source: TIBERIUS,
    });
    nodes.push({
      id: "tiberius",
      features: ["winauth", "native-tls", "bigdecimal", "tds73"],
      deps: [],
    });
  } else {
    const directory = path.join(source, "vendor/winauth");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "Cargo.toml"), "[package]\n");
    const registry = "registry+https://github.com/rust-lang/crates.io-index";
    packages.push(
      {
        id: "winauth",
        name: "winauth",
        version: policy.winauthSource.version,
        source: null,
        manifest_path: path.join(directory, "Cargo.toml"),
      },
      {
        id: "auth-rand",
        name: "rand",
        version: policy.winauthSource.randVersion,
        source: registry,
      },
    );
    nodes.push(
      {
        id: "winauth",
        features: ["oja-security-contracts"],
        deps: [{ name: "rand", pkg: "auth-rand" }],
      },
      { id: "auth-rand", features: ["std", "std_rng"], deps: [] },
    );
    nodes[0].deps.push({ name: "winauth", pkg: "winauth" });
  }
  if (!contracts) {
    const registry = "registry+https://github.com/rust-lang/crates.io-index";
    packages.push(
      {
        id: "reqwest",
        name: "reqwest",
        version: policy.httpClientVersion,
        source: registry,
      },
      { id: "h2-client", name: "h2", version: "0.4.20", source: registry },
    );
    nodes.push(
      {
        id: "reqwest",
        features: ["default-tls", "charset", "http2", "system-proxy"],
        deps: [{ name: "h2", pkg: "h2-client" }],
      },
      { id: "h2-client", features: [], deps: [] },
    );
    for (const name of ["query-engine", "black-box-tests"])
      nodes
        .find((n) => n.id === name)
        .deps.push({ name: "reqwest", pkg: "reqwest" });
    for (const [name, features] of [
      ["hyper", ["server", "client", "http1", "http2"]],
      ["hyper-util", ["server-auto", "tokio", "http1", "http2"]],
      ["http-body-util", []],
    ]) {
      packages.push({
        id: name,
        name,
        version: policy.httpServerDependencies[name],
        source: registry,
      });
      nodes.push({
        id: name,
        features,
        deps: name === "hyper" ? [{ name: "h2", pkg: "h2-client" }] : [],
      });
      nodes
        .find((n) => n.id === "query-engine")
        .deps.push({ name: name.replaceAll("-", "_"), pkg: name });
    }
    nodes
      .find((n) => n.id === "query-tests-setup")
      .deps.push({ name: "hyper", pkg: "hyper" });
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
  for (const item of policy.postgresSource.packages) {
    const directory = path.join(source, "vendor/postgres", item.name);
    fs.mkdirSync(directory, { recursive: true });
    const manifest = path.join(directory, "Cargo.toml");
    fs.writeFileSync(manifest, "[package]\n");
    packages.push({
      id: item.name,
      name: item.name,
      version: item.version,
      source: null,
      manifest_path: manifest,
    });
    const names =
      item.name === "postgres-native-tls"
        ? ["tokio-postgres"]
        : item.name === "postgres-types"
          ? ["postgres-protocol"]
          : item.name === "tokio-postgres"
            ? ["postgres-protocol", "postgres-types"]
            : [];
    nodes.push({
      id: item.name,
      features: [
        "runtime",
        ...(contracts &&
        ["tokio-postgres", "postgres-protocol"].includes(item.name)
          ? ["oja-security-contracts"]
          : []),
      ],
      deps: names.map((name) => ({
        name: name.replaceAll("-", "_"),
        pkg: name,
      })),
    });
  }
  const pgOwner = nodes.find(
    (node) =>
      node.id === (contracts ? "oja-prisma-source-contracts" : "quaint"),
  );
  for (const item of policy.postgresSource.packages.filter(
    (pkg) => contracts || pkg.name !== "postgres-protocol",
  ))
    pgOwner.deps.push({ name: item.name.replaceAll("-", "_"), pkg: item.name });
  return { source, metadata: { packages, resolve: { nodes } } };
};

const authFixture = (t, { contracts = true, windows = false } = {}) => {
  const { source, metadata } = metadataFixture(t, true);
  const registry = "registry+https://github.com/rust-lang/crates.io-index";
  if (!contracts) {
    metadata.resolve.nodes.find((n) => n.id === "winauth").features = [];
    metadata.packages.push({
      id: "tiberius",
      name: "tiberius",
      version: "0.13.0",
      source: TIBERIUS,
    });
    metadata.resolve.nodes.push({
      id: "tiberius",
      features: ["winauth", "native-tls", "tds73", "bigdecimal"],
      deps: [{ name: "winauth", pkg: "winauth" }],
    });
  }
  if (windows) {
    metadata.packages.push({
      id: "winapi",
      name: "winapi",
      version: "0.3.9",
      source: registry,
    });
    metadata.resolve.nodes.push({
      id: "winapi",
      features: ["winerror", "sspi"],
      deps: [],
    });
    metadata.resolve.nodes
      .find((n) => n.id === "winauth")
      .deps.push({ name: "winapi", pkg: "winapi" });
  }
  return {
    source,
    metadata,
    options: {
      contracts,
      target: windows ? "x86_64-pc-windows-msvc" : "x86_64-unknown-linux-gnu",
    },
  };
};

test("winauth resolution rejects detached overrides, old random generators and production test hooks", (t) => {
  for (const change of [
    (m) => {
      m.packages.find((p) => p.name === "winauth").version = "0.0.5";
    },
    (m) => {
      m.packages.find((p) => p.name === "winauth").source =
        "registry+https://github.com/rust-lang/crates.io-index";
    },
    (m) => {
      m.packages.find((p) => p.name === "winauth").manifest_path =
        m.packages[0].manifest_path;
    },
    (m) => {
      m.packages.find((p) => p.id === "auth-rand").version = "0.7.3";
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "winauth").deps = [];
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "auth-rand").features = ["std"];
    },
    (m) => {
      m.resolve.nodes[0].deps = [];
    },
    (m) => {
      m.packages.push({ id: "legacy-rand", name: "rand", version: "0.7.3" });
    },
  ]) {
    const { source, metadata, options } = authFixture(t);
    assert.equal(
      checkPrismaWinauthMetadata(
        metadata,
        source,
        policy.winauthSource,
        options,
      ),
      true,
    );
    change(metadata);
    assert.throws(
      () =>
        checkPrismaWinauthMetadata(
          metadata,
          source,
          policy.winauthSource,
          options,
        ),
      /prisma_winauth_/,
    );
  }
  const { source, metadata, options } = authFixture(t, {
    contracts: false,
    windows: true,
  });
  metadata.resolve.nodes
    .find((n) => n.id === "winauth")
    .features.push("oja-security-contracts");
  assert.throws(
    () =>
      checkPrismaWinauthMetadata(
        metadata,
        source,
        policy.winauthSource,
        options,
      ),
    /prisma_winauth_resolution_invalid/,
  );
});

test("Windows metadata requires the real Tiberius and SSPI feature chain", (t) => {
  for (const change of [
    (m) => {
      m.resolve.nodes.find((n) => n.id === "tiberius").deps = [];
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "tiberius").features = [
        "native-tls",
      ];
    },
    (m) => {
      m.packages.find((p) => p.name === "tiberius").source = TIBERIUS.replace(
        "35605c9",
        "0000000",
      );
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "winapi").features = ["winerror"];
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "winauth").deps.pop();
    },
  ]) {
    const { source, metadata, options } = authFixture(t, {
      contracts: false,
      windows: true,
    });
    assert.equal(
      checkPrismaWinauthMetadata(
        metadata,
        source,
        policy.winauthSource,
        options,
      ),
      true,
    );
    change(metadata);
    assert.throws(
      () =>
        checkPrismaWinauthMetadata(
          metadata,
          source,
          policy.winauthSource,
          options,
        ),
      /prisma_winauth_/,
    );
  }
});

test("winauth wiring binds the workspace, consumer features, license and offline test entry point", (t) => {
  const source = fixture(t);
  const files = {
    "Cargo.toml":
      '[workspace]\nexclude=["vendor/winauth"]\n[patch.crates-io]\nwinauth={path="vendor/winauth"}\n',
    "security-contracts/Cargo.toml":
      '[dependencies]\nwinauth={path="../vendor/winauth",features=["oja-security-contracts"]}\n',
    "security-contracts/src/lib.rs":
      "#[cfg(test)]\nmod winauth_contracts;\n#[cfg(test)]\nmod winauth_parser_contracts;\n",
    "quaint/Cargo.toml":
      '[target.a.dependencies]\ntiberius={features=["winauth","bigdecimal","tds73"]}\n[target.b.dependencies]\ntiberius={features=["winauth","bigdecimal","tds73"]}\n',
    "vendor/winauth/src/lib.rs":
      '#[cfg(feature = "oja-security-contracts")]\npub mod oja_security_contracts;\n#[cfg(feature = "oja-security-contracts")]\npub mod oja_parser_contracts;\n',
    "vendor/winauth/Cargo.toml":
      '[package]\nname="winauth"\nversion="0.0.5+oja.2"\nlicense="MIT/Apache-2.0"\n[dependencies.rand]\nversion="=0.8.8"\n[features]\noja-security-contracts=[]\n[target."cfg(windows)".dependencies.winapi]\nfeatures=["winerror","sspi"]\n',
  };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), content);
  }
  assert.equal(
    checkPrismaWinauthWiring(source, policy.winauthSource, () => {}),
    true,
  );
  for (const [file, content] of Object.entries(files)) {
    const changed = content
      .replace(/winauth/g, "detached")
      .replace("=0.8.8", "=0.7.3")
      .replace(/oja_security_contracts/g, "detached_contracts");
    fs.writeFileSync(path.join(source, file), changed);
    assert.throws(
      () => checkPrismaWinauthWiring(source, policy.winauthSource, () => {}),
      /prisma_winauth_wiring_invalid/,
    );
    fs.writeFileSync(path.join(source, file), content);
  }
});

test("maintenance policy binds exact maintained packages and all original consumers", () => {
  assert.equal(validatePrismaSourcePolicy(policy), policy);
  for (const change of [
    (p) => {
      delete p.maintenanceDependencies;
    },
    (p) => {
      p.maintenanceDependencies.pastey = "*";
    },
    (p) => {
      p.maintenanceDependencies["codspeed-criterion-compat"] = "1.1.0";
    },
    (p) => {
      p.maintenanceDependencies["codspeed-criterion-compat-walltime"] = "5.0.3";
    },
    (p) => {
      p.maintenanceDependencies.atty = "0.2.14";
    },
    (p) => {
      p.sourceFiles.pop();
    },
  ]) {
    const changed = structuredClone(policy);
    change(changed);
    assert.throws(
      () => validatePrismaSourcePolicy(changed),
      /prisma_source_policy_invalid/,
    );
  }
  for (const name of ["atty", "paste"]) {
    assert.equal(
      rustRegistryPackages(
        prismaSourceInput(ROOT, policy.lockfile).toString(),
      ).packages.some((p) => p.name === name),
      false,
    );
  }
  const enginePatch = prismaSourceInput(ROOT, policy.patch).toString();
  assert.ok(
    enginePatch.includes('+paste = { package = "pastey", version = "=0.2.3" }'),
  );
  assert.ok(enginePatch.includes('+codspeed-criterion-compat = "=6.0.0"'));
  for (const file of [
    "quaint/src/macros.rs",
    "query-engine/schema/benches/schema_builder_bench.rs",
    "query-engine/request-handlers/benches/query_planning_bench.rs",
  ])
    assert.ok(policy.sourceFiles.some((entry) => entry.path === file));
});

test("maintenance metadata rejects removed consumers, old resolutions and feature stripping", (t) => {
  for (const change of [
    (m) => {
      m.packages.find((p) => p.name === "pastey").name = "paste";
    },
    (m) => {
      m.packages.find((p) => p.name === "pastey").version = "0.1.0";
    },
    (m) => {
      m.packages.find((p) => p.name === "pastey").source = null;
    },
    (m) => {
      m.packages.push({ id: "atty", name: "atty", version: "0.2.14" });
    },
    (m) => {
      m.packages.push({ id: "criterion", name: "criterion", version: "0.4.0" });
    },
    (m) => {
      m.resolve.nodes
        .find((n) => n.id === "codspeed-criterion-compat")
        .features.pop();
    },
    (m) => {
      m.resolve.nodes
        .find((n) => n.id === "codspeed-criterion-compat")
        .deps.pop();
    },
    (m) => {
      m.packages.find((p) => p.name === "codspeed").version = "1.1.0";
    },
    ...[
      "quaint",
      "query-engine-tests",
      "sql-migration-tests",
      "schema",
      "request-handlers",
    ].map((name) => (m) => {
      m.resolve.nodes.find((n) => n.id === name).deps = [];
    }),
    (m) => {
      m.packages.find((p) => p.name === "schema").targets = [];
    },
  ]) {
    const { metadata } = metadataFixture(t, false);
    assert.equal(checkPrismaMaintenanceMetadata(metadata, policy), true);
    change(metadata);
    assert.throws(
      () => checkPrismaMaintenanceMetadata(metadata, policy),
      /prisma_maintenance_resolution_invalid/,
    );
  }
});

test("paste contracts bind the registry implementation under the existing import alias", (t) => {
  for (const contracts of [false, true]) {
    const { metadata } = metadataFixture(t, contracts);
    assert.equal(
      checkPrismaMaintenanceMetadata(metadata, policy, { contracts }),
      true,
    );
    const consumer = contracts
      ? "oja-prisma-source-contracts"
      : "query-engine-tests";
    metadata.resolve.nodes
      .find((n) => n.id === consumer)
      .deps.find((d) => d.name === "paste").name = "pastey";
    assert.throws(
      () => checkPrismaMaintenanceMetadata(metadata, policy, { contracts }),
      /prisma_maintenance_resolution_invalid/,
    );
  }
});

test("paste receipts require eight distinct successful macro regressions", () => {
  const lines = Array.from(
    { length: 8 },
    (_, i) => `test paste_contracts::case_${i} ... ok`,
  );
  assert.deepEqual(prismaPasteTestTotals(lines.join("\n")), {
    passed: 8,
    failed: 0,
    ignored: 0,
  });
  for (const invalid of [
    lines.slice(1),
    [...lines.slice(1), lines[1]],
    [...lines.slice(1), lines[0].replace("ok", "ignored")],
    [...lines, lines[0]],
    ["test unrelated::case ... ok"],
  ])
    assert.throws(
      () => prismaPasteTestTotals(invalid.join("\n")),
      /prisma_paste_tests_incomplete/,
    );
});

test("benchmark smoke receipts require every original case and reject duplicates or missing successes", () => {
  const commands = prismaBenchmarkArguments();
  assert.equal(commands.length, 2);
  assert.ok(
    commands
      .find((command) => command.label === "benchmark-request-handlers")
      .args.includes("request-handlers/all"),
  );
  for (const command of commands) {
    assert.ok(command.args.includes("--locked"));
    assert.deepEqual(command.args.slice(-2), ["--", "--test"]);
    const output = command.cases
      .map((name) => `Testing ${name}\nSuccess\n`)
      .join("\n");
    assert.equal(
      prismaBenchmarkTotals(output, command.cases).passed,
      command.cases.length,
    );
    assert.equal(
      prismaBenchmarkTotals(output.replaceAll("\n", "\r\n"), command.cases)
        .passed,
      command.cases.length,
    );
    for (const invalid of [
      "",
      output.replace("Success", "Failed"),
      output + output,
      output.replace(command.cases[0], command.cases[1]),
    ])
      assert.throws(
        () => prismaBenchmarkTotals(invalid, command.cases),
        /prisma_benchmark_tests_incomplete/,
      );
  }
});

test("macro consumer compilation checks all original tests and native dialects without executing database tests", () => {
  const args = prismaPasteConsumerArguments();
  assert.equal(args[0], "check");
  assert.ok(args.includes("--locked"));
  assert.ok(args.includes("--tests"));
  for (const name of [
    "quaint",
    "query-engine-tests",
    "sql-migration-tests",
    "quaint/all-native",
  ])
    assert.ok(args.includes(name));
  assert.equal(args.includes("--no-default-features"), false);
});

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
      m.resolve.nodes
        .find((n) => n.id === "query-engine")
        .deps.find((d) => d.name === "clap").pkg = "lru";
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

test("HTTP client metadata rejects old, detached or feature-reduced dependencies", (t) => {
  for (const change of [
    (m) => {
      m.packages.find((p) => p.name === "reqwest").version = "0.11.27";
    },
    (m) => {
      m.packages.push({
        id: "pem",
        name: "rustls-pemfile",
        version: "1.0.4",
        source: "registry+https://github.com/rust-lang/crates.io-index",
      });
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "black-box-tests").deps = [];
    },
    (m) => {
      m.resolve.nodes
        .find((n) => n.id === "query-engine")
        .deps.find((d) => d.name === "reqwest").pkg = "lru";
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "reqwest").features = [
        "http2",
        "charset",
        "system-proxy",
      ];
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "reqwest").features = [
        "default-tls",
        "charset",
        "system-proxy",
      ];
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "reqwest").features = [
        "default-tls",
        "http2",
        "system-proxy",
      ];
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "reqwest").features = [
        "default-tls",
        "http2",
        "charset",
      ];
    },
    (m) => {
      m.packages.find((p) => p.id === "h2-client").version = "0.4.15";
    },
  ]) {
    const { source, metadata } = metadataFixture(t, false);
    change(metadata);
    assert.throws(
      () => checkPrismaMetadata(metadata, source, policy),
      /prisma_http_client_(resolution_invalid|legacy_resolution)/,
    );
  }
});

test("HTTP contracts select only loopback tests and reject legacy server packages", () => {
  assert.deepEqual(prismaHttpClientCheckArguments(), [
    "check",
    "--locked",
    "--package",
    "black-box-tests",
    "--tests",
  ]);
  assert.deepEqual(prismaHttpClientArguments(), [
    "test",
    "--locked",
    "--package",
    "query-engine",
    "--lib",
    "oja_http_client_contracts",
  ]);
  const graph = rustRegistryPackages(
    prismaSourceInput(ROOT, policy.lockfile).toString("utf8"),
  );
  assert.deepEqual(
    graph.packages.filter((p) => p.name === "reqwest").map((p) => p.version),
    [policy.httpClientVersion],
  );
  assert.equal(
    graph.packages.some((p) => p.name === "rustls-pemfile"),
    false,
  );
  assert.equal(
    graph.packages.some((p) => p.name === "h2" && p.version === "0.3.27"),
    false,
  );
  assert.ok(
    graph.packages.some((p) => p.name === "h2" && p.version === "0.4.20"),
  );
  for (const [name, version] of Object.entries(policy.httpServerDependencies)) {
    assert.deepEqual(
      graph.packages.filter((p) => p.name === name).map((p) => p.version),
      [version],
    );
  }
  assert.deepEqual(prismaHttpServerArguments(), [
    "test",
    "--locked",
    "--package",
    "query-engine",
    "--lib",
    "oja_http_server_contracts",
  ]);
});

test("HTTP server metadata rejects legacy graphs, detached adapters and disabled protocols", (t) => {
  for (const change of [
    (m) => {
      m.packages.find((p) => p.name === "hyper").version = "0.14.32";
    },
    (m) => {
      m.packages.push({
        id: "old-h2",
        name: "h2",
        version: "0.3.27",
        source: "registry+https://github.com/rust-lang/crates.io-index",
      });
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "hyper").features = [
        "server",
        "http1",
      ];
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "hyper-util").features = [
        "tokio",
        "http1",
        "http2",
      ];
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "query-tests-setup").deps = [];
    },
    (m) => {
      m.resolve.nodes
        .find((n) => n.id === "query-engine")
        .deps.find((d) => d.name === "hyper_util").pkg = "hyper";
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "hyper").deps = [];
    },
  ]) {
    const { source, metadata } = metadataFixture(t, false);
    change(metadata);
    assert.throws(
      () => checkPrismaMetadata(metadata, source, policy),
      /prisma_http_server_(resolution_invalid|legacy_resolution)/,
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
    unresolved: Array(4).fill({}),
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
  assert.equal(receipt.unreviewedPatchedGitSources, 9);
  assert.equal(receipt.contractUnreviewedGitSources, 9);
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
    9,
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
  assert.equal(report.unresolved.length, 9);
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
    report.unresolved.slice(1, 5).map((entry) => entry.name),
    ["cuid", "cuid-util", "cuid1", "cuid2"],
  );
  for (const entry of report.unresolved.slice(1, 5)) {
    assert.equal(entry.commit, policy.cuidSource.commit);
    assert.equal(entry.archiveSha256, policy.cuidSource.sha256);
  }
  assert.deepEqual(
    report.unresolved.slice(5).map((entry) => entry.name),
    policy.postgresSource.packages.map((pkg) => pkg.name),
  );
  for (const entry of report.unresolved.slice(5)) {
    assert.equal(entry.commit, policy.postgresSource.commit);
    assert.equal(entry.archiveSha256, policy.postgresSource.sha256);
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

test("PostgreSQL recipe pins the original fork, official fixes and every relevant source file", () => {
  assert.equal(
    validatePrismaPostgresSource(policy.postgresSource),
    policy.postgresSource,
  );
  for (const change of [
    (p) => {
      p.commit = "0".repeat(40);
    },
    (p) => {
      p.repository = "other/fork";
    },
    (p) => {
      p.sha256 = "0".repeat(64);
    },
    (p) => {
      p.reviewStatus = "REVIEWED";
    },
    (p) => {
      p.patch.path = "../postgres.patch";
    },
    (p) => {
      p.packages.pop();
    },
    (p) => {
      p.packages[0].upstreamVersion = "0.6.9";
    },
    (p) => {
      p.packages[0].version = "0.6.8";
    },
    (p) => {
      delete p.fixes["RUSTSEC-2026-0179"];
    },
    (p) => {
      p.sourceFiles.pop();
    },
    (p) => {
      p.sourceFiles[0].path = "../Cargo.toml";
    },
    (p) => {
      p.productionApproved = true;
    },
  ]) {
    const changed = structuredClone(policy.postgresSource);
    change(changed);
    assert.throws(
      () => validatePrismaPostgresSource(changed),
      /prisma_postgres_policy_invalid/,
    );
  }
  const patch = prismaSourceInput(ROOT, policy.postgresSource.patch).toString();
  for (const required of [
    "MAX_ITERATION_COUNT",
    "split_at_checked(key_len",
    "split_at_checked(value_len",
    "row.ranges.len() != row.statement.columns().len()",
    "row.ranges.len() != row.columns.len()",
    "count as usize > buf.len() / 8",
    "oja-security-contracts",
  ])
    assert.ok(patch.includes(required));
  const enginePatch = prismaSourceInput(ROOT, policy.patch).toString();
  assert.equal(
    [
      ...enginePatch.matchAll(
        /^\+fn (?:scram|hstore|row|simple_row|pgbouncer)_\S+\(/gm,
      ),
    ].length,
    24,
  );
});

test("PostgreSQL metadata rejects detached forks, lost ownership, missing runtime and production diagnostics", (t) => {
  for (const contracts of [false, true])
    for (const change of [
      (m) => {
        m.packages.find((p) => p.name === "postgres-protocol").version =
          "0.6.8";
      },
      (m) => {
        m.packages.find((p) => p.name === "postgres-types").source =
          "registry+https://github.com/rust-lang/crates.io-index";
      },
      (m) => {
        m.packages.find((p) => p.name === "tokio-postgres").manifest_path =
          m.packages[0].manifest_path;
      },
      (m) => {
        m.resolve.nodes.find((n) => n.id === "postgres-native-tls").deps = [];
      },
      (m) => {
        m.resolve.nodes.find((n) => n.id === "postgres-types").deps = [];
      },
      (m) => {
        m.resolve.nodes.find((n) => n.id === "tokio-postgres").features = [
          "oja-security-contracts",
        ];
      },
      (m) => {
        m.resolve.nodes.find((n) => n.id === "postgres-protocol").features =
          contracts ? [] : ["oja-security-contracts"];
      },
      (m) => {
        m.resolve.nodes
          .find(
            (n) =>
              n.id === (contracts ? "oja-prisma-source-contracts" : "quaint"),
          )
          .deps.find((d) => d.name === "tokio_postgres").pkg = "postgres-types";
      },
      (m) => {
        m.packages.push({
          ...m.packages.find((p) => p.name === "postgres-protocol"),
          id: "duplicate",
        });
      },
    ]) {
      const { source, metadata } = metadataFixture(t, contracts);
      assert.equal(
        checkPrismaPostgresMetadata(metadata, source, policy.postgresSource, {
          contracts,
        }),
        true,
      );
      change(metadata);
      assert.throws(
        () =>
          checkPrismaPostgresMetadata(metadata, source, policy.postgresSource, {
            contracts,
          }),
        /prisma_postgres_/,
      );
    }
});

test("PostgreSQL wiring validates internal edges, diagnostic isolation and materialized licenses", (t) => {
  const source = fixture(t);
  const write = (file, bytes) => {
    const target = path.join(source, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  };
  const pkgs = policy.postgresSource.packages;
  const dependency = (pkg, base, hook = false) =>
    `${pkg.name}={path="${base}/${pkg.name}",version="=${pkg.version}"${hook ? ',features=["oja-security-contracts"]' : ""}}\n`;
  const root =
    '[workspace]\nexclude=["vendor/postgres"]\n[workspace.dependencies]\n' +
    pkgs
      .filter((p) => p.name !== "postgres-protocol")
      .map((p) => dependency(p, "vendor/postgres"))
      .join("");
  const contract =
    "[dependencies]\n" +
    pkgs
      .map((p) =>
        dependency(
          p,
          "../vendor/postgres",
          ["postgres-protocol", "tokio-postgres"].includes(p.name),
        ),
      )
      .join("");
  write("Cargo.toml", root);
  write("security-contracts/Cargo.toml", contract);
  for (const name of ["LICENSE-APACHE", "LICENSE-MIT"])
    write(`vendor/postgres/${name}`, name);
  for (const pkg of [
    "postgres-derive",
    "postgres-native-tls",
    "postgres-openssl",
    "postgres-protocol",
    "postgres-types",
    "postgres",
    "tokio-postgres",
  ])
    for (const name of ["LICENSE-APACHE", "LICENSE-MIT"])
      write(`vendor/postgres/${pkg}/${name}`, name);
  for (const pkg of pkgs) {
    const names =
      pkg.name === "postgres-native-tls"
        ? ["tokio-postgres"]
        : pkg.name === "postgres-types"
          ? ["postgres-protocol"]
          : pkg.name === "tokio-postgres"
            ? ["postgres-protocol", "postgres-types"]
            : [];
    write(
      `vendor/postgres/${pkg.name}/Cargo.toml`,
      `[package]\nname="${pkg.name}"\nversion="${pkg.version}"\n[features]\ndefault=[]\noja-security-contracts=[]\n[dependencies]\n` +
        names
          .map((name) =>
            dependency(
              pkgs.find((p) => p.name === name),
              "..",
            ),
          )
          .join(""),
    );
  }
  const verify = () =>
    checkPrismaPostgresWiring(source, policy.postgresSource, () => {});
  assert.equal(verify(), true);
  for (const modified of [
    root.replace('"vendor/postgres"', '"vendor/other"'),
    root.replace("=0.5.1+oja.1", "=0.5.1"),
    root.replace(
      'version="=0.5.1+oja.1"',
      'version="=0.5.1+oja.1",features=["oja-security-contracts"]',
    ),
  ]) {
    write("Cargo.toml", modified);
    assert.throws(verify, /prisma_postgres_wiring_invalid/);
  }
  write("Cargo.toml", root);
  write(
    "security-contracts/Cargo.toml",
    contract.replace(',features=["oja-security-contracts"]', ""),
  );
  assert.throws(verify, /prisma_postgres_wiring_invalid/);
  write("security-contracts/Cargo.toml", contract);
  write("vendor/postgres/postgres-types/LICENSE-MIT", "modified");
  assert.throws(verify, /prisma_postgres_license_invalid/);
});

test("PostgreSQL receipts require all 24 distinct successful real-library regressions", () => {
  const lines = Array.from(
    { length: 24 },
    (_, i) => `test postgres_contracts::case_${i} ... ok`,
  );
  assert.deepEqual(prismaPostgresTestTotals(lines.join("\n")), {
    passed: 24,
    failed: 0,
    ignored: 0,
  });
  for (const output of [
    "",
    lines.slice(1).join("\n"),
    lines.concat(lines[0]).join("\n"),
    Array(24).fill(lines[0]).join("\n"),
    lines.join("\n").replace("ok", "ignored"),
    lines.join("\n").replace("ok", "FAILED"),
    lines.join("\n").replaceAll("postgres_contracts", "other"),
  ])
    assert.throws(
      () => prismaPostgresTestTotals(output),
      /prisma_postgres_tests_incomplete/,
    );
});

test("PostgreSQL original identity checks retain findings and never pretend Git was a registry source", async () => {
  const findings = {
    results: [
      {
        vulns: [{ id: "RUSTSEC-2026-0179", modified: "2026-08-25T00:00:00Z" }],
      },
      {},
      {},
      {},
    ],
  };
  let query;
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://api.osv.dev/v1/querybatch");
    query = JSON.parse(options.body);
    return new Response(JSON.stringify(findings));
  };
  const report = await assessPrismaPostgresIdentities(policy.postgresSource, {
    fetchImpl,
  });
  assert.equal(report.sourceAuditOk, false);
  assert.equal(report.productionApproved, false);
  assert.equal(report.sourceReviewed, false);
  assert.equal(report.packages[0].matches[0].advisory, "RUSTSEC-2026-0179");
  assert.equal(query.queries[0].version, "0.6.8");
  assert.equal(JSON.stringify(query).includes("checksum"), false);
  for (const result of [
    { results: [] },
    { results: [{ next_page_token: "more" }, {}, {}, {}] },
    { results: [{ vulns: [{ id: "bad", modified: "bad" }] }, {}, {}, {}] },
  ])
    await assert.rejects(
      () =>
        assessPrismaPostgresIdentities(policy.postgresSource, {
          fetchImpl: async () => new Response(JSON.stringify(result)),
        }),
      /prisma_postgres_advisory_/,
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

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import test from "node:test";
import yaml from "js-yaml";
import {
  prismaNativeOptions,
  prismaNativeBuildArguments,
  prismaNativeReleaseProfile,
  assertPrismaNativeRegistryAssessment,
  selectPrismaNativeArtifacts,
  prismaNativeFixture,
  verifyPrismaNativeProbeReport,
} from "../../scripts/security/prisma-native-probe.mjs";
import {
  prismaTlsLabOptions,
  preparePrismaTlsLab,
  readPrismaTlsLab,
  PRISMA_LAB_IMAGE,
} from "../../scripts/security/prisma-tls-lab.mjs";
import { rustBuildEnvironment } from "../../scripts/security/rust-toolchain.mjs";
const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fixture = (t) => {
  const base = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, "prisma-native-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), base);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const library = path.join(root, "query_engine.dll"),
    schema = path.join(root, "schema-engine.exe");
  fs.writeFileSync(library, "synthetic-library");
  fs.writeFileSync(schema, "synthetic-schema");
  const metadata = {
    packages: [
      { name: "query-engine-node-api", id: "napi" },
      { name: "schema-engine-cli", id: "schema" },
    ],
  };
  const items = [
    {
      reason: "compiler-artifact",
      package_id: "napi",
      target: { name: "query_engine", crate_types: ["cdylib"] },
      filenames: [library],
    },
    {
      reason: "compiler-artifact",
      package_id: "schema",
      target: { name: "schema-engine", crate_types: ["bin"] },
      executable: schema,
    },
  ];
  const output = () => items.map(JSON.stringify).join("\n");
  return { root, library, schema, metadata, items, output };
};

test("native arguments allow only offline probes or the CI loopback database port", () => {
  assert.deepEqual(prismaNativeOptions(["--native-probe"]), {
    nativeProbe: true,
  });
  assert.deepEqual(prismaNativeOptions(["--native-probe", "--release"]), {
    nativeProbe: true,
    release: true,
  });
  const ci = { CI: "true", GITHUB_ACTIONS: "true" };
  assert.deepEqual(
    prismaNativeOptions(
      [
        "--native-probe",
        "--release",
        "--postgres-port",
        "54321",
        "--postgres-tls",
      ],
      ci,
      "linux",
    ),
    {
      nativeProbe: true,
      release: true,
      postgresPort: 54321,
      postgresTls: true,
    },
  );
  assert.deepEqual(
    prismaNativeOptions(
      ["--native-probe", "--postgres-port", "54321"],
      ci,
      "linux",
    ),
    { nativeProbe: true, postgresPort: 54321 },
  );
  for (const args of [
    [],
    ["--native-probe", "--assess-only"],
    ["--native-probe", "--postgres-port", "0"],
    ["--native-probe", "--postgres-port", "65536"],
    ["--native-probe", "--postgres-port", "1evil"],
    ["--native-probe", "--postgres-port", "05432"],
    ["--native-probe", "--postgres-url", "remote"],
    ["--native-probe", "--postgres-tls"],
    ["--native-probe", "--release", "--release"],
    [
      "--native-probe",
      "--release",
      "--postgres-port",
      "5432",
      "--postgres-tls",
      "--postgres-tls",
    ],
  ])
    assert.throws(
      () => prismaNativeOptions(args, ci, "linux"),
      /arguments_invalid/,
    );
  assert.throws(
    () =>
      prismaNativeOptions(
        ["--native-probe", "--postgres-port", "5432"],
        {},
        "linux",
      ),
    /arguments_invalid/,
  );
  assert.throws(
    () =>
      prismaNativeOptions(
        ["--native-probe", "--postgres-port", "5432"],
        ci,
        "win32",
      ),
    /arguments_invalid/,
  );
});

test("native builds keep both actual packages, frozen dependencies and default features", () => {
  assert.deepEqual(prismaNativeBuildArguments(), [
    "build",
    "--locked",
    "--package",
    "query-engine-node-api",
    "--package",
    "schema-engine-cli",
    "--message-format=json",
  ]);
  const release = prismaNativeBuildArguments(true);
  assert.deepEqual(release, [
    "build",
    "--release",
    ...prismaNativeBuildArguments().slice(1),
  ]);
  assert.throws(() => prismaNativeBuildArguments("release"), /profile_invalid/);
});

test("original release LTO/optimization settings and an override-free compiler environment are mandatory", () => {
  const manifest =
    '[profile.release]\nlto="fat"\ncodegen-units=1\nopt-level="s"\n[profile.release.package.query-engine-node-api]\nstrip="symbols"\n';
  assert.equal(
    prismaNativeReleaseProfile(manifest, { RUSTFLAGS: "" }).lto,
    "fat",
  );
  for (const change of [
    manifest.replace('"fat"', '"thin"'),
    manifest.replace("units=1", "units=2"),
    manifest.replace('level="s"', 'level="0"'),
    manifest.replace('strip="symbols"', 'strip="none"'),
  ])
    assert.throws(
      () => prismaNativeReleaseProfile(change, { RUSTFLAGS: "" }),
      /release_profile_invalid/,
    );
  for (const env of [
    { RUSTFLAGS: "-O" },
    { RUSTFLAGS: "", CARGO_PROFILE_RELEASE_LTO: "off" },
    { RUSTFLAGS: "", RUSTC_WRAPPER: "compiler-wrapper" },
  ])
    assert.throws(
      () => prismaNativeReleaseProfile(manifest, env),
      /release_profile_invalid/,
    );
});

test("release artifact receipts reject debug outputs even if the same source commit is embedded", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      selectPrismaNativeArtifacts(
        f.output(),
        f.metadata,
        f.root,
        "win32",
        true,
      ),
    /release_artifact_profile_invalid/,
  );
  fs.mkdirSync(path.join(f.root, "release"));
  for (const [index, file] of [
    [0, f.library],
    [1, f.schema],
  ]) {
    const target = path.join(f.root, "release", path.basename(file));
    fs.copyFileSync(file, target);
    if (index === 0) f.items[index].filenames = [target];
    else f.items[index].executable = target;
    f.items[index].profile = {
      opt_level: "s",
      debuginfo: 0,
      debug_assertions: false,
      overflow_checks: false,
      test: false,
    };
  }
  const result = selectPrismaNativeArtifacts(
    f.output(),
    f.metadata,
    f.root,
    "win32",
    true,
  );
  assert.equal(result.library.cargoProfile.opt_level, "s");
  for (const [key, bad] of [
    ["opt_level", "0"],
    ["debuginfo", 2],
    ["debug_assertions", true],
    ["overflow_checks", true],
    ["test", true],
  ]) {
    const before = f.items[0].profile[key];
    f.items[0].profile[key] = bad;
    assert.throws(
      () =>
        selectPrismaNativeArtifacts(
          f.output(),
          f.metadata,
          f.root,
          "win32",
          true,
        ),
      /release_artifact_profile_invalid/,
    );
    f.items[0].profile[key] = before;
  }
});

test("TLS lab accepts only an exact CI service container with the immutable synthetic database identity", async () => {
  const ci = { CI: "true", GITHUB_ACTIONS: "true" },
    container = "a".repeat(64);
  assert.equal(
    prismaTlsLabOptions(["--container", container], ci, "linux"),
    container,
  );
  for (const args of [
    ["--container", "production"],
    ["--container", container, "--force"],
    ["--url", "postgresql://external"],
  ])
    assert.throws(
      () => prismaTlsLabOptions(args, ci, "linux"),
      /arguments_invalid/,
    );
  for (const [env, platform] of [
    [{}, "linux"],
    [ci, "win32"],
  ])
    assert.throws(
      () => prismaTlsLabOptions(["--container", container], env, platform),
      /arguments_invalid/,
    );
  // The preparation entrypoint rechecks CI before it can invoke Docker or write files.
  if (
    process.platform !== "linux" ||
    process.env.CI !== "true" ||
    process.env.GITHUB_ACTIONS !== "true"
  )
    await assert.rejects(
      preparePrismaTlsLab(ROOT, container, () => {
        throw new Error("must-not-run");
      }),
      /arguments_invalid/,
    );
  assert.match(PRISMA_LAB_IMAGE, /^postgres:17\.11@sha256:[a-f0-9]{64}$/);
});

test("TLS evidence rejects absent certificates, forged manifests and private-path aliases", (t) => {
  const f = fixture(t),
    root = path.join(f.root, "repo");
  fs.mkdirSync(path.join(root, ".audit/prisma-tls-lab"), { recursive: true });
  const lab = path.join(root, ".audit/prisma-tls-lab");
  fs.writeFileSync(
    path.join(lab, "manifest.json"),
    JSON.stringify({
      image: "unbound",
      hostname: "localhost",
      plaintextRejected: true,
      productionApproved: false,
    }),
  );
  assert.throws(() => readPrismaTlsLab(root), /evidence_invalid/);
  fs.writeFileSync(
    path.join(lab, "manifest.json"),
    JSON.stringify({
      image: PRISMA_LAB_IMAGE,
      hostname: "localhost",
      plaintextRejected: true,
      productionApproved: false,
    }),
  );
  assert.throws(() => readPrismaTlsLab(root), /ENOENT/);
  fs.writeFileSync(path.join(lab, "ca.crt"), "not-a-certificate");
  assert.throws(() => readPrismaTlsLab(root), /certificate_invalid/);
});

test("new registry findings block native execution without approving unreviewed Git sources", () => {
  assert.doesNotThrow(() =>
    assertPrismaNativeRegistryAssessment({
      findings: [],
      sourceAuditOk: false,
      unresolved: [{ source: "git" }],
    }),
  );
  for (const report of [
    null,
    {},
    { findings: null },
    { findings: [{ advisory: "new" }] },
  ])
    assert.throws(
      () => assertPrismaNativeRegistryAssessment(report),
      /advisories_unresolved/,
    );
});

test("Cargo artifacts bind actual package/target identities, bytes and private target paths", (t) => {
  const f = fixture(t);
  const artifacts = selectPrismaNativeArtifacts(
    f.output(),
    f.metadata,
    f.root,
    "win32",
  );
  assert.equal(artifacts.library.sha256, sha(fs.readFileSync(f.library)));
  assert.equal(artifacts.schema.file, f.schema);
  fs.appendFileSync(f.library, "modified");
  assert.notEqual(
    selectPrismaNativeArtifacts(f.output(), f.metadata, f.root, "win32").library
      .sha256,
    artifacts.library.sha256,
  );
});

test("missing, duplicate, detached and hardlinked native artifacts fail closed", (t) => {
  const f = fixture(t);
  assert.throws(
    () => selectPrismaNativeArtifacts("{}", f.metadata, f.root, "win32"),
    /artifact_missing/,
  );
  assert.throws(
    () =>
      selectPrismaNativeArtifacts(
        f.output() + "\n" + JSON.stringify(f.items[0]),
        f.metadata,
        f.root,
        "win32",
      ),
    /identity_invalid/,
  );
  f.items[0].package_id = "registry-imposter";
  assert.throws(
    () => selectPrismaNativeArtifacts(f.output(), f.metadata, f.root, "win32"),
    /identity_invalid/,
  );
  f.items[0].package_id = "napi";
  const outside = fixture(t);
  fs.linkSync(f.library, path.join(outside.root, "linked"));
  assert.throws(
    () => selectPrismaNativeArtifacts(f.output(), f.metadata, f.root, "win32"),
    /path_invalid/,
  );
});

test("Cargo's internal hardlink aliases are inventoried before making private single-link evidence copies", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, "deps"));
  fs.linkSync(f.library, path.join(f.root, "deps/query_engine.dll"));
  const result = selectPrismaNativeArtifacts(
    f.output(),
    f.metadata,
    f.root,
    "win32",
  );
  assert.deepEqual(
    result.library.compilerAliases,
    [path.join("deps", "query_engine.dll"), "query_engine.dll"].sort(),
  );
});

test("native artifact selection rejects files outside the compiler target directory", (t) => {
  const f = fixture(t);
  const inside = path.join(f.root, "target");
  fs.mkdirSync(inside);
  assert.throws(
    () => selectPrismaNativeArtifacts(f.output(), f.metadata, inside, "win32"),
    /path_invalid/,
  );
});

test("only disposable schema fixtures and two explicit migrations are generated", () => {
  for (const provider of ["sqlite", "postgresql"]) {
    const value = prismaNativeFixture(provider);
    assert.ok(value.schema.includes(`provider = "${provider}"`));
    assert.ok(value.schema.includes('env("OJA_PRISMA_PROBE_DATABASE_URL")'));
    assert.ok(value.schema.includes('engineType = "library"'));
    assert.equal(value.migrations.length, 2);
    assert.ok(value.migrations[1][1].includes('ADD COLUMN "label"'));
    assert.equal(value.schema.includes("VendorStore"), false);
  }
  assert.throws(() => prismaNativeFixture("production"), /provider_invalid/);
});

test("successful native receipts cannot omit tests, substitute bytes or grant production approval", () => {
  const artifacts = {
    library: { sha256: "1".repeat(64) },
    schema: { sha256: "2".repeat(64) },
  };
  const report = {
    provider: "sqlite",
    sourceCommit: "c".repeat(40),
    librarySha256: artifacts.library.sha256,
    schemaSha256: artifacts.schema.sha256,
    loadedLibrarySha256: artifacts.library.sha256,
    checks: [
      "native-identity",
      "generated-client-native-loader",
      "migration-history",
      "crud-and-cuid",
      "parameterized-query",
      "unique-error",
      "batch-transaction",
      "interactive-commit",
      "interactive-rollback",
      "reconnect",
      "cleanup",
    ],
    migrationsApplied: 2,
    rowsRemaining: 0,
    schemaEngineInvocations: 2,
    productionApproved: false,
    clientVersion: "6.19.3",
  };
  const verify = (value) =>
    verifyPrismaNativeProbeReport(
      value,
      "sqlite",
      artifacts,
      report.sourceCommit,
    );
  assert.equal(verify(report), report);
  for (const mutate of [
    (r) => r.checks.pop(),
    (r) => r.checks.reverse(),
    (r) => (r.productionApproved = true),
    (r) => (r.wholeEngineVerified = true),
    (r) => (r.loadedLibrarySha256 = "0".repeat(64)),
    (r) => (r.librarySha256 = "0".repeat(64)),
    (r) => (r.schemaSha256 = "0".repeat(64)),
    (r) => (r.sourceCommit = "0".repeat(40)),
    (r) => (r.schemaEngineInvocations = 0),
    (r) => (r.rowsRemaining = 1),
    (r) => (r.migrationsApplied = 1),
    (r) => (r.clientVersion = "7.0.0"),
  ]) {
    const value = structuredClone(report);
    mutate(value);
    assert.throws(() => verify(value), /evidence_invalid/);
  }
  const pg = {
    ...structuredClone(report),
    provider: "postgresql",
    checks: [
      ...report.checks,
      "scram-authentication",
      "scram-over-budget-rejected",
    ],
    scram: {
      method: "SCRAM-SHA-256",
      iterations: 4096,
      rejectedIterations: 100001,
      controlIterations: 4096,
      controlConnections: 2,
      rejectionCode: "P1001",
    },
  };
  const verifyPg = (r) =>
    verifyPrismaNativeProbeReport(
      r,
      "postgresql",
      artifacts,
      report.sourceCommit,
    );
  assert.equal(verifyPg(pg), pg);
  for (const mutate of [
    (r) => delete r.scram,
    (r) => (r.scram.iterations = 100001),
    (r) => (r.scram.rejectedIterations = 100000),
    (r) => (r.scram.method = "trust"),
    (r) => (r.scram.controlConnections = 1),
    (r) => (r.scram.controlIterations = 100001),
    (r) => (r.scram.rejectionCode = "P1000"),
  ]) {
    const value = structuredClone(pg);
    mutate(value);
    assert.throws(() => verifyPg(value), /evidence_invalid/);
  }
  const tls = {
    caSha256: "3".repeat(64),
    serverSha256: "4".repeat(64),
    untrustedCaSha256: "5".repeat(64),
  };
  const encrypted = {
    ...structuredClone(pg),
    checks: [
      ...pg.checks,
      "tls-encrypted",
      "tls-untrusted-ca-rejected",
      "tls-hostname-rejected",
      "tls-plaintext-rejected",
    ],
    tls: {
      ...tls,
      version: "TLSv1.3",
      encrypted: true,
      strict: true,
      controlConnections: 4,
      untrustedCaRejectionCode: "P1011",
      hostnameRejectionCode: "P1011",
      plaintextRejectionCode: "P1010",
    },
  };
  const verifyTls = (r) =>
    verifyPrismaNativeProbeReport(
      r,
      "postgresql",
      artifacts,
      report.sourceCommit,
      tls,
    );
  assert.equal(verifyTls(encrypted), encrypted);
  for (const mutate of [
    (r) => delete r.tls,
    (r) => r.checks.pop(),
    (r) => (r.tls.caSha256 = "0".repeat(64)),
    (r) => (r.tls.serverSha256 = "0".repeat(64)),
    (r) => (r.tls.untrustedCaSha256 = "0".repeat(64)),
    (r) => (r.tls.version = "SSLv3"),
    (r) => (r.tls.encrypted = false),
    (r) => (r.tls.strict = false),
    (r) => (r.tls.controlConnections = 3),
    (r) => (r.tls.hostnameRejectionCode = "P1001"),
    (r) => (r.tls.untrustedCaRejectionCode = "P1001"),
    (r) => (r.tls.plaintextRejectionCode = "P1001"),
  ]) {
    const value = structuredClone(encrypted);
    mutate(value);
    assert.throws(() => verifyTls(value), /evidence_invalid/);
  }
  assert.throws(() => verifyPg(encrypted), /evidence_invalid/);
});

test("probe children have no production credentials or inherited native overrides", () => {
  const env = rustBuildEnvironment("isolated-home", "reviewed-compiler", {
    PATH: "system-path",
    DATABASE_URL: "must-not-inherit",
    RESEND_API_KEY: "must-not-inherit",
    GITHUB_TOKEN: "must-not-inherit",
    PRISMA_QUERY_ENGINE_LIBRARY: "old-engine",
    NODE_OPTIONS: "must-not-inherit",
  });
  for (const key of [
    "DATABASE_URL",
    "RESEND_API_KEY",
    "GITHUB_TOKEN",
    "PRISMA_QUERY_ENGINE_LIBRARY",
    "NODE_OPTIONS",
  ])
    assert.equal(env[key], undefined);
  const probe = read("tests/fixtures/prisma/native-probe.mjs");
  assert.ok(probe.includes("process.dlopen = function"));
  assert.ok(probe.includes('"--config"'));
  assert.ok(probe.includes("schema-engine-invocations.jsonl"));
});

test("native workflow has no production settings and keeps every probe as an independent required step", () => {
  const workflow = yaml.load(read(".github/workflows/prisma-native-probe.yml"));
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.on.schedule, undefined);
  const pg = workflow.jobs["linux-postgres"].services.postgres;
  assert.match(pg.image, /^postgres:17\.11@sha256:[a-f0-9]{64}$/);
  assert.equal(pg.env.POSTGRES_HOST_AUTH_METHOD, "scram-sha-256");
  assert.equal(pg.env.POSTGRES_INITDB_ARGS, "--auth-host=scram-sha-256");
  assert.deepEqual(pg.ports, ["5432/tcp"]);
  assert.equal(workflow.jobs["windows-sqlite"].services, undefined);
  const linux = workflow.jobs["linux-postgres"].steps
    .filter((s) => s.run)
    .map((s) => s.run);
  assert.ok(
    linux.includes(
      "node scripts/security/prisma-tls-lab.mjs --container ${{ job.services.postgres.id }}",
    ),
  );
  assert.ok(
    linux.some(
      (command) =>
        command.includes("--native-probe --release --postgres-port") &&
        command.endsWith("--postgres-tls"),
    ),
  );
  assert.ok(
    workflow.jobs["windows-sqlite"].steps.some(
      (s) =>
        s.run ===
        "node scripts/security/test-prisma-source.mjs --native-probe --release",
    ),
  );
  assert.ok(
    !read(".github/workflows/prisma-native-probe.yml").includes(
      ".audit/prisma-tls-lab/",
    ),
  );
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.steps[0].with["persist-credentials"], false);
    for (const step of job.steps.filter((s) => s.run)) {
      assert.equal(step.if, undefined);
      assert.equal(step["continue-on-error"], undefined);
      assert.equal(step.run.includes("\n"), false);
      assert.ok(!step.run.includes("migrate deploy"));
    }
  }
  assert.ok(
    !read(".github/workflows/prisma-native-probe.yml").includes("secrets."),
  );
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import yaml from "js-yaml";
import {
  DATABASE_NATIVE_INPUT,
  POOLER_SOURCE,
  FOUNDATION,
  DATABASE_CHECKS,
  sha,
  databaseCompatibilityOptions,
  applicationDatabaseInputs,
  selectDatabaseNativeInput,
  prepareApplicationProject,
  poolerConfiguration,
  verifyDatabaseCompatibilityReport,
} from "../../scripts/security/database-compatibility.mjs";
const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()),
    root = fs.mkdtempSync(path.join(parent, "database-contract-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("database probes accept only a CI Linux loopback port, never a supplied host or URL", () => {
  const ci = { CI: "true", GITHUB_ACTIONS: "true" };
  assert.equal(
    databaseCompatibilityOptions(["--postgres-port", "54321"], ci, "linux"),
    54321,
  );
  for (const args of [
    [],
    ["--postgres-port", "0"],
    ["--postgres-port", "65536"],
    ["--postgres-port", "05432"],
    ["--postgres-port", "5432evil"],
    ["--postgres-url", "production"],
    ["--postgres-port", "5432", "--skip"],
  ])
    assert.throws(
      () => databaseCompatibilityOptions(args, ci, "linux"),
      /arguments_invalid/,
    );
  for (const [env, platform] of [
    [{}, "linux"],
    [ci, "win32"],
  ])
    assert.throws(
      () =>
        databaseCompatibilityOptions(
          ["--postgres-port", "5432"],
          env,
          platform,
        ),
      /arguments_invalid/,
    );
});

test("application migration inventory binds every unchanged schema/SQL byte and rejects stray entries", (t) => {
  const inputs = applicationDatabaseInputs(ROOT);
  assert.ok(inputs.length > 40);
  assert.ok(
    inputs.some(
      (e) => e.path === `prisma/migrations/${FOUNDATION}/migration.sql`,
    ),
  );
  for (const entry of inputs)
    assert.equal(
      entry.sha256,
      sha(fs.readFileSync(path.join(ROOT, entry.path))),
    );
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "prisma/migrations"), { recursive: true });
  fs.writeFileSync(path.join(root, "prisma/schema.prisma"), "fixture");
  fs.writeFileSync(
    path.join(root, "prisma/migrations/migration_lock.toml"),
    'provider="postgresql"',
  );
  fs.mkdirSync(path.join(root, "prisma/migrations/20261105000000_fixture"));
  fs.writeFileSync(
    path.join(root, "prisma/migrations/20261105000000_fixture/migration.sql"),
    "SELECT 1;",
  );
  const before = applicationDatabaseInputs(root);
  fs.appendFileSync(path.join(root, "prisma/schema.prisma"), "changed");
  assert.notDeepEqual(applicationDatabaseInputs(root), before);
  fs.writeFileSync(path.join(root, "prisma/migrations/stray"), "unsafe");
  assert.throws(() => applicationDatabaseInputs(root), /input_invalid/);
});

test("migration inputs reject hardlinked SQL and undocumented files", (t) => {
  const root = fixture(t),
    directory = path.join(root, "prisma/migrations/20261105000000_fixture");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(root, "prisma/schema.prisma"), "fixture");
  fs.writeFileSync(
    path.join(root, "prisma/migrations/migration_lock.toml"),
    'provider="postgresql"',
  );
  fs.writeFileSync(path.join(directory, "migration.sql"), "SELECT 1;");
  fs.linkSync(
    path.join(directory, "migration.sql"),
    path.join(root, "outside.sql"),
  );
  assert.throws(() => applicationDatabaseInputs(root), /input_invalid/);
});

test("private application projects retain the complete schema and all SQL unchanged without overwriting installed clients", (t) => {
  const root = fixture(t),
    inputs = applicationDatabaseInputs(ROOT),
    project = path.join(root, "application");
  prepareApplicationProject(ROOT, project, inputs);
  for (const input of inputs)
    assert.equal(
      sha(fs.readFileSync(path.join(project, input.path))),
      input.sha256,
    );
  assert.ok(
    fs.existsSync(
      path.join(
        project,
        "node_modules/@prisma/client/generator-build/index.js",
      ),
    ),
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(project, "package.json"))),
    {
      name: "oja-isolated-application-probe",
      private: true,
      dependencies: { "@prisma/client": "6.19.3" },
    },
  );
  assert.throws(
    () => prepareApplicationProject(ROOT, project, inputs),
    /EEXIST/,
  );
  assert.ok(
    fs.existsSync(path.join(project, "node_modules/prisma/build/index.js")),
  );
  const history = path.join(root, "history");
  prepareApplicationProject(ROOT, history, inputs, true);
  assert.equal(
    fs.existsSync(
      path.join(history, `prisma/migrations/${FOUNDATION}/migration.sql`),
    ),
    false,
  );
  assert.equal(
    fs.readFileSync(path.join(history, "prisma/schema.prisma"), "utf8"),
    read("prisma/schema.prisma"),
  );
});

test("changed input digests are rejected before generating a client", (t) => {
  const root = fixture(t),
    inputs = applicationDatabaseInputs(ROOT).map((e) => ({
      ...e,
      sha256: "0".repeat(64),
    }));
  assert.throws(
    () =>
      prepareApplicationProject(ROOT, path.join(root, "application"), inputs),
    /input_changed/,
  );
});

test("pooler configuration is transaction-only, loopback-only and strict TLS in both directions", (t) => {
  const directory = fixture(t);
  for (const prepared of [false, true]) {
    const value = poolerConfiguration({
      directory,
      tlsDirectory: directory,
      postgresPort: 54321,
      port: 54322,
      prepared,
    });
    assert.ok(value.includes("listen_addr = localhost"));
    assert.ok(value.includes("pool_mode = transaction"));
    assert.ok(value.includes("server_tls_sslmode = verify-full"));
    assert.ok(value.includes("client_tls_sslmode = require"));
    assert.ok(value.includes("auth_type = scram-sha-256"));
    assert.ok(
      value.includes(`max_prepared_statements = ${prepared ? 100 : 0}`),
    );
    assert.ok(!value.includes("0.0.0.0"));
  }
  for (const change of [
    { port: 54321 },
    { postgresPort: 0 },
    { directory: "relative" },
    { tlsDirectory: directory + "\nunsafe" },
    { prepared: "true" },
  ])
    assert.throws(
      () =>
        poolerConfiguration({
          directory,
          tlsDirectory: directory,
          postgresPort: 54321,
          port: 54322,
          prepared: false,
          ...change,
        }),
      /config_invalid/,
    );
});

test("source-built pooler is pinned to the reviewed official release and digest", () => {
  assert.equal(POOLER_SOURCE.version, "1.26.1");
  assert.equal(
    POOLER_SOURCE.url,
    "https://www.pgbouncer.org/downloads/files/1.26.1/pgbouncer-1.26.1.tar.gz",
  );
  assert.match(POOLER_SOURCE.sha256, /^[a-f0-9]{64}$/);
  const runner = read("scripts/security/test-database-compatibility.mjs");
  assert.ok(
    runner.includes('redirect: "error"') || runner.includes('redirect:"error"'),
  );
  assert.ok(runner.includes("checkRustSourceTree(source)"));
  assert.ok(runner.includes('child.kill("SIGTERM")'));
  assert.ok(!runner.includes("pkill"));
});

test("native reuse cannot substitute a current unrelated build or treat prior approval flags as true", (t) => {
  const root = fixture(t),
    downloaded = path.join(root, "input");
  fs.mkdirSync(downloaded);
  assert.throws(
    () => selectDatabaseNativeInput(ROOT, downloaded),
    /evidence_invalid/,
  );
  fs.mkdirSync(path.join(downloaded, "run-fixture"));
  fs.writeFileSync(
    path.join(downloaded, "run-fixture/receipt.json"),
    JSON.stringify({
      tests: { nativeProbe: {} },
      source: {},
      compiler: {},
      productionApproved: true,
    }),
  );
  assert.throws(
    () => selectDatabaseNativeInput(ROOT, downloaded),
    /evidence_invalid/,
  );
  assert.deepEqual(DATABASE_NATIVE_INPUT, {
    run: "42038861752",
    head: "58db7772b94d294202ae4961d65b8c72d5ca57e2",
    artifactId: "13421125529",
    policySha256:
      "2da8f59fe8bf52764c1097bbf5f77766313ea7e9bd94857aa0f6c9cee904d217",
    librarySha256:
      "097b6f7d68a6ea3770d599b9f7b38544c38489e1c1b3775e3d2736407b9e2aa5",
    schemaSha256:
      "61ebb54084936ef7679d0b6c2e8f34a16d00aad6196e9c892833e0c990f6ee3f",
  });
  assert.equal(
    DATABASE_NATIVE_INPUT.policySha256,
    sha(
      fs.readFileSync(path.join(ROOT, "security/prisma-source-contracts.json")),
    ),
  );
});

test("foundation restores only the historical missing tables without changing existing migration files", () => {
  const sql = read(`prisma/migrations/${FOUNDATION}/migration.sql`);
  for (const table of [
    "Product",
    "Vendor",
    "VendorLoginCode",
    "VendorAdminSession",
    "ContactInquiry",
    "FixedReplyCandidate",
    "FixedReplyRule",
    "FxRate",
  ])
    assert.ok(sql.includes(`CREATE TABLE "${table}"`));
  assert.ok(sql.includes("39f0aaf8953587baf03d5dcc83a0046d9928da3e"));
  assert.ok(sql.includes("existing_count = 8 THEN RETURN"));
  assert.ok(sql.includes("legacy_foundation_partial_schema"));
  assert.ok(sql.includes("legacy_foundation_later_history_without_tables"));
  assert.ok(
    !/\b(?:DROP|TRUNCATE|DELETE|UPDATE|ALTER)\b/.test(
      sql
        .replace(/ON (?:UPDATE|DELETE) (?:CASCADE|RESTRICT)/g, "ON CASCADE")
        .split("\n")
        .filter((line) => !line.startsWith("--"))
        .join("\n"),
    ),
  );
});

test("database receipts reject missing tests, drift, partial migrations, swapped native bytes and production approval", () => {
  const inputs = [
      { path: "prisma/schema.prisma", sha256: "1".repeat(64) },
      {
        path: `prisma/migrations/${FOUNDATION}/migration.sql`,
        sha256: "2".repeat(64),
      },
    ],
    native = {
      sourceCommit: "c".repeat(40),
      librarySha256: "3".repeat(64),
      schemaSha256: "4".repeat(64),
    };
  const report = {
    checks: [...DATABASE_CHECKS],
    sourceCommit: native.sourceCommit,
    librarySha256: native.librarySha256,
    loadedLibrarySha256: native.librarySha256,
    schemaSha256: native.schemaSha256,
    clientVersion: "6.19.3",
    applicationInputSha256: sha(JSON.stringify(inputs)),
    migrationsApplied: 1,
    modelsChecked: 100,
    rowsRemaining: 0,
    seedRowsPreserved: 3,
    existingHistoryUpgraded: true,
    baselineStateSha256: "5".repeat(64),
    schemaEngineInvocations: 8,
    historyRegression: {
      code: "P3018",
      sqlState: "42P01",
      missingTable: "Product",
    },
    poolers: [false, true].map((prepared) => ({
      mode: prepared ? "prepared" : "compatibility",
      clientConnections: 12,
      backendProcesses: 1,
      pgbouncerFlag: !prepared,
      maxPreparedStatements: prepared ? 100 : 0,
      serverTlsVersion: "TLSv1.3",
      checks: 10,
      rowsRemaining: 0,
    })),
    productionApproved: false,
    wholeEngineVerified: false,
  };
  const verify = (r) => verifyDatabaseCompatibilityReport(r, inputs, native);
  assert.equal(verify(report), report);
  for (const mutate of [
    (r) => r.checks.pop(),
    (r) => (r.productionApproved = true),
    (r) => (r.wholeEngineVerified = true),
    (r) => (r.librarySha256 = "0".repeat(64)),
    (r) => (r.loadedLibrarySha256 = "0".repeat(64)),
    (r) => (r.applicationInputSha256 = "0".repeat(64)),
    (r) => (r.migrationsApplied = 0),
    (r) => delete r.modelsChecked,
    (r) => delete r.schemaEngineInvocations,
    (r) => (r.rowsRemaining = 1),
    (r) => (r.seedRowsPreserved = 0),
    (r) => (r.existingHistoryUpgraded = false),
    (r) => delete r.baselineStateSha256,
    (r) => (r.historyRegression.code = "P1001"),
    (r) => r.poolers.pop(),
    (r) => (r.poolers[0].clientConnections = 1),
    (r) => (r.poolers[0].backendProcesses = 12),
    (r) => (r.poolers[1].pgbouncerFlag = true),
    (r) => (r.poolers[1].serverTlsVersion = "SSLv3"),
    (r) => (r.poolers[1].maxPreparedStatements = 0),
    (r) => (r.poolers[1].checks = 0),
  ]) {
    const value = structuredClone(report);
    mutate(value);
    assert.throws(() => verify(value), /evidence_invalid/);
  }
});

test("database workflow reuses immutable byte-checked native inputs and never schedules or promotes", () => {
  const workflow = yaml.load(
    read(".github/workflows/database-compatibility.yml"),
  );
  assert.deepEqual(workflow.permissions, { contents: "read", actions: "read" });
  assert.equal(workflow.on.schedule, undefined);
  assert.equal(workflow.on.workflow_run, undefined);
  const job = workflow.jobs["postgres-pooler"],
    download = job.steps.find((step) => step.with?.["artifact-ids"]);
  assert.equal(
    String(download.with["artifact-ids"]),
    DATABASE_NATIVE_INPUT.artifactId,
  );
  assert.equal(String(download.with["run-id"]), DATABASE_NATIVE_INPUT.run);
  assert.match(
    job.services.postgres.image,
    /^postgres:17\.11@sha256:[a-f0-9]{64}$/,
  );
  assert.deepEqual(job.services.postgres.ports, ["5432/tcp"]);
  for (const step of job.steps.filter((s) => s.run)) {
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
    assert.ok(!step.run.includes("\n"));
    assert.ok(!step.run.includes("migrate deploy"));
  }
  const upload = job.steps.find((s) => s.with?.["retention-days"]);
  assert.ok(upload.with.path.includes("!"));
  assert.ok(!upload.with.path.includes("prisma-tls-lab"));
  assert.equal(job.steps[0].with["persist-credentials"], false);
});

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const DATABASE_NATIVE_INPUT = Object.freeze({
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
export const POOLER_SOURCE = Object.freeze({
  version: "1.26.1",
  url: "https://www.pgbouncer.org/downloads/files/1.26.1/pgbouncer-1.26.1.tar.gz",
  sha256: "00886a2994b4844cd37110970df777772cfc42a74c400522c82fba509a3f42d9",
});
export const FOUNDATION = "20260409000000_restore_legacy_foundation";
export const DATABASE_CHECKS = Object.freeze([
  "native-identity",
  "original-history-regression",
  "fresh-full-migration-history",
  "schema-drift",
  "all-model-tables",
  "foundation-existing-data-noop",
  "foundation-partial-rejected",
  "foundation-later-history-rejected",
  "application-types-and-relations",
  "compatibility-pool",
  "prepared-pool",
  "cleanup",
]);
export const sha = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

export function databaseCompatibilityOptions(
  args,
  env = process.env,
  platform = process.platform,
) {
  if (
    platform !== "linux" ||
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true" ||
    args.length !== 2 ||
    args[0] !== "--postgres-port" ||
    !/^[1-9][0-9]{0,4}$/.test(args[1]) ||
    Number(args[1]) > 65535
  )
    throw new Error("database_compatibility_arguments_invalid");
  return Number(args[1]);
}

function bytes(file, limit = 64 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > limit
  )
    throw new Error("database_compatibility_input_invalid");
  return fs.readFileSync(file);
}

export function applicationDatabaseInputs(root) {
  const directory = path.join(root, "prisma/migrations");
  if (fs.realpathSync(directory) !== directory)
    throw new Error("database_compatibility_input_invalid");
  const files = [
    "prisma/schema.prisma",
    "prisma/migrations/migration_lock.toml",
  ];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "migration_lock.toml") continue;
    if (!entry.isDirectory() || !/^[0-9]{14}_[a-z0-9_]+$/.test(entry.name))
      throw new Error("database_compatibility_input_invalid");
    files.push(`prisma/migrations/${entry.name}/migration.sql`);
    if (
      fs.readdirSync(path.join(directory, entry.name)).join() !==
      "migration.sql"
    )
      throw new Error("database_compatibility_input_invalid");
  }
  if (files.length < 3 || files.length > 202)
    throw new Error("database_compatibility_input_invalid");
  return files
    .sort()
    .map((file) => ({ path: file, sha256: sha(bytes(path.join(root, file))) }));
}

export function selectDatabaseNativeInput(root, downloaded) {
  const entries = fs.readdirSync(downloaded, { withFileTypes: true });
  if (
    entries.length !== 1 ||
    !entries[0].isDirectory() ||
    !/^run-[a-zA-Z0-9]+$/.test(entries[0].name)
  )
    throw new Error("database_native_evidence_invalid");
  const run = path.join(downloaded, entries[0].name);
  if (fs.realpathSync(run) !== run)
    throw new Error("database_native_evidence_invalid");
  const receipt = JSON.parse(bytes(path.join(run, "receipt.json")));
  const policy = JSON.parse(
    bytes(path.join(root, "security/prisma-source-contracts.json")),
  );
  const native = receipt.tests?.nativeProbe;
  if (
    sha(bytes(path.join(root, "security/prisma-source-contracts.json"))) !==
      DATABASE_NATIVE_INPUT.policySha256 ||
    receipt.policySha256 !== DATABASE_NATIVE_INPUT.policySha256 ||
    receipt.source.commit !== policy.source.commit ||
    receipt.compiler.policySha256 !==
      sha(bytes(path.join(root, "security/rust-toolchain.json"))) ||
    receipt.compiler.target !== "x86_64-unknown-linux-gnu" ||
    receipt.engineLockfileSha256 !== policy.lockfile.sha256 ||
    receipt.contractLockfileSha256 !== policy.contractLockfile.sha256 ||
    receipt.patchSha256 !== policy.patch.sha256 ||
    receipt.unreviewedGitSources !== 13 ||
    receipt.artifactStatus !== "NOT_VERIFIED" ||
    receipt.productionApproved !== false ||
    receipt.wholeEngineVerified !== false ||
    native?.profile !== "release/original-fat-lto" ||
    native.cargoProfile.lto !== "fat" ||
    native.cargoProfile["opt-level"] !== "s" ||
    native.cargoProfile["codegen-units"] !== 1 ||
    native.productionApproved !== false ||
    native.wholeEngineVerified !== false
  )
    throw new Error("database_native_evidence_invalid");
  const result = {
    sourceCommit: policy.source.commit,
    receiptSha256: sha(bytes(path.join(run, "receipt.json"))),
  };
  for (const [role, name] of [
    ["library", "query_engine.node"],
    ["schema", "schema-engine"],
  ]) {
    const file = path.join(run, "native-probe", name),
      value = bytes(file);
    if (
      sha(value) !== DATABASE_NATIVE_INPUT[`${role}Sha256`] ||
      sha(value) !== native.artifacts[role].sha256 ||
      value.subarray(0, 4).toString("hex") !== "7f454c46" ||
      native.artifacts[role].cargoProfile.opt_level !== "s"
    )
      throw new Error("database_native_binary_invalid");
    result[role] = file;
    result[`${role}Sha256`] = sha(value);
  }
  return result;
}

export function prepareApplicationProject(
  root,
  project,
  inputs,
  omitFoundation = false,
) {
  fs.mkdirSync(project);
  fs.writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "oja-isolated-application-probe",
      private: true,
      dependencies: { "@prisma/client": "6.19.3" },
    }),
  );
  fs.writeFileSync(
    path.join(project, "prisma.config.ts"),
    'export default { schema: "./prisma/schema.prisma" };\n',
  );
  fs.writeFileSync(path.join(project, ".env"), "");
  for (const entry of inputs) {
    if (omitFoundation && entry.path.includes(`/${FOUNDATION}/`)) continue;
    const source = bytes(path.join(root, entry.path));
    if (sha(source) !== entry.sha256)
      throw new Error("application_database_input_changed");
    const destination = path.join(project, entry.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, source, { flag: "wx" });
  }
  // Keep the complete real schema unchanged. A private generator package prevents
  // its default output from writing into the application's installed client.
  // The CLI and Client must resolve from the same private node_modules tree.
  for (const name of ["@prisma/client", "prisma"])
    fs.cpSync(
      path.join(root, "node_modules", name),
      path.join(project, "node_modules", name),
      {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: (source) => {
          const stat = fs.lstatSync(source);
          if (
            stat.isSymbolicLink() ||
            (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
          )
            throw new Error("application_client_input_invalid");
          return true;
        },
      },
    );
}

export function poolerConfiguration({
  directory,
  tlsDirectory,
  postgresPort,
  port,
  prepared,
}) {
  if (
    ![postgresPort, port].every(
      (p) => Number.isInteger(p) && p > 0 && p <= 65535,
    ) ||
    port === postgresPort ||
    typeof prepared !== "boolean" ||
    ![directory, tlsDirectory].every(
      (p) => path.isAbsolute(p) && !/[\r\n"']/.test(p),
    )
  )
    throw new Error("database_pooler_config_invalid");
  return `[databases]
oja_app_probe = host=localhost port=${postgresPort} dbname=oja_app_probe
[pgbouncer]
listen_addr = localhost
listen_port = ${port}
unix_socket_dir =
auth_type = scram-sha-256
auth_file = ${path.join(tlsDirectory, "pooler-users.txt")}
pool_mode = transaction
default_pool_size = 1
reserve_pool_size = 0
max_db_connections = 1
max_client_conn = 32
max_prepared_statements = ${prepared ? 100 : 0}
ignore_startup_parameters = extra_float_digits,search_path
client_tls_sslmode = require
client_tls_cert_file = ${path.join(tlsDirectory, "server.crt")}
client_tls_key_file = ${path.join(tlsDirectory, "server.key")}
client_tls_protocols = tlsv1.2,tlsv1.3
server_tls_sslmode = verify-full
server_tls_ca_file = ${path.join(tlsDirectory, "ca.crt")}
server_tls_protocols = tlsv1.2,tlsv1.3
query_wait_timeout = 10
server_connect_timeout = 5
server_login_retry = 1
logfile = ${path.join(directory, "pooler.log")}
pidfile = ${path.join(directory, "pooler.pid")}
`;
}

export function verifyDatabaseCompatibilityReport(report, inputs, native) {
  const keys = [
    "checks",
    "sourceCommit",
    "librarySha256",
    "schemaSha256",
    "loadedLibrarySha256",
    "clientVersion",
    "applicationInputSha256",
    "migrationsApplied",
    "modelsChecked",
    "rowsRemaining",
    "seedRowsPreserved",
    "baselineStateSha256",
    "existingHistoryUpgraded",
    "schemaEngineInvocations",
    "historyRegression",
    "poolers",
    "productionApproved",
    "wholeEngineVerified",
  ];
  if (
    !report ||
    Object.keys(report).sort().join() !== keys.sort().join() ||
    JSON.stringify(report.checks) !== JSON.stringify(DATABASE_CHECKS) ||
    report.productionApproved !== false ||
    report.wholeEngineVerified !== false ||
    report.librarySha256 !== native.librarySha256 ||
    report.loadedLibrarySha256 !== native.librarySha256 ||
    report.schemaSha256 !== native.schemaSha256 ||
    report.sourceCommit !== native.sourceCommit ||
    report.clientVersion !== "6.19.3" ||
    report.applicationInputSha256 !== sha(JSON.stringify(inputs)) ||
    report.migrationsApplied !==
      inputs.filter((e) => e.path.endsWith("/migration.sql")).length ||
    !Number.isInteger(report.modelsChecked) ||
    report.modelsChecked < 20 ||
    report.rowsRemaining !== 0 ||
    report.seedRowsPreserved !== 3 ||
    report.existingHistoryUpgraded !== true ||
    !/^[a-f0-9]{64}$/.test(report.baselineStateSha256) ||
    !Number.isInteger(report.schemaEngineInvocations) ||
    report.schemaEngineInvocations < 6 ||
    report.historyRegression?.code !== "P3018" ||
    report.historyRegression?.sqlState !== "42P01" ||
    report.historyRegression.missingTable !== "Product" ||
    report.poolers?.length !== 2 ||
    !report.poolers.every(
      (p, i) =>
        p.mode === (i === 0 ? "compatibility" : "prepared") &&
        p.clientConnections === 12 &&
        p.backendProcesses === 1 &&
        p.pgbouncerFlag === (i === 0) &&
        p.maxPreparedStatements === (i === 0 ? 0 : 100) &&
        ["TLSv1.2", "TLSv1.3"].includes(p.serverTlsVersion) &&
        p.checks === 10 &&
        p.rowsRemaining === 0,
    )
  )
    throw new Error("database_compatibility_evidence_invalid");
  return report;
}

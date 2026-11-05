import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const CHECKS = [
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
];

export function prismaNativeOptions(
  args,
  environment = process.env,
  platform = process.platform,
) {
  if (args.length === 1 && args[0] === "--native-probe")
    return { nativeProbe: true };
  if (
    args.length === 3 &&
    args[0] === "--native-probe" &&
    args[1] === "--postgres-port" &&
    /^[1-9][0-9]{0,4}$/.test(args[2]) &&
    Number(args[2]) <= 65535 &&
    platform === "linux" &&
    environment.GITHUB_ACTIONS === "true" &&
    environment.CI === "true"
  )
    return { nativeProbe: true, postgresPort: Number(args[2]) };
  throw new Error("prisma_native_probe_arguments_invalid");
}

export function prismaNativeBuildArguments() {
  return [
    "build",
    "--locked",
    "--package",
    "query-engine-node-api",
    "--package",
    "schema-engine-cli",
    "--message-format=json",
  ];
}

export function assertPrismaNativeRegistryAssessment(assessment) {
  if (!Array.isArray(assessment?.findings) || assessment.findings.length !== 0)
    throw new Error("prisma_native_registry_advisories_unresolved");
}

function compilerOwnedLinks(file, root) {
  const identity = fs.lstatSync(file, { bigint: true });
  if (identity.nlink === 1n) return [path.relative(root, file)];
  if (identity.ino === 0n)
    throw new Error("prisma_native_artifact_path_invalid");
  const aliases = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(candidate);
      else if (entry.isFile()) {
        const stat = fs.lstatSync(candidate, { bigint: true });
        if (stat.dev === identity.dev && stat.ino === identity.ino)
          aliases.push(path.relative(root, candidate));
      }
    }
  };
  // Cargo links deps outputs into debug/. Every alias must remain in this private target.
  walk(root);
  if (BigInt(aliases.length) !== identity.nlink)
    throw new Error("prisma_native_artifact_path_invalid");
  return aliases.sort();
}

export function selectPrismaNativeArtifacts(
  output,
  metadata,
  targetDirectory,
  platform = process.platform,
) {
  const selected = {};
  const definitions = [
    ["library", "query-engine-node-api", "query_engine", "cdylib"],
    ["schema", "schema-engine-cli", "schema-engine", "bin"],
  ];
  const targetRoot = fs.realpathSync(targetDirectory);
  for (const line of output.trim().split(/\r?\n/)) {
    const item = JSON.parse(line);
    if (item.reason !== "compiler-artifact") continue;
    for (const [role, owner, target, kind] of definitions) {
      if (
        item.target?.name !== target ||
        !item.target.crate_types?.includes(kind)
      )
        continue;
      const pkg = metadata.packages.find(
        (pkg) => pkg.name === owner && !pkg.source,
      );
      if (!pkg || item.package_id !== pkg.id || selected[role])
        throw new Error("prisma_native_artifact_identity_invalid");
      const files =
        role === "schema"
          ? [item.executable]
          : item.filenames.filter((name) =>
              name.endsWith(platform === "win32" ? ".dll" : ".so"),
            );
      if (files.length !== 1 || typeof files[0] !== "string")
        throw new Error("prisma_native_artifact_missing");
      const file = path.resolve(files[0]);
      const relative = path.relative(targetRoot, file);
      const stat = fs.lstatSync(file);
      if (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size === 0 ||
        stat.size > 512 * 1024 * 1024 ||
        fs.realpathSync(file) !== file
      )
        throw new Error("prisma_native_artifact_path_invalid");
      selected[role] = {
        file,
        sha256: sha(fs.readFileSync(file)),
        bytes: stat.size,
        packageId: pkg.id,
        compilerAliases: compilerOwnedLinks(file, targetRoot),
      };
    }
  }
  if (!selected.library || !selected.schema)
    throw new Error("prisma_native_artifact_missing");
  return selected;
}

export function prismaNativeFixture(provider) {
  if (!["sqlite", "postgresql"].includes(provider))
    throw new Error("prisma_native_provider_invalid");
  return {
    schema: `generator client {
  provider = "prisma-client-js"
  output = "./client"
  engineType = "library"
}
datasource db {
  provider = "${provider}"
  url = env("OJA_PRISMA_PROBE_DATABASE_URL")
}
model ProbeRecord {
  id String @id @default(cuid())
  key String @unique
  amount Int @default(0)
  label String?
}
`,
    migrations: [
      [
        "202611050001_initial",
        'CREATE TABLE "ProbeRecord" ("id" TEXT NOT NULL PRIMARY KEY, "key" TEXT NOT NULL, "amount" INTEGER NOT NULL DEFAULT 0);\nCREATE UNIQUE INDEX "ProbeRecord_key_key" ON "ProbeRecord"("key");\n',
      ],
      [
        "202611050002_label",
        'ALTER TABLE "ProbeRecord" ADD COLUMN "label" TEXT;\n',
      ],
    ],
  };
}

export function verifyPrismaNativeProbeReport(
  report,
  provider,
  artifacts,
  sourceCommit,
) {
  const expected = [
    ...CHECKS,
    ...(provider === "postgresql"
      ? ["scram-authentication", "scram-over-budget-rejected"]
      : []),
  ];
  const keys = [
    "provider",
    "sourceCommit",
    "librarySha256",
    "schemaSha256",
    "loadedLibrarySha256",
    "checks",
    "migrationsApplied",
    "rowsRemaining",
    "schemaEngineInvocations",
    "productionApproved",
    "clientVersion",
    ...(provider === "postgresql" ? ["scram"] : []),
  ];
  if (
    !report ||
    Object.keys(report).sort().join() !== keys.sort().join() ||
    !["sqlite", "postgresql"].includes(provider) ||
    report.provider !== provider ||
    report.sourceCommit !== sourceCommit ||
    report.librarySha256 !== artifacts.library.sha256 ||
    report.schemaSha256 !== artifacts.schema.sha256 ||
    JSON.stringify(report.checks) !== JSON.stringify(expected) ||
    report.loadedLibrarySha256 !== artifacts.library.sha256 ||
    report.migrationsApplied !== 2 ||
    report.rowsRemaining !== 0 ||
    report.clientVersion !== "6.19.3" ||
    report.productionApproved !== false ||
    !Number.isInteger(report.schemaEngineInvocations) ||
    report.schemaEngineInvocations < 2 ||
    (provider === "postgresql" &&
      (report.scram?.method !== "SCRAM-SHA-256" ||
        !Number.isInteger(report.scram.iterations) ||
        report.scram.iterations < 1 ||
        report.scram.iterations > 100000 ||
        report.scram.rejectedIterations !== 100001))
  )
    throw new Error("prisma_native_probe_evidence_invalid");
  return report;
}

export async function probePrismaNative({
  root,
  source,
  tools,
  execute,
  policy,
  metadata,
  run,
  postgresPort,
}) {
  if (postgresPort !== undefined)
    prismaNativeOptions([
      "--native-probe",
      "--postgres-port",
      String(postgresPort),
    ]);
  tools.env.GIT_HASH = policy.source.commit;
  tools.env.CARGO_PROFILE_DEV_DEBUG = "0";
  const output = execute(
    tools.cargo,
    prismaNativeBuildArguments(),
    source,
    "native-build",
    1_800_000,
  );
  const artifacts = selectPrismaNativeArtifacts(
    output,
    metadata,
    tools.env.CARGO_TARGET_DIR,
  );
  const work = path.join(run, "native-probe");
  fs.mkdirSync(work);
  const library = path.join(work, "query_engine.node");
  const schema = path.join(
    work,
    process.platform === "win32" ? "schema-engine.exe" : "schema-engine",
  );
  fs.copyFileSync(artifacts.library.file, library, fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(artifacts.schema.file, schema, fs.constants.COPYFILE_EXCL);
  if (fs.lstatSync(library).nlink !== 1 || fs.lstatSync(schema).nlink !== 1)
    throw new Error("prisma_native_artifact_copy_mismatch");
  if (sha(fs.readFileSync(schema)) !== artifacts.schema.sha256)
    throw new Error("prisma_native_artifact_copy_mismatch");
  if (sha(fs.readFileSync(library)) !== artifacts.library.sha256)
    throw new Error("prisma_native_artifact_copy_mismatch");
  const providers = [
    "sqlite",
    ...(postgresPort === undefined ? [] : ["postgresql"]),
  ];
  const results = [];
  const fixtureScript = path.join(
    root,
    "tests/fixtures/prisma/native-probe.mjs",
  );
  const cliHook = path.join(root, "tests/fixtures/prisma/probe-cli-hook.cjs");
  const cli = path.join(root, "node_modules/prisma/build/index.js");
  for (const provider of providers) {
    const project = path.join(work, provider);
    fs.mkdirSync(project);
    const fixture = prismaNativeFixture(provider);
    fs.writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({ name: "oja-ephemeral-native-probe", private: true }),
    );
    fs.writeFileSync(
      path.join(project, "prisma.config.ts"),
      'export default { schema: "./schema.prisma" };\n',
    );
    fs.writeFileSync(path.join(project, ".env"), "");
    fs.writeFileSync(path.join(project, "schema.prisma"), fixture.schema);
    fs.mkdirSync(path.join(project, "migrations"));
    fs.writeFileSync(
      path.join(project, "migrations/migration_lock.toml"),
      `provider = "${provider}"\n`,
    );
    for (const [name, sql] of fixture.migrations) {
      fs.mkdirSync(path.join(project, "migrations", name));
      fs.writeFileSync(
        path.join(project, "migrations", name, "migration.sql"),
        sql,
      );
    }
    const input = {
      provider,
      sourceCommit: policy.source.commit,
      library,
      schema,
      librarySha256: artifacts.library.sha256,
      schemaSha256: artifacts.schema.sha256,
      cli,
      cliHook,
      project,
      ...(provider === "postgresql" ? { postgresPort } : {}),
    };
    const inputFile = path.join(project, "probe-input.json");
    fs.writeFileSync(inputFile, JSON.stringify(input));
    const result = JSON.parse(
      execute(
        process.execPath,
        [fixtureScript, inputFile],
        project,
        `native-${provider}`,
        180_000,
      ),
    );
    results.push(
      verifyPrismaNativeProbeReport(
        result,
        provider,
        artifacts,
        policy.source.commit,
      ),
    );
  }
  return {
    profile: "dev/debug=0",
    artifacts,
    results,
    productionApproved: false,
    wholeEngineVerified: false,
    probeScriptSha256: sha(fs.readFileSync(fixtureScript)),
    cliHookSha256: sha(fs.readFileSync(cliHook)),
    workflowSha256: sha(
      fs.readFileSync(
        path.join(root, ".github/workflows/prisma-native-probe.yml"),
      ),
    ),
    orchestratorSha256: sha(fs.readFileSync(new URL(import.meta.url))),
    scope:
      "synthetic client/migration/native-link probes only; not a production binary, TLS, PgBouncer or whole-source approval",
  };
}

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import toml from "toml";
import { readPrismaTlsLab } from "./prisma-tls-lab.mjs";

const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const CHECKS = [
  "native-identity",
  "generated-client-native-loader",
  "graphql-depth-limit",
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
  const release = args[1] === "--release";
  if (release) args = [args[0], ...args.slice(2)];
  const postgresTls = args.at(-1) === "--postgres-tls";
  if (postgresTls) args = args.slice(0, -1);
  const extra = release ? { release: true } : {};
  if (args.length === 1 && args[0] === "--native-probe" && !postgresTls)
    return { nativeProbe: true, ...extra };
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
    return {
      nativeProbe: true,
      ...extra,
      postgresPort: Number(args[2]),
      ...(postgresTls ? { postgresTls: true } : {}),
    };
  throw new Error("prisma_native_probe_arguments_invalid");
}

export function prismaNativeBuildArguments(release = false) {
  if (typeof release !== "boolean")
    throw new Error("prisma_native_profile_invalid");
  return [
    "build",
    ...(release ? ["--release"] : []),
    "--locked",
    "--package",
    "query-engine-node-api",
    "--package",
    "schema-engine-cli",
    "--message-format=json",
  ];
}

export function prismaNativeReleaseProfile(manifest, environment) {
  const release = toml.parse(manifest).profile?.release;
  if (
    release?.lto !== "fat" ||
    release["codegen-units"] !== 1 ||
    release["opt-level"] !== "s" ||
    release.package?.["query-engine-node-api"]?.strip !== "symbols" ||
    Object.keys(environment).some((key) =>
      /^(CARGO_PROFILE_RELEASE|CARGO_ENCODED_RUSTFLAGS|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_BUILD_RUSTFLAGS)/.test(
        key,
      ),
    ) ||
    environment.RUSTFLAGS !== ""
  )
    throw new Error("prisma_native_release_profile_invalid");
  return release;
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
  // Cargo links deps outputs into its profile directory. Inventory every alias.
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
  release = false,
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
      if (
        release &&
        (relative.split(path.sep)[0] !== "release" ||
          item.profile?.opt_level !== "s" ||
          item.profile?.debuginfo !== 0 ||
          item.profile?.debug_assertions !== false ||
          item.profile?.overflow_checks !== false ||
          item.profile?.test !== false)
      )
        throw new Error("prisma_native_release_artifact_profile_invalid");
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
        ...(release ? { cargoProfile: item.profile } : {}),
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
  tls,
) {
  const expected = [
    ...CHECKS,
    ...(provider === "postgresql"
      ? ["scram-authentication", "scram-over-budget-rejected"]
      : []),
    ...(tls
      ? [
          "tls-encrypted",
          "tls-untrusted-ca-rejected",
          "tls-hostname-rejected",
          "tls-plaintext-rejected",
        ]
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
    "graphql",
    ...(provider === "postgresql" ? ["scram"] : []),
    ...(tls ? ["tls"] : []),
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
    Object.keys(report.graphql || {})
      .sort()
      .join() !==
      "acceptedLexicalCases,controlQueries,maximumNesting,rejected" ||
    report.graphql.maximumNesting !== 50 ||
    report.graphql.rejected !== 6 ||
    report.graphql.acceptedLexicalCases !== 3 ||
    report.graphql.controlQueries !== 18 ||
    report.loadedLibrarySha256 !== artifacts.library.sha256 ||
    report.migrationsApplied !== 2 ||
    report.rowsRemaining !== 0 ||
    report.clientVersion !== "6.19.3" ||
    report.productionApproved !== false ||
    (tls &&
      (provider !== "postgresql" ||
        report.tls?.caSha256 !== tls.caSha256 ||
        report.tls?.serverSha256 !== tls.serverSha256 ||
        report.tls?.untrustedCaSha256 !== tls.untrustedCaSha256 ||
        !["TLSv1.2", "TLSv1.3"].includes(report.tls?.version) ||
        report.tls?.encrypted !== true ||
        report.tls?.strict !== true ||
        report.tls?.controlConnections !== 4 ||
        report.tls?.untrustedCaRejectionCode !== "P1011" ||
        report.tls?.hostnameRejectionCode !== "P1011" ||
        report.tls?.plaintextRejectionCode !== "P1010")) ||
    !Number.isInteger(report.schemaEngineInvocations) ||
    report.schemaEngineInvocations < 2 ||
    (provider === "postgresql" &&
      (report.scram?.method !== "SCRAM-SHA-256" ||
        !Number.isInteger(report.scram.iterations) ||
        report.scram.iterations < 1 ||
        report.scram.iterations > 100000 ||
        report.scram.rejectedIterations !== 100001 ||
        report.scram.controlIterations !== 4096 ||
        report.scram.controlConnections !== 2 ||
        report.scram.rejectionCode !== "P1001"))
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
  postgresTls = false,
  release = false,
}) {
  if (postgresTls && postgresPort === undefined)
    throw new Error("prisma_native_probe_arguments_invalid");
  if (postgresPort !== undefined)
    prismaNativeOptions([
      "--native-probe",
      ...(release ? ["--release"] : []),
      "--postgres-port",
      String(postgresPort),
      ...(postgresTls ? ["--postgres-tls"] : []),
    ]);
  const tls = postgresTls ? readPrismaTlsLab(root) : undefined;
  tools.env.GIT_HASH = policy.source.commit;
  const cargoProfile = release
    ? prismaNativeReleaseProfile(
        fs.readFileSync(path.join(source, "Cargo.toml"), "utf8"),
        tools.env,
      )
    : undefined;
  if (release) tools.env.CARGO_BUILD_JOBS = "1";
  if (!release) tools.env.CARGO_PROFILE_DEV_DEBUG = "0";
  const buildArguments = prismaNativeBuildArguments(release);
  const output = execute(
    tools.cargo,
    buildArguments,
    source,
    "native-build",
    release ? 2_700_000 : 1_800_000,
  );
  const artifacts = selectPrismaNativeArtifacts(
    output,
    metadata,
    tools.env.CARGO_TARGET_DIR,
    process.platform,
    release,
  );
  const work = path.join(run, "native-probe");
  fs.mkdirSync(work);
  if (tls) {
    fs.mkdirSync(path.join(work, "tls"));
    for (const role of ["ca", "server", "untrustedCa"]) {
      const file = path.join(work, "tls", `${role}.crt`);
      fs.copyFileSync(tls[`${role}File`], file, fs.constants.COPYFILE_EXCL);
      if (
        sha(fs.readFileSync(file)) !== tls[`${role}Sha256`] ||
        fs.lstatSync(file).nlink !== 1
      )
        throw new Error("prisma_tls_lab_certificate_invalid");
      tls[`${role}File`] = file;
    }
  }
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
      ...(provider === "postgresql" && tls ? { tls } : {}),
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
        provider === "postgresql" ? tls : undefined,
      ),
    );
  }
  return {
    profile: release ? "release/original-fat-lto" : "dev/debug=0",
    buildArguments,
    buildJobs: Number(tools.env.CARGO_BUILD_JOBS),
    ...(release ? { cargoProfile } : {}),
    ...(tls ? { tlsLab: tls } : {}),
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
    tlsLabScriptSha256: sha(
      fs.readFileSync(path.join(root, "scripts/security/prisma-tls-lab.mjs")),
    ),
    scope:
      "isolated native/client/migration probes; optional original release profile and strict loopback TLS; not PgBouncer, actual application migrations, whole-source or production approval",
  };
}

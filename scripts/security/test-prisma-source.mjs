import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import toml from "toml";
import { checkedNativeDirectory } from "./rebuild-esbuild.mjs";
import {
  prepareRustToolchain,
  downloadRustInput,
  checkRustSourceTree,
} from "./rust-toolchain.mjs";
import { scanRustLockfile } from "./rust-source-audit.mjs";
import { assessPrismaGitIdentities } from "./prisma-git-assessment.mjs";
import {
  validatePrismaGraphqlSource,
  preparePrismaGraphqlSource,
  checkPrismaGraphqlWiring,
  checkPrismaGraphqlMetadata,
  prismaGraphqlArguments,
  prismaGraphqlStringArguments,
} from "./prisma-graphql-source.mjs";
import { verifyGraphqlStringOutput } from "./prisma-graphql-strings.mjs";
import {
  validatePrismaMysqlSources,
  preparePrismaMysqlSources,
  checkPrismaMysqlWiring,
  checkPrismaMysqlMetadata,
} from "./prisma-mysql-source.mjs";
import {
  validatePrismaCuidSource,
  preparePrismaCuidSource,
  checkPrismaCuidWiring,
  checkPrismaCuidMetadata,
  prismaPatchedGitSources,
} from "./prisma-cuid-source.mjs";
import {
  validatePrismaWinauthSource,
  preparePrismaWinauthSource,
  checkPrismaWinauthWiring,
  checkPrismaWinauthMetadata,
} from "./prisma-winauth-source.mjs";
import {
  validatePrismaPostgresSource,
  preparePrismaPostgresSource,
  checkPrismaPostgresWiring,
  checkPrismaPostgresMetadata,
  assessPrismaPostgresIdentities,
} from "./prisma-postgres-source.mjs";
import {
  probePrismaNative,
  prismaNativeOptions,
  assertPrismaNativeRegistryAssessment,
} from "./prisma-native-probe.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const digest = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const UNIT_FEATURES = [
  "query-core/metrics",
  "schema-connector/postgresql",
  "schema-connector/mysql",
  "schema-connector/mssql",
  "schema-connector/sqlite",
  "schema-connector/cockroachdb",
];
const SOURCE_FILES = [
  "Cargo.toml",
  "query-engine/core/src/interactive_transactions/mod.rs",
  "query-engine/core/src/interactive_transactions/manager.rs",
  "query-engine/core/src/interactive_transactions/cache_capacity.rs",
  "security-contracts/Cargo.toml",
  "security-contracts/src/lib.rs",
  "query-engine/core/Cargo.toml",
  "schema-engine/connectors/schema-connector/src/checksum.rs",
  "security-contracts/src/mongodb_compression.rs",
  "security-contracts/src/mysql_contracts.rs",
  "security-contracts/src/mysql_crypto.rs",
  "security-contracts/src/cuid_contracts.rs",
  "query-engine/query-structure/Cargo.toml",
  "query-engine/query-structure/src/default_value.rs",
  "query-engine/query-engine/Cargo.toml",
  "query-engine/query-engine/src/main.rs",
  "query-engine/query-engine/src/opt.rs",
  "schema-engine/cli/Cargo.toml",
  "schema-engine/cli/src/main.rs",
  "schema-engine/cli/src/commands.rs",
  "prisma-fmt/Cargo.toml",
  "prisma-fmt/src/main.rs",
  "quaint/src/connector/mssql/native/conversion.rs",
  "query-engine/query-engine/src/server/mod.rs",
  "query-engine/query-engine/src/server/oja_http_client_contracts.rs",
  "query-engine/black-box-tests/Cargo.toml",
  "query-engine/black-box-tests/tests/protocols/mismatched.rs",
  "query-engine/black-box-tests/tests/metrics/smoke_tests.rs",
  "query-engine/query-engine/src/server/transport.rs",
  "query-engine/query-engine/src/server/oja_http_server_contracts.rs",
  "query-engine/connector-test-kit-rs/query-tests-setup/Cargo.toml",
  "quaint/Cargo.toml",
  "security-contracts/src/winauth_contracts.rs",
  "security-contracts/src/winauth_parser_contracts.rs",
  "security-contracts/src/paste_contracts.rs",
  "query-engine/schema/Cargo.toml",
  "query-engine/schema/benches/schema_builder_bench.rs",
  "query-engine/request-handlers/Cargo.toml",
  "query-engine/request-handlers/benches/query_planning_bench.rs",
  "query-engine/connector-test-kit-rs/query-engine-tests/Cargo.toml",
  "schema-engine/sql-migration-tests/Cargo.toml",
  "quaint/src/macros.rs",
  "security-contracts/src/postgres_contracts.rs",
];
const PASTE_CONSUMERS = [
  ["quaint", "quaint/Cargo.toml", "dev-dependencies"],
  [
    "query-engine-tests",
    "query-engine/connector-test-kit-rs/query-engine-tests/Cargo.toml",
    "dependencies",
  ],
  [
    "sql-migration-tests",
    "schema-engine/sql-migration-tests/Cargo.toml",
    "dev-dependencies",
  ],
];
const BENCHMARKS = [
  ["schema", "schema_builder_bench", "query-engine/schema"],
  ["request-handlers", "query_planning_bench", "query-engine/request-handlers"],
];
const MONGODB_FILES = [
  "Cargo.toml",
  "src/lib.rs",
  "src/compression.rs",
  "src/compression/compress.rs",
  "src/compression/decompress.rs",
  "src/compression/compressors.rs",
];
const exact = (value, names) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...names].sort().join();

export function validatePrismaSourcePolicy(policy) {
  if (
    !exact(policy, [
      "schemaVersion",
      "role",
      "prismaVersion",
      "source",
      "patch",
      "lockfile",
      "contractLockfile",
      "sourceFiles",
      "dependencies",
      "overrides",
      "mysqlSources",
      "cuidSource",
      "winauthSource",
      "postgresSource",
      "graphqlSource",
      "cliVersion",
      "httpClientVersion",
      "httpServerDependencies",
      "maintenanceDependencies",
    ]) ||
    policy.schemaVersion !== 1 ||
    policy.role !== "prisma-source-contracts" ||
    policy.prismaVersion !== "6.19.3" ||
    policy.cliVersion !== "4.6.7" ||
    policy.httpClientVersion !== "0.12.28" ||
    !exact(policy.httpServerDependencies, [
      "hyper",
      "hyper-util",
      "http-body-util",
      "h2",
    ]) ||
    policy.httpServerDependencies.hyper !== "1.12.0" ||
    policy.httpServerDependencies["hyper-util"] !== "0.1.21" ||
    policy.httpServerDependencies["http-body-util"] !== "0.1.5" ||
    policy.httpServerDependencies.h2 !== "0.4.20" ||
    !exact(policy.maintenanceDependencies, [
      "pastey",
      "codspeed-criterion-compat",
      "codspeed-criterion-compat-walltime",
    ]) ||
    policy.maintenanceDependencies.pastey !== "0.2.3" ||
    policy.maintenanceDependencies["codspeed-criterion-compat"] !== "6.0.0" ||
    policy.maintenanceDependencies["codspeed-criterion-compat-walltime"] !==
      "6.0.0" ||
    !exact(policy.source, ["repository", "commit", "sha256"]) ||
    policy.source.repository !== "prisma/prisma-engines" ||
    policy.source.commit !== "c2990dca591cba766e3b7ef5d9e8a84796e47ab7" ||
    !HASH.test(policy.source.sha256 || "") ||
    !exact(policy.dependencies, ["lru", "sha2"]) ||
    policy.dependencies.lru !== "0.18.2" ||
    policy.dependencies.sha2 !== "0.11.1" ||
    !Array.isArray(policy.sourceFiles) ||
    policy.sourceFiles.length !== SOURCE_FILES.length ||
    !Array.isArray(policy.overrides) ||
    policy.overrides.length !== 1
  )
    throw new Error("prisma_source_policy_invalid");
  for (const [item, name] of [
    [policy.patch, "engine.patch"],
    [policy.lockfile, "Cargo.lock"],
    [policy.contractLockfile, "contracts.Cargo.lock"],
  ]) {
    if (
      !exact(item, ["path", "sha256"]) ||
      item.path !== `vendor/native/prisma/${name}` ||
      !HASH.test(item.sha256 || "")
    )
      throw new Error("prisma_source_policy_invalid");
  }
  policy.sourceFiles.forEach((item, index) => {
    if (
      !exact(item, ["path", "sha256"]) ||
      item.path !== SOURCE_FILES[index] ||
      !HASH.test(item.sha256 || "")
    )
      throw new Error("prisma_source_policy_invalid");
  });
  const override = policy.overrides[0];
  if (
    !exact(override, [
      "name",
      "upstreamVersion",
      "version",
      "sha256",
      "patch",
      "sourceFiles",
      "dependencies",
    ]) ||
    override.name !== "mongodb" ||
    override.upstreamVersion !== "3.9.1" ||
    override.version !== "3.9.1+oja.1" ||
    !HASH.test(override.sha256 || "") ||
    !exact(override.patch, ["path", "sha256"]) ||
    override.patch.path !== "vendor/native/prisma/mongodb.patch" ||
    !HASH.test(override.patch.sha256 || "") ||
    !exact(override.dependencies, ["zstd", "zstd-safe"]) ||
    override.dependencies.zstd !== "0.14.3" ||
    override.dependencies["zstd-safe"] !== "8.2.0" ||
    !Array.isArray(override.sourceFiles) ||
    override.sourceFiles.length !== MONGODB_FILES.length
  )
    throw new Error("prisma_source_policy_invalid");
  override.sourceFiles.forEach((item, index) => {
    if (
      !exact(item, ["path", "sha256"]) ||
      item.path !== MONGODB_FILES[index] ||
      !HASH.test(item.sha256 || "")
    )
      throw new Error("prisma_source_policy_invalid");
  });
  validatePrismaMysqlSources(policy.mysqlSources);
  validatePrismaCuidSource(policy.cuidSource);
  validatePrismaWinauthSource(policy.winauthSource);
  validatePrismaPostgresSource(policy.postgresSource);
  validatePrismaGraphqlSource(policy.graphqlSource);
  return policy;
}

export function prismaSourceInput(root, input) {
  const base = fs.realpathSync(root);
  if (
    !input.path ||
    input.path.includes("\\") ||
    path.isAbsolute(input.path) ||
    input.path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("prisma_source_path_invalid");
  const file = path.join(base, input.path);
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 2 * 1024 * 1024 ||
    fs.realpathSync(file) !== file
  )
    throw new Error("prisma_source_path_invalid");
  const bytes = fs.readFileSync(file);
  if (digest(bytes) !== input.sha256)
    throw new Error("prisma_source_digest_mismatch");
  return bytes;
}

export function checkPrismaClientVersion(manifest, policy) {
  if (
    manifest?.dependencies?.["@prisma/client"] !== policy.prismaVersion ||
    manifest?.dependencies?.prisma !== policy.prismaVersion
  )
    throw new Error("prisma_source_client_version_mismatch");
  return true;
}

export function checkPrismaSourceWiring(source, policy) {
  for (const item of policy.sourceFiles) prismaSourceInput(source, item);
  checkPrismaMysqlWiring(source, policy.mysqlSources, prismaSourceInput);
  checkPrismaCuidWiring(source, policy.cuidSource, prismaSourceInput);
  checkPrismaWinauthWiring(source, policy.winauthSource, prismaSourceInput);
  checkPrismaPostgresWiring(source, policy.postgresSource, prismaSourceInput);
  const manifest = toml.parse(
    fs.readFileSync(path.join(source, "Cargo.toml"), "utf8"),
  );
  const clap = manifest.workspace.dependencies.clap;
  if (
    manifest.workspace.dependencies.reqwest !== `=${policy.httpClientVersion}`
  )
    throw new Error("prisma_http_client_wiring_invalid");
  const query = toml.parse(
    fs.readFileSync(
      path.join(source, "query-engine/query-engine/Cargo.toml"),
      "utf8",
    ),
  );
  const blackbox = toml.parse(
    fs.readFileSync(
      path.join(source, "query-engine/black-box-tests/Cargo.toml"),
      "utf8",
    ),
  );
  if (
    query["dev-dependencies"].reqwest?.workspace !== true ||
    blackbox.dependencies.reqwest?.workspace !== true ||
    !fs
      .readFileSync(
        path.join(source, "query-engine/query-engine/src/server/mod.rs"),
        "utf8",
      )
      .includes("#[cfg(test)]\nmod oja_http_client_contracts;")
  )
    throw new Error("prisma_http_client_wiring_invalid");
  for (const name of ["hyper", "hyper-util", "http-body-util"]) {
    if (
      manifest.workspace.dependencies[name] !==
        `=${policy.httpServerDependencies[name]}` ||
      query.dependencies[name]?.workspace !== true
    )
      throw new Error("prisma_http_server_wiring_invalid");
  }
  const testkit = toml.parse(
    fs.readFileSync(
      path.join(
        source,
        "query-engine/connector-test-kit-rs/query-tests-setup/Cargo.toml",
      ),
      "utf8",
    ),
  );
  const server = fs.readFileSync(
    path.join(source, "query-engine/query-engine/src/server/mod.rs"),
    "utf8",
  );
  const clientTests = fs.readFileSync(
    path.join(
      source,
      "query-engine/query-engine/src/server/oja_http_client_contracts.rs",
    ),
    "utf8",
  );
  if (
    query.dependencies.hyper.features.slice().sort().join() !==
      "http1,http2,server" ||
    query.dependencies["hyper-util"].features.slice().sort().join() !==
      "server-auto,tokio" ||
    query.dependencies.bytes?.workspace !== true ||
    !["signal", "net", "io-util"].every((f) =>
      query.dependencies.tokio.features.includes(f),
    ) ||
    testkit.dependencies.hyper?.workspace !== true ||
    testkit.dependencies.hyper?.features?.join() !== "full" ||
    !server.includes("mod transport;") ||
    !server.includes("#[cfg(test)]\nmod oja_http_server_contracts;") ||
    !server.includes("transport::serve(listener,") ||
    !clientTests.includes("transport::serve(listener,")
  )
    throw new Error("prisma_http_server_wiring_invalid");
  if (
    !exact(clap, ["version", "features"]) ||
    clap.version !== `=${policy.cliVersion}` ||
    !Array.isArray(clap.features) ||
    [...clap.features].sort().join() !== "derive,env" ||
    manifest.workspace.dependencies.structopt
  )
    throw new Error("prisma_cli_wiring_invalid");
  for (const relative of [
    "query-engine/query-engine/Cargo.toml",
    "schema-engine/cli/Cargo.toml",
    "prisma-fmt/Cargo.toml",
  ]) {
    const consumer = toml.parse(
      fs.readFileSync(path.join(source, relative), "utf8"),
    );
    const dependencies = relative.startsWith("prisma-fmt/")
      ? consumer.target['cfg(not(target_arch = "wasm32"))'].dependencies
      : consumer.dependencies;
    if (dependencies.clap?.workspace !== true || dependencies.structopt)
      throw new Error("prisma_cli_wiring_invalid");
  }
  const contract = toml.parse(
    fs.readFileSync(path.join(source, "security-contracts/Cargo.toml"), "utf8"),
  );
  const readManifest = (relative) =>
    toml.parse(fs.readFileSync(path.join(source, relative), "utf8"));
  const paste = manifest.workspace.dependencies.paste;
  if (
    !exact(paste, ["package", "version"]) ||
    paste.package !== "pastey" ||
    paste.version !== `=${policy.maintenanceDependencies.pastey}` ||
    JSON.stringify(contract.dependencies.paste) !== JSON.stringify(paste) ||
    manifest.workspace.dependencies["codspeed-criterion-compat"] !==
      `=${policy.maintenanceDependencies["codspeed-criterion-compat"]}` ||
    !fs
      .readFileSync(path.join(source, "security-contracts/src/lib.rs"), "utf8")
      .includes("#[cfg(test)]\nmod paste_contracts;")
  )
    throw new Error("prisma_maintenance_wiring_invalid");
  for (const [, relative, kind] of PASTE_CONSUMERS) {
    if (readManifest(relative)[kind]?.paste?.workspace !== true)
      throw new Error("prisma_maintenance_wiring_invalid");
  }
  for (const [, bench, relative] of BENCHMARKS) {
    const consumer = readManifest(`${relative}/Cargo.toml`);
    if (
      consumer["dev-dependencies"]?.["codspeed-criterion-compat"]?.workspace !==
        true ||
      !consumer.bench?.some(
        (target) => target.name === bench && target.harness === false,
      )
    )
      throw new Error("prisma_maintenance_wiring_invalid");
  }
  const core = toml.parse(
    fs.readFileSync(path.join(source, "query-engine/core/Cargo.toml"), "utf8"),
  );
  const override = policy.overrides[0];
  const vendor = path.join(source, "vendor", override.name);
  for (const item of override.sourceFiles) prismaSourceInput(vendor, item);
  const mongo = toml.parse(
    fs.readFileSync(path.join(vendor, "Cargo.toml"), "utf8"),
  );
  const features = [
    "zstd-compression",
    "zlib-compression",
    "snappy-compression",
  ];
  if (
    manifest.patch?.["crates-io"]?.mongodb?.path !== "vendor/mongodb" ||
    manifest.workspace.dependencies.mongodb.path !== "vendor/mongodb" ||
    manifest.workspace.dependencies.mongodb.version !==
      `=${override.version}` ||
    !manifest.workspace.exclude?.includes("vendor/mongodb") ||
    mongo.package.name !== override.name ||
    mongo.package.version !== override.version ||
    mongo.dependencies.zstd.version !== `=${override.dependencies.zstd}` ||
    !features.every((feature) =>
      manifest.workspace.dependencies.mongodb.features.includes(feature),
    ) ||
    manifest.workspace.dependencies.mongodb.features.includes(
      "oja-security-contracts",
    ) ||
    mongo.features.default.includes("oja-security-contracts") ||
    !Array.isArray(mongo.features["oja-security-contracts"]) ||
    mongo.features["oja-security-contracts"].length !== 0 ||
    contract.dependencies.mongodb.path !== "../vendor/mongodb" ||
    ![...features, "oja-security-contracts"].every((feature) =>
      contract.dependencies.mongodb.features.includes(feature),
    )
  )
    throw new Error("prisma_override_wiring_invalid");
  if (!core.dependencies.indexmap.features.includes("serde"))
    throw new Error("prisma_dependency_wiring_invalid");
  for (const [name, version] of Object.entries(policy.dependencies)) {
    if (
      manifest.workspace.dependencies[name] !== `=${version}` ||
      contract.dependencies[name] !== `=${version}`
    )
      throw new Error("prisma_dependency_wiring_invalid");
  }
  const manager = fs.readFileSync(path.join(source, SOURCE_FILES[2]), "utf8");
  const modules = fs.readFileSync(path.join(source, SOURCE_FILES[1]), "utf8");
  const testSource = fs.readFileSync(
    path.join(source, "security-contracts/src/lib.rs"),
    "utf8",
  );
  if (
    !manager.includes("cache_capacity::closed_transaction_cache") ||
    !manager.includes("closed_transaction_cache(*CLOSED_TX_CACHE_SIZE)") ||
    !modules.includes("mod cache_capacity;") ||
    !testSource.includes(
      '#[path = "../../query-engine/core/src/interactive_transactions/cache_capacity.rs"]',
    ) ||
    !testSource.includes(
      '#[path = "../../schema-engine/connectors/schema-connector/src/checksum.rs"]',
    )
  )
    throw new Error("prisma_source_tests_detached");
  return true;
}

export function checkPrismaMetadata(
  metadata,
  source,
  policy,
  { contracts = false, gitSources = [], target } = {},
) {
  if (
    !Array.isArray(metadata?.packages) ||
    !Array.isArray(metadata.resolve?.nodes)
  )
    throw new Error("prisma_metadata_invalid");
  const base = fs.realpathSync(source);
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  for (const pkg of metadata.packages) {
    if (!pkg.source) {
      const relative = path.relative(base, fs.realpathSync(pkg.manifest_path));
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error("prisma_metadata_source_escape");
    } else if (
      pkg.source !== "registry+https://github.com/rust-lang/crates.io-index" &&
      (contracts ||
        !/^git\+https:\/\/github\.com\/prisma\/[a-zA-Z0-9_-]+(?:\.git)?(?:\?[^#]*)?#[a-f0-9]{40}$/.test(
          pkg.source,
        ) ||
        !gitSources.includes(pkg.source))
    ) {
      throw new Error("prisma_metadata_source_unpinned");
    }
  }
  const rootFor = (name) =>
    metadata.packages.find((pkg) => pkg.name === name && !pkg.source);
  if (!contracts) {
    if (
      metadata.packages.some(
        (pkg) =>
          pkg.name === "rustls-pemfile" ||
          (pkg.name === "reqwest" && pkg.version !== policy.httpClientVersion),
      )
    )
      throw new Error("prisma_http_client_legacy_resolution");
    for (const name of ["black-box-tests", "query-engine"]) {
      const owner = rootFor(name);
      const dep = nodes.get(owner?.id)?.deps.find((d) => d.name === "reqwest");
      const client = packages.get(dep?.pkg);
      const node = nodes.get(client?.id);
      const h2 = packages.get(node?.deps.find((d) => d.name === "h2")?.pkg);
      if (
        client?.name !== "reqwest" ||
        client.version !== policy.httpClientVersion ||
        client.source !==
          "registry+https://github.com/rust-lang/crates.io-index" ||
        !["default-tls", "charset", "http2", "system-proxy"].every((f) =>
          node?.features?.includes(f),
        ) ||
        h2?.name !== "h2" ||
        h2.version !== "0.4.20" ||
        h2.source !== "registry+https://github.com/rust-lang/crates.io-index"
      )
        throw new Error("prisma_http_client_resolution_invalid");
    }
    if (
      metadata.packages.some(
        (pkg) =>
          Object.hasOwn(policy.httpServerDependencies, pkg.name) &&
          (pkg.version !== policy.httpServerDependencies[pkg.name] ||
            pkg.source !==
              "registry+https://github.com/rust-lang/crates.io-index"),
      )
    )
      throw new Error("prisma_http_server_legacy_resolution");
    const query = rootFor("query-engine");
    for (const [name, features] of [
      ["hyper", ["server", "http1", "http2"]],
      ["hyper-util", ["server-auto", "tokio", "http1", "http2"]],
      ["http-body-util", []],
    ]) {
      const dep = nodes
        .get(query?.id)
        ?.deps.find((d) => d.name === name.replaceAll("-", "_"));
      const pkg = packages.get(dep?.pkg);
      if (
        pkg?.name !== name ||
        pkg.version !== policy.httpServerDependencies[name] ||
        !features.every((f) => nodes.get(pkg?.id)?.features.includes(f))
      )
        throw new Error("prisma_http_server_resolution_invalid");
    }
    const hyper = packages.get(
      nodes.get(query?.id)?.deps.find((d) => d.name === "hyper")?.pkg,
    );
    const h2 = packages.get(
      nodes.get(hyper?.id)?.deps.find((d) => d.name === "h2")?.pkg,
    );
    const testkit = rootFor("query-tests-setup");
    if (
      h2?.name !== "h2" ||
      h2.version !== policy.httpServerDependencies.h2 ||
      nodes.get(testkit?.id)?.deps.find((d) => d.name === "hyper")?.pkg !==
        hyper?.id
    )
      throw new Error("prisma_http_server_resolution_invalid");
    if (
      metadata.packages.some((pkg) =>
        [
          "structopt",
          "structopt-derive",
          "ansi_term",
          "proc-macro-error",
        ].includes(pkg.name),
      )
    )
      throw new Error("prisma_cli_legacy_resolution");
    for (const [name, relative] of [
      ["query-engine", "query-engine/query-engine"],
      ["schema-engine-cli", "schema-engine/cli"],
      ["prisma-fmt", "prisma-fmt"],
    ]) {
      const owner = rootFor(name);
      const dependency = nodes
        .get(owner?.id)
        ?.deps.find((dep) => dep.name === "clap");
      const resolved = packages.get(dependency?.pkg);
      const features = nodes.get(resolved?.id)?.features || [];
      if (
        !owner ||
        path.dirname(fs.realpathSync(owner.manifest_path)) !==
          path.join(base, relative) ||
        resolved?.name !== "clap" ||
        resolved.version !== policy.cliVersion ||
        resolved.source !==
          "registry+https://github.com/rust-lang/crates.io-index" ||
        !["derive", "env"].every((feature) => features.includes(feature))
      )
        throw new Error("prisma_cli_resolution_invalid");
    }
  }
  if (contracts) {
    const locals = metadata.packages.filter((pkg) => !pkg.source);
    if (
      locals.length !== 13 ||
      !rootFor("oja-prisma-source-contracts") ||
      path.dirname(
        fs.realpathSync(rootFor("oja-prisma-source-contracts").manifest_path),
      ) !== path.join(base, "security-contracts")
    )
      throw new Error("prisma_contract_root_invalid");
  }
  checkPrismaMysqlMetadata(metadata, source, policy.mysqlSources, {
    contracts,
  });
  checkPrismaCuidMetadata(metadata, source, policy.cuidSource, { contracts });
  checkPrismaPostgresMetadata(metadata, source, policy.postgresSource, {
    contracts,
  });
  checkPrismaWinauthMetadata(metadata, source, policy.winauthSource, {
    contracts,
    target,
  });
  checkPrismaMaintenanceMetadata(metadata, policy, { contracts });
  const override = policy.overrides[0];
  const mongo = metadata.packages.filter((pkg) => pkg.name === override.name);
  const node = nodes.get(mongo[0]?.id);
  if (
    mongo.length !== 1 ||
    mongo[0].source ||
    mongo[0].version !== override.version ||
    path.dirname(fs.realpathSync(mongo[0].manifest_path)) !==
      path.join(base, "vendor", override.name) ||
    !["zstd-compression", "zlib-compression", "snappy-compression"].every(
      (feature) => node?.features?.includes(feature),
    ) ||
    Boolean(node?.features?.includes("oja-security-contracts")) !== contracts
  )
    throw new Error("prisma_override_unbound");
  const zstd = packages.get(node.deps.find((dep) => dep.name === "zstd")?.pkg);
  const safe = packages.get(
    nodes.get(zstd?.id)?.deps.find((dep) => dep.name === "zstd_safe")?.pkg,
  );
  if (
    zstd?.version !== override.dependencies.zstd ||
    safe?.version !== override.dependencies["zstd-safe"] ||
    [zstd, safe].some(
      (pkg) =>
        pkg?.source !== "registry+https://github.com/rust-lang/crates.io-index",
    ) ||
    metadata.packages.some(
      (pkg) =>
        Object.hasOwn(override.dependencies, pkg.name) &&
        pkg.version !== override.dependencies[pkg.name],
    )
  )
    throw new Error("prisma_compression_resolution_invalid");
  for (const [owner, name] of contracts
    ? [
        ["oja-prisma-source-contracts", "lru"],
        ["oja-prisma-source-contracts", "sha2"],
      ]
    : [
        ["query-core", "lru"],
        ["schema-connector", "sha2"],
      ]) {
    const root = rootFor(owner);
    const dep = nodes.get(root?.id)?.deps.find((item) => item.name === name);
    if (!dep || packages.get(dep.pkg)?.version !== policy.dependencies[name])
      throw new Error("prisma_dependency_resolution_invalid");
  }
  return true;
}

export function rustTestTotals(output, minimum) {
  const suites = [
    ...output.matchAll(
      /test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;/g,
    ),
  ];
  const total = { passed: 0, failed: 0, ignored: 0, suites: suites.length };
  for (const match of suites) {
    total.passed += Number(match[1]);
    total.failed += Number(match[2]);
    total.ignored += Number(match[3]);
  }
  if (
    total.passed < minimum ||
    total.failed ||
    total.ignored ||
    output.includes("test result: FAILED")
  )
    throw new Error("prisma_source_tests_incomplete");
  return total;
}

export function prismaUnitArguments() {
  return [
    "test",
    "--locked",
    "--package",
    "query-core",
    "--package",
    "schema-connector",
    "--features",
    UNIT_FEATURES.join(","),
    "--lib",
  ];
}

export function prismaParserTestTotals(output) {
  const cases = [
    ...output.matchAll(/^test winauth_parser_contracts::(\S+) \.\.\. (.+)$/gm),
  ];
  if (
    cases.length !== 24 ||
    new Set(cases.map((item) => item[1])).size !== 24 ||
    cases.some((item) => item[2].trim() !== "ok")
  )
    throw new Error("prisma_parser_tests_incomplete");
  return { passed: 24, failed: 0, ignored: 0 };
}

export function checkPrismaMaintenanceMetadata(
  metadata,
  policy,
  { contracts = false } = {},
) {
  const registry = "registry+https://github.com/rust-lang/crates.io-index";
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const owner = (name) =>
    metadata.packages.find((pkg) => pkg.name === name && !pkg.source);
  const dependency = (pkg, name) =>
    packages.get(
      nodes.get(pkg?.id)?.deps.find((dep) => dep.name === name)?.pkg,
    );
  for (const pkg of metadata.packages) {
    if (
      ["atty", "paste"].includes(pkg.name) ||
      (pkg.name === "criterion" && pkg.version === "0.4.0") ||
      (Object.hasOwn(policy.maintenanceDependencies, pkg.name) &&
        (pkg.version !== policy.maintenanceDependencies[pkg.name] ||
          pkg.source !== registry))
    )
      throw new Error("prisma_maintenance_resolution_invalid");
  }
  const macro = metadata.packages.filter((pkg) => pkg.name === "pastey");
  if (macro.length !== 1)
    throw new Error("prisma_maintenance_resolution_invalid");
  for (const name of contracts
    ? ["oja-prisma-source-contracts"]
    : PASTE_CONSUMERS.map(([name]) => name)) {
    if (dependency(owner(name), "paste")?.id !== macro[0].id)
      throw new Error("prisma_maintenance_resolution_invalid");
  }
  if (contracts) return true;
  const compat = metadata.packages.filter(
    (pkg) => pkg.name === "codspeed-criterion-compat",
  );
  const walltime = metadata.packages.filter(
    (pkg) => pkg.name === "codspeed-criterion-compat-walltime",
  );
  const speed = dependency(compat[0], "codspeed");
  if (
    compat.length !== 1 ||
    walltime.length !== 1 ||
    dependency(compat[0], "criterion")?.id !== walltime[0].id ||
    speed?.name !== "codspeed" ||
    speed.version !== "6.0.0" ||
    speed.source !== registry ||
    !["rayon", "plotters", "cargo_bench_support"].every((f) =>
      nodes.get(compat[0]?.id)?.features?.includes(f),
    )
  )
    throw new Error("prisma_maintenance_resolution_invalid");
  for (const [name, bench] of BENCHMARKS) {
    const consumer = owner(name);
    if (
      dependency(consumer, "codspeed_criterion_compat")?.id !== compat[0].id ||
      !consumer?.targets?.some(
        (target) => target.name === bench && target.kind.includes("bench"),
      )
    )
      throw new Error("prisma_maintenance_resolution_invalid");
  }
  return true;
}

export function prismaPostgresTestTotals(output) {
  const entries = [
    ...output.matchAll(/^test postgres_contracts::(\S+) \.\.\. (.+)$/gm),
  ];
  if (
    entries.length !== 24 ||
    new Set(entries.map((match) => match[1])).size !== 24 ||
    entries.some((match) => match[2].trim() !== "ok")
  )
    throw new Error("prisma_postgres_tests_incomplete");
  return { passed: 24, failed: 0, ignored: 0 };
}

export function prismaPasteTestTotals(output) {
  const cases = [
    ...output.matchAll(/^test paste_contracts::(\S+) \.\.\. (.+)$/gm),
  ];
  if (
    cases.length !== 8 ||
    new Set(cases.map((item) => item[1])).size !== 8 ||
    cases.some((item) => item[2].trim() !== "ok")
  )
    throw new Error("prisma_paste_tests_incomplete");
  return { passed: 8, failed: 0, ignored: 0 };
}

export function prismaBenchmarkArguments() {
  return BENCHMARKS.map(([name, bench]) => ({
    label: `benchmark-${name}`,
    args: [
      "test",
      "--locked",
      "--package",
      name,
      // The planning benchmark imports connector types through request-handlers.
      ...(name === "request-handlers"
        ? ["--features", "request-handlers/all"]
        : []),
      "--bench",
      bench,
      "--",
      "--test",
    ],
    cases:
      name === "schema"
        ? [
            "psl::validate (small)",
            "schema_builder::build (small)",
            "psl::validate (medium)",
            "schema_builder::build (medium)",
            "psl::validate (large)",
            "schema_builder::build (large)",
          ]
        : [
            "small_read",
            "medium_read",
            "large_read",
            "deep_read_query",
            "mutation",
          ],
  }));
}

export function prismaBenchmarkTotals(output, cases) {
  const successes = [...output.matchAll(/^Testing (.+)\r?\nSuccess\r?$/gm)].map(
    (match) => match[1],
  );
  if (
    successes.length !== cases.length ||
    new Set(successes).size !== cases.length ||
    cases.some((name) => !successes.includes(name))
  )
    throw new Error("prisma_benchmark_tests_incomplete");
  return {
    passed: cases.length,
    failed: 0,
    scope:
      "existing benchmark correctness smoke; not timing or instrumentation approval",
  };
}

export function prismaPasteConsumerArguments() {
  return [
    "check",
    "--locked",
    "--package",
    "quaint",
    "--package",
    "query-engine-tests",
    "--package",
    "sql-migration-tests",
    "--features",
    "quaint/all-native",
    "--tests",
  ];
}

export function prismaCliArguments() {
  return [
    {
      label: "cli-query",
      minimum: 9,
      args: [
        "test",
        "--locked",
        "--package",
        "query-engine",
        "--lib",
        "--bin",
        "query-engine",
        "oja_cli_contracts",
      ],
    },
    {
      label: "cli-schema",
      minimum: 9,
      args: [
        "test",
        "--locked",
        "--package",
        "schema-engine-cli",
        "--bin",
        "schema-engine",
        "oja_cli_contracts",
      ],
    },
    {
      label: "cli-fmt",
      minimum: 5,
      args: [
        "test",
        "--locked",
        "--package",
        "prisma-fmt",
        "--bin",
        "prisma-fmt",
        "oja_cli_contracts",
      ],
    },
    {
      label: "cli-mssql-numeric",
      minimum: 5,
      args: [
        "test",
        "--locked",
        "--package",
        "quaint",
        "--lib",
        "--features",
        "mssql-native",
        "oja_cli_contracts",
      ],
    },
  ];
}

export function prismaContractAssessment(policy, report) {
  const gitSources = prismaPatchedGitSources(policy);
  return {
    ...report,
    registryAuditOk: report.sourceAuditOk,
    sourceAuditOk: report.sourceAuditOk && gitSources.length === 0,
    unresolved: [...report.unresolved, ...gitSources],
  };
}

export function prismaHttpClientArguments() {
  return [
    "test",
    "--locked",
    "--package",
    "query-engine",
    "--lib",
    "oja_http_client_contracts",
  ];
}

export function prismaHttpClientCheckArguments() {
  return ["check", "--locked", "--package", "black-box-tests", "--tests"];
}

export function prismaHttpServerArguments() {
  return [
    "test",
    "--locked",
    "--package",
    "query-engine",
    "--lib",
    "oja_http_server_contracts",
  ];
}

export function prismaSourceReceipt(policy, engine, contracts, tests = null) {
  const patchedGitSources = prismaPatchedGitSources(policy).length;
  return {
    schemaVersion: 1,
    role: policy.role,
    artifactStatus: "NOT_VERIFIED",
    productionApproved: false,
    wholeEngineVerified: false,
    source: policy.source,
    patchSha256: policy.patch.sha256,
    overrides: policy.overrides,
    mysqlSources: policy.mysqlSources,
    cuidSource: policy.cuidSource,
    winauthSource: policy.winauthSource,
    postgresSource: policy.postgresSource,
    graphqlSource: policy.graphqlSource,
    cliVersion: policy.cliVersion,
    httpClientVersion: policy.httpClientVersion,
    httpServerDependencies: policy.httpServerDependencies,
    maintenanceDependencies: policy.maintenanceDependencies,
    engineRegistryPackages: engine.packageCount,
    engineAdvisoryMatches: engine.findings.length,
    unreviewedGitSources: engine.unresolved.length + patchedGitSources,
    unreviewedPatchedGitSources: patchedGitSources,
    engineSourceAuditOk: engine.sourceAuditOk && patchedGitSources === 0,
    contractRegistryPackages: contracts.packageCount,
    contractSourceAuditOk: contracts.sourceAuditOk && patchedGitSources === 0,
    contractRegistryAuditOk:
      contracts.registryAuditOk ?? contracts.sourceAuditOk,
    contractUnreviewedGitSources: patchedGitSources,
    contractSourceReviewed: false,
    tests,
    observedAt: new Date().toISOString(),
  };
}

export async function testPrismaSource(
  root = ROOT,
  {
    assessOnly = false,
    upstreamUnits = false,
    graphqlOnly = false,
    nativeProbe = false,
    postgresPort,
    postgresTls = false,
    release = false,
  } = {},
) {
  if (
    (nativeProbe && (assessOnly || upstreamUnits || graphqlOnly)) ||
    (graphqlOnly && (assessOnly || upstreamUnits)) ||
    (!nativeProbe && (postgresPort !== undefined || postgresTls || release)) ||
    (postgresTls && postgresPort === undefined)
  )
    throw new Error("unexpected_prisma_source_arguments");
  if (postgresPort !== undefined)
    prismaNativeOptions([
      "--native-probe",
      ...(release ? ["--release"] : []),
      "--postgres-port",
      String(postgresPort),
      ...(postgresTls ? ["--postgres-tls"] : []),
    ]);
  const policyBytes = fs.readFileSync(
    path.join(root, "security/prisma-source-contracts.json"),
  );
  const policy = validatePrismaSourcePolicy(JSON.parse(policyBytes));
  checkPrismaClientVersion(
    JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")),
    policy,
  );
  const patch = prismaSourceInput(root, policy.patch);
  const lock = prismaSourceInput(root, policy.lockfile);
  const contractLock = prismaSourceInput(root, policy.contractLockfile);
  for (const override of policy.overrides)
    prismaSourceInput(root, override.patch);
  for (const entry of policy.mysqlSources) prismaSourceInput(root, entry.patch);
  prismaSourceInput(root, policy.cuidSource.patch);
  prismaSourceInput(root, policy.winauthSource.patch);
  prismaSourceInput(root, policy.postgresSource.patch);
  prismaSourceInput(root, policy.graphqlSource.patch);
  const tools = await prepareRustToolchain(root);
  const { env, home, cargo } = tools;
  const out = checkedNativeDirectory(root, ".audit/native-prisma");
  const run = fs.mkdtempSync(path.join(out, "run-"));
  const write = (name, value) =>
    fs.writeFileSync(path.join(run, name), value, { flag: "wx" });
  const json = (name, value) =>
    write(name, `${JSON.stringify(value, null, 2)}\n`);
  const execute = (command, args, cwd, label, timeout = 600_000) => {
    const result = spawnSync(command, args, {
      cwd,
      env,
      timeout,
      maxBuffer: 40 * 1024 * 1024,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
    write(`${label}.stdout.log`, result.stdout || "");
    write(`${label}.stderr.log`, result.stderr || "");
    if (result.error || result.status !== 0)
      throw new Error(`prisma_source_command_failed:${label}`);
    return result.stdout;
  };
  const cache = checkedNativeDirectory(root, ".audit/rust-cache");
  const archive = path.join(cache, "prisma-source.tar.gz");
  await downloadRustInput(
    `https://codeload.github.com/${policy.source.repository}/tar.gz/${policy.source.commit}`,
    archive,
    policy.source.sha256,
  );
  execute("tar", ["-xf", archive, "-C", home], root, "extract");
  const source = path.join(home, `prisma-engines-${policy.source.commit}`);
  checkRustSourceTree(source);
  const vendor = path.join(source, "vendor");
  if (fs.existsSync(vendor))
    throw new Error("prisma_unexpected_vendor_directory");
  fs.mkdirSync(vendor);
  for (const override of policy.overrides) {
    const name = `${override.name}-${override.upstreamVersion}`;
    const archive = path.join(cache, `${name}.crate`);
    await downloadRustInput(
      `https://static.crates.io/crates/${override.name}/${name}.crate`,
      archive,
      override.sha256,
    );
    execute("tar", ["-xf", archive, "-C", vendor], root, "override-extract");
    const unpacked = path.join(vendor, name);
    checkRustSourceTree(unpacked);
    const target = path.join(vendor, override.name);
    // Fixed children of a newly created private directory, never an existing cache.
    fs.renameSync(unpacked, target);
    execute(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "apply",
        "--check",
        path.join(root, override.patch.path),
      ],
      target,
      "override-patch-check",
    );
    execute(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "apply",
        path.join(root, override.patch.path),
      ],
      target,
      "override-patch",
    );
  }
  await preparePrismaMysqlSources(
    root,
    source,
    cache,
    policy.mysqlSources,
    execute,
    prismaSourceInput,
  );
  await preparePrismaCuidSource(
    root,
    source,
    cache,
    policy.cuidSource,
    execute,
    prismaSourceInput,
  );
  await preparePrismaWinauthSource(
    root,
    source,
    cache,
    policy.winauthSource,
    execute,
    prismaSourceInput,
  );
  await preparePrismaPostgresSource(
    root,
    source,
    cache,
    policy.postgresSource,
    execute,
    prismaSourceInput,
  );
  await preparePrismaGraphqlSource(
    root,
    source,
    cache,
    policy.graphqlSource,
    execute,
    prismaSourceInput,
  );
  execute(
    "git",
    [
      "-c",
      "core.autocrlf=false",
      "apply",
      "--check",
      path.join(root, policy.patch.path),
    ],
    source,
    "patch-check",
  );
  execute(
    "git",
    ["-c", "core.autocrlf=false", "apply", path.join(root, policy.patch.path)],
    source,
    "patch",
  );
  checkPrismaSourceWiring(source, policy);
  checkPrismaGraphqlWiring(source, policy.graphqlSource, prismaSourceInput);
  fs.writeFileSync(path.join(source, "Cargo.lock"), lock);
  fs.writeFileSync(
    path.join(source, "security-contracts/Cargo.lock"),
    contractLock,
    { flag: "wx" },
  );
  const engine = await scanRustLockfile(lock.toString("utf8"));
  const contracts = prismaContractAssessment(
    policy,
    await scanRustLockfile(contractLock.toString("utf8")),
  );
  // Path overrides must not conceal new advisories against their original crate.
  const overrideLock = [
    ...policy.overrides,
    ...policy.mysqlSources.filter((entry) => !entry.gitSource),
    policy.winauthSource,
  ]
    .map(
      (entry) =>
        `[[package]]\nname = ${JSON.stringify(entry.name)}\nversion = ${JSON.stringify(entry.upstreamVersion)}\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = ${JSON.stringify(entry.sha256)}\n`,
    )
    .join("\n");
  const overrides = await scanRustLockfile(overrideLock);
  json("engine-source-assessment.json", engine);
  json("contract-source-assessment.json", contracts);
  json("override-source-assessment.json", overrides);
  json(
    "postgres-original-identity-assessment.json",
    await assessPrismaPostgresIdentities(policy.postgresSource),
  );
  // A clean small test graph is not an approval of the complete engine graph.
  if (!contracts.registryAuditOk || !overrides.sourceAuditOk)
    throw new Error("prisma_contract_advisories_unresolved");
  if (nativeProbe) assertPrismaNativeRegistryAssessment(engine);
  const common = [
    "metadata",
    "--locked",
    "--format-version",
    "1",
    "--filter-platform",
    tools.receipt.target,
  ];
  const metadata = JSON.parse(
    execute(cargo, common, source, "engine-metadata"),
  );
  const contractMetadata = JSON.parse(
    execute(
      cargo,
      [...common, "--manifest-path", "security-contracts/Cargo.toml"],
      source,
      "contract-metadata",
    ),
  );
  const gitSources = toml
    .parse(lock.toString("utf8"))
    .package.map((pkg) => pkg.source)
    .filter((value) => typeof value === "string" && value.startsWith("git+"));
  checkPrismaMetadata(metadata, source, policy, {
    gitSources,
    target: tools.receipt.target,
  });
  checkPrismaMetadata(contractMetadata, source, policy, {
    contracts: true,
    target: tools.receipt.target,
  });
  checkPrismaGraphqlMetadata(metadata, source, policy.graphqlSource);
  json("engine-metadata.json", metadata);
  json("contract-metadata.json", contractMetadata);
  const gitAssessment = await assessPrismaGitIdentities(policy, lock, metadata);
  json("git-original-identity-assessment.json", gitAssessment);
  const tests = {};
  if (!assessOnly && !nativeProbe) {
    tests.graphql = rustTestTotals(
      execute(
        cargo,
        prismaGraphqlArguments(),
        source,
        "graphql-contracts",
        900_000,
      ),
      18,
    );
    tests.graphqlUpstream = rustTestTotals(
      execute(
        cargo,
        ["test", "--locked", "--package", "graphql-parser", "--lib"],
        source,
        "graphql-upstream",
        900_000,
      ),
      61,
    );
    tests.graphqlStrings = verifyGraphqlStringOutput(
      execute(
        cargo,
        prismaGraphqlStringArguments(),
        source,
        "graphql-strings",
        900_000,
      ),
      "regressions",
    );
  }
  if (!assessOnly && !nativeProbe && !graphqlOnly) {
    const contractOutput = execute(
      cargo,
      [
        "test",
        "--locked",
        "--manifest-path",
        "security-contracts/Cargo.toml",
        "--lib",
      ],
      source,
      "contracts",
      900_000,
    );
    tests.contracts = rustTestTotals(contractOutput, 120);
    tests.postgres = prismaPostgresTestTotals(contractOutput);
    tests.ntlmParser = prismaParserTestTotals(contractOutput);
    tests.paste = prismaPasteTestTotals(contractOutput);
    env.GIT_HASH = policy.source.commit;
    tests.cli = {};
    for (const command of prismaCliArguments()) {
      tests.cli[command.label] = rustTestTotals(
        execute(cargo, command.args, source, command.label, 1_800_000),
        command.minimum,
      );
    }
    tests.httpClient = rustTestTotals(
      execute(
        cargo,
        prismaHttpClientArguments(),
        source,
        "http-client",
        1_800_000,
      ),
      9,
    );
    execute(
      cargo,
      prismaHttpClientCheckArguments(),
      source,
      "http-client-consumers",
      1_800_000,
    );
    tests.httpClientConsumersChecked = true;
    tests.httpServer = rustTestTotals(
      execute(
        cargo,
        prismaHttpServerArguments(),
        source,
        "http-server",
        1_800_000,
      ),
      14,
    );
    if (upstreamUnits) {
      env.GIT_HASH = policy.source.commit;
      tests.upstreamUnits = rustTestTotals(
        execute(
          cargo,
          prismaUnitArguments(),
          source,
          "upstream-units",
          1_800_000,
        ),
        8,
      );
    }
    tests.benchmarks = {};
    for (const command of prismaBenchmarkArguments()) {
      tests.benchmarks[command.label] = prismaBenchmarkTotals(
        execute(cargo, command.args, source, command.label, 1_800_000),
        command.cases,
      );
    }
    execute(
      cargo,
      prismaPasteConsumerArguments(),
      source,
      "paste-consumers",
      1_800_000,
    );
    tests.pasteConsumersChecked = true;
  }
  if (nativeProbe)
    tests.nativeProbe = await probePrismaNative({
      root,
      source,
      tools,
      execute,
      policy,
      metadata,
      run,
      postgresPort,
      postgresTls,
      release,
    });
  if (
    digest(fs.readFileSync(path.join(source, "Cargo.lock"))) !==
      policy.lockfile.sha256 ||
    digest(
      fs.readFileSync(path.join(source, "security-contracts/Cargo.lock")),
    ) !== policy.contractLockfile.sha256
  )
    throw new Error("prisma_lock_changed_during_test");
  checkPrismaSourceWiring(source, policy);
  checkPrismaGraphqlWiring(source, policy.graphqlSource, prismaSourceInput);
  const receipt = {
    ...prismaSourceReceipt(
      policy,
      engine,
      contracts,
      assessOnly ? null : tests,
    ),
    policySha256: digest(policyBytes),
    compiler: tools.receipt,
    engineLockfileSha256: digest(lock),
    contractLockfileSha256: digest(contractLock),
    sourceFiles: policy.sourceFiles,
    overrideSourceAuditOk: overrides.sourceAuditOk,
    gitIdentityAssessmentSha256: digest(JSON.stringify(gitAssessment)),
    testScope: graphqlOnly
      ? "actual adopted GraphQL depth/string contracts and complete library units; not complete engine, NAPI, database or production approval"
      : nativeProbe
        ? "native NAPI/schema and synthetic migrations/client probes; explicit optional release/TLS evidence only; not PgBouncer, actual app migrations, whole-engine or production approval"
        : "source modules; not NAPI, migrations, database or production approval",
    upstreamUnitFeatures: upstreamUnits && !assessOnly ? UNIT_FEATURES : [],
  };
  json("receipt.json", receipt);
  return {
    ...receipt,
    evidenceDirectory: path.relative(root, run),
    patchSha256: digest(patch),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const args = process.argv.slice(2);
    const nativeOptions = args.includes("--native-probe")
      ? prismaNativeOptions(args)
      : {};
    if (
      !nativeOptions.nativeProbe &&
      (args.length > 1 ||
        args.some(
          (arg) =>
            !["--assess-only", "--upstream-units", "--graphql-only"].includes(
              arg,
            ),
        ))
    )
      throw new Error("unexpected_prisma_source_arguments");
    const result = await testPrismaSource(ROOT, {
      assessOnly: args.includes("--assess-only"),
      upstreamUnits: args.includes("--upstream-units"),
      graphqlOnly: args.includes("--graphql-only"),
      ...nativeOptions,
    });
    console.log(
      JSON.stringify({
        artifactStatus: result.artifactStatus,
        productionApproved: result.productionApproved,
        wholeEngineVerified: result.wholeEngineVerified,
        engineAdvisoryMatches: result.engineAdvisoryMatches,
        unreviewedGitSources: result.unreviewedGitSources,
        contractSourceAuditOk: result.contractSourceAuditOk,
        tests: result.tests,
        evidenceDirectory: result.evidenceDirectory,
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

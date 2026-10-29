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
    ]) ||
    policy.schemaVersion !== 1 ||
    policy.role !== "prisma-source-contracts" ||
    policy.prismaVersion !== "6.19.3" ||
    !exact(policy.source, ["repository", "commit", "sha256"]) ||
    policy.source.repository !== "prisma/prisma-engines" ||
    policy.source.commit !== "c2990dca591cba766e3b7ef5d9e8a84796e47ab7" ||
    !HASH.test(policy.source.sha256 || "") ||
    !exact(policy.dependencies, ["lru", "sha2"]) ||
    policy.dependencies.lru !== "0.18.2" ||
    policy.dependencies.sha2 !== "0.11.1" ||
    !Array.isArray(policy.sourceFiles) ||
    policy.sourceFiles.length !== SOURCE_FILES.length
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
  const manifest = toml.parse(
    fs.readFileSync(path.join(source, "Cargo.toml"), "utf8"),
  );
  const contract = toml.parse(
    fs.readFileSync(path.join(source, "security-contracts/Cargo.toml"), "utf8"),
  );
  const core = toml.parse(
    fs.readFileSync(path.join(source, "query-engine/core/Cargo.toml"), "utf8"),
  );
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
  { contracts = false, gitSources = [] } = {},
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
  if (contracts) {
    const locals = metadata.packages.filter((pkg) => !pkg.source);
    if (
      locals.length !== 1 ||
      locals[0].name !== "oja-prisma-source-contracts" ||
      path.dirname(fs.realpathSync(locals[0].manifest_path)) !==
        path.join(base, "security-contracts")
    )
      throw new Error("prisma_contract_root_invalid");
  }
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

export function prismaSourceReceipt(policy, engine, contracts, tests = null) {
  return {
    schemaVersion: 1,
    role: policy.role,
    artifactStatus: "NOT_VERIFIED",
    productionApproved: false,
    wholeEngineVerified: false,
    source: policy.source,
    patchSha256: policy.patch.sha256,
    engineRegistryPackages: engine.packageCount,
    engineAdvisoryMatches: engine.findings.length,
    unreviewedGitSources: engine.unresolved.length,
    engineSourceAuditOk: engine.sourceAuditOk,
    contractRegistryPackages: contracts.packageCount,
    contractSourceAuditOk: contracts.sourceAuditOk,
    tests,
    observedAt: new Date().toISOString(),
  };
}

export async function testPrismaSource(
  root = ROOT,
  { assessOnly = false, upstreamUnits = false } = {},
) {
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
  fs.writeFileSync(path.join(source, "Cargo.lock"), lock);
  fs.writeFileSync(
    path.join(source, "security-contracts/Cargo.lock"),
    contractLock,
    { flag: "wx" },
  );
  const engine = await scanRustLockfile(lock.toString("utf8"));
  const contracts = await scanRustLockfile(contractLock.toString("utf8"));
  json("engine-source-assessment.json", engine);
  json("contract-source-assessment.json", contracts);
  // A clean small test graph is not an approval of the complete engine graph.
  if (!contracts.sourceAuditOk)
    throw new Error("prisma_contract_advisories_unresolved");
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
  checkPrismaMetadata(metadata, source, policy, { gitSources });
  checkPrismaMetadata(contractMetadata, source, policy, { contracts: true });
  json("engine-metadata.json", metadata);
  json("contract-metadata.json", contractMetadata);
  const tests = {};
  if (!assessOnly) {
    tests.contracts = rustTestTotals(
      execute(
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
      ),
      11,
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
  }
  if (
    digest(fs.readFileSync(path.join(source, "Cargo.lock"))) !==
      policy.lockfile.sha256 ||
    digest(
      fs.readFileSync(path.join(source, "security-contracts/Cargo.lock")),
    ) !== policy.contractLockfile.sha256
  )
    throw new Error("prisma_lock_changed_during_test");
  checkPrismaSourceWiring(source, policy);
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
    testScope:
      "source modules; not NAPI, migrations, database or production approval",
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
    if (
      args.length > 1 ||
      args.some((arg) => !["--assess-only", "--upstream-units"].includes(arg))
    )
      throw new Error("unexpected_prisma_source_arguments");
    const result = await testPrismaSource(ROOT, {
      assessOnly: args.includes("--assess-only"),
      upstreamUnits: args.includes("--upstream-units"),
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

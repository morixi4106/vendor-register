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
import {
  scanRustLockfile,
  rustRegistryPackages,
} from "./rust-source-audit.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const keys = (object, names) =>
  object &&
  typeof object === "object" &&
  !Array.isArray(object) &&
  Object.keys(object).sort().join() === [...names].sort().join();

export function validateRunnerPolicy(policy) {
  if (
    !keys(policy, [
      "schemaVersion",
      "role",
      "version",
      "source",
      "patch",
      "lockfile",
      "overrides",
    ]) ||
    policy.schemaVersion !== 1 ||
    policy.role !== "function-runner" ||
    policy.version !== "9.2.2+oja.1" ||
    !keys(policy.source, ["repository", "commit", "sha256"]) ||
    policy.source.repository !== "Shopify/function-runner" ||
    policy.source.commit !== "47dca499b04de5158822cc451cd4daf61dfd0fd0" ||
    !HASH.test(policy.source.sha256 || "") ||
    !Array.isArray(policy.overrides) ||
    policy.overrides.length !== 2
  )
    throw new Error("runner_policy_invalid");
  const checked = (item, filename) => {
    if (
      !keys(item, ["path", "sha256"]) ||
      item.path !== `vendor/native/function-runner/${filename}` ||
      !HASH.test(item.sha256 || "")
    )
      throw new Error("runner_policy_invalid");
  };
  checked(policy.patch, "runner.patch");
  checked(policy.lockfile, "Cargo.lock");
  for (const [index, name, version, file] of [
    [0, "wasmtime-internal-cache", "36.0.19", "cache.patch"],
    [1, "fxprof-processed-profile", "0.6.0", "profiler.patch"],
  ]) {
    const entry = policy.overrides[index];
    if (
      !keys(entry, ["name", "upstreamVersion", "version", "sha256", "patch"]) ||
      entry.name !== name ||
      entry.upstreamVersion !== version ||
      entry.version !== `${version}+oja.1` ||
      !HASH.test(entry.sha256 || "")
    )
      throw new Error("runner_policy_invalid");
    checked(entry.patch, file);
  }
  return policy;
}

export function runnerInput(root, input) {
  const base = fs.realpathSync(root);
  const filename = path.join(base, input.path);
  const stat = fs.lstatSync(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 2 * 1024 * 1024 ||
    fs.realpathSync(filename) !== filename ||
    hash(fs.readFileSync(filename)) !== input.sha256
  )
    throw new Error("runner_input_digest_mismatch");
  return fs.readFileSync(filename);
}

export function validateRunnerMetadata(metadata, source, policy) {
  if (
    !Array.isArray(metadata?.packages) ||
    !Array.isArray(metadata.resolve?.nodes)
  )
    throw new Error("runner_metadata_invalid");
  const root = fs.realpathSync(source);
  const local = metadata.packages.filter((pkg) => !pkg.source);
  for (const pkg of metadata.packages) {
    if (
      pkg.source &&
      pkg.source !== "registry+https://github.com/rust-lang/crates.io-index"
    )
      throw new Error("runner_non_registry_dependency");
  }
  for (const pkg of local) {
    const directory = fs.realpathSync(path.dirname(pkg.manifest_path));
    const relative = path.relative(root, directory);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error("runner_metadata_source_escape");
  }
  const rootPackage = local.find(
    (pkg) => path.dirname(fs.realpathSync(pkg.manifest_path)) === root,
  );
  if (
    rootPackage?.name !== "function-runner" ||
    rootPackage.version !== policy.version
  )
    throw new Error("runner_metadata_invalid");
  for (const override of policy.overrides) {
    const pkg = local.find((item) => item.name === override.name);
    if (
      !pkg ||
      pkg.version !== override.version ||
      path.dirname(fs.realpathSync(pkg.manifest_path)) !==
        path.join(root, "vendor", override.name)
    )
      throw new Error("runner_override_unbound");
  }
  const wasmtime = metadata.packages.filter((pkg) =>
    ["wasmtime", "wasmtime-wasi"].includes(pkg.name),
  );
  if (
    wasmtime.length !== 2 ||
    wasmtime.some((pkg) => pkg.version !== "36.0.19")
  )
    throw new Error("runner_wasmtime_unpatched");
  return true;
}

export function validateRunnerSmoke(result, previous) {
  if (
    result?.success !== true ||
    JSON.stringify(result.output) !== '{"operations":[]}' ||
    result.logs !== "" ||
    !Number.isSafeInteger(result.instructions) ||
    result.instructions < 1 ||
    result.instructions > 10_000 ||
    !Number.isSafeInteger(result.memory_usage) ||
    result.memory_usage > 128 ||
    (previous && result.instructions !== previous.instructions)
  )
    throw new Error("runner_smoke_or_fuel_failed");
  return true;
}

export function writeRunnerEvidence(directory, name, bytes) {
  if (!/^[a-zA-Z0-9._-]+$/.test(name) || name === "." || name === "..")
    throw new Error("runner_evidence_path_invalid");
  const target = path.join(directory, name);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error("runner_evidence_path_invalid");
  }
  fs.writeFileSync(target, bytes);
}

function execute(
  command,
  args,
  cwd,
  env,
  { log, timeout = 120_000, allowFailure = false } = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    timeout,
    maxBuffer: 40 * 1024 * 1024,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (log) {
    writeRunnerEvidence(
      path.dirname(log),
      `${path.basename(log)}.stdout.log`,
      result.stdout || "",
    );
    writeRunnerEvidence(
      path.dirname(log),
      `${path.basename(log)}.stderr.log`,
      result.stderr || "",
    );
  }
  if (result.error || (!allowFailure && result.status !== 0))
    throw new Error(
      result.error?.code === "ETIMEDOUT"
        ? "runner_build_timeout"
        : `runner_command_failed:${path.basename(command)}`,
    );
  return result;
}

export async function rebuildFunctionRunner(
  root = ROOT,
  { build = true } = {},
) {
  const policyBytes = fs.readFileSync(
    path.join(root, "security/function-runner-rebuild.json"),
  );
  const policy = validateRunnerPolicy(JSON.parse(policyBytes));
  const patch = runnerInput(root, policy.patch);
  const lock = runnerInput(root, policy.lockfile);
  for (const entry of policy.overrides) runnerInput(root, entry.patch);
  const tools = await prepareRustToolchain(root);
  const { home, env, cargo } = tools;
  const out = checkedNativeDirectory(root, ".audit/native-runner");
  const cache = checkedNativeDirectory(root, ".audit/rust-cache");
  const sourceArchive = path.join(cache, "function-runner-source.tar.gz");
  await downloadRustInput(
    `https://codeload.github.com/${policy.source.repository}/tar.gz/${policy.source.commit}`,
    sourceArchive,
    policy.source.sha256,
  );
  execute("tar", ["-xf", sourceArchive, "-C", home], root, env);
  const source = path.join(home, `function-runner-${policy.source.commit}`);
  checkRustSourceTree(source);
  const apply = (directory, item) => {
    runnerInput(root, item);
    execute(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "apply",
        "--check",
        path.join(root, item.path),
      ],
      directory,
      env,
    );
    execute(
      "git",
      ["-c", "core.autocrlf=false", "apply", path.join(root, item.path)],
      directory,
      env,
    );
  };
  apply(source, policy.patch);
  const vendor = path.join(source, "vendor");
  if (fs.existsSync(vendor))
    throw new Error("runner_unexpected_vendor_directory");
  fs.mkdirSync(vendor);
  for (const entry of policy.overrides) {
    const name = `${entry.name}-${entry.upstreamVersion}`;
    const archive = path.join(cache, `${name}.crate`);
    await downloadRustInput(
      `https://static.crates.io/crates/${entry.name}/${name}.crate`,
      archive,
      entry.sha256,
    );
    execute("tar", ["-xf", archive, "-C", vendor], root, env);
    const unpacked = path.join(vendor, name);
    checkRustSourceTree(unpacked);
    const directory = path.join(vendor, entry.name);
    // Both are fixed children of this newly created private source tree.
    fs.renameSync(unpacked, directory);
    apply(directory, entry.patch);
    const manifest = toml.parse(
      fs.readFileSync(path.join(directory, "Cargo.toml"), "utf8"),
    );
    if (
      manifest.package.name !== entry.name ||
      manifest.package.version !== entry.version
    )
      throw new Error("runner_override_unbound");
  }
  fs.writeFileSync(path.join(source, "Cargo.lock"), lock);
  const report = await scanRustLockfile(lock.toString("utf8"));
  writeRunnerEvidence(
    out,
    "source-assessment.json",
    JSON.stringify(
      {
        ...report,
        source: policy.source,
        policySha256: hash(policyBytes),
        overrides: policy.overrides,
      },
      null,
      2,
    ) + "\n",
  );
  if (!report.sourceAuditOk)
    throw new Error("runner_source_advisories_unresolved");
  const metadata = JSON.parse(
    execute(
      cargo,
      [
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--filter-platform",
        tools.receipt.target,
      ],
      source,
      env,
      { timeout: 600_000, log: path.join(out, "metadata") },
    ).stdout,
  );
  validateRunnerMetadata(metadata, source, policy);
  writeRunnerEvidence(
    out,
    "metadata.json",
    JSON.stringify(metadata, null, 2) + "\n",
  );
  const baseReceipt = {
    schemaVersion: 1,
    role: "function-runner",
    artifactStatus: "NOT_VERIFIED",
    policySha256: hash(policyBytes),
    source: policy.source,
    patchSha256: hash(patch),
    lockfileSha256: hash(lock),
    overrides: policy.overrides,
    compiler: tools.receipt,
    sourceAssessmentSha256: hash(
      fs.readFileSync(path.join(out, "source-assessment.json")),
    ),
    observedAt: new Date().toISOString(),
  };
  if (!build) {
    writeRunnerEvidence(
      out,
      "resolution.json",
      JSON.stringify(baseReceipt, null, 2) + "\n",
    );
    return {
      ok: true,
      ...baseReceipt,
      metadataVerified: true,
      buildPerformed: false,
    };
  }
  const flags = [`--remap-path-prefix=${home}=/oja/build`];
  if (process.platform === "win32")
    flags.push("-C", "target-feature=+crt-static");
  env.CARGO_ENCODED_RUSTFLAGS = flags.join("\x1f");
  const compiled = execute(
    cargo,
    [
      "build",
      "--locked",
      "--release",
      "--package",
      "function-runner",
      "--bin",
      "function-runner",
      "--message-format=json-render-diagnostics",
    ],
    source,
    env,
    { timeout: 1_800_000, log: path.join(out, "build") },
  );
  const messages = compiled.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const binary = path.join(
    env.CARGO_TARGET_DIR,
    "release",
    `function-runner${process.platform === "win32" ? ".exe" : ""}`,
  );
  const artifact = messages.find(
    (item) =>
      item.reason === "compiler-artifact" &&
      item.target?.name === "function-runner" &&
      item.executable &&
      fs.realpathSync(item.executable) === fs.realpathSync(binary),
  );
  if (!artifact) throw new Error("runner_binary_not_bound_to_build");
  if (
    execute(binary, ["--version"], source, env).stdout.trim() !==
    `function-runner ${policy.version}`
  )
    throw new Error("runner_binary_identity_invalid");
  execute(
    cargo,
    [
      "test",
      "--locked",
      "--release",
      "--package",
      "wasmtime-internal-cache",
      "--package",
      "fxprof-processed-profile",
      "--lib",
    ],
    source,
    env,
    { timeout: 600_000, log: path.join(out, "override-tests") },
  );
  const fixture = path.join(root, "tests/fixtures/native-runner");
  const smoke = (name, extra = []) =>
    execute(
      binary,
      [
        "--function",
        path.join(fixture, `${name}.wat`),
        "--input",
        path.join(fixture, "input.json"),
        "--json",
        ...extra,
      ],
      home,
      env,
      { timeout: 30_000, allowFailure: true },
    );
  let first;
  for (const name of ["json", "json", "environment"]) {
    const result = smoke(name);
    if (result.status !== 0) throw new Error("runner_smoke_failed");
    const value = JSON.parse(result.stdout);
    validateRunnerSmoke(value, name === "json" ? first : undefined);
    if (!first) first = value;
  }
  const trapped = smoke("trap");
  if (trapped.status !== 1 || JSON.parse(trapped.stdout).success !== false)
    throw new Error("runner_trap_not_isolated");
  const profiled = smoke("json", [
    "--profile",
    "--profile-out",
    path.join(out, "profile.txt"),
  ]);
  if (profiled.status !== 0 || !fs.existsSync(path.join(out, "profile.txt")))
    throw new Error("runner_profiler_failed");
  if (
    hash(fs.readFileSync(path.join(source, "Cargo.lock"))) !==
    policy.lockfile.sha256
  )
    throw new Error("runner_lockfile_changed");
  const binaryBytes = fs.readFileSync(binary);
  const binarySha256 = hash(binaryBytes);
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: "function-runner",
        version: policy.version,
        hashes: [{ alg: "SHA-256", content: binarySha256 }],
        externalReferences: [
          {
            type: "vcs",
            url: `https://github.com/${policy.source.repository}/commit/${policy.source.commit}`,
          },
        ],
      },
    },
    components: [
      ...rustRegistryPackages(lock.toString("utf8")).packages.map((pkg) => ({
        type: "library",
        name: pkg.name,
        version: pkg.version,
        purl: `pkg:cargo/${pkg.name}@${pkg.version}`,
        hashes: [{ alg: "SHA-256", content: pkg.checksum }],
      })),
      ...policy.overrides.map((entry) => ({
        type: "library",
        name: entry.name,
        version: entry.version,
        properties: [
          { name: "oja:original-crate-sha256", value: entry.sha256 },
          { name: "oja:source-patch-sha256", value: entry.patch.sha256 },
        ],
      })),
      {
        type: "library",
        name: "rust-stdlib",
        version: tools.receipt.version,
        properties: [
          {
            name: "oja:toolchain-policy-sha256",
            value: tools.receipt.policySha256,
          },
        ],
      },
    ],
    properties: [
      { name: "oja:scope", value: "complete-lock-graph-not-linker-proof" },
    ],
  };
  const sbomBytes = JSON.stringify(sbom, null, 2) + "\n";
  const receipt = {
    ...baseReceipt,
    binarySha256,
    sbomSha256: hash(sbomBytes),
    abiSmokePassed: true,
    deterministicFuel: first.instructions,
    overrideTestsPassed: true,
    productionApproved: false,
  };
  writeRunnerEvidence(out, path.basename(binary), binaryBytes);
  writeRunnerEvidence(out, "function-runner.cdx.json", sbomBytes);
  writeRunnerEvidence(
    out,
    "receipt.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  return {
    ok: true,
    artifactStatus: "NOT_VERIFIED",
    productionApproved: false,
    binarySha256,
    sourceAdvisories: 0,
    abiSmokePassed: true,
    deterministicFuel: first.instructions,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (
      process.argv.length > 3 ||
      (process.argv[2] && process.argv[2] !== "--resolve-only")
    )
      throw new Error("unexpected_runner_arguments");
    console.log(
      JSON.stringify(
        await rebuildFunctionRunner(ROOT, {
          build: process.argv[2] !== "--resolve-only",
        }),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

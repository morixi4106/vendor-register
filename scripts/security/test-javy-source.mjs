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
import {
  runnerInput,
  writeRunnerEvidence,
} from "./rebuild-function-runner.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const REGISTRY = "registry+https://github.com/rust-lang/crates.io-index";
const SOURCE_FILES = [
  "Cargo.toml",
  ".cargo/config.toml",
  "crates/cli/Cargo.toml",
  "crates/cli/build.rs",
  "crates/codegen/Cargo.toml",
  "crates/codegen/src/lib.rs",
  "crates/codegen/src/plugin.rs",
  "crates/codegen/src/js.rs",
  "crates/plugin/Cargo.toml",
  "crates/plugin-processing/Cargo.toml",
  "crates/plugin-processing/src/lib.rs",
  "crates/profiler/Cargo.toml",
  "crates/profiler/src/lib.rs",
  "vendor/wirm/Cargo.toml",
  "vendor/wirm/src/ir/instr_tests.rs",
  "vendor/wirm/tests/common/wast_iter.rs",
  "vendor/wirm/tests/common/validate.rs",
];
const LOCAL = [
  ["javy", "9.0.0-alpha.1", "crates/javy"],
  ["javy-cli", "9.1.0+oja.1", "crates/cli"],
  ["javy-codegen", "4.0.1-alpha.1", "crates/codegen"],
  ["javy-fuzz", "0.0.0", "fuzz"],
  ["javy-plugin", "0.0.0", "crates/plugin"],
  ["javy-plugin-api", "8.0.0-alpha.1", "crates/plugin-api"],
  ["javy-plugin-processing", "0.0.0", "crates/plugin-processing"],
  ["javy-profiler", "0.0.0", "crates/profiler"],
  ["javy-profiler-lib", "0.0.0", "crates/profiler-lib"],
  ["javy-release", "0.1.0", "release"],
  ["javy-runner", "0.0.0", "crates/runner"],
  ["javy-test-invalid-plugin", "0.0.0", "crates/test-invalid-plugin"],
  ["javy-test-macros", "0.0.0", "crates/test-macros"],
  ["javy-test-plugin-wasip1", "0.0.0", "crates/test-plugin-wasip1"],
  ["javy-test-plugin-wasip2", "0.0.0", "crates/test-plugin-wasip2"],
  ["wirm", "5.1.0+oja.1", "vendor/wirm"],
];
const exact = (value, names) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...names].sort().join();

export function validateJavyPolicy(p) {
  const input = (i, filename) =>
    exact(i, ["path", "sha256"]) &&
    i.path === `vendor/native/javy/${filename}` &&
    HASH.test(i.sha256 || "");
  if (
    !exact(p, [
      "schemaVersion",
      "role",
      "version",
      "source",
      "baseline",
      "patch",
      "lockfile",
      "wirm",
      "sourceFiles",
    ]) ||
    p.schemaVersion !== 1 ||
    p.role !== "javy-source" ||
    p.version !== "9.1.0+oja.1" ||
    !exact(p.source, ["repository", "commit", "sha256"]) ||
    p.source.repository !== "bytecodealliance/javy" ||
    p.source.commit !== "66f04f1fa2065123e0f712cddcee20770f58b13e" ||
    p.source.sha256 !==
      "5f51e3c3109a6321e619182e23da64961d6746201834e9d1c941390e866ce17e" ||
    !exact(p.baseline, [
      "version",
      "repository",
      "commit",
      "manifestSha256",
      "lockfileSha256",
    ]) ||
    p.baseline.version !== "9.0.0" ||
    p.baseline.repository !== p.source.repository ||
    p.baseline.commit !== "03458aaa9ed3e56d9a2baffcf646ac38f69664b5" ||
    p.baseline.manifestSha256 !==
      "b310cbce35730bce014c5f78fa3340a632393be208011fa3244985ad300b1b8c" ||
    p.baseline.lockfileSha256 !==
      "fc1329878e52f3b282b768518e5909d4807c4c311079383b9f55c77d86d54121" ||
    !input(p.patch, "javy.patch") ||
    !input(p.lockfile, "Cargo.lock") ||
    !exact(p.wirm, [
      "upstreamVersion",
      "version",
      "sha256",
      "patch",
      "testSource",
    ]) ||
    p.wirm.upstreamVersion !== "5.1.0" ||
    p.wirm.version !== "5.1.0+oja.1" ||
    p.wirm.sha256 !==
      "cbf24563802785ba2885e5357ab24d56a3b13b9884d9102347fe663d712df462" ||
    !input(p.wirm.patch, "wirm.patch") ||
    !exact(p.wirm.testSource, ["repository", "commit", "sha256", "files"]) ||
    p.wirm.testSource.repository !== "composablesys/wirm" ||
    p.wirm.testSource.commit !== "a03a3eb0466e8a7950ce601481505749b10f660c" ||
    p.wirm.testSource.sha256 !==
      "6c018a7e6f4b484d0affd22641005b7074f6f953bb820c71b5e216edfe4861ec" ||
    !Array.isArray(p.wirm.testSource.files) ||
    p.wirm.testSource.files.length !== 2 ||
    p.wirm.testSource.files.some(
      (f, i) =>
        !exact(f, ["path", "sha256"]) ||
        f.path !==
          ["tests/common/wast_iter.rs", "tests/common/validate.rs"][i] ||
        f.sha256 !==
          [
            "4944e1371d6ebb84595125b256aa25e68e0a9f7ca3798467111057941b123907",
            "be90edeef139858381189070ba6605a129049aa86b739a2dfbd009f3de54d37f",
          ][i],
    ) ||
    !Array.isArray(p.sourceFiles) ||
    p.sourceFiles.length !== SOURCE_FILES.length ||
    p.sourceFiles.some(
      (f, i) =>
        !exact(f, ["path", "sha256"]) ||
        f.path !== SOURCE_FILES[i] ||
        !HASH.test(f.sha256 || ""),
    )
  )
    throw new Error("javy_policy_invalid");
  return p;
}

export function checkJavyWirmTestOrigin(
  crate,
  source,
  policy,
  readInput = runnerInput,
) {
  validateJavyPolicy(policy);
  const expected = policy.wirm.testSource;
  const vcs = JSON.parse(
    fs.readFileSync(path.join(crate, ".cargo_vcs_info.json"), "utf8"),
  );
  if (
    vcs.git?.sha1 !== expected.commit ||
    vcs.path_in_vcs !== "" ||
    !fs
      .readFileSync(path.join(crate, "Cargo.toml.orig"))
      .equals(fs.readFileSync(path.join(source, "Cargo.toml")))
  )
    throw new Error("javy_wirm_test_origin_invalid");
  const files = (root, relative = "src") =>
    fs
      .readdirSync(path.join(root, relative), { withFileTypes: true })
      .flatMap((entry) => {
        const name = `${relative}/${entry.name}`;
        if (entry.isSymbolicLink())
          throw new Error("javy_wirm_test_origin_invalid");
        if (entry.isDirectory()) return files(root, name);
        if (!entry.isFile()) throw new Error("javy_wirm_test_origin_invalid");
        return [name];
      })
      .sort();
  const published = files(crate);
  if (
    published.length !== 51 ||
    JSON.stringify(published) !== JSON.stringify(files(source))
  )
    throw new Error("javy_wirm_test_origin_invalid");
  const sourceBindings = published.map((name) => {
    const bytes = fs.readFileSync(path.join(crate, name));
    if (!bytes.equals(fs.readFileSync(path.join(source, name))))
      throw new Error("javy_wirm_test_origin_invalid");
    return { path: name, sha256: sha(bytes) };
  });
  for (const file of expected.files) readInput(source, file);
  return {
    repository: expected.repository,
    commit: expected.commit,
    archiveSha256: expected.sha256,
    publishedSourceFiles: published.length,
    sourceBindings,
    files: expected.files,
  };
}

export function checkJavyWiring(source, policy, readInput = runnerInput) {
  validateJavyPolicy(policy);
  for (const f of policy.sourceFiles) readInput(source, f);
  const manifest = (p) =>
    toml.parse(fs.readFileSync(path.join(source, p), "utf8"));
  const workspace = manifest("Cargo.toml");
  if (
    workspace.workspace.package.version !== policy.version ||
    workspace.workspace.members.length !== LOCAL.length ||
    !workspace.workspace.members.includes("vendor/wirm") ||
    workspace.patch?.["crates-io"]?.wirm?.path !== "vendor/wirm" ||
    ["wasmtime", "wasmtime-wasi", "wasmtime-wizer"].some(
      (n) => workspace.workspace.dependencies[n] !== "=50.0.1",
    ) ||
    workspace.workspace.dependencies["deterministic-wasi-ctx"] !== "=4.0.9" ||
    manifest("crates/profiler/Cargo.toml").dependencies.whamm !== "=2.0.1"
  )
    throw new Error("javy_source_wiring_invalid");
  const wirm = manifest("vendor/wirm/Cargo.toml");
  const cli = manifest("crates/cli/Cargo.toml");
  if (
    wirm.package.version !== policy.wirm.version ||
    wirm.dependencies.paste.package !== "pastey" ||
    wirm.dependencies.paste.version !== "=0.2.3" ||
    wirm["dev-dependencies"].wasmtime.version !== "=50.0.1" ||
    cli.dependencies["javy-profiler"].optional !== true ||
    JSON.stringify(cli.features.profiler) !== '["dep:javy-profiler"]'
  )
    throw new Error("javy_source_wiring_invalid");
  return true;
}

export function checkJavyMetadata(m, source, policy) {
  validateJavyPolicy(policy);
  if (
    !Array.isArray(m?.packages) ||
    !m.packages.length ||
    !Array.isArray(m.resolve?.nodes)
  )
    throw new Error("javy_metadata_invalid");
  const packages = new Map(m.packages.map((p) => [p.id, p]));
  const nodes = new Map(m.resolve.nodes.map((n) => [n.id, n]));
  if (
    packages.size !== m.packages.length ||
    nodes.size !== m.resolve.nodes.length
  )
    throw new Error("javy_metadata_invalid");
  for (const n of nodes.values()) {
    if (
      !packages.has(n.id) ||
      !Array.isArray(n.features) ||
      n.features.some((f) => typeof f !== "string") ||
      !Array.isArray(n.deps) ||
      n.deps.some(
        (d) =>
          !packages.has(d.pkg) ||
          typeof d.name !== "string" ||
          !Array.isArray(d.dep_kinds) ||
          !d.dep_kinds.length ||
          d.dep_kinds.some((k) => ![null, "dev", "build"].includes(k.kind)),
      )
    )
      throw new Error("javy_metadata_invalid");
  }
  const root = fs.realpathSync(source);
  for (const p of packages.values()) {
    if (p.source && p.source !== REGISTRY)
      throw new Error("javy_non_registry_source");
    if (!nodes.has(p.id)) throw new Error("javy_metadata_invalid");
    if (!p.source) {
      const expected = LOCAL.find(([name]) => name === p.name);
      if (
        !expected ||
        p.version !== expected[1] ||
        fs.realpathSync(p.manifest_path) !==
          path.join(root, expected[2], "Cargo.toml")
      )
        throw new Error("javy_local_source_unbound");
    }
  }
  if (
    m.packages.filter((p) => !p.source).length !== LOCAL.length ||
    LOCAL.some(
      ([name]) =>
        m.packages.filter((p) => !p.source && p.name === name).length !== 1,
    )
  )
    throw new Error("javy_local_source_unbound");
  const pkg = (name, version) => {
    const found = m.packages.filter(
      (p) => p.name === name && p.version === version,
    );
    if (found.length !== 1) throw new Error("javy_dependency_unbound");
    return found[0];
  };
  for (const name of ["wasmtime", "wasmtime-wasi"]) {
    if (m.packages.filter((p) => p.name === name).length !== 2)
      throw new Error("javy_wasmtime_unpatched");
    for (const version of ["48.0.8", "50.0.1"]) {
      const p = pkg(name, version),
        f = nodes.get(p.id).features;
      const required =
        name === "wasmtime"
          ? ["default", "cranelift", "runtime", "cache", "component-model"]
          : version === "50.0.1"
            ? ["default", "p1", "p2", "p3"]
            : ["default", "p1", "p2"];
      if (required.some((feature) => !f.includes(feature)))
        throw new Error("javy_features_removed");
    }
  }
  if (
    m.packages.some(
      (p) =>
        p.name === "paste" ||
        ((p.name.startsWith("wasmtime") ||
          p.name.startsWith("wiggle") ||
          p.name.startsWith("pulley-")) &&
          !["48.0.8", "50.0.1"].includes(p.version)),
    )
  )
    throw new Error("javy_wasmtime_unpatched");
  const edge = (
    name,
    version,
    dep,
    depVersion,
    alias = dep.replaceAll("-", "_"),
    kind = null,
  ) => {
    const from = pkg(name, version),
      to = pkg(dep, depVersion);
    if (
      !nodes
        .get(from.id)
        .deps.some(
          (d) =>
            d.name === alias &&
            d.pkg === to.id &&
            d.dep_kinds.some((k) => k.kind === kind),
        )
    )
      throw new Error("javy_consumer_detached");
  };
  for (const [name, version] of [
    ["javy-cli", policy.version],
    ["javy-codegen", "4.0.1-alpha.1"],
    ["javy-plugin-processing", "0.0.0"],
    ["javy-profiler", "0.0.0"],
    ["deterministic-wasi-ctx", "4.0.9"],
  ])
    edge(name, version, "wasmtime", "50.0.1");
  edge("javy-cli", policy.version, "javy-codegen", "4.0.1-alpha.1");
  edge("javy-cli", policy.version, "javy-plugin-processing", "0.0.0");
  edge(
    "javy-cli",
    policy.version,
    "javy-plugin-processing",
    "0.0.0",
    "javy_plugin_processing",
    "build",
  );
  edge("javy-codegen", "4.0.1-alpha.1", "wasmtime-wizer", "50.0.1");
  edge("javy-codegen", "4.0.1-alpha.1", "deterministic-wasi-ctx", "4.0.9");
  edge("javy-profiler", "0.0.0", "whamm", "2.0.1");
  edge("whamm", "2.0.1", "wasmtime", "48.0.8");
  edge("whamm", "2.0.1", "wasmtime-wasi", "48.0.8");
  edge("whamm", "2.0.1", "wirm", policy.wirm.version);
  edge("wirm", policy.wirm.version, "pastey", "0.2.3", "paste");
  return true;
}

export function javySourceTestPlans() {
  return [
    {
      name: "codegen",
      args: ["test", "--locked", "--package", "javy-codegen", "--lib"],
      count: 25,
    },
    {
      name: "plugin-processing",
      args: [
        "test",
        "--locked",
        "--package",
        "javy-plugin-processing",
        "--lib",
      ],
      count: 1,
    },
    {
      name: "wirm-instructions",
      args: [
        "test",
        "--locked",
        "--package",
        "wirm",
        "--lib",
        "ir::instr_tests::",
      ],
      count: 8,
    },
  ];
}

export function javyTestTotals(output, count) {
  const results = [
    ...output.matchAll(
      /test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;/g,
    ),
  ];
  if (
    results.length !== 1 ||
    Number(results[0][1]) !== count ||
    results[0][2] !== "0" ||
    results[0][3] !== "0"
  )
    throw new Error("javy_source_tests_incomplete");
  return { passed: count, failed: 0, ignored: 0 };
}

export function javySourceOptions(args, env = process.env) {
  if (args.length || env.CI !== "true" || env.GITHUB_ACTIONS !== "true")
    throw new Error("javy_source_ci_only");
  return true;
}

export async function testJavySource(root = ROOT) {
  javySourceOptions([]);
  const policyBytes = fs.readFileSync(
    path.join(root, "security/javy-source-contracts.json"),
  );
  const policy = validateJavyPolicy(JSON.parse(policyBytes));
  const patch = runnerInput(root, policy.patch),
    lock = runnerInput(root, policy.lockfile),
    wirmPatch = runnerInput(root, policy.wirm.patch);
  const output = fs.mkdtempSync(
    path.join(checkedNativeDirectory(root, ".audit/native-javy"), "run-"),
  );
  const json = (name, value) =>
    writeRunnerEvidence(output, name, JSON.stringify(value, null, 2) + "\n");
  writeRunnerEvidence(output, "policy.json", policyBytes);
  const prepared = await prepareRustToolchain(root);
  const { home, toolchain, env, receipt } = prepared;
  json("compiler.json", receipt);
  const cargo = path.join(
    toolchain,
    "bin",
    process.platform === "win32" ? "cargo.exe" : "cargo",
  );
  env.CARGO_BUILD_JOBS = "1";
  const execute = (command, args, cwd, label) => {
    const r = spawnSync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 1_800_000,
      maxBuffer: 40 * 1024 * 1024,
    });
    writeRunnerEvidence(output, `${label}.stdout.log`, r.stdout || "");
    writeRunnerEvidence(output, `${label}.stderr.log`, r.stderr || "");
    json(`${label}.command.json`, {
      command: path.basename(command),
      args,
      status: r.status,
      error: r.error?.code || null,
    });
    if (r.error || r.status !== 0)
      throw new Error(`javy_source_command_failed:${label}`);
    return r.stdout;
  };
  const extract = (archive, prefix, destination) => {
    const entries = execute("tar", ["-tf", archive], home, `list-${prefix}`)
      .trim()
      .split(/\r?\n/);
    if (
      !entries.length ||
      entries.some(
        (e) =>
          !e.startsWith(`${prefix}/`) ||
          e.includes("\\") ||
          e.includes(":") ||
          e.split("/").includes(".."),
      )
    )
      throw new Error("javy_archive_path_invalid");
    execute(
      "tar",
      ["-xf", archive, "-C", destination],
      home,
      `extract-${prefix}`,
    );
    const source = path.join(destination, prefix);
    checkRustSourceTree(source);
    return source;
  };
  const archive = path.join(home, "javy-source.tar.gz");
  await downloadRustInput(
    `https://codeload.github.com/${policy.source.repository}/tar.gz/${policy.source.commit}`,
    archive,
    policy.source.sha256,
  );
  const source = extract(archive, `javy-${policy.source.commit}`, home);
  const originalLock = fs.readFileSync(path.join(source, "Cargo.lock"));
  json(
    "development-original-assessment.json",
    await scanRustLockfile(originalLock.toString("utf8")),
  );
  for (const [name, expected] of [
    ["Cargo.toml", policy.baseline.manifestSha256],
    ["Cargo.lock", policy.baseline.lockfileSha256],
  ]) {
    const response = await fetch(
      `https://raw.githubusercontent.com/${policy.baseline.repository}/${policy.baseline.commit}/${name}`,
      { redirect: "error", signal: AbortSignal.timeout(60_000) },
    );
    if (!response.ok) throw new Error("javy_baseline_download_failed");
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024)
        throw new Error("javy_baseline_download_limit");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (sha(bytes) !== expected)
      throw new Error("javy_baseline_digest_mismatch");
    writeRunnerEvidence(output, `release-${name}`, bytes);
    if (name === "Cargo.lock")
      json(
        "release-original-assessment.json",
        await scanRustLockfile(bytes.toString("utf8")),
      );
  }
  const patchFile = path.join(home, "javy.patch");
  fs.writeFileSync(patchFile, patch, { flag: "wx" });
  execute(
    "git",
    ["-c", "core.autocrlf=false", "apply", "--check", patchFile],
    source,
    "javy-patch-check",
  );
  execute(
    "git",
    ["-c", "core.autocrlf=false", "apply", patchFile],
    source,
    "javy-patch",
  );
  const wirmArchive = path.join(home, "wirm.crate");
  await downloadRustInput(
    "https://static.crates.io/crates/wirm/wirm-5.1.0.crate",
    wirmArchive,
    policy.wirm.sha256,
  );
  const wirm = extract(wirmArchive, "wirm-5.1.0", home);
  fs.mkdirSync(path.join(source, "vendor"));
  fs.cpSync(wirm, path.join(source, "vendor/wirm"), {
    recursive: true,
    errorOnExist: true,
  });
  const testArchive = path.join(home, "wirm-test-source.tar.gz");
  const testSourcePolicy = policy.wirm.testSource;
  await downloadRustInput(
    `https://codeload.github.com/${testSourcePolicy.repository}/tar.gz/${testSourcePolicy.commit}`,
    testArchive,
    testSourcePolicy.sha256,
  );
  const testSource = extract(
    testArchive,
    `wirm-${testSourcePolicy.commit}`,
    home,
  );
  const wirmTestOrigin = checkJavyWirmTestOrigin(wirm, testSource, policy);
  json("wirm-test-origin.json", wirmTestOrigin);
  for (const file of testSourcePolicy.files) {
    const destination = path.join(source, "vendor/wirm", file.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(
      path.join(testSource, file.path),
      destination,
      fs.constants.COPYFILE_EXCL,
    );
  }
  const wirmPatchFile = path.join(home, "wirm.patch");
  fs.writeFileSync(wirmPatchFile, wirmPatch, { flag: "wx" });
  execute(
    "git",
    ["-c", "core.autocrlf=false", "apply", "--check", wirmPatchFile],
    path.join(source, "vendor/wirm"),
    "wirm-patch-check",
  );
  execute(
    "git",
    ["-c", "core.autocrlf=false", "apply", wirmPatchFile],
    path.join(source, "vendor/wirm"),
    "wirm-patch",
  );
  fs.writeFileSync(path.join(source, "Cargo.lock"), lock);
  checkJavyWiring(source, policy);
  const before = policy.sourceFiles.map((f) => ({ ...f }));
  json("source-bindings.json", before);
  writeRunnerEvidence(output, "Cargo.lock", lock);
  const assessment = await scanRustLockfile(lock.toString("utf8"));
  json("candidate-assessment.json", assessment);
  if (
    !assessment.sourceAuditOk ||
    assessment.findings.length ||
    assessment.unresolved.length
  )
    throw new Error("javy_registry_assessment_failed");
  const target = receipt.target;
  const metadata = JSON.parse(
    execute(
      cargo,
      [
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--filter-platform",
        target,
      ],
      source,
      "metadata",
    ),
  );
  checkJavyMetadata(metadata, source, policy);
  json("metadata.json", metadata);
  const tests = [];
  for (const plan of javySourceTestPlans())
    tests.push({
      name: plan.name,
      ...javyTestTotals(
        execute(cargo, plan.args, source, plan.name),
        plan.count,
      ),
    });
  checkJavyWiring(source, policy);
  if (
    sha(fs.readFileSync(path.join(source, "Cargo.lock"))) !==
    policy.lockfile.sha256
  )
    throw new Error("javy_source_lock_changed");
  const report = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    target,
    source: policy.source,
    baseline: policy.baseline,
    policySha256: sha(policyBytes),
    lockfileSha256: policy.lockfile.sha256,
    patchSha256: policy.patch.sha256,
    compiler: receipt,
    sourceBindings: before,
    wirmTestSource: testSourcePolicy,
    wirmTestOriginSha256: sha(JSON.stringify(wirmTestOrigin)),
    tests,
    registryPackageCount: assessment.packageCount,
    registryAdvisoryMatches: 0,
    artifactStatus: "NOT_VERIFIED",
    wholeCompilerVerified: false,
    productionApproved: false,
  };
  json("receipt.json", report);
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    javySourceOptions(process.argv.slice(2));
    console.log(JSON.stringify(await testJavySource()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

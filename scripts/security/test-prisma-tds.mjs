import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { checkedNativeDirectory } from "./rebuild-esbuild.mjs";
import {
  prepareRustToolchain,
  downloadRustInput,
  checkRustSourceTree,
} from "./rust-toolchain.mjs";
import { preparePrismaWinauthSource } from "./prisma-winauth-source.mjs";
import {
  scanRustLockfile,
  rustRegistryPackages,
} from "./rust-source-audit.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const read = (file, limit = 4_000_000) => {
  const s = fs.lstatSync(file);
  assert.ok(
    s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= limit,
  );
  return fs.readFileSync(file);
};
export function validateTdsPolicy(p) {
  assert.equal(p.schemaVersion, 1);
  assert.equal(p.repository, "prisma/tiberius");
  assert.equal(p.commit, "35605c90adb38cc107d35c3432fd2643d9d6e1e6");
  assert.equal(p.sourceFiles, 158);
  assert.equal(
    p.sourcePolicySha256,
    "7a4ed503a7641076954c1620c2a35e51106ef2b817b58ea2740ca3f35ce6d5d0",
  );
  for (const k of [
    "archiveSha256",
    "sourceManifestSha256",
    "fixtureSha256",
    "manifestSha256",
    "lockSha256",
  ])
    assert.match(p[k], /^[a-f0-9]{64}$/);
  assert.equal(p.platform, "linux");
  assert.equal(p.target, "x86_64-unknown-linux-gnu");
  assert.equal(p.testCount, 12);
  assert.equal(p.connectCalls, 258);
  assert.equal(p.successfulSyntheticLogins, 2);
  assert.equal(p.protocolErrors, 256);
  assert.equal(p.artifactStatus, "NOT_VERIFIED");
  for (const key of [
    "sourceReviewComplete",
    "wholeEngineVerified",
    "productionApproved",
  ])
    assert.equal(p[key], false);
  return p;
}
export function verifyTdsResult(stdout, stderr, p) {
  assert.match(
    stdout,
    /test result: ok\. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out/,
  );
  const names = [
    "normal_prelogin_and_done_reach_connected_state",
    "required_tls_rejects_off_before_login",
    "on_tls_rejects_not_supported_before_login",
    "required_tls_rejects_not_supported_before_login",
    "on_tls_rejects_off_before_login",
    "malformed_threadid_is_protocol_error_before_login",
    "row_without_metadata_is_rejected",
    "nbcrow_without_metadata_is_rejected",
    "feature_ack_rejects_unknown_feature",
    "feature_ack_rejects_invalid_fedauth_length",
    "colinfo_is_handled_without_unimplemented_panic",
    "unknown_prelogin_option_is_rejected",
  ];
  for (const name of names)
    assert.match(stdout, new RegExp(`test tests::${name} \\.\\.\\. ok`));
  const calls = stderr
    .split(/\r?\n/)
    .filter((s) => s.startsWith("OJA_TDS_CALL "));
  assert.equal(calls.length, p.connectCalls);
  assert.equal(
    calls.filter((s) => s === "OJA_TDS_CALL success=true").length,
    p.successfulSyntheticLogins,
  );
  assert.equal(
    calls.filter((s) => s === "OJA_TDS_CALL success=false").length,
    p.protocolErrors,
  );
  assert.doesNotMatch(stderr, /panicked at|thread .* panicked|stack overflow/);
  return {
    tests: p.testCount,
    connectCalls: calls.length,
    successfulSyntheticLogins: p.successfulSyntheticLogins,
    protocolErrors: p.protocolErrors,
  };
}
export function tdsSourceManifest(directory) {
  const files = [];
  const visit = (base, prefix = "") => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const name = prefix + entry.name,
        file = path.join(base, entry.name);
      assert.ok(!entry.isSymbolicLink());
      if (entry.isDirectory()) visit(file, name + "/");
      else {
        const b = read(file);
        files.push({ path: name, size: b.length, sha256: sha(b) });
      }
    }
  };
  visit(directory);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export function checkTdsMetadata(metadata, fixture) {
  const locals = metadata.packages.filter((p) => !p.source);
  assert.deepEqual(locals.map((p) => p.name).sort(), [
    "oja-prisma-tds-probes",
    "tiberius",
    "tiberius-macros",
  ]);
  const pkg = metadata.packages.find((p) => p.name === "tiberius");
  assert.equal(pkg.version, "0.13.0");
  assert.equal(
    fs.realpathSync(pkg.manifest_path),
    path.join(fs.realpathSync(fixture), "vendor/tiberius/Cargo.toml"),
  );
  const node = metadata.resolve.nodes.find((n) => n.id === pkg.id);
  assert.deepEqual(
    [...node.features].sort(),
    [
      "async-native-tls",
      "bigdecimal",
      "bigdecimal_",
      "chrono",
      "native-tls",
      "rustls-pki-types",
      "sql-browser-tokio",
      "tds73",
      "tokio",
      "tokio-util",
      "winauth",
    ].sort(),
  );
  const macro = metadata.packages.find((p) => p.name === "tiberius-macros");
  assert.equal(macro.version, "0.1.0");
  assert.equal(
    fs.realpathSync(macro.manifest_path),
    path.join(
      fs.realpathSync(fixture),
      "vendor/tiberius/tiberius-macros/Cargo.toml",
    ),
  );
  assert.ok(macro.targets.some((t) => t.kind.includes("proc-macro")));
  assert.ok(node.deps.some((d) => d.pkg === macro.id));
  return true;
}

export async function testPrismaTds(root = ROOT) {
  assert.equal(process.env.CI, "true");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.platform, "linux");
  const bytes = read(path.join(root, "security/prisma-tds-contracts.json"));
  const p = validateTdsPolicy(JSON.parse(bytes));
  const original = read(
    path.join(root, "security/prisma-source-contracts.json"),
  );
  assert.equal(sha(original), p.sourcePolicySha256);
  const engine = JSON.parse(original);
  const home = fs.mkdtempSync(
    path.join(checkedNativeDirectory(root, ".audit/prisma-tds"), "run-"),
  );
  const save = (n, b) =>
    fs.writeFileSync(path.join(home, n), b, { flag: "wx" });
  save("policy.json", bytes);
  save("source-policy.json", original);
  const tools = await prepareRustToolchain(root);
  const fixture = path.join(tools.home, "probe");
  fs.mkdirSync(fixture);
  fs.mkdirSync(path.join(fixture, "src"));
  fs.mkdirSync(path.join(fixture, "vendor"));
  const commands = [];
  const execute = (exe, args, cwd, name) => {
    const result = spawnSync(exe, args, {
      cwd,
      env: tools.env,
      windowsHide: true,
      timeout: 1200000,
      maxBuffer: 32_000_000,
    });
    const stdout = result.stdout || Buffer.alloc(0),
      stderr = result.stderr || Buffer.alloc(0);
    save(`${name}.stdout.log`, stdout);
    save(`${name}.stderr.log`, stderr);
    commands.push({
      name,
      executable: exe,
      args,
      status: result.status,
      signal: result.signal,
      error: result.error?.code || null,
      stdoutSha256: sha(stdout),
      stderrSha256: sha(stderr),
    });
    save(
      `${name}.command.json`,
      JSON.stringify(commands.at(-1), null, 2) + "\n",
    );
    assert.equal(
      result.status,
      0,
      `${name}: ${stderr.toString().slice(-2000)}`,
    );
    return stdout.toString();
  };
  for (const [file, expected] of [
    ["Cargo.toml", p.manifestSha256],
    ["Cargo.lock", p.lockSha256],
    ["src/lib.rs", p.fixtureSha256],
  ]) {
    const b = read(path.join(root, "tests/fixtures/prisma-tds", file));
    assert.equal(sha(b), expected);
    fs.writeFileSync(path.join(fixture, file), b);
    save(file.replaceAll("/", "-"), b);
  }
  const archive = path.join(home, "tiberius.tar.gz");
  await downloadRustInput(
    `https://codeload.github.com/${p.repository}/tar.gz/${p.commit}`,
    archive,
    p.archiveSha256,
  );
  execute(
    "tar",
    ["-xf", archive, "-C", path.join(fixture, "vendor")],
    root,
    "source-extract",
  );
  const unpacked = path.join(fixture, "vendor", `tiberius-${p.commit}`),
    source = path.join(fixture, "vendor", "tiberius");
  checkRustSourceTree(unpacked);
  assert.ok(unpacked.startsWith(tools.home) && source.startsWith(tools.home));
  fs.renameSync(unpacked, source);
  const sources = tdsSourceManifest(source);
  assert.equal(sources.length, p.sourceFiles);
  assert.equal(sha(JSON.stringify(sources)), p.sourceManifestSha256);
  const input = (base, item) =>
    assert.equal(sha(read(path.join(base, item.path))), item.sha256);
  await preparePrismaWinauthSource(
    root,
    fixture,
    path.join(root, ".audit/rust-cache"),
    engine.winauthSource,
    execute,
    input,
  );
  for (const file of engine.winauthSource.sourceFiles)
    input(path.join(fixture, "vendor/winauth"), file);
  const lock = read(path.join(fixture, "Cargo.lock"));
  const baseline = rustRegistryPackages(
    read(path.join(root, engine.lockfile.path)).toString(),
  ).packages;
  const assessment = await scanRustLockfile(lock.toString());
  save("registry-assessment.json", JSON.stringify(assessment, null, 2) + "\n");
  assert.equal(assessment.sourceAuditOk, true);
  assert.ok(
    assessment.packages.every((x) =>
      baseline.some(
        (y) =>
          x.name === y.name &&
          x.version === y.version &&
          x.checksum === y.checksum,
      ),
    ),
  );
  const metadata = JSON.parse(
    execute(
      tools.cargo,
      [
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--filter-platform",
        p.target,
      ],
      fixture,
      "metadata",
    ),
  );
  checkTdsMetadata(metadata, fixture);
  save("metadata.json", JSON.stringify(metadata) + "\n");
  const built = execute(
    tools.cargo,
    [
      "test",
      "--locked",
      "--offline",
      "--release",
      "--no-run",
      "--message-format=json",
      "--lib",
    ],
    fixture,
    "compile",
  );
  const messages = built
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const compiledTds = messages.filter(
    (x) => x.reason === "compiler-artifact" && x.target.name === "tiberius",
  );
  assert.equal(compiledTds.length, 1);
  const tdsId = metadata.packages.find((x) => x.name === "tiberius").id;
  assert.deepEqual(
    [...compiledTds[0].features].sort(),
    [...metadata.resolve.nodes.find((x) => x.id === tdsId).features].sort(),
  );
  const artifacts = messages.filter(
    (x) =>
      x.reason === "compiler-artifact" &&
      x.target.name === "oja_prisma_tds_probes" &&
      x.profile.test &&
      x.executable,
  );
  assert.equal(artifacts.length, 1);
  const executable = fs.realpathSync(artifacts[0].executable);
  assert.ok(executable.startsWith(fs.realpathSync(tools.home) + path.sep));
  const executableBytes = read(executable, 64_000_000);
  save("tds-probes", executableBytes);
  const stdout = execute(
    executable,
    ["--test-threads=1", "--nocapture"],
    fixture,
    "native-tests",
  );
  const result = verifyTdsResult(
    stdout,
    read(path.join(home, "native-tests.stderr.log")).toString(),
    p,
  );
  assert.equal(sha(read(executable, 64_000_000)), sha(executableBytes));
  assert.deepEqual(tdsSourceManifest(source), sources);
  assert.ok(read(path.join(fixture, "Cargo.lock")).equals(lock));
  for (const file of engine.winauthSource.sourceFiles)
    input(path.join(fixture, "vendor/winauth"), file);
  const report = {
    observedAt: new Date().toISOString(),
    policy: p,
    policySha256: sha(bytes),
    toolchain: tools.receipt,
    sourceManifest: sources,
    metadataSha256: sha(read(path.join(home, "metadata.json"))),
    registryAssessmentSha256: sha(
      read(path.join(home, "registry-assessment.json")),
    ),
    executableSha256: sha(executableBytes),
    compiledTdsFeatures: compiledTds[0].features,
    executableBytes: executableBytes.length,
    commands,
    result,
    allTdsProbeContractsVerified: true,
    sourceReviewComplete: false,
    wholeEngineVerified: false,
    productionApproved: false,
    artifactStatus: "NOT_VERIFIED",
    scope:
      "Fixed original Tiberius public API, exact source tree and release-mode synthetic in-memory protocol probes only; no SQL Server, real TLS/certificate handshake, production database or whole engine approval. Other platforms untested.",
  };
  save("receipt.json", JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      home,
      ...result,
      allTdsProbeContractsVerified: true,
      productionApproved: false,
    }),
  );
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assert.equal(process.argv.length, 2);
  await testPrismaTds();
}

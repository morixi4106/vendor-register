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
import { tdsSourceManifest } from "./test-prisma-tds.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const read = (file, limit = 4_000_000) => {
  const s = fs.lstatSync(file);
  assert.ok(
    s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= limit,
  );
  return fs.readFileSync(file);
};
const TARGETS = {
  linux: "x86_64-unknown-linux-gnu",
  win32: "x86_64-pc-windows-msvc",
};
const FEATURES = [
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
].sort();
const CASES = [
  "tuple_struct",
  "unit_struct",
  "enum_type",
  "union_type",
  "multiple_lifetimes",
  "bare_attribute",
  "list_attribute",
  "numeric_attribute",
  "expression_attribute",
  "duplicate_attribute",
];
const TESTS = [
  "scalar_columns_keep_order_and_type",
  "owned_columns_survive_input_drop",
  "borrowed_columns_keep_the_declared_lifetime",
  "optional_columns_preserve_null_values",
  "empty_named_struct_has_no_bound_columns",
  "column_attributes_do_not_change_field_binding",
];
export function validateMacroPolicy(p) {
  assert.equal(p.schemaVersion, 1);
  assert.equal(
    p.originalTdsPolicySha256,
    "ebd344db5c49c3ae1366ec2078557850ff0e1ed6800829a0d6af94b7424d5ca6",
  );
  for (const field of ["fixtureSha256", "invalidCasesSha256"])
    assert.match(p[field], /^[a-f0-9]{64}$/);
  assert.equal(p.nativeTests, 6);
  assert.equal(p.compilerRejections, 10);
  assert.equal(p.registryPackages, 133);
  assert.deepEqual(p.targets, TARGETS);
  assert.deepEqual(
    p.macroSourceFiles.map((x) => x.path),
    ["Cargo.toml", "src/lib.rs", "src/attr.rs", "src/table_value_param.rs"],
  );
  for (const f of p.macroSourceFiles) assert.match(f.sha256, /^[a-f0-9]{64}$/);
  for (const field of [
    "wholeEngineVerified",
    "sourceReviewComplete",
    "productionApproved",
  ])
    assert.equal(p[field], false);
  assert.equal(p.artifactStatus, "NOT_VERIFIED");
  return p;
}
export function validateMacroCases(cases) {
  assert.deepEqual(
    cases.map((x) => x.name),
    CASES,
  );
  for (const c of cases) {
    assert.match(c.name, /^[a-z][a-z_]{0,31}$/);
    assert.equal(typeof c.declaration, "string");
    assert.ok(c.declaration.length > 0 && c.declaration.length < 4096);
    assert.equal(typeof c.diagnostic, "string");
    assert.ok(
      c.diagnostic.startsWith("TableValueRow ") ||
        c.diagnostic.includes("`#[colname]`"),
    );
  }
  return cases;
}
export function macroCaseSource(c) {
  return `#[derive(tiberius::TableValueRow)]\n${c.declaration}\nfn main() {}\n`;
}
export function verifyMacroRejection(result, rootId, c) {
  assert.equal(result.status, 101);
  assert.equal(result.signal, null);
  assert.equal(result.error, null);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /proc macro panicked|internal compiler error|panicked at|stack overflow/i,
  );
  const messages = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
  const errors = messages.filter(
    (m) => m.reason === "compiler-message" && m.message.level === "error",
  );
  assert.ok(errors.length > 0);
  for (const e of errors) {
    assert.equal(e.package_id, rootId);
    assert.equal(e.target.name, c.name);
    assert.deepEqual(e.target.kind, ["bin"]);
  }
  assert.ok(errors.some((m) => m.message.message.includes(c.diagnostic)));
  assert.ok(
    messages.some((m) => m.reason === "build-finished" && m.success === false),
  );
  assert.ok(
    !messages.some(
      (m) => m.reason === "compiler-artifact" && m.target.name === c.name,
    ),
  );
  return {
    name: c.name,
    expectedDiagnostic: c.diagnostic,
    diagnosticMessages: errors.map((e) => e.message.message),
    correctlyRejected: true,
  };
}
export function verifyMacroNative(stdout, stderr) {
  assert.match(
    stdout,
    /test result: ok\. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out/,
  );
  for (const name of TESTS)
    assert.match(stdout, new RegExp(`test tests::${name} \\.\\.\\. ok`));
  assert.doesNotMatch(
    stdout + stderr,
    /panicked at|stack overflow|internal compiler error/,
  );
  return { tests: 6, failed: 0, ignored: 0 };
}
export function checkMacroMetadata(m, fixture, platform) {
  assert.ok(TARGETS[platform]);
  assert.deepEqual(
    m.packages
      .filter((x) => !x.source)
      .map((x) => x.name)
      .sort(),
    [
      "oja-prisma-tds-probes",
      "tiberius",
      "tiberius-macros",
      ...(platform === "win32" ? ["winauth"] : []),
    ].sort(),
  );
  const driver = m.packages.find((x) => x.name === "tiberius"),
    macro = m.packages.find((x) => x.name === "tiberius-macros");
  assert.equal(driver.version, "0.13.0");
  assert.equal(macro.version, "0.1.0");
  for (const [pkg, file] of [
    [driver, "vendor/tiberius/Cargo.toml"],
    [macro, "vendor/tiberius/tiberius-macros/Cargo.toml"],
  ])
    assert.equal(
      fs.realpathSync(pkg.manifest_path),
      path.join(fs.realpathSync(fixture), file),
    );
  const node = m.resolve.nodes.find((x) => x.id === driver.id);
  assert.deepEqual([...node.features].sort(), FEATURES);
  assert.ok(node.deps.some((x) => x.pkg === macro.id));
  assert.ok(macro.targets.some((x) => x.kind.includes("proc-macro")));
  const root = m.resolve.nodes.find((x) => x.id === m.resolve.root);
  assert.ok(root.deps.some((x) => x.pkg === driver.id));
  if (platform === "win32") {
    const auth = m.packages.find((x) => x.name === "winauth");
    assert.equal(auth.version, "0.0.5+oja.2");
    assert.equal(
      fs.realpathSync(auth.manifest_path),
      path.join(fs.realpathSync(fixture), "vendor/winauth/Cargo.toml"),
    );
    assert.ok(node.deps.some((x) => x.pkg === auth.id));
  }
  return FEATURES;
}

export async function testPrismaMacros(root = ROOT) {
  assert.equal(process.env.CI, "true");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.ok(TARGETS[process.platform]);
  const bytes = read(path.join(root, "security/prisma-macro-contracts.json")),
    p = validateMacroPolicy(JSON.parse(bytes));
  const originalBytes = read(
    path.join(root, "security/prisma-tds-contracts.json"),
  );
  assert.equal(sha(originalBytes), p.originalTdsPolicySha256);
  const original = JSON.parse(originalBytes);
  const engineBytes = read(
    path.join(root, "security/prisma-source-contracts.json"),
  );
  assert.equal(sha(engineBytes), original.sourcePolicySha256);
  const engine = JSON.parse(engineBytes);
  const home = fs.mkdtempSync(
    path.join(checkedNativeDirectory(root, ".audit/prisma-macros"), "run-"),
  );
  const save = (file, b) =>
    fs.writeFileSync(path.join(home, file), b, { flag: "wx" });
  save("policy.json", bytes);
  save("original-tds-policy.json", originalBytes);
  save("engine-policy.json", engineBytes);
  const tools = await prepareRustToolchain(root);
  tools.env.GIT_CEILING_DIRECTORIES = tools.home;
  const fixture = path.join(tools.home, "probe");
  fs.mkdirSync(fixture);
  fs.mkdirSync(path.join(fixture, "vendor"));
  fs.mkdirSync(path.join(fixture, "src/bin"), { recursive: true });
  for (const [file, expected] of [
    ["Cargo.toml", original.manifestSha256],
    ["Cargo.lock", original.lockSha256],
  ]) {
    const b = read(path.join(root, "tests/fixtures/prisma-tds", file));
    assert.equal(sha(b), expected);
    fs.writeFileSync(path.join(fixture, file), b);
    save(file, b);
  }
  const lib = read(
    path.join(root, "tests/fixtures/prisma-macro-contracts/lib.rs"),
  );
  assert.equal(sha(lib), p.fixtureSha256);
  fs.writeFileSync(path.join(fixture, "src/lib.rs"), lib);
  save("src-lib.rs", lib);
  const caseBytes = read(
    path.join(root, "tests/fixtures/prisma-macro-contracts/invalid.json"),
  );
  assert.equal(sha(caseBytes), p.invalidCasesSha256);
  save("invalid.json", caseBytes);
  const cases = validateMacroCases(JSON.parse(caseBytes));
  for (const c of cases) {
    const source = macroCaseSource(c);
    fs.writeFileSync(path.join(fixture, `src/bin/${c.name}.rs`), source);
    save(`case-${c.name}.rs`, source);
  }
  const commands = [];
  const execute = (exe, args, cwd, name, expectedStatus = 0) => {
    const r = spawnSync(exe, args, {
      cwd,
      env: tools.env,
      windowsHide: true,
      timeout: 1200000,
      maxBuffer: 32_000_000,
    });
    const stdout = (r.stdout || Buffer.alloc(0)).toString(),
      stderr = (r.stderr || Buffer.alloc(0)).toString();
    save(`${name}.stdout.log`, stdout);
    save(`${name}.stderr.log`, stderr);
    const c = {
      name,
      executable: exe,
      args,
      status: r.status,
      expectedStatus,
      signal: r.signal,
      error: r.error?.code || null,
      stdoutSha256: sha(stdout),
      stderrSha256: sha(stderr),
    };
    commands.push(c);
    save(`${name}.command.json`, JSON.stringify(c, null, 2) + "\n");
    assert.equal(r.status, expectedStatus, `${name}: ${stderr.slice(-2500)}`);
    return {
      stdout,
      stderr,
      status: r.status,
      signal: r.signal,
      error: r.error?.code || null,
    };
  };
  const archive = path.join(home, "tiberius.tar.gz");
  await downloadRustInput(
    `https://codeload.github.com/${original.repository}/tar.gz/${original.commit}`,
    archive,
    original.archiveSha256,
  );
  execute(
    "tar",
    ["-xf", archive, "-C", path.join(fixture, "vendor")],
    root,
    "source-extract",
  );
  const unpacked = path.join(fixture, "vendor", `tiberius-${original.commit}`),
    source = path.join(fixture, "vendor/tiberius");
  checkRustSourceTree(unpacked);
  fs.renameSync(unpacked, source);
  const sources = tdsSourceManifest(source);
  assert.equal(sources.length, 158);
  assert.equal(sha(JSON.stringify(sources)), original.sourceManifestSha256);
  const input = (base, file) =>
    assert.equal(sha(read(path.join(base, file.path))), file.sha256);
  for (const f of p.macroSourceFiles)
    input(path.join(source, "tiberius-macros"), f);
  await preparePrismaWinauthSource(
    root,
    fixture,
    path.join(root, ".audit/rust-cache"),
    engine.winauthSource,
    execute,
    input,
  );
  for (const f of engine.winauthSource.sourceFiles)
    input(path.join(fixture, "vendor/winauth"), f);
  const lock = read(path.join(fixture, "Cargo.lock")),
    assessment = await scanRustLockfile(lock.toString());
  save("registry-assessment.json", JSON.stringify(assessment, null, 2) + "\n");
  assert.equal(assessment.sourceAuditOk, true);
  assert.equal(assessment.packageCount, 133);
  const baseline = rustRegistryPackages(
    read(path.join(root, engine.lockfile.path)).toString(),
  ).packages;
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
  const m = JSON.parse(
    execute(
      tools.cargo,
      [
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--filter-platform",
        TARGETS[process.platform],
      ],
      fixture,
      "metadata",
    ).stdout,
  );
  checkMacroMetadata(m, fixture, process.platform);
  save("metadata.json", JSON.stringify(m) + "\n");
  const messages = execute(
    tools.cargo,
    [
      "test",
      "--release",
      "--locked",
      "--offline",
      "--no-run",
      "--message-format=json",
      "--lib",
    ],
    fixture,
    "compile",
  )
    .stdout.trim()
    .split(/\r?\n/)
    .map(JSON.parse);
  const macroId = m.packages.find((x) => x.name === "tiberius-macros").id;
  assert.ok(
    messages.some(
      (x) =>
        x.reason === "compiler-artifact" &&
        x.package_id === macroId &&
        x.target.kind.includes("proc-macro"),
    ),
  );
  const driver = messages.filter(
    (x) => x.reason === "compiler-artifact" && x.target.name === "tiberius",
  );
  assert.equal(driver.length, 1);
  assert.deepEqual([...driver[0].features].sort(), FEATURES);
  const built = messages.filter(
    (x) =>
      x.reason === "compiler-artifact" &&
      x.target.name === "oja_prisma_tds_probes" &&
      x.profile.test &&
      x.executable,
  );
  assert.equal(built.length, 1);
  const executable = fs.realpathSync(built[0].executable),
    stat = fs.lstatSync(executable);
  assert.ok(
    executable.startsWith(fs.realpathSync(tools.home) + path.sep) &&
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size <= 64_000_000,
  );
  const sealed = path.join(
    home,
    process.platform === "win32" ? "macro-probes.exe" : "macro-probes",
  );
  fs.copyFileSync(executable, sealed, fs.constants.COPYFILE_EXCL);
  const executableBytes = read(sealed, 64_000_000);
  assert.equal(sha(executableBytes), sha(fs.readFileSync(executable)));
  const native = execute(
    sealed,
    ["--test-threads=1", "--nocapture"],
    fixture,
    "native-tests",
  );
  const result = verifyMacroNative(native.stdout, native.stderr);
  const rejections = [];
  for (const c of cases) {
    const r = execute(
      tools.cargo,
      [
        "check",
        "--release",
        "--locked",
        "--offline",
        "--message-format=json",
        "--bin",
        c.name,
      ],
      fixture,
      `reject-${c.name}`,
      101,
    );
    rejections.push(verifyMacroRejection(r, m.resolve.root, c));
  }
  assert.equal(sha(read(sealed, 64_000_000)), sha(executableBytes));
  assert.deepEqual(tdsSourceManifest(source), sources);
  assert.ok(read(path.join(fixture, "Cargo.lock")).equals(lock));
  for (const f of engine.winauthSource.sourceFiles)
    input(path.join(fixture, "vendor/winauth"), f);
  const report = {
    observedAt: new Date().toISOString(),
    platform: process.platform,
    target: TARGETS[process.platform],
    policy: p,
    policySha256: sha(bytes),
    toolchain: tools.receipt,
    sourceManifest: sources,
    metadataSha256: sha(read(path.join(home, "metadata.json"))),
    registryAssessmentSha256: sha(
      read(path.join(home, "registry-assessment.json")),
    ),
    executableSha256: sha(executableBytes),
    executableBytes: executableBytes.length,
    commands,
    native: result,
    rejections,
    allMacroContractsVerified: true,
    wholeEngineVerified: false,
    sourceReviewComplete: false,
    productionApproved: false,
    artifactStatus: "NOT_VERIFIED",
    scope:
      "Original fixed proc macro, actual public TableValueRow/TableValue data binding and case-specific compile-time rejection only. No SQL Server, network, integrated authentication, full driver/compiler-source or production approval.",
  };
  save("receipt.json", JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      home,
      platform: process.platform,
      nativeTests: result.tests,
      compilerRejections: rejections.length,
      allMacroContractsVerified: true,
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
  await testPrismaMacros();
}

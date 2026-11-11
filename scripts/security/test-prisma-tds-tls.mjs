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
const read = (file, max = 4_000_000) => {
  const s = fs.lstatSync(file);
  assert.ok(
    s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= max,
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
const TESTS = [
  "trusted_ca_and_matching_hostname_complete_encrypted_login",
  "untrusted_ca_is_rejected_before_tds_data",
  "wrong_hostname_is_rejected_before_tds_data",
  "expired_certificate_is_rejected_before_tds_data",
  "future_certificate_is_rejected_before_tds_data",
];
export function validateTdsTlsPolicy(p) {
  assert.equal(p.schemaVersion, 1);
  assert.equal(
    p.originalTdsPolicySha256,
    "44c787da3cd940fd2e2b6b7894515b8c3db3bf8283ca4e5e7c0b8c980ab7725a",
  );
  assert.deepEqual(p.targets, TARGETS);
  assert.equal(p.encryptionMode, "Strict");
  assert.equal(p.serverProtocol, "TLSv1.2");
  assert.equal(p.testCount, 5);
  assert.equal(p.connectCalls, 5);
  assert.equal(p.successfulEncryptedLogins, 1);
  assert.equal(p.certificateRejections, 4);
  assert.ok(Number.isInteger(p.registryPackages) && p.registryPackages > 100);
  assert.deepEqual(
    p.fixtureFiles.map((x) => x.path).sort(),
    [
      "Cargo.toml",
      "Cargo.lock",
      "src/lib.rs",
      "generate-certificates.ps1",
      "certificates/root.der",
      "certificates/valid.der",
      "certificates/valid.pfx",
      "certificates/expired.der",
      "certificates/expired.pfx",
      "certificates/future.der",
      "certificates/future.pfx",
    ].sort(),
  );
  for (const f of p.fixtureFiles) assert.match(f.sha256, /^[a-f0-9]{64}$/);
  for (const field of [
    "wholeEngineVerified",
    "sourceReviewComplete",
    "productionApproved",
    "systemTrustStoreModified",
  ])
    assert.equal(p[field], false);
  assert.equal(p.artifactStatus, "NOT_VERIFIED");
  return p;
}
export function verifyCertificateFixtures(directory, p, now = new Date()) {
  const certs = {};
  for (const file of p.fixtureFiles) {
    const b = read(path.join(directory, file.path));
    assert.equal(sha(b), file.sha256, file.path);
    if (file.path.endsWith(".der"))
      certs[path.basename(file.path, ".der")] = new crypto.X509Certificate(b);
  }
  const root = certs.root;
  assert.equal(root.ca, true);
  assert.equal(root.subject, "CN=Oja isolated TLS fixture CA");
  assert.ok(root.verify(root.publicKey));
  assert.ok(root.validFromDate < now && root.validToDate > now);
  for (const name of ["valid", "expired", "future"]) {
    const c = certs[name];
    assert.equal(c.ca, false);
    assert.equal(c.issuer, root.subject);
    assert.ok(c.verify(root.publicKey));
    assert.equal(c.checkHost("tds.fixture.invalid"), "tds.fixture.invalid");
    assert.equal(c.checkHost("wrong.fixture.invalid"), undefined);
  }
  assert.ok(certs.valid.validFromDate < now && certs.valid.validToDate > now);
  assert.ok(certs.expired.validToDate < now);
  assert.ok(certs.future.validFromDate > now);
  return Object.fromEntries(
    Object.entries(certs).map(([name, c]) => [
      name,
      {
        sha256: sha(c.raw),
        from: c.validFromDate.toISOString(),
        to: c.validToDate.toISOString(),
        subject: c.subject,
        issuer: c.issuer,
        ca: c.ca,
        san: c.subjectAltName || null,
      },
    ]),
  );
}
export function verifyTdsTlsResult(stdout, stderr) {
  assert.match(
    stdout,
    /test result: ok\. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out/,
  );
  for (const name of TESTS)
    assert.match(stdout, new RegExp(`test tests::${name} \\.\\.\\. ok`));
  const markers = stderr
    .split(/\r?\n/)
    .filter((s) => s.startsWith("OJA_TDS_TLS "));
  assert.deepEqual(
    markers.sort(),
    [
      "OJA_TDS_TLS scenario=trusted success=true prelogin=1 login=1",
      ...["untrusted", "hostname", "expired", "future"].map(
        (n) => `OJA_TDS_TLS scenario=${n} success=false prelogin=0 login=0`,
      ),
    ].sort(),
  );
  const errors = stderr
    .split(/\r?\n/)
    .filter((s) => s.startsWith("OJA_TDS_TLS_ERROR "));
  assert.equal(errors.length, 4);
  for (const name of ["untrusted", "hostname", "expired", "future"])
    assert.equal(
      errors.filter((s) =>
        s.startsWith(`OJA_TDS_TLS_ERROR scenario=${name} detail=`),
      ).length,
      1,
    );
  assert.doesNotMatch(
    stdout + stderr,
    /panicked at|thread .* panicked|stack overflow/,
  );
  return {
    tests: 5,
    connectCalls: 5,
    successfulEncryptedLogins: 1,
    certificateRejections: 4,
    rejectedConnectionsWithTdsData: 0,
  };
}
export function validateClassicTdsTlsPolicy(p) {
  assert.deepEqual(
    Object.keys(p).sort(),
    [
      "schemaVersion",
      "strictTlsPolicySha256",
      "fixturePath",
      "fixtureSha256",
      "clientModes",
      "serverModes",
      "serverProtocol",
      "testCount",
      "connectCalls",
      "successfulEncryptedLogins",
      "certificateRejections",
      "registryPackages",
      "wholeEngineVerified",
      "sourceReviewComplete",
      "productionApproved",
      "systemTrustStoreModified",
      "artifactStatus",
    ].sort(),
  );
  assert.equal(p.schemaVersion, 1);
  assert.equal(
    p.strictTlsPolicySha256,
    "3e846f519e789014383a8455f6e1032ad317dada665236f9f5db044e5e59f419",
  );
  assert.equal(p.fixturePath, "tests/fixtures/prisma-tds-classic/lib.rs");
  assert.match(p.fixtureSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(p.clientModes, ["On", "Required"]);
  assert.deepEqual(p.serverModes, [1, 3]);
  assert.equal(p.serverProtocol, "TLSv1.2");
  assert.equal(p.testCount, 5);
  assert.equal(p.connectCalls, 20);
  assert.equal(p.successfulEncryptedLogins, 4);
  assert.equal(p.certificateRejections, 16);
  assert.equal(p.registryPackages, 134);
  for (const key of [
    "wholeEngineVerified",
    "sourceReviewComplete",
    "productionApproved",
    "systemTrustStoreModified",
  ])
    assert.equal(p[key], false);
  assert.equal(p.artifactStatus, "NOT_VERIFIED");
  return p;
}
export function verifyClassicTdsTlsResult(stdout, stderr) {
  const names = [
    "trusted_classic_modes_complete_encrypted_login",
    "untrusted_classic_modes_reject_before_login",
    "wrong_hostname_classic_modes_reject_before_login",
    "expired_classic_modes_reject_before_login",
    "future_classic_modes_reject_before_login",
  ];
  assert.match(
    stdout,
    /test result: ok\. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out/,
  );
  for (const name of names)
    assert.equal(
      stdout
        .split(/\r?\n/)
        .filter((line) => line === `test tests::${name} ... ok`).length,
      1,
    );
  const lines = stderr.split(/\r?\n/);
  const markers = lines.filter((line) => line.startsWith("OJA_TDS_CLASSIC "));
  const errors = lines.filter((line) =>
    line.startsWith("OJA_TDS_CLASSIC_ERROR "),
  );
  assert.equal(markers.length, 20);
  assert.equal(errors.length, 16);
  for (const scenario of [
    "trusted",
    "untrusted",
    "hostname",
    "expired",
    "future",
  ])
    for (const client of ["On", "Required"])
      for (const server of [1, 3]) {
        const prefix = `scenario=${scenario} client=${client} server=${server}`;
        const selected = markers.filter((line) =>
          line.startsWith(`OJA_TDS_CLASSIC ${prefix} `),
        );
        assert.equal(selected.length, 1);
        const success = scenario === "trusted";
        assert.match(
          selected[0],
          new RegExp(
            `^OJA_TDS_CLASSIC ${prefix} success=${success} clear_prelogin=1 encrypted_login=${success ? 1 : 0} received=([1-9][0-9]?) sent=([1-9][0-9]?)$`,
          ),
        );
        const detail = errors.filter((line) =>
          line.startsWith(`OJA_TDS_CLASSIC_ERROR ${prefix} detail=`),
        );
        assert.equal(detail.length, success ? 0 : 1);
        if (!success) assert.ok(detail[0].split(" detail=")[1].trim());
      }
  assert.doesNotMatch(
    stdout + stderr,
    /panicked at|thread .* panicked|stack overflow/,
  );
  return {
    tests: 5,
    connectCalls: 20,
    successfulEncryptedLogins: 4,
    certificateRejections: 16,
    plaintextPrelogins: 20,
    rejectedConnectionsWithLogin: 0,
  };
}
export function checkTdsTlsMetadata(m, fixture, platform) {
  assert.ok(TARGETS[platform]);
  const locals = m.packages.filter((x) => !x.source);
  assert.deepEqual(
    locals.map((x) => x.name).sort(),
    [
      "oja-prisma-tds-tls-probes",
      "tiberius",
      "tiberius-macros",
      ...(platform === "win32" ? ["winauth"] : []),
    ].sort(),
  );
  const pkg = m.packages.find((x) => x.name === "tiberius"),
    macro = m.packages.find((x) => x.name === "tiberius-macros");
  assert.equal(pkg.version, "0.13.0");
  assert.equal(macro.version, "0.1.0");
  for (const [p, relative] of [
    [pkg, "vendor/tiberius/Cargo.toml"],
    [macro, "vendor/tiberius/tiberius-macros/Cargo.toml"],
  ])
    assert.equal(
      fs.realpathSync(p.manifest_path),
      path.join(fs.realpathSync(fixture), relative),
    );
  const node = m.resolve.nodes.find((x) => x.id === pkg.id);
  assert.deepEqual([...node.features].sort(), FEATURES);
  assert.ok(macro.targets.some((x) => x.kind.includes("proc-macro")));
  assert.ok(node.deps.some((x) => x.pkg === macro.id));
  const root = m.resolve.nodes.find((x) => x.id === m.resolve.root);
  for (const [name, version] of [
    ["native-tls", "0.2.18"],
    ["tokio-native-tls", "0.3.1"],
    ["tokio", "1.54.1"],
    ["tokio-util", "0.7.20"],
  ]) {
    const dep = m.packages.find((x) => x.name === name);
    assert.equal(dep.version, version);
    assert.equal(
      dep.source,
      "registry+https://github.com/rust-lang/crates.io-index",
    );
    assert.ok(root.deps.some((x) => x.pkg === dep.id));
  }
  if (platform === "win32") {
    const auth = m.packages.find((x) => x.name === "winauth");
    assert.equal(auth.version, "0.0.5+oja.2");
    assert.equal(
      fs.realpathSync(auth.manifest_path),
      path.join(fs.realpathSync(fixture), "vendor/winauth/Cargo.toml"),
    );
    assert.ok(node.deps.some((x) => x.pkg === auth.id));
  }
  return node.features;
}

export async function testPrismaTdsTls(root = ROOT, { classic = false } = {}) {
  assert.equal(typeof classic, "boolean");
  assert.equal(process.env.CI, "true");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.ok(TARGETS[process.platform]);
  const strictPolicyBytes = read(
    path.join(root, "security/prisma-tds-tls-contracts.json"),
  );
  const strictPolicy = validateTdsTlsPolicy(JSON.parse(strictPolicyBytes));
  const policyBytes = classic
    ? read(path.join(root, "security/prisma-tds-classic-contracts.json"))
    : strictPolicyBytes;
  const p = classic
    ? validateClassicTdsTlsPolicy(JSON.parse(policyBytes))
    : strictPolicy;
  if (classic) assert.equal(sha(strictPolicyBytes), p.strictTlsPolicySha256);
  const originalBytes = read(
    path.join(root, "security/prisma-tds-contracts.json"),
  );
  assert.equal(sha(originalBytes), strictPolicy.originalTdsPolicySha256);
  const original = JSON.parse(originalBytes);
  const engineBytes = read(
    path.join(root, "security/prisma-source-contracts.json"),
  );
  assert.equal(sha(engineBytes), original.sourcePolicySha256);
  const engine = JSON.parse(engineBytes);
  const home = fs.mkdtempSync(
    path.join(
      checkedNativeDirectory(
        root,
        classic ? ".audit/prisma-tds-classic" : ".audit/prisma-tds-tls",
      ),
      "run-",
    ),
  );
  const save = (name, bytes) =>
    fs.writeFileSync(path.join(home, name), bytes, { flag: "wx" });
  save("policy.json", policyBytes);
  if (classic) save("strict-tls-policy.json", strictPolicyBytes);
  save("original-tds-policy.json", originalBytes);
  save("engine-policy.json", engineBytes);
  const tools = await prepareRustToolchain(root);
  tools.env.GIT_CEILING_DIRECTORIES = tools.home;
  const fixture = path.join(tools.home, "probe");
  fs.mkdirSync(fixture);
  fs.mkdirSync(path.join(fixture, "vendor"));
  const fixtureSource = path.join(root, "tests/fixtures/prisma-tds-tls");
  const certificates = verifyCertificateFixtures(fixtureSource, strictPolicy);
  for (const file of strictPolicy.fixtureFiles) {
    const target = path.join(fixture, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const b = read(path.join(fixtureSource, file.path));
    fs.writeFileSync(target, b, { flag: "wx" });
    save(file.path.replaceAll("/", "-"), b);
  }
  if (classic) {
    const bytes = read(path.join(root, p.fixturePath));
    assert.equal(sha(bytes), p.fixtureSha256);
    fs.writeFileSync(path.join(fixture, "src/lib.rs"), bytes);
    save("classic-src-lib.rs", bytes);
  }
  const commands = [];
  const execute = (executable, args, cwd, name) => {
    const r = spawnSync(executable, args, {
      cwd,
      env: tools.env,
      windowsHide: true,
      timeout: 1200000,
      maxBuffer: 32_000_000,
    });
    const stdout = r.stdout || Buffer.alloc(0),
      stderr = r.stderr || Buffer.alloc(0);
    save(`${name}.stdout.log`, stdout);
    save(`${name}.stderr.log`, stderr);
    const c = {
      name,
      executable,
      args,
      status: r.status,
      signal: r.signal,
      error: r.error?.code || null,
      stdoutSha256: sha(stdout),
      stderrSha256: sha(stderr),
    };
    commands.push(c);
    save(`${name}.command.json`, JSON.stringify(c, null, 2) + "\n");
    assert.equal(r.status, 0, `${name}: ${stderr.toString().slice(-2500)}`);
    return stdout.toString();
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
    source = path.join(fixture, "vendor", "tiberius");
  checkRustSourceTree(unpacked);
  fs.renameSync(unpacked, source);
  const sources = tdsSourceManifest(source);
  assert.equal(sources.length, 158);
  assert.equal(sha(JSON.stringify(sources)), original.sourceManifestSha256);
  const input = (base, f) =>
    assert.equal(sha(read(path.join(base, f.path))), f.sha256);
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
  const lock = read(path.join(fixture, "Cargo.lock"));
  const assessment = await scanRustLockfile(lock.toString());
  save("registry-assessment.json", JSON.stringify(assessment, null, 2) + "\n");
  assert.equal(assessment.sourceAuditOk, true);
  assert.equal(assessment.packageCount, p.registryPackages);
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
    ),
  );
  const features = checkTdsTlsMetadata(m, fixture, process.platform);
  save("metadata.json", JSON.stringify(m) + "\n");
  const messages = execute(
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
  )
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse);
  const driver = messages.filter(
    (x) => x.reason === "compiler-artifact" && x.target.name === "tiberius",
  );
  assert.equal(driver.length, 1);
  assert.deepEqual([...driver[0].features].sort(), [...features].sort());
  const built = messages.filter(
    (x) =>
      x.reason === "compiler-artifact" &&
      x.target.name === "oja_prisma_tds_tls_probes" &&
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
    `${classic ? "tds-classic" : "tds-tls"}-probes${process.platform === "win32" ? ".exe" : ""}`,
  );
  fs.copyFileSync(executable, sealed, fs.constants.COPYFILE_EXCL);
  const executableBytes = read(sealed, 64_000_000);
  assert.equal(sha(fs.readFileSync(executable)), sha(executableBytes));
  const stdout = execute(
    sealed,
    ["--test-threads=1", "--nocapture"],
    fixture,
    "native-tests",
  );
  const result = (classic ? verifyClassicTdsTlsResult : verifyTdsTlsResult)(
    stdout,
    read(path.join(home, "native-tests.stderr.log")).toString(),
  );
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
    policySha256: sha(policyBytes),
    toolchain: tools.receipt,
    sourceManifest: sources,
    certificates,
    metadataSha256: sha(read(path.join(home, "metadata.json"))),
    registryAssessmentSha256: sha(
      read(path.join(home, "registry-assessment.json")),
    ),
    compiledTdsFeatures: features,
    executableSha256: sha(executableBytes),
    executableBytes: executableBytes.length,
    commands,
    result,
    ...(classic
      ? { allClassicTdsTlsContractsVerified: true }
      : { allTdsTlsContractsVerified: true }),
    wholeEngineVerified: false,
    sourceReviewComplete: false,
    productionApproved: false,
    systemTrustStoreModified: false,
    artifactStatus: "NOT_VERIFIED",
    scope: classic
      ? "Original fixed Tiberius classic PRELOGIN-wrapped TLS 1.2 certificate handshakes, client On/Required and server On/Required, fragmented memory-only duplex streams. Test-only CA/identities, no sockets or SQL Server, no system trust changes; not TLS1.3, integrated authentication, full source or production approval."
      : "Original fixed Tiberius Strict-mode TLS 1.2 certificate handshakes over memory-only duplex streams. Test-only CA and identities, no sockets or SQL Server, no system trust changes; not classic TDS-wrapped TLS, integrated authentication, full source or production approval.",
  };
  save("receipt.json", JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      home,
      platform: process.platform,
      ...result,
      ...(classic
        ? { allClassicTdsTlsContractsVerified: true }
        : { allTdsTlsContractsVerified: true }),
      productionApproved: false,
    }),
  );
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assert.ok(
    process.argv.length === 2 ||
      (process.argv.length === 3 && process.argv[2] === "--classic"),
  );
  await testPrismaTdsTls(ROOT, { classic: process.argv[2] === "--classic" });
}

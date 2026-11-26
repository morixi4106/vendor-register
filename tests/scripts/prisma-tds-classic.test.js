import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import yaml from "js-yaml";
import {
  validateClassicTdsTlsPolicy,
  verifyClassicTdsTlsResult,
  validateTdsTlsPolicy,
  verifyCertificateFixtures,
} from "../../scripts/security/test-prisma-tds-tls.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const read = (name) => fs.readFileSync(path.join(root, name));
const digest = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const policy = () =>
  JSON.parse(read("security/prisma-tds-classic-contracts.json"));

test("classic policy fixes the full mode matrix without approving source or production", () => {
  assert.equal(validateClassicTdsTlsPolicy(policy()).connectCalls, 20);
  for (const change of [
    (p) => {
      p.clientModes = ["Strict"];
    },
    (p) => {
      p.serverModes = [0, 2];
    },
    (p) => {
      p.serverProtocol = "TLSv1.3";
    },
    (p) => {
      p.testCount = 20;
    },
    (p) => {
      p.connectCalls = 5;
    },
    (p) => {
      p.certificateRejections = 0;
    },
    (p) => {
      p.successfulEncryptedLogins = 20;
    },
    (p) => {
      p.productionApproved = true;
    },
    (p) => {
      p.wholeEngineVerified = true;
    },
    (p) => {
      p.sourceReviewComplete = true;
    },
    (p) => {
      p.systemTrustStoreModified = true;
    },
    (p) => {
      p.fixturePath = "../unbound.rs";
    },
    (p) => {
      p.fixtureSha256 = "invalid";
    },
    (p) => {
      p.strictTlsPolicySha256 = "0".repeat(64);
    },
    (p) => {
      p.unknownApproval = true;
    },
  ]) {
    const p = policy();
    change(p);
    assert.throws(() => validateClassicTdsTlsPolicy(p));
  }
});

test("classic probes reuse every fixed Strict input and original dependency graph", () => {
  const p = policy();
  const strictBytes = read("security/prisma-tds-tls-contracts.json");
  assert.equal(digest(strictBytes), p.strictTlsPolicySha256);
  const strict = validateTdsTlsPolicy(JSON.parse(strictBytes));
  assert.equal(digest(read(p.fixturePath)), p.fixtureSha256);
  assert.equal(p.registryPackages, strict.registryPackages);
  const certificates = verifyCertificateFixtures(
    path.join(root, "tests/fixtures/prisma-tds-tls"),
    strict,
    new Date("2026-11-07T00:00:00Z"),
  );
  assert.equal(certificates.valid.san, "DNS:tds.fixture.invalid");
  const runner = read("scripts/security/test-prisma-tds-tls.mjs").toString();
  assert.match(
    runner,
    /if \(classic\) assert\.equal\(sha\(strictPolicyBytes\), p\.strictTlsPolicySha256\)/,
  );
  assert.match(
    runner,
    /verifyCertificateFixtures\(fixtureSource, strictPolicy\)/,
  );
  assert.match(runner, /assert\.equal\(sha\(bytes\), p\.fixtureSha256\)/);
});

function output() {
  const names = [
    "trusted_classic_modes_complete_encrypted_login",
    "untrusted_classic_modes_reject_before_login",
    "wrong_hostname_classic_modes_reject_before_login",
    "expired_classic_modes_reject_before_login",
    "future_classic_modes_reject_before_login",
  ];
  const stdout =
    names.map((n) => `test tests::${n} ... ok`).join("\n") +
    "\ntest result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n";
  const lines = [];
  for (const scenario of [
    "trusted",
    "untrusted",
    "hostname",
    "expired",
    "future",
  ])
    for (const client of ["On", "Required"])
      for (const server of [1, 3]) {
        const success = scenario === "trusted";
        const prefix = `scenario=${scenario} client=${client} server=${server}`;
        lines.push(
          `OJA_TDS_CLASSIC ${prefix} success=${success} clear_prelogin=1 encrypted_login=${success ? 1 : 0} received=2 sent=2`,
        );
        if (!success)
          lines.push(
            `OJA_TDS_CLASSIC_ERROR ${prefix} detail=fixture certificate error`,
          );
      }
  return [stdout, lines.join("\n") + "\n"];
}

test("classic results require all twenty distinct connections and sixteen exact rejection slots", () => {
  const [stdout, stderr] = output();
  assert.deepEqual(verifyClassicTdsTlsResult(stdout, stderr), {
    tests: 5,
    connectCalls: 20,
    successfulEncryptedLogins: 4,
    certificateRejections: 16,
    plaintextPrelogins: 20,
    rejectedConnectionsWithLogin: 0,
  });
  for (const [out, err] of [
    [stdout.replace("5 passed", "0 passed"), stderr],
    [stdout.replace("0 ignored", "1 ignored"), stderr],
    [
      stdout.replace(
        "wrong_hostname_classic_modes_reject_before_login",
        "missing",
      ),
      stderr,
    ],
    [stdout, stderr.replace("client=Required", "client=Off")],
    [stdout, stderr.replace("server=3", "server=2")],
    [stdout, stderr.replace("clear_prelogin=1", "clear_prelogin=0")],
    [stdout, stderr.replace("received=2", "received=0")],
    [stdout, stderr.replace("sent=2", "sent=0")],
    [
      stdout,
      stderr.replace(
        "success=false clear_prelogin=1 encrypted_login=0",
        "success=false clear_prelogin=1 encrypted_login=1",
      ),
    ],
    [
      stdout,
      stderr.replace("OJA_TDS_CLASSIC_ERROR scenario=hostname", "missing"),
    ],
    [stdout, stderr + stderr.split("\n")[0] + "\n"],
    [stdout, stderr + "thread 'probe' panicked at certificate validation"],
  ])
    assert.throws(() => verifyClassicTdsTlsResult(out, err));
});

test("classic native fixture uses the real client, fragmented PRELOGIN wrapping and encrypted LOGIN", () => {
  const rust = read(policy().fixturePath).toString();
  for (const required of [
    "Client::connect(config, Segmented(client_io).compat())",
    "[EncryptionLevel::On, EncryptionLevel::Required]",
    "[1u8, 3u8]",
    "tokio::io::duplex",
    "let mut small = [0u8; 3]",
    "bytes.len().min(11)",
    "acceptor.accept(framed)",
    "handshake.store(false",
    "assert_eq!(kind, 0x10",
    "Err(Error::Tls(message))",
    "assert_certificate_error(name, &message)",
    "Duration::from_secs(10)",
    "Protocol::Tlsv12",
    "packet(0x12,",
  ])
    assert.ok(rust.includes(required), required);
  assert.doesNotMatch(
    rust,
    /TcpStream|TcpListener|danger_accept|trust_cert\(\)|DATABASE_URL|EncryptionLevel::NotSupported/,
  );
  assert.equal((rust.match(/#\[tokio::test\]/g) || []).length, 5);
});

test("classic workflow is read-only, source-bound and cannot publish or use real credentials", () => {
  const w = yaml.load(
    read(".github/workflows/prisma-tds-classic-contracts.yml").toString(),
  );
  assert.deepEqual(w.permissions, { contents: "read" });
  assert.deepEqual(w.jobs.classic.strategy.matrix.os, [
    "ubuntu-latest",
    "windows-latest",
  ]);
  assert.equal(w.jobs.classic["timeout-minutes"], 25);
  const text = JSON.stringify(w);
  assert.match(text, /test-prisma-tds-tls\.mjs --classic/);
  assert.match(text, /persist-credentials.*false/);
  assert.doesNotMatch(
    text,
    /secrets\.|schedule|pull_request_target|migrate deploy|shopify app|send.*mail/i,
  );
});

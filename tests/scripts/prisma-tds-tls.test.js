import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateTdsTlsPolicy,
  verifyCertificateFixtures,
  verifyTdsTlsResult,
  checkTdsTlsMetadata,
} from "../../scripts/security/test-prisma-tds-tls.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const p = () =>
  JSON.parse(
    fs.readFileSync(path.join(root, "security/prisma-tds-tls-contracts.json")),
  );
const fixtures = path.join(root, "tests/fixtures/prisma-tds-tls");

test("TLS policy fixes both platforms, real handshakes, controls and non-approval flags", () => {
  assert.equal(validateTdsTlsPolicy(p()).testCount, 5);
  for (const change of [
    (q) => {
      q.productionApproved = true;
    },
    (q) => {
      q.systemTrustStoreModified = true;
    },
    (q) => {
      q.encryptionMode = "NotSupported";
    },
    (q) => {
      q.targets.win32 = "linux";
    },
    (q) => {
      q.testCount = 0;
    },
    (q) => {
      q.fixtureFiles[0].path = "../escape";
    },
    (q) => {
      q.originalTdsPolicySha256 = "0".repeat(64);
    },
  ]) {
    const q = p();
    change(q);
    assert.throws(() => validateTdsTlsPolicy(q));
  }
});

test("fixed certificates verify actual issuer signatures, SANs and opposing validity periods", () => {
  const certs = verifyCertificateFixtures(
    fixtures,
    p(),
    new Date("2026-11-06T00:00:00Z"),
  );
  assert.equal(certs.root.ca, true);
  assert.equal(certs.valid.san, "DNS:tds.fixture.invalid");
  for (const date of ["2019-01-01", "2039-01-01"])
    assert.throws(() =>
      verifyCertificateFixtures(fixtures, p(), new Date(date)),
    );
  const q = p();
  q.fixtureFiles.find((f) => f.path === "certificates/valid.pfx").sha256 =
    "0".repeat(64);
  assert.throws(() => verifyCertificateFixtures(fixtures, q));
});

test("certificate fixtures reject links, replacements and missing files", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tds-tls-fixture-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(fixtures, dir, { recursive: true });
  const file = path.join(dir, "certificates/valid.der");
  fs.linkSync(file, path.join(dir, "duplicate"));
  assert.throws(() => verifyCertificateFixtures(dir, p()));
  fs.unlinkSync(path.join(dir, "duplicate"));
  fs.writeFileSync(
    file,
    fs.readFileSync(path.join(dir, "certificates/expired.der")),
  );
  assert.throws(() => verifyCertificateFixtures(dir, p()));
});

test("native evidence requires five real cases, certificate errors and no prelogin on rejection", () => {
  const names = [
    "trusted_ca_and_matching_hostname_complete_encrypted_login",
    "untrusted_ca_is_rejected_before_tds_data",
    "wrong_hostname_is_rejected_before_tds_data",
    "expired_certificate_is_rejected_before_tds_data",
    "future_certificate_is_rejected_before_tds_data",
  ];
  const stdout =
    names.map((n) => `test tests::${n} ... ok`).join("\n") +
    "\ntest result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n";
  const stderr =
    "OJA_TDS_TLS scenario=trusted success=true prelogin=1 login=1\n" +
    ["untrusted", "hostname", "expired", "future"]
      .map(
        (n) =>
          `OJA_TDS_TLS scenario=${n} success=false prelogin=0 login=0\nOJA_TDS_TLS_ERROR scenario=${n} detail=certificate rejected\n`,
      )
      .join("");
  assert.equal(verifyTdsTlsResult(stdout, stderr).certificateRejections, 4);
  for (const [out, err] of [
    [stdout.replace("5 passed", "0 passed"), stderr],
    [stdout.replace(names[0], "missing"), stderr],
    [stdout.replace("0 ignored", "1 ignored"), stderr],
    [stdout, stderr.replace("prelogin=0", "prelogin=1")],
    [stdout, stderr.replace("OJA_TDS_TLS_ERROR scenario=hostname", "removed")],
    [stdout, stderr + "thread 'native' panicked at TLS"],
    [
      stdout,
      stderr + "OJA_TDS_TLS scenario=trusted success=true prelogin=1 login=1\n",
    ],
  ])
    assert.throws(() => verifyTdsTlsResult(out, err));
});

test("metadata binds original TLS features and target-specific auth without extra local sources", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tds-tls-metadata-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const packages = [{ id: "root", name: "oja-prisma-tds-tls-probes" }];
  for (const [id, name, version, location] of [
    ["tds", "tiberius", "0.13.0", "vendor/tiberius"],
    ["macro", "tiberius-macros", "0.1.0", "vendor/tiberius/tiberius-macros"],
  ]) {
    fs.mkdirSync(path.join(dir, location), { recursive: true });
    fs.writeFileSync(path.join(dir, location, "Cargo.toml"), "[package]\n");
    packages.push({
      id,
      name,
      version,
      manifest_path: path.join(dir, location, "Cargo.toml"),
      targets: [{ kind: [id === "macro" ? "proc-macro" : "lib"] }],
    });
  }
  for (const [name, version] of [
    ["native-tls", "0.2.18"],
    ["tokio-native-tls", "0.3.1"],
    ["tokio", "1.54.1"],
    ["tokio-util", "0.7.20"],
  ])
    packages.push({
      id: name,
      name,
      version,
      source: "registry+https://github.com/rust-lang/crates.io-index",
    });
  const m = {
    packages,
    resolve: {
      root: "root",
      nodes: [
        {
          id: "root",
          deps: packages.filter((p) => p.source).map((p) => ({ pkg: p.id })),
        },
        {
          id: "tds",
          deps: [{ pkg: "macro" }],
          features: [
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
          ],
        },
      ],
    },
  };
  assert.ok(checkTdsTlsMetadata(m, dir, "linux"));
  for (const change of [
    (j) => {
      j.resolve.nodes[1].features.push("vendored-openssl");
    },
    (j) => {
      j.resolve.nodes[1].deps = [];
    },
    (j) => {
      j.packages.push({ id: "unknown", name: "unknown" });
    },
    (j) => {
      j.resolve.nodes[0].deps = [];
    },
  ]) {
    const j = structuredClone(m);
    change(j);
    assert.throws(() => checkTdsTlsMetadata(j, dir, "linux"));
  }
  assert.throws(() => checkTdsTlsMetadata(m, dir, "win32"));
  fs.mkdirSync(path.join(dir, "vendor/winauth"));
  fs.writeFileSync(path.join(dir, "vendor/winauth/Cargo.toml"), "[package]\n");
  m.packages.push({
    id: "auth",
    name: "winauth",
    version: "0.0.5+oja.2",
    manifest_path: path.join(dir, "vendor/winauth/Cargo.toml"),
  });
  m.resolve.nodes[1].deps.push({ pkg: "auth" });
  assert.ok(checkTdsTlsMetadata(m, dir, "win32"));
});

test("TLS workflow remains isolated and never turns on certificate bypass or network peers", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/prisma-tds-tls-contracts.yml"),
    "utf8",
  );
  assert.match(workflow, /os: \[ubuntu-latest, windows-latest\]/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(
    workflow,
    /secrets\.|schedule:|pull_request_target:|migrate deploy|shopify app deploy/,
  );
  const native = fs.readFileSync(path.join(fixtures, "src/lib.rs"), "utf8");
  assert.match(native, /Client::connect/);
  assert.match(native, /tokio::io::duplex/);
  assert.match(native, /EncryptionLevel::Strict/);
  assert.doesNotMatch(
    native,
    /TcpStream|TcpListener|danger_accept|trust_cert\(\)|DATABASE_URL/,
  );
  const generator = fs.readFileSync(
    path.join(fixtures, "generate-certificates.ps1"),
    "utf8",
  );
  assert.doesNotMatch(
    generator,
    /Cert:\\|Import-Certificate|X509Store|New-SelfSignedCertificate/,
  );
});

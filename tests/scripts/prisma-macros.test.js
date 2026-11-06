import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  validateMacroPolicy,
  validateMacroCases,
  macroCaseSource,
  verifyMacroRejection,
  verifyMacroNative,
  checkMacroMetadata,
} from "../../scripts/security/test-prisma-macros.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const policy = () => JSON.parse(read("security/prisma-macro-contracts.json"));
const cases = () =>
  JSON.parse(read("tests/fixtures/prisma-macro-contracts/invalid.json"));

test("macro policy reuses original immutable source/manifest/lock and never grants approval", () => {
  const p = validateMacroPolicy(policy());
  assert.equal(
    sha(read("security/prisma-tds-contracts.json")),
    p.originalTdsPolicySha256,
  );
  assert.equal(
    sha(read("tests/fixtures/prisma-macro-contracts/lib.rs")),
    p.fixtureSha256,
  );
  assert.equal(
    sha(read("tests/fixtures/prisma-macro-contracts/invalid.json")),
    p.invalidCasesSha256,
  );
  for (const mutate of [
    (q) => {
      q.productionApproved = true;
    },
    (q) => {
      q.sourceReviewComplete = true;
    },
    (q) => {
      q.nativeTests = 0;
    },
    (q) => {
      q.compilerRejections = 0;
    },
    (q) => {
      q.targets.win32 = "linux";
    },
    (q) => {
      q.macroSourceFiles.pop();
    },
  ]) {
    const q = policy();
    mutate(q);
    assert.throws(() => validateMacroPolicy(q));
  }
});

test("all ten fixed negative inputs stay separate and cannot escape source paths", () => {
  const cs = validateMacroCases(cases());
  assert.equal(cs.length, 10);
  for (const c of cs)
    assert.equal(
      macroCaseSource(c),
      `#[derive(tiberius::TableValueRow)]\n${c.declaration}\nfn main() {}\n`,
    );
  for (const mutate of [
    (cs) => {
      cs[0].name = "../escape";
    },
    (cs) => {
      cs.pop();
    },
    (cs) => {
      cs[0].declaration = "";
    },
    (cs) => {
      cs[0].diagnostic = "";
    },
  ]) {
    const q = cases();
    mutate(q);
    assert.throws(() => validateMacroCases(q));
  }
});

test("compile rejection requires exit101 and the exact root/bin diagnostic, not dependency failure or panic", () => {
  const c = cases()[0];
  const messages = [
    {
      reason: "compiler-message",
      package_id: "root",
      target: { name: c.name, kind: ["bin"] },
      message: { level: "error", message: c.diagnostic },
    },
    { reason: "build-finished", success: false },
  ];
  const result = {
    status: 101,
    signal: null,
    error: null,
    stdout: messages.map(JSON.stringify).join("\n"),
    stderr: "",
  };
  assert.equal(verifyMacroRejection(result, "root", c).correctlyRejected, true);
  for (const change of [
    (r) => {
      r.status = 0;
    },
    (r) => {
      r.status = 1;
    },
    (r) => {
      r.signal = "SIGTERM";
    },
    (r) => {
      r.error = "ETIMEDOUT";
    },
    (r) => {
      r.stderr = "proc macro panicked";
    },
    (r) => {
      r.stdout = r.stdout.replace(
        '"package_id":"root"',
        '"package_id":"dependency"',
      );
    },
    (r) => {
      r.stdout = r.stdout.replace(c.diagnostic, "unrelated failure");
    },
    (r) => {
      r.stdout = r.stdout.replace('"success":false', '"success":true');
    },
    (r) => {
      r.stdout += `\n${JSON.stringify({ reason: "compiler-artifact", target: { name: c.name } })}`;
    },
  ]) {
    const r = structuredClone(result);
    change(r);
    assert.throws(() => verifyMacroRejection(r, "root", c));
  }
});

test("positive native proof requires every real data-binding test without skipped or failed tests", () => {
  const names = [
    "scalar_columns_keep_order_and_type",
    "owned_columns_survive_input_drop",
    "borrowed_columns_keep_the_declared_lifetime",
    "optional_columns_preserve_null_values",
    "empty_named_struct_has_no_bound_columns",
    "column_attributes_do_not_change_field_binding",
  ];
  const stdout =
    names.map((n) => `test tests::${n} ... ok`).join("\n") +
    "\ntest result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n";
  assert.equal(verifyMacroNative(stdout, "").tests, 6);
  for (const [out, err] of [
    [stdout.replace("6 passed", "0 passed"), ""],
    [stdout.replace(names[0], "missing"), ""],
    [stdout.replace("0 ignored", "1 ignored"), ""],
    [stdout, "panicked at the actual macro"],
  ])
    assert.throws(() => verifyMacroNative(out, err));
});

test("metadata binds the actual public driver and proc-macro with platform auth and TLS features", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "macro-metadata-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const packages = [{ name: "oja-prisma-tds-probes", id: "root" }];
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
  const m = {
    packages,
    resolve: {
      root: "root",
      nodes: [
        { id: "root", deps: [{ pkg: "tds" }] },
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
  assert.ok(checkMacroMetadata(m, dir, "linux"));
  assert.throws(() => checkMacroMetadata(m, dir, "win32"));
  for (const change of [
    (j) => {
      j.resolve.nodes[1].features = [];
    },
    (j) => {
      j.resolve.nodes[1].deps = [];
    },
    (j) => {
      j.resolve.nodes[0].deps = [];
    },
    (j) => {
      j.packages[2].targets[0].kind = ["lib"];
    },
    (j) => {
      j.packages.push({ id: "unbound", name: "unbound" });
    },
  ]) {
    const j = structuredClone(m);
    change(j);
    assert.throws(() => checkMacroMetadata(j, dir, "linux"));
  }
  fs.mkdirSync(path.join(dir, "vendor/winauth"));
  fs.writeFileSync(path.join(dir, "vendor/winauth/Cargo.toml"), "[package]\n");
  m.packages.push({
    id: "auth",
    name: "winauth",
    version: "0.0.5+oja.2",
    manifest_path: path.join(dir, "vendor/winauth/Cargo.toml"),
  });
  m.resolve.nodes[1].deps.push({ pkg: "auth" });
  assert.ok(checkMacroMetadata(m, dir, "win32"));
});

test("macro workflow has both platforms, real Rust expansion, no production changes or network peer", () => {
  const workflow = read(
    ".github/workflows/prisma-macro-contracts.yml",
  ).toString();
  assert.match(workflow, /os: \[ubuntu-latest, windows-latest\]/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(
    workflow,
    /secrets\.|schedule:|pull_request_target:|migrate deploy|shopify app deploy/,
  );
  const fixture = read(
    "tests/fixtures/prisma-macro-contracts/lib.rs",
  ).toString();
  assert.match(fixture, /derive\(TableValueRow\)/);
  assert.match(fixture, /\.into_sql\(\)/);
  assert.doesNotMatch(
    fixture,
    /Client::connect|TcpStream|TcpListener|DATABASE_URL/,
  );
  const cli = read("scripts/security/test-prisma-macros.mjs").toString();
  assert.match(cli, /verifyMacroRejection\(r, m\.resolve\.root, c\)/);
  assert.match(cli, /expectedStatus = 0/);
});

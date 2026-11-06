import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateTdsPolicy,
  verifyTdsResult,
  tdsSourceManifest,
  checkTdsMetadata,
} from "../../scripts/security/test-prisma-tds.mjs";

const policy = () =>
  JSON.parse(
    fs.readFileSync(
      new URL("../../security/prisma-tds-contracts.json", import.meta.url),
    ),
  );
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const fixturePath = (n) =>
  new URL(`../fixtures/prisma-tds/${n}`, import.meta.url);

test("TDS review preserves the existing engine recipe and binds source, fixture and lock bytes", () => {
  const p = policy();
  assert.equal(validateTdsPolicy(p), p);
  for (const [file, key] of [
    ["Cargo.toml", "manifestSha256"],
    ["Cargo.lock", "lockSha256"],
    ["src/lib.rs", "fixtureSha256"],
  ])
    assert.equal(sha(fs.readFileSync(fixturePath(file))), p[key]);
  assert.equal(
    sha(
      fs.readFileSync(
        new URL("../../security/prisma-source-contracts.json", import.meta.url),
      ),
    ),
    p.sourcePolicySha256,
  );
  for (const k of [
    "sourceReviewComplete",
    "wholeEngineVerified",
    "productionApproved",
  ]) {
    const q = policy();
    q[k] = true;
    assert.throws(() => validateTdsPolicy(q));
  }
  for (const [k, v] of [
    ["commit", "a".repeat(40)],
    ["testCount", 0],
    ["connectCalls", 0],
    ["platform", "win32"],
    ["fixtureSha256", "PENDING"],
  ]) {
    const q = policy();
    q[k] = v;
    assert.throws(() => validateTdsPolicy(q));
  }
});

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
test("native proof requires every named test, exact real call counts, positive controls and no panics", () => {
  const stdout =
    names.map((n) => `test tests::${n} ... ok`).join("\n") +
    "\ntest result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n";
  const stderr =
    "OJA_TDS_CALL success=true\n".repeat(2) +
    "OJA_TDS_CALL success=false\n".repeat(256);
  assert.equal(verifyTdsResult(stdout, stderr, policy()).connectCalls, 258);
  for (const output of [
    stdout.replace("12 passed", "0 passed"),
    stdout.replace("0 ignored", "1 ignored"),
    stdout.replace(names[0], "missing"),
  ])
    assert.throws(() => verifyTdsResult(output, stderr, policy()));
  for (const error of [
    stderr + "thread 'probe' panicked at parser",
    stderr + "OJA_TDS_CALL success=true\n",
    stderr.replace("success=false", "success=true"),
    stderr.replace("OJA_TDS_CALL success=true\n", ""),
  ])
    assert.throws(() => verifyTdsResult(stdout, error, policy()));
});

test("complete source manifests bind every byte and reject symlinks and hardlinks", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tds-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    outside = path.join(root, "outside");
  fs.mkdirSync(source);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(source, "Cargo.toml"), "[package]\n");
  assert.equal(
    tdsSourceManifest(source)[0].sha256,
    sha(Buffer.from("[package]\n")),
  );
  fs.linkSync(path.join(source, "Cargo.toml"), path.join(source, "other.toml"));
  assert.throws(() => tdsSourceManifest(source));
  fs.unlinkSync(path.join(source, "other.toml"));
  fs.symlinkSync(
    outside,
    path.join(source, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => tdsSourceManifest(source));
});

test("metadata binds exact local identities, proc macro consumer and original TLS/auth features", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tds-metadata-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "vendor/tiberius"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "vendor/tiberius/Cargo.toml"),
    "[package]\n",
  );
  fs.mkdirSync(path.join(root, "vendor/tiberius/tiberius-macros"));
  fs.writeFileSync(
    path.join(root, "vendor/tiberius/tiberius-macros/Cargo.toml"),
    "[package]\n",
  );
  const m = {
    // The Windows-only winauth package is deliberately absent from Linux metadata.
    packages: [
      { name: "oja-prisma-tds-probes", id: "root" },
      {
        name: "tiberius",
        id: "tds",
        version: "0.13.0",
        manifest_path: path.join(root, "vendor/tiberius/Cargo.toml"),
      },
      {
        name: "tiberius-macros",
        id: "macro",
        version: "0.1.0",
        manifest_path: path.join(
          root,
          "vendor/tiberius/tiberius-macros/Cargo.toml",
        ),
        targets: [{ kind: ["proc-macro"] }],
      },
    ],
    resolve: {
      nodes: [
        {
          id: "tds",
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
          deps: [{ pkg: "macro" }],
        },
      ],
    },
  };
  assert.equal(checkTdsMetadata(m, root), true);
  for (const mutate of [
    (j) => j.packages.push({ name: "unbound", id: "other" }),
    (j) => {
      j.packages[1].source = "git+unverified";
    },
    (j) => {
      j.packages[1].version = "0.12.3";
    },
    (j) => {
      j.resolve.nodes[0].features = j.resolve.nodes[0].features.filter(
        (x) => x !== "native-tls",
      );
    },
    (j) => {
      j.resolve.nodes[0].deps = [];
    },
    (j) => {
      j.resolve.nodes[0].features.push("vendored-openssl");
    },
    (j) => {
      j.packages[2].targets[0].kind = ["lib"];
    },
  ]) {
    const j = structuredClone(m);
    mutate(j);
    assert.throws(() => checkTdsMetadata(j, root));
  }
});

test("TDS workflow cannot change production, send notifications or replace real Rust tests with JavaScript", () => {
  const workflow = fs.readFileSync(
    new URL(
      "../../.github/workflows/prisma-tds-contracts.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /test-prisma-tds\.mjs/);
  assert.doesNotMatch(
    workflow,
    /secrets\.|schedule:|pull_request_target:|migrate deploy|shopify app deploy|npm publish/,
  );
  const fixture = fs.readFileSync(fixturePath("src/lib.rs"), "utf8");
  assert.match(fixture, /Client::connect\(config, peer\)/);
  assert.match(fixture, /for token in 8\.\.255/);
  assert.doesNotMatch(fixture, /TcpStream|TcpListener|DATABASE_URL|https:\/\//);
});

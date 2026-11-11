import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import toml from "toml";
import {
  validatePrismaSqliteSource,
  sqliteWalFunction,
  checkPrismaSqliteWiring,
  checkPrismaSqliteMetadata,
  assessPrismaSqliteIdentity,
} from "../../scripts/security/prisma-sqlite-source.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const policy = JSON.parse(
  fs.readFileSync(
    path.join(root, "security/prisma-source-contracts.json"),
    "utf8",
  ),
).sqliteSource;
const advisory = JSON.parse(
  fs.readFileSync(
    path.join(root, "security/advisories/RUSTSEC-2026-0459.json"),
    "utf8",
  ),
);
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fixture = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oja-sqlite-contract-"));
  assert.equal(path.dirname(dir), fs.realpathSync(os.tmpdir()));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("SQLite policy preserves original version/checksum, full advisory and all27 source bindings", () => {
  assert.equal(validatePrismaSqliteSource(policy), policy);
  assert.equal(sha(JSON.stringify(advisory)), policy.advisory.sha256);
  assert.deepEqual(
    policy.sourceFiles
      .filter((f) => f.sha256 !== f.originalSha256)
      .map((f) => f.path),
    ["sqlite3/sqlite3.c"],
  );
  for (const key of ["patch", "harness", "buildScript", "contractLock"])
    assert.equal(
      sha(fs.readFileSync(path.join(root, policy[key].path))),
      policy[key].sha256,
    );
  const lock = toml.parse(
    fs.readFileSync(path.join(root, "vendor/native/prisma/Cargo.lock"), "utf8"),
  );
  const sqlite = lock.package.filter((p) => p.name === policy.name);
  assert.equal(sqlite.length, 1);
  assert.equal(sqlite[0].version, policy.version);
  assert.equal(sqlite[0].source, undefined);
  assert.equal(sqlite[0].checksum, undefined);
});

test("SQLite policy rejects disguised versions, hash omissions, unrelated edits and changed advisories", () => {
  for (const mutate of [
    (p) => (p.version = "0.39.0"),
    (p) => (p.sha256 = "0".repeat(64)),
    (p) => (p.patch.path = "../fix"),
    (p) => p.sourceFiles.pop(),
    (p) => p.sourceFiles.push(p.sourceFiles[0]),
    (p) => (p.sourceFiles[0].path = "../escape"),
    (p) =>
      (p.sourceFiles.find((f) => f.path !== "sqlite3/sqlite3.c").sha256 =
        "0".repeat(64)),
    (p) => (p.advisory.modified = "2026-11-10T00:00:00Z"),
    (p) => (p.advisory.sha256 = "0".repeat(64)),
    (p) => (p.productionApproved = true),
  ]) {
    const changed = structuredClone(policy);
    mutate(changed);
    assert.throws(
      () => validatePrismaSqliteSource(changed),
      /prisma_sqlite_policy_invalid/,
    );
  }
});

test("SQLite function extraction requires the actual declaration plus unique bounded definition", () => {
  const text =
    "SQLITE_PRIVATE int sqlite3WalReadFrame(Wal *wal);\nSQLITE_PRIVATE int sqlite3WalReadFrame(Wal *wal){\n  return 0;\n}\n";
  assert.equal(
    sqliteWalFunction(text),
    text.slice(text.indexOf("SQLITE_PRIVATE", 10)),
  );
  for (const bad of [
    "",
    text + text,
    text.replace("return 0;\n}", "return 0;"),
    text.replace("return 0;", " ".repeat(2001)),
  ])
    assert.throws(
      () => sqliteWalFunction(bad),
      /prisma_sqlite_function_changed/,
    );
});

test("SQLite wiring binds every file and rejects unused overrides, source drift and extra files", (t) => {
  const source = fixture(t),
    base = path.join(source, "vendor/libsqlite3-sys");
  fs.mkdirSync(base, { recursive: true });
  const synthetic = structuredClone(policy);
  for (const input of synthetic.sourceFiles) {
    const data =
      input.path === "Cargo.toml"
        ? '[package]\nname = "libsqlite3-sys"\nversion = "0.30.1"\n'
        : "test bytes\n";
    fs.mkdirSync(path.dirname(path.join(base, input.path)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(base, input.path), data);
    input.sha256 = sha(data);
    if (input.path !== "sqlite3/sqlite3.c") input.originalSha256 = input.sha256;
  }
  const manifest =
    '[workspace]\nexclude = ["vendor/libsqlite3-sys"]\n[patch.crates-io]\nlibsqlite3-sys = { path = "vendor/libsqlite3-sys" }\n';
  fs.writeFileSync(path.join(source, "Cargo.toml"), manifest);
  assert.equal(checkPrismaSqliteWiring(source, synthetic), true);
  fs.appendFileSync(path.join(base, "build.rs"), "drift");
  assert.throws(
    () => checkPrismaSqliteWiring(source, synthetic),
    /prisma_sqlite_source_changed/,
  );
  fs.writeFileSync(path.join(base, "build.rs"), "test bytes\n");
  fs.writeFileSync(path.join(base, "extra.rs"), "extra");
  assert.throws(
    () => checkPrismaSqliteWiring(source, synthetic),
    /prisma_sqlite_inventory_changed/,
  );
  fs.unlinkSync(path.join(base, "extra.rs"));
  fs.writeFileSync(
    path.join(source, "Cargo.toml"),
    manifest.replace("[patch.crates-io]", "[unused]"),
  );
  assert.throws(
    () => checkPrismaSqliteWiring(source, synthetic),
    /prisma_sqlite_wiring_invalid/,
  );
});

test("SQLite metadata requires one bundled original-version local crate, never an untouched registry/system copy", (t) => {
  const source = fixture(t),
    manifest = path.join(source, "vendor/libsqlite3-sys/Cargo.toml");
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, "[package]\n");
  const good = {
    packages: [
      {
        id: "sqlite",
        name: policy.name,
        version: policy.version,
        source: null,
        manifest_path: manifest,
      },
    ],
    resolve: { nodes: [{ id: "sqlite", features: ["bundled"] }] },
  };
  assert.equal(checkPrismaSqliteMetadata(good, source, policy), true);
  assert.equal(
    checkPrismaSqliteMetadata(
      { packages: [], resolve: { nodes: [] } },
      source,
      policy,
      { contracts: true },
    ),
    true,
  );
  for (const mutate of [
    (m) => m.packages.push({ ...m.packages[0] }),
    (m) => (m.packages[0].version = "0.39.0"),
    (m) =>
      (m.packages[0].source =
        "registry+https://github.com/rust-lang/crates.io-index"),
    (m) => (m.resolve.nodes[0].features = []),
    (m) => m.resolve.nodes[0].features.push("bundled-sqlcipher"),
    (m) => m.resolve.nodes[0].features.push("loadable_extension"),
  ]) {
    const bad = structuredClone(good);
    mutate(bad);
    assert.throws(
      () => checkPrismaSqliteMetadata(bad, source, policy),
      /prisma_sqlite_resolution_invalid/,
    );
  }
});

const responder =
  ({ matches, body = advisory } = {}) =>
  async (url) =>
    url.endsWith("querybatch")
      ? Response.json({
          results: [
            {
              vulns: matches ?? [
                { id: policy.advisory.id, modified: policy.advisory.modified },
              ],
            },
          ],
        })
      : Response.json(body);
test("SQLite original-identity audit retains the full raw match, never claims registry or production approval", async () => {
  const report = await assessPrismaSqliteIdentity(policy, {
    fetchImpl: responder(),
  });
  assert.equal(report.findings.length, 1);
  assert.equal(report.sourceAuditOk, false);
  assert.equal(report.productionApproved, false);
  assert.equal(report.packages[0].checksum, policy.sha256);
  assert.deepEqual(report.advisory, advisory);
});
test("SQLite audit rejects changed/extra/removed matches and any modified full advisory payload", async () => {
  for (const options of [
    { matches: [] },
    {
      matches: [
        { id: "RUSTSEC-2026-0460", modified: policy.advisory.modified },
      ],
    },
    { matches: [{ id: policy.advisory.id, modified: "2026-11-10T00:00:00Z" }] },
    {
      matches: [
        { id: policy.advisory.id, modified: policy.advisory.modified },
        { id: "RUSTSEC-2026-0460", modified: policy.advisory.modified },
      ],
    },
    { body: { ...advisory, summary: "changed" } },
  ])
    await assert.rejects(
      assessPrismaSqliteIdentity(policy, { fetchImpl: responder(options) }),
      /prisma_sqlite_advisory_changed/,
    );
});

test("SQLite full-advisory binding ignores object key order but never payload changes", async () => {
  const reordered = Object.fromEntries(Object.entries(advisory).reverse());
  const report = await assessPrismaSqliteIdentity(policy, {
    fetchImpl: responder({ body: reordered }),
  });
  assert.equal(
    report.canonicalAdvisorySha256,
    "775268f2214d68fbda497ec20183114be74804b2a0f58475705743ec0c47fc58",
  );
});

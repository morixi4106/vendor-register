import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import {
  validateJavyPolicy,
  checkJavyWiring,
  checkJavyWirmTestOrigin,
  checkJavyMetadata,
  javySourceTestPlans,
  javyTestTotals,
  javySourceOptions,
} from "../../scripts/security/test-javy-source.mjs";
import { runnerInput } from "../../scripts/security/rebuild-function-runner.mjs";
import { rustRegistryPackages } from "../../scripts/security/rust-source-audit.mjs";
const root = path.resolve(import.meta.dirname, "../..");
const policy = JSON.parse(
  fs.readFileSync(path.join(root, "security/javy-source-contracts.json")),
);
const registry = "registry+https://github.com/rust-lang/crates.io-index";

test("Javy recipe distinguishes the CLI release from the development candidate and binds every input", () => {
  assert.equal(validateJavyPolicy(policy), policy);
  assert.notEqual(policy.source.commit, policy.baseline.commit);
  assert.equal(policy.baseline.version, "9.0.0");
  const audit = fs.readFileSync(
    path.join(root, "scripts/security/rust-source-audit.mjs"),
    "utf8",
  );
  assert.match(
    audit,
    /javy: \{\s*repository: "bytecodealliance\/javy",\s*commit: "03458aaa9ed3e56d9a2baffcf646ac38f69664b5"/,
  );
  for (const change of [
    (p) => {
      p.productionApproved = true;
    },
    (p) => {
      p.source.commit = p.baseline.commit;
    },
    (p) => {
      p.source.sha256 = "0".repeat(64);
    },
    (p) => {
      p.baseline.lockfileSha256 = "0".repeat(64);
    },
    (p) => {
      p.patch.path = "../javy.patch";
    },
    (p) => {
      p.wirm.sha256 = "0".repeat(64);
    },
    (p) => {
      p.wirm.testSource.commit = "0".repeat(40);
    },
    (p) => {
      p.wirm.testSource.files[0].sha256 = "0".repeat(64);
    },
    (p) => {
      p.wirm.testSource.files[0].path = "../Cargo.toml";
    },
    (p) => {
      p.sourceFiles.pop();
    },
    (p) => {
      p.sourceFiles[0].path = "../Cargo.toml";
    },
    (p) => {
      p.sourceFiles.reverse();
    },
    (p) => {
      p.sourceFiles[0].sha256 = "bad";
    },
  ]) {
    const p = structuredClone(policy);
    change(p);
    assert.throws(() => validateJavyPolicy(p), /javy_policy_invalid/);
  }
  for (const input of [policy.patch, policy.lockfile, policy.wirm.patch])
    assert.ok(runnerInput(root, input).length);
  assert.throws(
    () => runnerInput(root, { ...policy.patch, sha256: "0".repeat(64) }),
    /digest_mismatch/,
  );
});

test("the actual locked graph contains patched profiler and main engines without Git or paste", () => {
  const lock = runnerInput(root, policy.lockfile).toString("utf8");
  const parsed = rustRegistryPackages(lock);
  assert.equal(parsed.packages.length, 483);
  assert.deepEqual(parsed.unresolved, []);
  for (const name of ["wasmtime", "wasmtime-wasi"])
    assert.deepEqual(
      parsed.packages.filter((p) => p.name === name).map((p) => p.version),
      ["48.0.8", "50.0.1"],
    );
  assert.equal(
    parsed.packages.some((p) => p.name === "paste"),
    false,
  );
  assert.ok(
    parsed.packages.some((p) => p.name === "pastey" && p.version === "0.2.3"),
  );
  assert.ok(
    parsed.packages.some((p) => p.name === "whamm" && p.version === "2.0.1"),
  );
  const patch = runnerInput(root, policy.patch).toString("utf8");
  assert.match(patch, /\+whamm = "=2\.0\.1"/);
  assert.doesNotMatch(patch, /^[-+]\s*(?:default-features|profiler\s*=)/m);
  const wirm = runnerInput(root, policy.wirm.patch).toString("utf8");
  assert.match(wirm, /\+package = "pastey"/);
  assert.match(wirm, /\+version = "=50\.0\.1"/);
});

function fixture(t) {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "javy-source-"));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  const locals = [
    ["javy", "9.0.0-alpha.1", "crates/javy"],
    ["javy-cli", policy.version, "crates/cli"],
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
    ["wirm", policy.wirm.version, "vendor/wirm"],
  ];
  const packages = locals.map(([name, version, dir]) => {
    const manifest_path = path.join(source, dir, "Cargo.toml");
    fs.mkdirSync(path.dirname(manifest_path), { recursive: true });
    fs.writeFileSync(manifest_path, "");
    return {
      id: `${name}@${version}`,
      name,
      version,
      manifest_path,
      source: null,
    };
  });
  for (const [name, version] of [
    ["wasmtime", "48.0.8"],
    ["wasmtime", "50.0.1"],
    ["wasmtime-wasi", "48.0.8"],
    ["wasmtime-wasi", "50.0.1"],
    ["wasmtime-wizer", "50.0.1"],
    ["whamm", "2.0.1"],
    ["pastey", "0.2.3"],
    ["deterministic-wasi-ctx", "4.0.9"],
  ])
    packages.push({
      id: `${name}@${version}`,
      name,
      version,
      source: registry,
    });
  const nodes = packages.map((p) => ({
    id: p.id,
    features:
      p.name === "wasmtime"
        ? ["default", "cranelift", "runtime", "cache", "component-model"]
        : p.name === "wasmtime-wasi"
          ? p.version === "50.0.1"
            ? ["default", "p1", "p2", "p3"]
            : ["default", "p1", "p2"]
          : [],
    deps: [],
  }));
  const node = (name) => nodes.find((n) => n.id === name);
  const edge = (
    from,
    to,
    alias = to.split("@")[0].replaceAll("-", "_"),
    kind = null,
  ) =>
    node(from).deps.push({
      name: alias,
      pkg: to,
      dep_kinds: [{ kind, target: null }],
    });
  for (const from of [
    `javy-cli@${policy.version}`,
    "javy-codegen@4.0.1-alpha.1",
    "javy-plugin-processing@0.0.0",
    "javy-profiler@0.0.0",
    "deterministic-wasi-ctx@4.0.9",
  ])
    edge(from, "wasmtime@50.0.1");
  edge(`javy-cli@${policy.version}`, "javy-codegen@4.0.1-alpha.1");
  edge(`javy-cli@${policy.version}`, "javy-plugin-processing@0.0.0");
  edge(
    `javy-cli@${policy.version}`,
    "javy-plugin-processing@0.0.0",
    "javy_plugin_processing",
    "build",
  );
  edge("javy-codegen@4.0.1-alpha.1", "wasmtime-wizer@50.0.1");
  edge("javy-codegen@4.0.1-alpha.1", "deterministic-wasi-ctx@4.0.9");
  edge("javy-profiler@0.0.0", "whamm@2.0.1");
  edge("whamm@2.0.1", "wasmtime@48.0.8");
  edge("whamm@2.0.1", "wasmtime-wasi@48.0.8");
  edge("whamm@2.0.1", `wirm@${policy.wirm.version}`);
  edge(`wirm@${policy.wirm.version}`, "pastey@0.2.3", "paste");
  fs.writeFileSync(
    path.join(source, "Cargo.toml"),
    `[workspace]\nmembers=${JSON.stringify(locals.map((l) => l[2]))}\n[workspace.package]\nversion="${policy.version}"\n[workspace.dependencies]\nwasmtime="=50.0.1"\nwasmtime-wasi="=50.0.1"\nwasmtime-wizer="=50.0.1"\ndeterministic-wasi-ctx="=4.0.9"\n[patch.crates-io]\nwirm={path="vendor/wirm"}\n`,
  );
  fs.writeFileSync(
    path.join(source, "crates/profiler/Cargo.toml"),
    '[dependencies]\nwhamm="=2.0.1"\n',
  );
  fs.writeFileSync(
    path.join(source, "crates/cli/Cargo.toml"),
    '[dependencies]\njavy-profiler={path="../profiler",optional=true}\n[features]\nprofiler=["dep:javy-profiler"]\n',
  );
  fs.writeFileSync(
    path.join(source, "vendor/wirm/Cargo.toml"),
    `[package]\nversion="${policy.wirm.version}"\n[dependencies.paste]\npackage="pastey"\nversion="=0.2.3"\n[dev-dependencies.wasmtime]\nversion="=50.0.1"\n`,
  );
  return { source, metadata: { packages, resolve: { nodes } } };
}

test("source wiring requires all hashes and preserves the optional profiler", (t) => {
  const { source } = fixture(t),
    calls = [];
  assert.equal(
    checkJavyWiring(source, policy, (base, f) => calls.push({ base, ...f })),
    true,
  );
  assert.deepEqual(
    calls.map((f) => f.path),
    policy.sourceFiles.map((f) => f.path),
  );
  assert.ok(calls.every((f) => f.base === source));
  assert.throws(
    () =>
      checkJavyWiring(source, policy, () => {
        throw Error("changed_hash");
      }),
    /changed_hash/,
  );
  fs.writeFileSync(
    path.join(source, "crates/cli/Cargo.toml"),
    '[dependencies]\njavy-profiler={path="../profiler",optional=true}\n[features]\nprofiler=[]\n',
  );
  assert.throws(
    () => checkJavyWiring(source, policy, () => {}),
    /wiring_invalid/,
  );
});

test("restored wirm test helpers must come from the published crate's exact source commit", (t) => {
  const { source } = fixture(t);
  const crate = path.join(source, "published"),
    git = path.join(source, "upstream");
  for (const d of [crate, git])
    fs.mkdirSync(path.join(d, "src"), { recursive: true });
  const vcs = { git: { sha1: policy.wirm.testSource.commit }, path_in_vcs: "" };
  fs.writeFileSync(
    path.join(crate, ".cargo_vcs_info.json"),
    JSON.stringify(vcs),
  );
  fs.writeFileSync(
    path.join(crate, "Cargo.toml.orig"),
    '[package]\nname="wirm"\n',
  );
  fs.writeFileSync(path.join(git, "Cargo.toml"), '[package]\nname="wirm"\n');
  for (let i = 0; i < 51; i++)
    for (const d of [crate, git])
      fs.writeFileSync(
        path.join(d, "src", `item${i}.rs`),
        `fn item${i}() {}\n`,
      );
  const calls = [];
  const report = checkJavyWirmTestOrigin(crate, git, policy, (base, file) =>
    calls.push({ base, ...file }),
  );
  assert.equal(report.publishedSourceFiles, 51);
  assert.equal(report.sourceBindings.length, 51);
  assert.deepEqual(report.files, policy.wirm.testSource.files);
  assert.ok(calls.every((c) => c.base === git));
  assert.deepEqual(
    calls.map((c) => c.path),
    ["tests/common/wast_iter.rs", "tests/common/validate.rs"],
  );
  assert.throws(
    () =>
      checkJavyWirmTestOrigin(crate, git, policy, () => {
        throw Error("changed_helper_hash");
      }),
    /changed_helper_hash/,
  );
  fs.writeFileSync(path.join(git, "src/item0.rs"), "changed\n");
  assert.throws(
    () => checkJavyWirmTestOrigin(crate, git, policy, () => {}),
    /origin_invalid/,
  );
  fs.copyFileSync(
    path.join(crate, "src/item0.rs"),
    path.join(git, "src/item0.rs"),
  );
  fs.writeFileSync(path.join(git, "src/extra.rs"), "extra\n");
  assert.throws(
    () => checkJavyWirmTestOrigin(crate, git, policy, () => {}),
    /origin_invalid/,
  );
  fs.unlinkSync(path.join(git, "src/extra.rs"));
  fs.writeFileSync(
    path.join(crate, ".cargo_vcs_info.json"),
    JSON.stringify({ ...vcs, git: { sha1: "0".repeat(40) } }),
  );
  assert.throws(
    () => checkJavyWirmTestOrigin(crate, git, policy, () => {}),
    /origin_invalid/,
  );
  fs.writeFileSync(
    path.join(crate, ".cargo_vcs_info.json"),
    JSON.stringify(vcs),
  );
  fs.writeFileSync(path.join(git, "Cargo.toml"), "changed manifest\n");
  assert.throws(
    () => checkJavyWirmTestOrigin(crate, git, policy, () => {}),
    /origin_invalid/,
  );
});

test("actual metadata must retain both patched engines, their consumers and build edges", (t) => {
  const { source, metadata } = fixture(t);
  assert.equal(checkJavyMetadata(metadata, source, policy), true);
  for (const change of [
    (m) => {
      m.packages[0].source = "git+https://untrusted.test/repository";
    },
    (m) => {
      m.packages[0].version = "8.0.0";
    },
    (m) => {
      m.packages[0].manifest_path = path.join(source, "Cargo.toml");
    },
    (m) => {
      m.packages.push({ ...m.packages[0] });
    },
    (m) => {
      m.resolve.nodes.pop();
    },
    (m) => {
      m.resolve.nodes[0].deps.push({
        name: "unbound",
        pkg: "missing",
        dep_kinds: [{ kind: null }],
      });
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "wasmtime@48.0.8").features = [];
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "wasmtime-wasi@50.0.1").features = [
        "p1",
        "p2",
      ];
    },
    (m) => {
      m.packages.find((p) => p.id === "wasmtime@48.0.8").version = "47.0.4";
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === `javy-cli@${policy.version}`).deps =
        [];
    },
    (m) => {
      const n = m.resolve.nodes.find(
        (n) => n.id === `javy-cli@${policy.version}`,
      );
      n.deps = n.deps.filter(
        (d) => !d.dep_kinds.some((k) => k.kind === "build"),
      );
    },
    (m) => {
      m.resolve.nodes.find((n) => n.id === "javy-profiler@0.0.0").deps = [];
    },
    (m) => {
      m.resolve.nodes.find(
        (n) => n.id === `wirm@${policy.wirm.version}`,
      ).deps[0].name = "pastey";
    },
  ]) {
    const m = structuredClone(metadata);
    change(m);
    assert.throws(() => checkJavyMetadata(m, source, policy), /javy_/);
  }
});

test("source tests require exact successful nonignored totals and keep the compiler unapproved", () => {
  assert.deepEqual(
    javySourceTestPlans().map((p) => [p.name, p.count]),
    [
      ["codegen", 25],
      ["plugin-processing", 1],
      ["wirm-instructions", 8],
    ],
  );
  assert.ok(
    javySourceTestPlans().every(
      (p) => p.args.includes("--locked") && p.args.includes("--lib"),
    ),
  );
  assert.deepEqual(
    javyTestTotals(
      "test result: ok. 25 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;",
      25,
    ),
    { passed: 25, failed: 0, ignored: 0 },
  );
  for (const output of [
    "",
    "test result: ok. 24 passed; 0 failed; 0 ignored;",
    "test result: ok. 25 passed; 1 failed; 0 ignored;",
    "test result: ok. 25 passed; 0 failed; 1 ignored;",
    "test result: ok. 25 passed; 0 failed; 0 ignored;\ntest result: ok. 0 passed; 0 failed; 0 ignored;",
  ])
    assert.throws(() => javyTestTotals(output, 25), /tests_incomplete/);
  const text = fs.readFileSync(
    path.join(root, "scripts/security/test-javy-source.mjs"),
    "utf8",
  );
  assert.match(text, /wholeCompilerVerified: false/);
  assert.match(text, /productionApproved: false/);
  assert.match(text, /artifactStatus: "NOT_VERIFIED"/);
  assert.doesNotMatch(
    text,
    /CARGO_CFG_FEATURE|stub_plugin|\.audit\/.*private.*key/,
  );
  assert.equal([...text.matchAll(/"core\.autocrlf=false"/g)].length, 4);
});

test("source verification is argument-free CI only and never publishes or installs tools", () => {
  assert.equal(
    javySourceOptions([], { CI: "true", GITHUB_ACTIONS: "true" }),
    true,
  );
  for (const [args, env] of [
    [[], {}],
    [["--approve"], { CI: "true", GITHUB_ACTIONS: "true" }],
    [[], { CI: "true" }],
  ])
    assert.throws(() => javySourceOptions(args, env), /ci_only/);
  const workflow = yaml.load(
    fs.readFileSync(
      path.join(root, ".github/workflows/javy-source-contracts.yml"),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(workflow.on).sort(), [
    "pull_request",
    "workflow_dispatch",
  ]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const job = workflow.jobs["source-contracts"];
  assert.deepEqual(job.strategy.matrix.os, ["ubuntu-latest", "windows-latest"]);
  assert.ok(job.steps.some((s) => s.with?.["persist-credentials"] === false));
  assert.ok(job.steps.some((s) => s.run === "git diff --exit-code"));
  for (const s of job.steps)
    assert.doesNotMatch(
      s.run || "",
      /--no-verify|shopify.*(?:release|deploy)|migrate deploy|npm install/,
    );
  const artifact = job.steps.at(-1);
  assert.equal(artifact.with.path, ".audit/native-javy/");
  assert.equal(artifact.with["retention-days"], 45);
  assert.ok(job.steps.some((s) => s.run?.includes("TRUSTED_REVIEW_SOURCE")));
});

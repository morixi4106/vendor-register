import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import yaml from "js-yaml";
import {
  validateJavyNativePolicy,
  javyNativeStage,
  javyNativePlans,
  observeJavyWasm,
  downloadJavyInput,
  checkJavySdkListing,
  verifyJavyPluginTransfer,
} from "../../scripts/security/test-javy-native.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const policy = JSON.parse(
  fs.readFileSync(path.join(root, "security/javy-native-contracts.json")),
);
const hash = (b) => crypto.createHash("sha256").update(b).digest("hex");
const tmp = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "javy-native-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

test("native lab pins the reviewed source policy, current SDK, cross Rust standard library and official provider independently", () => {
  assert.equal(validateJavyNativePolicy(policy), policy);
  assert.equal(
    policy.sourcePolicySha256,
    hash(
      fs.readFileSync(path.join(root, "security/javy-source-contracts.json")),
    ),
  );
  for (const change of [
    (p) => {
      p.productionApproved = true;
    },
    (p) => {
      p.sourcePolicySha256 = "0".repeat(64);
    },
    (p) => {
      p.rustStd.version = "1.99.0";
    },
    (p) => {
      p.rustStd.date = "2026-10-14";
    },
    (p) => {
      p.rustStd.target = "wasm32-wasip2";
    },
    (p) => {
      p.rustStd.sha256 = "0".repeat(64);
    },
    (p) => {
      p.wasiSdk.archive = "../sdk.tar.gz";
    },
    (p) => {
      p.wasiSdk.version = "24.0";
    },
    (p) => {
      p.wasiSdk.size--;
    },
    (p) => {
      p.wasiSdk.sha256 = "0".repeat(64);
    },
    (p) => {
      p.shopifyProvider.version = 3;
    },
    (p) => {
      p.shopifyProvider.namespace = "other";
    },
    (p) => {
      p.shopifyProvider.url = "https://example.com/provider.wasm";
    },
    (p) => {
      p.shopifyProvider.sha256 = "0".repeat(64);
    },
    (p) => {
      p.shopifyProvider.size++;
    },
  ]) {
    const p = structuredClone(policy);
    change(p);
    assert.throws(() => validateJavyNativePolicy(p), /policy_invalid/);
  }
});

test("only CI builds real release plugins and a profiler-enabled CLI without feature or LTO removal", () => {
  const env = { CI: "true", GITHUB_ACTIONS: "true" };
  assert.equal(javyNativeStage(["plugin"], env, "linux"), "plugin");
  assert.equal(javyNativeStage(["native"], env, "win32"), "native");
  for (const [args, e, os] of [
    [[], env, "linux"],
    [["plugin", "--skip"], env, "linux"],
    [["native"], {}, "linux"],
    [["plugin"], env, "win32"],
    [["native"], env, "darwin"],
  ])
    assert.throws(() => javyNativeStage(args, e, os), /ci_only/);
  assert.deepEqual(javyNativePlans("plugin"), [
    [
      "build",
      "--locked",
      "--release",
      "--target",
      "wasm32-wasip1",
      "--package",
      "javy-plugin",
      "--package",
      "javy-profiler-lib",
    ],
  ]);
  assert.deepEqual(javyNativePlans("native"), [
    [
      "build",
      "--locked",
      "--release",
      "--package",
      "javy-cli",
      "--features",
      "profiler",
    ],
  ]);
  assert.throws(() => javyNativePlans("skip"), /stage_invalid/);
});

test("SDK tar validation permits internal aliases but rejects escaping links and special entries before extraction", () => {
  const prefix = "wasi-sdk-34.0-x86_64-linux";
  const entry = (mode, name) =>
    `${mode} runner/runner 123 2026-08-25 00:00 ${name}`;
  assert.equal(
    checkJavySdkListing(
      [
        entry("drwxr-xr-x", `${prefix}/`),
        entry("-rwxr-xr-x", `${prefix}/bin/clang-23`),
        entry("lrwxrwxrwx", `${prefix}/bin/clang -> clang-23`),
        entry("lrwxrwxrwx", `${prefix}/lib/alias -> ../bin/clang-23`),
      ].join("\n"),
      prefix,
    ),
    true,
  );
  for (const line of [
    "",
    "invalid",
    entry("-rw-r--r--", "/tmp/escape"),
    entry("-rw-r--r--", `${prefix}/../escape`),
    entry("-rw-r--r--", `${prefix}/C:escape`),
    entry("-rw-r--r--", `${prefix}/bin\\escape`),
    entry("lrwxrwxrwx", `${prefix}/bin/clang -> /usr/bin/clang`),
    entry("lrwxrwxrwx", `${prefix}/bin/clang -> ../../escape`),
    entry("hrwxrwxrwx", `${prefix}/bin/clang link to elsewhere`),
    entry("prwxrwxrwx", `${prefix}/pipe`),
    entry("lrwxrwxrwx", `${prefix}/bin/clang -> valid -> extra`),
  ])
    assert.throws(() => checkJavySdkListing(line, prefix), /archive_invalid/);
});

function wasm(role, importModule) {
  const leb = (n) => (n < 128 ? [n] : [(n & 127) | 128, ...leb(n >>> 7)]);
  const str = (s) => [...leb(Buffer.byteLength(s)), ...Buffer.from(s)];
  const section = (id, b) => [id, ...leb(b.length), ...b];
  const names =
    role === "plugin" || role === "provider"
      ? ["initialize-runtime", "compile-src", "invoke"]
      : role === "profiler"
        ? ["wizer.initialize"]
        : ["_start"];
  const bytes = [0, 97, 115, 109, 1, 0, 0, 0, ...section(1, [1, 0x60, 0, 0])];
  if (importModule)
    bytes.push(...section(2, [1, ...str(importModule), ...str("probe"), 0, 0]));
  bytes.push(
    ...section(3, [names.length, ...names.map(() => 0)]),
    ...section(5, [1, 0, 1]),
    ...section(7, [
      names.length + 1,
      ...str("memory"),
      2,
      0,
      ...names.flatMap((n, i) => [...str(n), 0, i + (importModule ? 1 : 0)]),
    ]),
    ...section(10, [names.length, ...names.flatMap(() => [2, 0, 0x0b])]),
  );
  if (["plugin", "provider"].includes(role))
    bytes.push(
      ...section(0, [
        ...str("import_namespace"),
        ...Buffer.from(
          role === "plugin"
            ? "javy-default-plugin-v5"
            : "shopify_functions_javy_v4",
        ),
      ]),
    );
  bytes.push(...section(0, [...str("padding"), ...new Array(120).fill(0)]));
  return Buffer.from(bytes);
}

test("WASM observations reject empty stubs, wrong namespace, unknown imports, missing entries and malformed modules without guest execution", () => {
  for (const role of ["plugin", "provider", "profiler", "static"])
    assert.equal(observeJavyWasm(wasm(role), role).sha256, hash(wasm(role)));
  assert.equal(
    observeJavyWasm(wasm("dynamic", "javy-default-plugin-v5"), "dynamic")
      .imports.length,
    1,
  );
  assert.equal(
    observeJavyWasm(wasm("shopify", "shopify_functions_javy_v4"), "shopify")
      .imports.length,
    1,
  );
  for (const [bytes, role] of [
    [Buffer.alloc(0), "plugin"],
    [Buffer.alloc(120), "plugin"],
    [wasm("provider"), "plugin"],
    [wasm("static"), "profiler"],
    [wasm("profiler"), "static"],
    [wasm("static", "unknown"), "static"],
    [wasm("provider", "wasi_snapshot_preview1"), "provider"],
    [wasm("dynamic"), "dynamic"],
    [wasm("shopify", "javy-default-plugin-v5"), "shopify"],
    [wasm("static"), "unknown"],
    [wasm("static").subarray(0, 110), "static"],
  ])
    assert.throws(() => observeJavyWasm(bytes, role));
});

test("same-run plugin transfer binds both actual WASM bytes and source, cross toolchain and unapproved provenance", (t) => {
  const directory = tmp(t);
  const source = {
    policySha256: policy.sourcePolicySha256,
    lockfileSha256: "a".repeat(64),
  };
  const plugins = ["plugin.wasm", "javy_profiler_lib.wasm"].map((name, i) => {
    const bytes = wasm(i ? "profiler" : "plugin");
    fs.writeFileSync(path.join(directory, name), bytes);
    return { name, wasm: observeJavyWasm(bytes, i ? "profiler" : "plugin") };
  });
  const receipt = {
    schemaVersion: 1,
    sourcePolicySha256: policy.sourcePolicySha256,
    lockfileSha256: source.lockfileSha256,
    nativePolicySha256: hash(Buffer.from(JSON.stringify(policy))),
    compiler: {
      version: policy.rustStd.version,
      target: "x86_64-unknown-linux-gnu",
    },
    wasi: {
      stdSha256: policy.rustStd.sha256,
      sdkSha256: policy.wasiSdk.sha256,
    },
    plugins,
    wholeCompilerVerified: false,
    productionApproved: false,
  };
  const write = (r) =>
    fs.writeFileSync(path.join(directory, "plugins.json"), JSON.stringify(r));
  write(receipt);
  assert.deepEqual(
    verifyJavyPluginTransfer(directory, policy, source),
    receipt,
  );
  for (const change of [
    (r) => {
      r.productionApproved = true;
    },
    (r) => {
      r.wholeCompilerVerified = true;
    },
    (r) => {
      r.sourcePolicySha256 = "b".repeat(64);
    },
    (r) => {
      r.lockfileSha256 = "b".repeat(64);
    },
    (r) => {
      r.nativePolicySha256 = "b".repeat(64);
    },
    (r) => {
      r.compiler.target = "x86_64-pc-windows-msvc";
    },
    (r) => {
      r.compiler.version = "1.99.0";
    },
    (r) => {
      r.wasi.sdkSha256 = "b".repeat(64);
    },
    (r) => {
      r.wasi.stdSha256 = "b".repeat(64);
    },
    (r) => {
      r.plugins[0].name = "../plugin.wasm";
    },
    (r) => {
      r.plugins[0].wasm.sha256 = "b".repeat(64);
    },
    (r) => {
      r.plugins.pop();
    },
  ]) {
    const r = structuredClone(receipt);
    change(r);
    write(r);
    assert.throws(
      () => verifyJavyPluginTransfer(directory, policy, source),
      /transfer_invalid/,
    );
  }
  write(receipt);
  fs.writeFileSync(path.join(directory, "plugin.wasm"), wasm("provider"));
  assert.throws(
    () => verifyJavyPluginTransfer(directory, policy, source),
    /plugin_invalid/,
  );
});

test("downloads enforce HTTPS release redirects, bounded exact size and SHA without overwriting existing files", async (t) => {
  const directory = tmp(t);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const bytes = Buffer.from("fixed-input");
  globalThis.fetch = async () => new Response(bytes);
  const file = path.join(directory, "input");
  await downloadJavyInput(
    policy.shopifyProvider.url,
    file,
    hash(bytes),
    bytes.length,
  );
  assert.deepEqual(fs.readFileSync(file), bytes);
  await assert.rejects(
    downloadJavyInput(
      policy.shopifyProvider.url,
      file,
      hash(bytes),
      bytes.length,
    ),
    /EEXIST/,
  );
  await assert.rejects(
    downloadJavyInput("http://example.com", file, hash(bytes), bytes.length),
    /download_invalid/,
  );
  await assert.rejects(
    downloadJavyInput(
      policy.shopifyProvider.url,
      file,
      "0".repeat(64),
      bytes.length,
    ),
    /digest_mismatch/,
  );
  await assert.rejects(
    downloadJavyInput(
      policy.shopifyProvider.url,
      file,
      hash(bytes),
      bytes.length - 1,
    ),
    /download_limit/,
  );
  await assert.rejects(
    downloadJavyInput(
      policy.shopifyProvider.url,
      file,
      hash(bytes),
      bytes.length + 1,
    ),
    /digest_mismatch/,
  );
  globalThis.fetch = async () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://example.com/escape" },
    });
  await assert.rejects(
    downloadJavyInput(
      policy.shopifyProvider.url,
      file,
      hash(bytes),
      bytes.length,
    ),
    /redirect_invalid/,
  );
  await assert.rejects(
    downloadJavyInput(
      "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-x86_64-linux.tar.gz",
      file,
      hash(bytes),
      bytes.length,
    ),
    /redirect_invalid/,
  );
});

test("native workflow has no schedules, secrets, deployments, installs or approval and requires plugin success and unchanged tracked files", () => {
  const workflow = yaml.load(
    fs.readFileSync(
      path.join(root, ".github/workflows/javy-native-contracts.yml"),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(workflow.on).sort(), [
    "pull_request",
    "workflow_dispatch",
  ]);
  assert.deepEqual(workflow.permissions, { contents: "read", actions: "read" });
  assert.equal(workflow.jobs.native.needs, "plugins");
  assert.deepEqual(workflow.jobs.native.strategy.matrix.os, [
    "ubuntu-latest",
    "windows-latest",
  ]);
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(job.steps.some((s) => s.with?.["persist-credentials"] === false));
    assert.ok(job.steps.some((s) => s.run === "git diff --exit-code"));
    assert.ok(job.steps.some((s) => s.run?.includes("TRUSTED_REVIEW_SOURCE")));
    for (const step of job.steps) {
      assert.doesNotMatch(
        JSON.stringify(step),
        /secrets\.|--no-verify|shopify.*(?:deploy|release)|migrate deploy|npm install/,
      );
      if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
      if (step.with?.["retention-days"])
        assert.equal(step.with["retention-days"], 45);
    }
  }
  const script = fs.readFileSync(
    path.join(root, "scripts/security/test-javy-native.mjs"),
    "utf8",
  );
  assert.doesNotMatch(
    script,
    /CARGO_CFG_FEATURE|CARGO_PROFILE_RELEASE_LTO|--no-default-features|--deterministic|node_modules/,
  );
  assert.match(script, /profile\.lto !== true/);
  assert.match(script, /fullFunctionVerified: false/);
  assert.match(script, /providerSourceVerified: false/);
});

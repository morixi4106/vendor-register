import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import toml from "toml";
import {
  validateRunnerPolicy,
  runnerInput,
  validateRunnerMetadata,
  validateRunnerSmoke,
} from "../../scripts/security/rebuild-function-runner.mjs";
import {
  rustRegistryPackages,
  scanRustLockfile,
} from "../../scripts/security/rust-source-audit.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const policy = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, "security/function-runner-rebuild.json"),
    "utf8",
  ),
);

test("runner recipe binds all patches and the generated lock graph to real bytes", () => {
  assert.equal(validateRunnerPolicy(policy), policy);
  for (const input of [
    policy.patch,
    policy.lockfile,
    ...policy.overrides.map((entry) => entry.patch),
  ])
    assert.ok(runnerInput(ROOT, input).length);
  for (const patch of [
    { ignoreAdvisories: true },
    { version: "9.2.2" },
    { overrides: [] },
    { lockfile: { ...policy.lockfile, path: "../outside" } },
  ])
    assert.throws(
      () => validateRunnerPolicy({ ...policy, ...patch }),
      /runner_policy_invalid/,
    );
  assert.throws(
    () => runnerInput(ROOT, { ...policy.lockfile, sha256: "a".repeat(64) }),
    /runner_input_digest_mismatch/,
  );
});

test("frozen runner lock removes old compression, hash and certificate dependencies", () => {
  const lock = runnerInput(ROOT, policy.lockfile).toString("utf8");
  const { packages, unresolved } = rustRegistryPackages(lock);
  assert.deepEqual(unresolved, []);
  for (const name of ["fxhash", "block-buffer"]) {
    if (name === "fxhash")
      assert.equal(
        packages.some((pkg) => pkg.name === name),
        false,
      );
    else
      assert.equal(
        packages
          .filter((pkg) => pkg.name === name)
          .every((pkg) => pkg.version === "0.12.1"),
        true,
      );
  }
  for (const [name, version] of [
    ["wasmtime", "36.0.19"],
    ["wasmtime-wasi", "36.0.19"],
    ["zstd", "0.14.3"],
    ["zstd-safe", "8.2.0"],
  ])
    assert.deepEqual(
      packages.filter((pkg) => pkg.name === name).map((pkg) => pkg.version),
      [version],
    );
  const all = toml.parse(lock).package;
  for (const entry of policy.overrides)
    assert.ok(
      all.some(
        (pkg) =>
          pkg.name === entry.name &&
          pkg.version === entry.version &&
          !pkg.source,
      ),
    );
});

test("a source advisory response does not certify compiled artifacts", async () => {
  const report = await scanRustLockfile(
    runnerInput(ROOT, policy.lockfile).toString("utf8"),
    {
      fetchImpl: async (_url, options) =>
        new Response(
          JSON.stringify({
            results: JSON.parse(options.body).queries.map(() => ({})),
          }),
        ),
    },
  );
  assert.equal(report.sourceAuditOk, true);
  assert.equal(report.artifactStatus, "NOT_VERIFIED");
});

test("runner metadata rejects outside path packages and unpatched runtime selection", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-metadata-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Cargo.toml"), "fixture");
  const packages = [
    {
      name: "function-runner",
      version: policy.version,
      manifest_path: path.join(root, "Cargo.toml"),
      source: null,
    },
  ];
  for (const entry of policy.overrides) {
    const directory = path.join(root, "vendor", entry.name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "Cargo.toml"), "fixture");
    packages.push({
      name: entry.name,
      version: entry.version,
      source: null,
      manifest_path: path.join(directory, "Cargo.toml"),
    });
  }
  packages.push(
    ...["wasmtime", "wasmtime-wasi"].map((name) => ({
      name,
      version: "36.0.19",
      source: "registry+https://github.com/rust-lang/crates.io-index",
    })),
  );
  const metadata = { packages, resolve: { nodes: [] } };
  assert.equal(validateRunnerMetadata(metadata, root, policy), true);
  assert.throws(
    () =>
      validateRunnerMetadata(
        {
          ...metadata,
          packages: [
            ...packages,
            {
              name: "wasmtime",
              version: "36.0.14",
              source: "registry+https://github.com/rust-lang/crates.io-index",
            },
          ],
        },
        root,
        policy,
      ),
    /runner_wasmtime_unpatched/,
  );
  assert.throws(
    () =>
      validateRunnerMetadata(
        {
          ...metadata,
          packages: [
            ...packages,
            {
              name: "outside",
              source: null,
              manifest_path: path.join(ROOT, "package.json"),
            },
          ],
        },
        root,
        policy,
      ),
    /runner_metadata_source_escape/,
  );
});

test("runner smoke requires valid output and stable bounded nonzero fuel", () => {
  const result = {
    success: true,
    output: { operations: [] },
    logs: "",
    instructions: 23,
    memory_usage: 64,
  };
  assert.equal(validateRunnerSmoke(result), true);
  for (const patch of [
    { success: false },
    { output: {} },
    { instructions: 0 },
    { instructions: 11000001 },
    { logs: "injected" },
    { memory_usage: 9999 },
  ])
    assert.throws(
      () => validateRunnerSmoke({ ...result, ...patch }),
      /runner_smoke_or_fuel_failed/,
    );
  assert.throws(
    () => validateRunnerSmoke(result, { ...result, instructions: 24 }),
    /runner_smoke_or_fuel_failed/,
  );
});

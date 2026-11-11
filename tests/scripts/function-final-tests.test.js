import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import yaml from "js-yaml";
import {
  validateFinalTestsPolicy,
  finalFixturePaths,
} from "../../scripts/security/function-final-tests.mjs";
import {
  validateFinalRunnerResult,
  verifyFinalSuite,
} from "../fixtures/functions/final-contracts.mjs";
import {
  optimizerCreateArguments,
  verifyOptimizerContainer,
  postprocessOptions,
} from "../../scripts/security/function-postprocess.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const policy = JSON.parse(read("security/function-final-tests.json"));

test("final tests retain both fixed source/test/final-WASM identities and the independently verified Runner", () => {
  assert.equal(validateFinalTestsPolicy(policy), policy);
  for (const mutate of [
    (p) => p.runner.run++,
    (p) => p.runner.artifact++,
    (p) => (p.runner.head = "0".repeat(40)),
    (p) => (p.runner.version = "9.2.2"),
    (p) => (p.runner.binarySha256 = "0".repeat(64)),
    (p) => (p.runner.receiptSha256 = "0".repeat(64)),
    (p) => p.candidates.reverse(),
    (p) => p.candidates[0].testCount--,
    (p) => p.candidates[1].runnerCalls--,
    (p) => (p.candidates[0].wasmSha256 = "0".repeat(64)),
    (p) => (p.candidates[1].testSha256 = "0".repeat(64)),
    (p) => (p.fullFunctionVerified = true),
    (p) => (p.wholeCompilerVerified = true),
    (p) => (p.productionApproved = true),
    (p) => (p.artifactStatus = "APPROVED"),
  ]) {
    const p = structuredClone(policy);
    mutate(p);
    assert.throws(() => validateFinalTestsPolicy(p), /policy_invalid/);
  }
  assert.throws(
    () =>
      postprocessOptions(
        ["--skip"],
        { CI: "true", GITHUB_ACTIONS: "true" },
        "linux",
      ),
    /arguments_invalid/,
  );
});

test("fixture discovery accepts exactly twelve flat Git-controlled synthetic JSON paths, not extra files or escaping names", () => {
  const names = Array.from(
    { length: 12 },
    (_, i) =>
      `extensions/marketplace-purchase-control/tests/fixtures/case-${i}.json`,
  );
  assert.equal(finalFixturePaths(names.join("\n") + "\n").length, 12);
  for (const paths of [
    names.slice(1),
    [...names, names[0]],
    [...names.slice(1), "../private.json"],
    [...names.slice(1), names[0].replace("case-0", "../private")],
    [...names.slice(1), names[0].replace(".json", ".js")],
  ])
    assert.throws(
      () => finalFixturePaths(paths.join("\n")),
      /fixture_paths_invalid/,
    );
});

test("every native call enforces finite fuel, memory and byte limits rather than only checking that a process exited", () => {
  const output = {
    success: true,
    instructions: 100,
    memory_usage: 1280,
    output: { operations: [] },
  };
  assert.deepEqual(validateFinalRunnerResult(output, 1000, 12000), {
    instructions: 100,
    memoryUsageKiB: 1280,
    inputBytes: 1000,
    jsonOutputBytes: 17,
  });
  for (const patch of [
    { success: false },
    { instructions: NaN },
    { instructions: 0 },
    { instructions: 11000001 },
    { memory_usage: Infinity },
    { memory_usage: 10001 },
    { output: null },
    { output: { data: "x".repeat(20000) } },
  ])
    assert.throws(() =>
      validateFinalRunnerResult({ ...output, ...patch }, 1000, 12000),
    );
  for (const [inputBytes, wasmBytes] of [
    [128001, 12000],
    [0, 12000],
    [1000, 262145],
    [1000, 0],
  ])
    assert.throws(() =>
      validateFinalRunnerResult(output, inputBytes, wasmBytes),
    );
});

function suite() {
  const expected = {
    ...policy.candidates[0],
    runnerSha256: policy.runner.binarySha256,
    wasmBytes: 11938,
  };
  const results = {
    success: true,
    numTotalTests: 51,
    numPassedTests: 51,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [
      {
        assertionResults: Array.from({ length: 51 }, () => ({
          status: "passed",
        })),
      },
    ],
  };
  const output = { operations: [] },
    metrics = validateFinalRunnerResult(
      { success: true, instructions: 100, memory_usage: 1280, output },
      1000,
      11938,
    );
  const commands = Array.from({ length: 12 }, () => ({
    status: 0,
    signal: null,
    error: null,
    validated: true,
    wasmSha256: expected.wasmSha256,
    binarySha256: expected.runnerSha256,
    inputSha256: "1".repeat(64),
    stdoutSha256: "2".repeat(64),
    stderrSha256: "3".repeat(64),
    inputBytes: 1000,
    output,
    metrics,
  }));
  return { results, commands, expected };
}

test("the complete suite rejects skipped/missing/failed tests, missing real calls, mismatched binaries and fabricated metrics", () => {
  const valid = suite();
  assert.equal(
    verifyFinalSuite(valid.results, valid.commands, valid.expected).runnerCalls,
    12,
  );
  for (const mutate of [
    (s) => (s.results.success = false),
    (s) => s.results.numTotalTests--,
    (s) => s.results.numPassedTests--,
    (s) => s.results.numFailedTests++,
    (s) => s.results.numPendingTests++,
    (s) => s.results.testResults[0].assertionResults.pop(),
    (s) => (s.results.testResults[0].assertionResults[0].status = "pending"),
    (s) => s.commands.pop(),
    (s) => (s.commands[0].status = 1),
    (s) => (s.commands[0].signal = "SIGTERM"),
    (s) => (s.commands[0].error = "ETIMEDOUT"),
    (s) => (s.commands[0].validated = false),
    (s) => (s.commands[0].binarySha256 = "0".repeat(64)),
    (s) => (s.commands[0].wasmSha256 = "0".repeat(64)),
    (s) => (s.commands[0].stdoutSha256 = "missing"),
    (s) => s.commands[0].metrics.jsonOutputBytes++,
  ]) {
    const s = structuredClone(suite());
    mutate(s);
    assert.throws(() => verifyFinalSuite(s.results, s.commands, s.expected));
  }
});

test("the optional dependency mount is read-only and actual inspection still rejects writable, missing or extra mounts", () => {
  const s = {
    image: "sha256:" + "1".repeat(64),
    nonce: "2".repeat(24),
    uid: 1001,
    gid: 1001,
    inputs: "/tmp/inputs",
    work: "/tmp/work",
    modules: "/tmp/node_modules",
    container: "3".repeat(64),
  };
  const args = optimizerCreateArguments(s);
  assert.ok(
    args.includes(
      "type=bind,source=/tmp/node_modules,target=/inputs/node_modules,readonly",
    ),
  );
  assert.equal(args.filter((x) => x === "--mount").length, 3);
  assert.throws(
    () => optimizerCreateArguments({ ...s, modules: "/tmp/a,readonly=false" }),
    /container_invalid/,
  );
  const actual = [
    {
      Id: s.container,
      Image: s.image,
      Name: `/oja-function-opt-${s.nonce}`,
      Config: {
        User: "1001:1001",
        Labels: { "oja.function-opt": s.nonce },
        Env: ["HOME=/work"],
        Entrypoint: ["/usr/local/bin/node"],
        Cmd: ["/inputs/probe.mjs"],
        WorkingDir: "/work",
      },
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        Privileged: false,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        PidsLimit: 128,
        Memory: 1073741824,
        NanoCpus: 2000000000,
        Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=64m" },
      },
      State: { ExitCode: 0, OOMKilled: false, Running: false },
      Mounts: [
        ["inputs", "/inputs", false],
        ["work", "/work", true],
        ["modules", "/inputs/node_modules", false],
      ].map(([k, dest, rw]) => ({
        Type: "bind",
        Source: s[k],
        Destination: dest,
        RW: rw,
      })),
    },
  ];
  assert.equal(verifyOptimizerContainer(actual, s).Id, s.container);
  for (const change of [
    (a) => (a[0].Mounts[2].RW = true),
    (a) => a[0].Mounts.pop(),
    (a) => a[0].Mounts.push(a[0].Mounts[2]),
  ]) {
    const a = structuredClone(actual);
    change(a);
    assert.throws(() => verifyOptimizerContainer(a, s), /isolation_invalid/);
  }
});

test("workflow downloads only the fixed Runner, requires optimizer success, and uploads full final-test evidence even on failure", () => {
  const w = yaml.load(read(".github/workflows/function-postprocess.yml"));
  assert.deepEqual(Object.keys(w.on).sort(), [
    "pull_request",
    "workflow_dispatch",
  ]);
  assert.deepEqual(w.permissions, { contents: "read", actions: "read" });
  const steps = w.jobs.optimize.steps,
    final = steps.findIndex(
      (s) => s.run === "node scripts/security/function-final-tests.mjs",
    ),
    optimize = steps.findIndex(
      (s) => s.run === "node scripts/security/function-postprocess.mjs",
    );
  assert.ok(final > optimize);
  assert.equal(steps[final].if, undefined);
  const download = steps.find(
    (s) => s.with?.path === ".audit/function-runner-input",
  );
  assert.equal(download.with["artifact-ids"], policy.runner.artifact);
  assert.equal(download.with["run-id"], policy.runner.run);
  const upload = steps.at(-1);
  assert.equal(upload.if, "always()");
  assert.match(upload.with.path, /function-final-tests/);
  const setup = read("tests/fixtures/functions/final-vitest.setup.mjs");
  assert.match(setup, /importOriginal\(\)/);
  assert.match(setup, /spawnSync\(binary/);
  assert.doesNotMatch(setup, /expectedOutput/);
  assert.match(setup, /timeout: 15000/);
  assert.match(setup, /validated: false/);
  assert.match(
    read("tests/fixtures/functions/final-tests-probe.mjs"),
    /\/inputs\/node_modules\/denied/,
  );
});

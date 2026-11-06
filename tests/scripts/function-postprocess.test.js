import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import yaml from "js-yaml";
import { verifyOptimizerRejection } from "../fixtures/functions/postprocess-probe.mjs";
import {
  OPTIMIZER_FLAGS,
  postprocessOptions,
  validatePostprocessPolicy,
  optimizerCreateArguments,
  verifyOptimizerContainer,
  observeFunctionWasm,
  downloadOptimizer,
} from "../../scripts/security/function-postprocess.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const policy = JSON.parse(read("security/function-postprocess.json"));
const settings = {
  image: "sha256:" + "1".repeat(64),
  nonce: "2".repeat(24),
  uid: 1001,
  gid: 1001,
  inputs: "/tmp/lab/inputs",
  work: "/tmp/lab/work",
  container: "3".repeat(64),
};

test("postprocessing is argument-free Linux CI only, with no supplied URL, tool or publication option", () => {
  const ci = { CI: "true", GITHUB_ACTIONS: "true" };
  assert.equal(postprocessOptions([], ci, "linux"), undefined);
  for (const args of [
    ["--skip"],
    ["--publish"],
    ["--tool", "old"],
    ["--url", "production"],
  ])
    assert.throws(
      () => postprocessOptions(args, ci, "linux"),
      /arguments_invalid/,
    );
  assert.throws(() => postprocessOptions([], ci, "win32"), /arguments_invalid/);
  assert.throws(() => postprocessOptions([], {}, "linux"), /arguments_invalid/);
});

test("optimizer policy binds the fixed upstream release, included fixes, real CLI receipt and both unapproved candidates", () => {
  assert.equal(validatePostprocessPolicy(policy), policy);
  for (const change of [
    (p) => (p.optimizer.version = "123"),
    (p) => (p.optimizer.commit = "0".repeat(40)),
    (p) => (p.optimizer.url = "https://example.com/tool"),
    (p) => p.optimizer.archiveSize++,
    (p) => (p.optimizer.archiveSha256 = "0".repeat(64)),
    (p) => (p.optimizer.jsSha256 = "0".repeat(64)),
    (p) => (p.optimizer.wasmSha256 = "0".repeat(64)),
    (p) => p.optimizer.includedFixes.pop(),
    (p) => p.native.run++,
    (p) => p.native.artifact++,
    (p) => (p.native.head = "0".repeat(40)),
    (p) => (p.native.binarySha256 = "0".repeat(64)),
    (p) => (p.native.receiptSha256 = "0".repeat(64)),
    (p) => (p.sdkSha256 = "0".repeat(64)),
    (p) => p.candidates.reverse(),
    (p) => (p.candidates[1].bundleSha256 = "0".repeat(64)),
    (p) => (p.candidates[1].head = "0".repeat(40)),
    (p) => (p.artifactStatus = "APPROVED"),
    (p) => (p.wholeCompilerVerified = true),
    (p) => (p.fullFunctionVerified = true),
    (p) => (p.productionApproved = true),
  ]) {
    const p = structuredClone(policy);
    change(p);
    assert.throws(() => validatePostprocessPolicy(p), /policy_invalid/);
  }
});

test("container creation has bounded resources, no network/root/capabilities/secrets or writable tools", () => {
  const args = optimizerCreateArguments(settings);
  const value = (f) => args[args.indexOf(f) + 1];
  assert.equal(value("--network"), "none");
  assert.equal(value("--user"), "1001:1001");
  assert.equal(value("--memory"), "1g");
  assert.equal(value("--cpus"), "2");
  assert.equal(value("--pids-limit"), "128");
  assert.equal(value("--cap-drop"), "ALL");
  assert.equal(value("--security-opt"), "no-new-privileges");
  assert.equal(value("--tmpfs"), "/tmp:rw,noexec,nosuid,nodev,size=64m");
  assert.ok(args.includes("--read-only"));
  assert.ok(
    args.includes(
      `type=bind,source=${settings.inputs},target=/inputs,readonly`,
    ),
  );
  assert.equal(args.filter((a) => a === "--mount").length, 2);
  assert.equal(args.filter((a) => a === "--env").length, 1);
  assert.equal(value("--env"), "HOME=/work");
  assert.ok(
    !args.some((a) => /docker\.sock|env-file|privileged|publish/.test(a)),
  );
  for (const change of [
    { image: "node:latest" },
    { uid: 0 },
    { gid: -1 },
    { nonce: "unknown" },
    { inputs: "/tmp/../etc" },
    { work: "/tmp/a,readonly=false" },
  ])
    assert.throws(
      () => optimizerCreateArguments({ ...settings, ...change }),
      /container_invalid/,
    );
});

function container() {
  return [
    {
      Id: settings.container,
      Image: settings.image,
      Name: `/oja-function-opt-${settings.nonce}`,
      Config: {
        User: "1001:1001",
        Labels: { "oja.function-opt": settings.nonce },
        Env: ["PATH=/usr/bin", "HOME=/work"],
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
        {
          Type: "bind",
          Source: settings.inputs,
          Destination: "/inputs",
          RW: false,
        },
        { Type: "bind", Source: settings.work, Destination: "/work", RW: true },
      ],
    },
  ];
}

test("actual container inspection rejects weakened isolation, unexpected environment, mounts, command and failed execution", () => {
  assert.equal(
    verifyOptimizerContainer(container(), settings).Id,
    settings.container,
  );
  assert.equal(
    verifyOptimizerContainer(container(), settings, false).Id,
    settings.container,
  );
  for (const mutate of [
    (a) => (a.Id = "other"),
    (a) => (a.Image = "other"),
    (a) => (a.Config.User = "0:0"),
    (a) => a.Config.Env.push("GITHUB_TOKEN=synthetic"),
    (a) => (a.Config.Entrypoint = ["sh"]),
    (a) => (a.Config.Cmd = ["other.mjs"]),
    (a) => (a.Config.WorkingDir = "/"),
    (a) => (a.HostConfig.NetworkMode = "bridge"),
    (a) => (a.HostConfig.ReadonlyRootfs = false),
    (a) => (a.HostConfig.Privileged = true),
    (a) => (a.HostConfig.CapDrop = []),
    (a) => (a.HostConfig.SecurityOpt = []),
    (a) => (a.HostConfig.PidsLimit = 0),
    (a) => (a.HostConfig.Memory = 0),
    (a) => (a.HostConfig.NanoCpus = 0),
    (a) => (a.HostConfig.Tmpfs["/tmp"] = "rw"),
    (a) => (a.Mounts[0].RW = true),
    (a) =>
      a.Mounts.push({
        Type: "bind",
        Source: "/var/run/docker.sock",
        Destination: "/socket",
        RW: true,
      }),
    (a) => (a.State.ExitCode = 1),
    (a) => (a.State.OOMKilled = true),
    (a) => (a.State.Running = true),
  ]) {
    const actual = container();
    mutate(actual[0]);
    assert.throws(
      () => verifyOptimizerContainer(actual, settings),
      /isolation_invalid/,
    );
  }
});

test("WASM validation rejects malformed bytes, oversize output and valid empty stubs without invoking a guest", () => {
  for (const b of [
    null,
    Buffer.alloc(0),
    Buffer.from("not wasm"),
    Buffer.alloc(262145),
  ])
    assert.throws(() => observeFunctionWasm(b), /wasm_invalid/);
  assert.throws(
    () => observeFunctionWasm(Buffer.from("0061736d01000000", "hex")),
    /interface_invalid/,
  );
  assert.deepEqual(OPTIMIZER_FLAGS, [
    "-Oz",
    "--enable-bulk-memory",
    "--enable-multimemory",
    "--enable-nontrapping-float-to-int",
    "--strip-debug",
  ]);
});

test("workflow has fixed read-only inputs, no schedules/deployments, and no old compiler or optimizer fallback", () => {
  const w = yaml.load(read(".github/workflows/function-postprocess.yml"));
  assert.deepEqual(w.permissions, { contents: "read", actions: "read" });
  assert.deepEqual(Object.keys(w.on).sort(), [
    "pull_request",
    "workflow_dispatch",
  ]);
  assert.equal(w.jobs.optimize.runs_on, undefined);
  assert.equal(w.jobs.optimize["timeout-minutes"], 20);
  const steps = w.jobs.optimize.steps;
  const download = steps.find((s) =>
    s.uses?.startsWith("actions/download-artifact@"),
  );
  assert.equal(download.with["artifact-ids"], policy.native.artifact);
  assert.equal(download.with["run-id"], policy.native.run);
  assert.equal(steps[0].with["persist-credentials"], false);
  for (const s of steps.filter((s) => s.uses))
    assert.match(s.uses, /@[a-f0-9]{40}$/);
  const runs = steps.map((s) => s.run || "").join("\n");
  assert.match(runs, /npm ci --ignore-scripts/);
  assert.match(runs, /node scripts\/security\/rebuild-esbuild\.mjs/);
  assert.doesNotMatch(
    runs,
    /shopify.*(deploy|release)|npm start|migrate deploy|git push/,
  );
  const probe = read("tests/fixtures/functions/postprocess-probe.mjs");
  assert.match(probe, /readonlyInputWriteDenied: true/);
  assert.match(probe, /timeout: 60000/);
  assert.doesNotMatch(probe, /expectedOutput|process\.env\.GITHUB/);
});

test("optimizer download pins the release, bounds bytes and HTTPS redirects and never overwrites inputs", async (t) => {
  const home = fs.mkdtempSync(
    path.join(os.tmpdir(), "oja-optimizer-download-"),
  );
  t.after(() => {
    assert.equal(
      path.dirname(fs.realpathSync(home)),
      fs.realpathSync(os.tmpdir()),
    );
    fs.rmSync(home, { recursive: true });
  });
  const file = path.join(home, "archive");
  for (const destination of [
    "http://github.com/file",
    "https://example.com/tool",
    "https://user@github.com/file",
    "https://github.com:444/file",
  ]) {
    await assert.rejects(
      downloadOptimizer(policy, file, async (url, options) => {
        assert.equal(url, policy.optimizer.url);
        assert.equal(options.redirect, "manual");
        return new Response(null, {
          status: 302,
          headers: { location: destination },
        });
      }),
      /redirect_invalid/,
    );
  }
  await assert.rejects(
    downloadOptimizer(
      policy,
      file,
      async () => new Response("missing", { status: 404 }),
    ),
    /download_failed/,
  );
  await assert.rejects(
    downloadOptimizer(policy, file, async () => new Response("wrong bytes")),
    /digest_mismatch/,
  );
  await assert.rejects(
    downloadOptimizer(
      policy,
      file,
      async () => new Response(Buffer.alloc(policy.optimizer.archiveSize + 1)),
    ),
    /download_limit/,
  );
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, "keep");
  await assert.rejects(
    downloadOptimizer(policy, file, () => {
      throw new Error("must not fetch");
    }),
    /download_exists/,
  );
  assert.equal(fs.readFileSync(file, "utf8"), "keep");
});

test("invalid input requires explicit parser rejection, not a timeout, signal, assertion or memory failure", () => {
  const parserExit = {
    status: 1,
    error: undefined,
    signal: null,
    stderr:
      "Fatal: invalid.wasm:1:0: error: unrecognized module field\nAborted()\nRuntimeError: unreachable\n",
  };
  assert.equal(verifyOptimizerRejection(parserExit), undefined);
  for (const patch of [
    { status: 0 },
    { status: 2 },
    { signal: "SIGSEGV" },
    { error: new Error("timeout") },
    { stderr: "RuntimeError: unreachable" },
    { stderr: "Fatal: Assertion failed" },
    { stderr: "Fatal: memory access out of bounds" },
    { stderr: "Fatal: stack overflow" },
  ])
    assert.throws(() => verifyOptimizerRejection({ ...parserExit, ...patch }));
});

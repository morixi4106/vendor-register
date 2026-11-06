import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  postprocessOptions,
  validatePostprocessPolicy,
  observeFunctionWasm,
  optimizerCreateArguments,
  verifyOptimizerContainer,
} from "./function-postprocess.mjs";
import {
  checkedNativeDirectory,
  verifyRebuiltEsbuild,
} from "./rebuild-esbuild.mjs";
import {
  validateRunnerPolicy,
  runnerInput,
} from "./rebuild-function-runner.mjs";
import { scanRustLockfile } from "./rust-source-audit.mjs";
import { assertNodeRuntime, evaluateNodeRuntime } from "./node-runtime.mjs";
import { PRISMA_RUNTIME_BASE } from "./prisma-runtime-compatibility.mjs";
import { verifyFinalSuite } from "../../tests/fixtures/functions/final-contracts.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const read = (file) => {
  const stat = fs.lstatSync(file);
  assert.ok(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      stat.size <= 100000000,
  );
  return fs.readFileSync(file);
};
const json = (file) => JSON.parse(read(file));

export function validateFinalTestsPolicy(p) {
  if (
    !p ||
    p.schemaVersion !== 1 ||
    JSON.stringify(p.runner) !==
      JSON.stringify({
        run: 41814202050,
        artifact: 13313318892,
        head: "be952e3283df80097598ee6954cb0e75e6d4a848",
        version: "9.2.2+oja.2",
        binarySha256:
          "57c6c1491e7644a312517060636063d06f41f39d9cb20ea8916171194c652b32",
        receiptSha256:
          "62f1d43a45590b3331c8ff907c8b022df090f8eff48b974f8f2752686a23967f",
      }) ||
    JSON.stringify(
      p.candidates?.map((c) => [
        c.name,
        c.head,
        c.wasmSha256,
        c.testSha256,
        c.testCount,
        c.runnerCalls,
      ]),
    ) !==
      JSON.stringify([
        [
          "security",
          "e7781b4aeab5a934cebbdc020b8e18195ed35121",
          "dd1f186d81ce877f76a724c6d3921ad6f393a0d4d42edec2ed5d22336773cc6d",
          "e6789e6dc34cfe99fb19a04c23b591e2e5b8aef29bbd4d40ab3bcc172afbe1b4",
          51,
          12,
        ],
        [
          "international",
          "7731ab6e863580f6ed7ba6118a04a5234e8769df",
          "d9bc6dcd2a659126bdcf0d6e143f41598d615a5ed0f1ab8be9e218729c9f2d1b",
          "5c21952057b0f95ae94e2157aaae565a2d542f3a84b54f0dadfbe56523f1a78b",
          92,
          24,
        ],
      ]) ||
    p.artifactStatus !== "NOT_VERIFIED" ||
    [
      p.fullFunctionVerified,
      p.wholeCompilerVerified,
      p.productionApproved,
    ].some((v) => v !== false)
  )
    throw new Error("function_final_tests_policy_invalid");
  return p;
}

export function finalFixturePaths(listing) {
  const prefix = "extensions/marketplace-purchase-control/tests/fixtures/";
  const files = listing.trim().split(/\r?\n/).sort();
  if (
    files.length !== 12 ||
    new Set(files).size !== 12 ||
    files.some(
      (f) =>
        !f.startsWith(prefix) ||
        !/^[a-z0-9-]+\.json$/.test(f.slice(prefix.length)),
    )
  )
    throw new Error("function_final_fixture_paths_invalid");
  return files;
}

export async function testFinalFunctions(root = ROOT) {
  postprocessOptions([]);
  assertNodeRuntime();
  const policyBytes = read(
      path.join(root, "security/function-final-tests.json"),
    ),
    p = validateFinalTestsPolicy(JSON.parse(policyBytes));
  const postPolicy = validatePostprocessPolicy(
    json(path.join(root, "security/function-postprocess.json")),
  );
  const postBase = checkedNativeDirectory(root, ".audit/function-postprocess");
  const postRuns = fs.readdirSync(postBase);
  assert.equal(postRuns.length, 1);
  const postHome = path.join(postBase, postRuns[0]),
    postReceiptBytes = read(path.join(postHome, "receipt.json")),
    post = JSON.parse(postReceiptBytes);
  assert.deepEqual(post.policy, postPolicy);
  assert.equal(
    post.policySha256,
    sha(read(path.join(root, "security/function-postprocess.json"))),
  );
  assert.equal(post.productionApproved, false);
  assert.equal(post.fullFunctionVerified, false);
  assert.equal(post.baseImage, PRISMA_RUNTIME_BASE);
  assert.equal(post.report.success, true);
  const home = fs.mkdtempSync(
    path.join(
      checkedNativeDirectory(root, ".audit/function-final-tests"),
      "run-",
    ),
  );
  const inputs = path.join(home, "inputs"),
    work = path.join(home, "work");
  fs.mkdirSync(inputs);
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(inputs, "node_modules"));
  const commands = [];
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home };
  const execute = (name, command, args, cwd = root, timeout = 60000) => {
    const r = spawnSync(command, args, {
      cwd,
      env,
      shell: false,
      timeout,
      maxBuffer: 16000000,
    });
    fs.writeFileSync(path.join(home, name + ".stdout.log"), r.stdout || "");
    fs.writeFileSync(path.join(home, name + ".stderr.log"), r.stderr || "");
    const entry = {
      name,
      command,
      args,
      cwd,
      status: r.status,
      signal: r.signal,
      error: r.error?.code || null,
    };
    commands.push(entry);
    fs.writeFileSync(
      path.join(home, name + ".command.json"),
      JSON.stringify(entry, null, 2) + "\n",
    );
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.equal(r.error, undefined);
    assert.equal(r.signal, null);
    return r.stdout;
  };
  const runnerRoot = path.join(root, ".audit/function-runner-input");
  const originalReceipt = read(path.join(runnerRoot, "receipt.json"));
  assert.equal(sha(originalReceipt), p.runner.receiptSha256);
  const runnerReceipt = JSON.parse(originalReceipt),
    runnerPolicyBytes = read(
      path.join(root, "security/function-runner-rebuild.json"),
    );
  const runnerPolicy = validateRunnerPolicy(JSON.parse(runnerPolicyBytes));
  assert.equal(runnerReceipt.policySha256, sha(runnerPolicyBytes));
  assert.equal(runnerReceipt.productionApproved, false);
  assert.equal(runnerPolicy.version, p.runner.version);
  assert.equal(runnerReceipt.binarySha256, p.runner.binarySha256);
  assert.equal(
    sha(read(path.join(runnerRoot, "function-runner.cdx.json"))),
    runnerReceipt.sbomSha256,
  );
  assert.equal(
    sha(read(path.join(runnerRoot, "source-assessment.json"))),
    runnerReceipt.sourceAssessmentSha256,
  );
  const runnerBytes = read(path.join(runnerRoot, "function-runner"));
  assert.equal(sha(runnerBytes), p.runner.binarySha256);
  assert.equal(
    runnerReceipt.lockfileSha256,
    sha(runnerInput(root, runnerPolicy.lockfile)),
  );
  assert.equal(
    runnerReceipt.patchSha256,
    sha(runnerInput(root, runnerPolicy.patch)),
  );
  assert.deepEqual(runnerReceipt.overrides, runnerPolicy.overrides);
  for (const override of runnerPolicy.overrides)
    runnerInput(root, override.patch);
  const assessment = await scanRustLockfile(
    runnerInput(root, runnerPolicy.lockfile).toString(),
  );
  assert.equal(assessment.sourceAuditOk, true);
  assert.equal(assessment.packageCount, 426);
  assert.deepEqual(assessment.findings, []);
  assert.deepEqual(assessment.unresolved, []);
  fs.writeFileSync(
    path.join(home, "runner-current-assessment.json"),
    JSON.stringify(assessment, null, 2) + "\n",
  );
  fs.mkdirSync(path.join(home, "runner-original-evidence"));
  for (const file of fs
    .readdirSync(runnerRoot)
    .filter((f) => f !== "function-runner")) {
    assert.match(file, /^[a-zA-Z0-9_.-]+$/);
    const b = read(path.join(runnerRoot, file));
    fs.writeFileSync(path.join(home, "runner-original-evidence", file), b, {
      flag: "wx",
    });
  }
  fs.writeFileSync(path.join(inputs, "function-runner"), runnerBytes, {
    flag: "wx",
    mode: 0o755,
  });
  const esbuild = verifyRebuiltEsbuild(root),
    esbuildBytes = read(
      path.join(root, "node_modules/@esbuild/linux-x64/bin/esbuild"),
    );
  assert.equal(sha(esbuildBytes), esbuild.binarySha256);
  fs.writeFileSync(path.join(inputs, "esbuild"), esbuildBytes, {
    flag: "wx",
    mode: 0o755,
  });
  const dependencies = {};
  for (const name of ["vitest", "@shopify/shopify-function-test-helpers"]) {
    const b = read(path.join(root, "node_modules", name, "package.json"));
    dependencies[name] = {
      version: JSON.parse(b).version,
      packageJsonSha256: sha(b),
    };
  }
  assert.equal(dependencies.vitest.version, "4.1.12");
  assert.equal(
    dependencies["@shopify/shopify-function-test-helpers"].version,
    "1.1.0",
  );
  const extension = "extensions/marketplace-purchase-control/",
    candidates = [];
  for (const c of p.candidates) {
    const repository =
      c.name === "security"
        ? root
        : path.join(root, ".audit/function-international-source");
    const optimized = observeFunctionWasm(
      read(path.join(postHome, "work", c.name + ".wasm")),
    );
    assert.equal(optimized.sha256, c.wasmSha256);
    assert.deepEqual(
      optimized,
      post.report.candidates.find((x) => x.name === c.name).optimized,
    );
    fs.writeFileSync(
      path.join(inputs, c.name + ".wasm"),
      read(path.join(postHome, "work", c.name + ".wasm")),
      { flag: "wx" },
    );
    const fixtureFiles = finalFixturePaths(
      execute(`fixtures-${c.name}`, "git", [
        "-C",
        repository,
        "ls-tree",
        "-r",
        "--name-only",
        c.head,
        extension + "tests/fixtures/",
      ]).toString(),
    );
    const source = post.candidates.find((x) => x.name === c.name);
    assert.ok(source);
    assert.equal(source.head, c.head);
    const paths = [...source.bindings.map((b) => b.path), ...fixtureFiles];
    const bindings = [];
    for (const file of paths) {
      assert.ok(file.startsWith(extension));
      const relative = file.slice(extension.length);
      assert.ok(!relative.split("/").includes(".."));
      const b = execute(`source-${commands.length}`, "git", [
        "-C",
        repository,
        "show",
        `${c.head}:${file}`,
      ]);
      const old = source.bindings.find((x) => x.path === file);
      if (old) assert.equal(sha(b), old.sha256);
      const destination = path.join(inputs, c.name, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, b, { flag: "wx" });
      bindings.push({ path: relative, sha256: sha(b) });
    }
    assert.equal(
      bindings.find((b) => b.path === "tests/default.test.js").sha256,
      c.testSha256,
    );
    candidates.push({ ...c, bindings, wasmBytes: optimized.size });
  }
  const helpers = [];
  for (const [source, destination] of [
    ["final-tests-probe.mjs", "probe.mjs"],
    ["final-contracts.mjs", "final-contracts.mjs"],
    ["final-vitest.setup.mjs", "final-vitest.setup.mjs"],
    ["final-vitest.config.mjs", "final-vitest.config.mjs"],
  ]) {
    const file = "tests/fixtures/functions/" + source,
      b = read(path.join(root, file));
    fs.writeFileSync(path.join(inputs, destination), b, { flag: "wx" });
    helpers.push({ path: file, destination, sha256: sha(b) });
  }
  fs.writeFileSync(
    path.join(inputs, "manifest.json"),
    JSON.stringify(
      { runner: p.runner, candidates, esbuildSha256: esbuild.binarySha256 },
      null,
      2,
    ) + "\n",
  );
  const settings = {
    image: post.image,
    nonce: crypto.randomBytes(12).toString("hex"),
    uid: process.getuid(),
    gid: process.getgid(),
    inputs,
    work,
    modules: fs.realpathSync(path.join(root, "node_modules")),
  };
  const container = execute(
    "container-create",
    "docker",
    optimizerCreateArguments(settings),
  )
    .toString()
    .trim();
  assert.match(container, /^[a-f0-9]{64}$/);
  let report;
  try {
    verifyOptimizerContainer(
      JSON.parse(
        execute("container-inspect-before", "docker", ["inspect", container]),
      ),
      { ...settings, container },
      false,
    );
    execute(
      "final-tests",
      "docker",
      ["start", "--attach", container],
      root,
      480000,
    );
    verifyOptimizerContainer(
      JSON.parse(
        execute("container-inspect-after", "docker", ["inspect", container]),
      ),
      { ...settings, container },
    );
    report = json(path.join(work, "report.json"));
    assert.equal(report.success, true);
    assert.equal(report.uid, settings.uid);
    assert.equal(report.hostname, container.slice(0, 12));
    assert.equal(report.readonlyInputsAndDependenciesWriteDenied, true);
    assert.equal(report.readonlyRootWriteDenied, true);
    assert.equal(
      evaluateNodeRuntime(
        report.node,
        json(path.join(root, "security/node-runtime.json")),
      ).ok,
      true,
    );
    assert.equal(report.countsIncludeJavaScriptAssertions, true);
    assert.equal(report.actualWireInputBytesMeasured, false);
    for (const key of [
      "fullFunctionVerified",
      "wholeCompilerVerified",
      "productionApproved",
    ])
      assert.equal(report[key], false);
    assert.equal(report.candidates.length, 2);
    for (const c of candidates) {
      const directory = path.join(work, c.name),
        result = json(path.join(directory, "vitest-results.json"));
      const invocations = fs
        .readdirSync(directory)
        .filter((n) => /^run-\d+\.command\.json$/.test(n))
        .sort()
        .map((n) => {
          const command = json(path.join(directory, n));
          const out = read(
              path.join(directory, n.replace(".command.json", ".stdout.log")),
            ),
            err = read(
              path.join(directory, n.replace(".command.json", ".stderr.log")),
            );
          assert.equal(sha(out), command.stdoutSha256);
          assert.equal(sha(err), command.stderrSha256);
          assert.deepEqual(JSON.parse(out).output, command.output);
          return command;
        });
      const summary = verifyFinalSuite(result, invocations, {
        ...c,
        runnerSha256: p.runner.binarySha256,
      });
      assert.deepEqual(
        report.candidates.find((x) => x.name === c.name),
        { name: c.name, head: c.head, wasmSha256: c.wasmSha256, ...summary },
      );
      for (const b of c.bindings)
        assert.equal(sha(read(path.join(inputs, c.name, b.path))), b.sha256);
      assert.equal(
        sha(read(path.join(inputs, c.name + ".wasm"))),
        c.wasmSha256,
      );
    }
  } finally {
    execute("container-remove", "docker", ["rm", "--force", container]);
  }
  assert.equal(
    sha(read(path.join(inputs, "function-runner"))),
    p.runner.binarySha256,
  );
  assert.equal(sha(read(path.join(inputs, "esbuild"))), esbuild.binarySha256);
  const receipt = {
    observedAt: new Date().toISOString(),
    policy: p,
    policySha256: sha(policyBytes),
    postprocessReceiptSha256: sha(postReceiptBytes),
    runnerReceiptSha256: sha(originalReceipt),
    runnerAssessmentSha256: sha(
      read(path.join(home, "runner-current-assessment.json")),
    ),
    candidates,
    helpers,
    dependencies,
    packageLockSha256: sha(read(path.join(root, "package-lock.json"))),
    esbuild,
    image: settings.image,
    baseImage: PRISMA_RUNTIME_BASE,
    container,
    report,
    orchestratorSha256: sha(read(new URL(import.meta.url))),
    workflowSha256: sha(
      read(path.join(root, ".github/workflows/function-postprocess.yml")),
    ),
    existingFinalByteTestsPassed: true,
    artifactStatus: "NOT_VERIFIED",
    fullFunctionVerified: false,
    wholeCompilerVerified: false,
    productionApproved: false,
    scope:
      "existing pinned final-WASM tests, native Runner and finite resource contracts in an isolated container; not full source, provider, production or financial approval",
  };
  fs.writeFileSync(
    path.join(home, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  return {
    ok: true,
    home,
    candidates: report.candidates,
    existingFinalByteTestsPassed: true,
    fullFunctionVerified: false,
    productionApproved: false,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    postprocessOptions(process.argv.slice(2));
    console.log(JSON.stringify(await testFinalFunctions()));
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  }
}

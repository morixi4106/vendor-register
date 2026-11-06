import fs from "node:fs";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { verifyFinalSuite } from "./final-contracts.mjs";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const input = JSON.parse(fs.readFileSync("/inputs/manifest.json"));
assert.equal(process.platform, "linux");
assert.ok(process.getuid() > 0);
assert.match(process.env.HOSTNAME, /^[a-f0-9]{12}$/);
assert.deepEqual(
  Object.keys(process.env).filter(
    (k) =>
      !["HOME", "PATH", "NODE_VERSION", "YARN_VERSION", "HOSTNAME"].includes(k),
  ),
  [],
);
for (const file of ["/denied", "/inputs/denied", "/inputs/node_modules/denied"])
  assert.throws(
    () => fs.writeFileSync(file, "x"),
    (e) => ["EROFS", "EACCES"].includes(e.code),
  );
assert.equal(
  sha(fs.readFileSync("/inputs/function-runner")),
  input.runner.binarySha256,
);
assert.equal(sha(fs.readFileSync("/inputs/esbuild")), input.esbuildSha256);
const version = spawnSync("/inputs/function-runner", ["--version"], {
  cwd: "/work",
  env: { HOME: "/work", TMPDIR: "/tmp" },
  encoding: "utf8",
  timeout: 15000,
  shell: false,
});
fs.writeFileSync("/work/runner-version.stdout.log", version.stdout || "");
fs.writeFileSync("/work/runner-version.stderr.log", version.stderr || "");
assert.equal(version.status, 0);
assert.equal(version.error, undefined);
assert.equal(version.stdout.trim(), `function-runner ${input.runner.version}`);
const candidates = [];
for (const c of input.candidates) {
  const home = `/work/${c.name}`;
  fs.mkdirSync(home);
  const snapshot = `/inputs/${c.name}`;
  for (const b of c.bindings)
    assert.equal(sha(fs.readFileSync(`${snapshot}/${b.path}`)), b.sha256);
  const wasmPath = `/inputs/${c.name}.wasm`;
  const wasm = fs.readFileSync(wasmPath);
  assert.equal(sha(wasm), c.wasmSha256);
  assert.ok(WebAssembly.validate(wasm));
  const manifest = {
    ...c,
    home,
    snapshot,
    wasmPath,
    wasmBytes: wasm.length,
    runnerSha256: input.runner.binarySha256,
    schemaPath: `${snapshot}/schema.graphql`,
    queryPath: `${snapshot}/src/cart_validations_generate_run.graphql`,
    schemaSha256: c.bindings.find((b) => b.path === "schema.graphql").sha256,
    querySha256: c.bindings.find(
      (b) => b.path === "src/cart_validations_generate_run.graphql",
    ).sha256,
    prebuiltBuildSubstitution: true,
    functionInfoSubstitution: true,
    finalPostprocessedBytes: true,
    fullFunctionVerified: false,
    productionApproved: false,
  };
  fs.writeFileSync(
    `${home}/manifest.json`,
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const config = fs.readFileSync("/inputs/final-vitest.config.mjs");
  fs.writeFileSync(`${home}/vitest.config.mjs`, config);
  const env = {
    HOME: home,
    TMPDIR: "/tmp",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    ESBUILD_BINARY_PATH: "/inputs/esbuild",
    OJA_FUNCTION_LAB_MANIFEST: `${home}/manifest.json`,
  };
  const args = [
    "/inputs/node_modules/vitest/vitest.mjs",
    "run",
    "--config",
    `${home}/vitest.config.mjs`,
  ];
  const r = spawnSync(process.execPath, args, {
    cwd: home,
    env,
    shell: false,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 8000000,
  });
  fs.writeFileSync(`${home}/stdout.log`, r.stdout || "");
  fs.writeFileSync(`${home}/stderr.log`, r.stderr || "");
  fs.writeFileSync(
    `${home}/command.json`,
    JSON.stringify(
      {
        args,
        status: r.status,
        signal: r.signal,
        error: r.error?.code || null,
      },
      null,
      2,
    ) + "\n",
  );
  assert.equal(r.status, 0, `${c.name}: ${r.stderr}`);
  assert.equal(r.error, undefined);
  assert.equal(r.signal, null);
  const results = JSON.parse(fs.readFileSync(`${home}/vitest-results.json`));
  const commands = fs
    .readdirSync(home)
    .filter((n) => /^run-\d+\.command\.json$/.test(n))
    .sort()
    .map((n) => {
      const cmd = JSON.parse(fs.readFileSync(`${home}/${n}`));
      const out = fs.readFileSync(
          `${home}/${n.replace(".command.json", ".stdout.log")}`,
        ),
        err = fs.readFileSync(
          `${home}/${n.replace(".command.json", ".stderr.log")}`,
        );
      assert.equal(sha(out), cmd.stdoutSha256);
      assert.equal(sha(err), cmd.stderrSha256);
      assert.deepEqual(JSON.parse(out).output, cmd.output);
      return cmd;
    });
  const summary = verifyFinalSuite(results, commands, manifest);
  for (const b of c.bindings)
    assert.equal(sha(fs.readFileSync(`${snapshot}/${b.path}`)), b.sha256);
  assert.equal(sha(fs.readFileSync(wasmPath)), c.wasmSha256);
  candidates.push({
    name: c.name,
    head: c.head,
    wasmSha256: c.wasmSha256,
    ...summary,
  });
}
assert.equal(
  sha(fs.readFileSync("/inputs/function-runner")),
  input.runner.binarySha256,
);
assert.equal(sha(fs.readFileSync("/inputs/esbuild")), input.esbuildSha256);
const report = {
  success: true,
  candidates,
  uid: process.getuid(),
  hostname: process.env.HOSTNAME,
  node: {
    version: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    sha256: sha(fs.readFileSync(process.execPath)),
  },
  readonlyInputsAndDependenciesWriteDenied: true,
  readonlyRootWriteDenied: true,
  countsIncludeJavaScriptAssertions: true,
  actualWireInputBytesMeasured: false,
  fullFunctionVerified: false,
  wholeCompilerVerified: false,
  productionApproved: false,
};
fs.writeFileSync("/work/report.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));

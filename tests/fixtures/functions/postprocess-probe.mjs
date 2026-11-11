import fs from "node:fs";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
export function verifyOptimizerRejection(result) {
  assert.equal(result.status, 1);
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  // Emscripten represents Binaryen's input-error _Exit as an unreachable trap.
  assert.match(result.stderr, /^Fatal:|\[parse exception:/m);
  assert.doesNotMatch(
    result.stderr,
    /Assertion failed|memory access out of bounds|memory out of bounds|stack overflow/i,
  );
}

export function runOptimizerProbe() {
  const manifest = JSON.parse(fs.readFileSync("/inputs/manifest.json"));
  assert.equal(process.platform, "linux");
  assert.equal(process.getuid() > 0, true);
  assert.deepEqual(
    Object.keys(process.env).filter(
      (k) =>
        !["HOME", "PATH", "NODE_VERSION", "YARN_VERSION", "HOSTNAME"].includes(
          k,
        ),
    ),
    [],
  );
  assert.match(process.env.HOSTNAME, /^[a-f0-9]{12}$/);
  assert.throws(
    () => fs.writeFileSync("/inputs/denied", "x"),
    (e) => ["EROFS", "EACCES"].includes(e.code),
  );
  assert.throws(
    () => fs.writeFileSync("/denied", "x"),
    (e) => ["EROFS", "EACCES"].includes(e.code),
  );
  assert.equal(
    sha(fs.readFileSync("/inputs/wasm-opt.cjs")),
    manifest.optimizer.jsSha256,
  );
  assert.equal(
    sha(fs.readFileSync("/inputs/wasm-opt.wasm")),
    manifest.optimizer.wasmSha256,
  );
  const commands = [];
  const run = (name, args, success) => {
    const env = { HOME: "/work", TMPDIR: "/tmp", BINARYEN_CORES: "2" };
    const r = spawnSync(process.execPath, ["/inputs/wasm-opt.cjs", ...args], {
      cwd: "/work",
      env,
      shell: false,
      timeout: 60000,
      encoding: "utf8",
      maxBuffer: 4_000_000,
    });
    fs.writeFileSync(`/work/${name}.stdout.log`, r.stdout || "");
    fs.writeFileSync(`/work/${name}.stderr.log`, r.stderr || "");
    const command = {
      name,
      args,
      status: r.status,
      signal: r.signal,
      error: r.error?.code || null,
      stdoutSha256: sha(r.stdout || ""),
      stderrSha256: sha(r.stderr || ""),
    };
    commands.push(command);
    fs.writeFileSync(
      `/work/${name}.command.json`,
      JSON.stringify(command, null, 2) + "\n",
    );
    assert.equal(r.error, undefined, name);
    assert.equal(r.signal, null, name);
    if (success) assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    else {
      verifyOptimizerRejection(r);
    }
    return r;
  };
  const version = run("version", ["--version"], true);
  assert.match(version.stdout, /wasm-opt version 133/);
  fs.writeFileSync("/work/empty.wasm", Buffer.from("0061736d01000000", "hex"));
  run(
    "empty-valid",
    ["empty.wasm", ...manifest.flags, "-o", "empty-output.wasm"],
    true,
  );
  assert.equal(
    WebAssembly.validate(fs.readFileSync("/work/empty-output.wasm")),
    true,
  );
  fs.writeFileSync("/work/invalid.wasm", "not wasm");
  run(
    "invalid",
    ["invalid.wasm", ...manifest.flags, "-o", "invalid-output.wasm"],
    false,
  );
  assert.equal(fs.existsSync("/work/invalid-output.wasm"), false);
  const observe = (b) => {
    assert.equal(WebAssembly.validate(b), true);
    const m = new WebAssembly.Module(b),
      imports = WebAssembly.Module.imports(m),
      exports = WebAssembly.Module.exports(m);
    return {
      sha256: sha(b),
      size: b.length,
      imports,
      exports,
      requiresCliTrampoline: imports.some((i) =>
        ["shopify_function_v1", "shopify_function_v2"].includes(i.module),
      ),
    };
  };
  const candidates = [];
  for (const c of manifest.candidates) {
    const raw = fs.readFileSync(`/inputs/${c.name}.wasm`);
    assert.deepEqual(observe(raw), c.raw);
    const output = `/work/${c.name}.wasm`;
    run(
      `optimize-${c.name}`,
      [`/inputs/${c.name}.wasm`, ...manifest.flags, "-o", output],
      true,
    );
    const optimized = observe(fs.readFileSync(output));
    assert.ok(optimized.size >= 8 && optimized.size <= 262144);
    const sorted = (values) => values.map((v) => JSON.stringify(v)).sort();
    assert.deepEqual(sorted(optimized.imports), sorted(c.raw.imports));
    assert.deepEqual(sorted(optimized.exports), sorted(c.raw.exports));
    fs.writeFileSync("/work/truncated.wasm", raw.subarray(0, raw.length - 1));
    run(
      `truncated-${c.name}`,
      ["truncated.wasm", ...manifest.flags, "-o", "truncated-output.wasm"],
      false,
    );
    assert.equal(fs.existsSync("/work/truncated-output.wasm"), false);
    assert.equal(sha(fs.readFileSync(`/inputs/${c.name}.wasm`)), c.raw.sha256);
    candidates.push({ name: c.name, raw: c.raw, optimized });
  }
  const nodeSha256 = sha(fs.readFileSync(process.execPath));
  const report = {
    success: true,
    uid: process.getuid(),
    hostname: process.env.HOSTNAME,
    node: {
      version: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      sha256: nodeSha256,
    },
    nodeSha256,
    version: version.stdout.trim(),
    commands,
    candidates,
    readonlyInputWriteDenied: true,
    readonlyRootWriteDenied: true,
    fullFunctionVerified: false,
    wholeCompilerVerified: false,
    productionApproved: false,
  };
  fs.writeFileSync("/work/report.json", JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      success: true,
      uid: process.getuid(),
      candidates: candidates.map((c) => ({
        name: c.name,
        sha256: c.optimized.sha256,
        bytes: c.optimized.size,
      })),
      productionApproved: false,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runOptimizerProbe();

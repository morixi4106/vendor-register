import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import {
  createBuildEnvironment,
  assertBuildInputs,
  runSafeBuildCommand,
  buildCommand,
} from "../../scripts/security/safe-build.mjs";

const require = createRequire(import.meta.url);
const guard = require("../../scripts/security/braces-guard.cjs");
const ROOT = path.resolve(import.meta.dirname, "../..");
const PRELOAD = path.join(ROOT, "scripts/security/braces-build-preload.mjs");

test("build environment drops secrets and uses an isolated profile and fixed resource bounds", () => {
  const source = {
    PATH: "path",
    HOME: "private-home",
    NODE_OPTIONS: "--inspect",
    GITHUB_TOKEN: "fake-github-secret",
    RENDER_API_KEY: "fake-render-secret",
    DATABASE_URL: "fake-live-db",
    SHOPIFY_API_SECRET: "fake-shopify-secret",
    PRIVACY_ENCRYPTION_KEY: "fake-encryption-secret",
  };
  const env = createBuildEnvironment("isolated", source);
  assert.equal(env.HOME, "isolated");
  assert.equal(env.PATH, "path");
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.RENDER_API_KEY, undefined);
  assert.equal(env.PRIVACY_ENCRYPTION_KEY, undefined);
  assert.ok(!JSON.stringify(env).includes("fake-"));
  assert.match(env.NODE_OPTIONS, /max-old-space-size=1024/);
  assert.ok(env.NODE_OPTIONS.includes("braces-build-preload.mjs"));
});

test("pattern guards reject deep, oversized, cyclic and excessive AST inputs before calling the library", () => {
  assert.doesNotThrow(() => guard.validatePattern("src/*.{js,ts}"));
  for (const input of [
    "{".repeat(33) + "a" + "}".repeat(33),
    "a".repeat(1025),
    null,
    1,
  ])
    assert.throws(() => guard.validatePattern(input), /unsafe_build_pattern/);
  const cyclic = { nodes: [] };
  cyclic.nodes.push(cyclic);
  assert.throws(() => guard.validateAst(cyclic), /unsafe_build_pattern/);
  assert.throws(
    () => guard.validateAst({ nodes: new Array(2049).fill({ value: "a" }) }),
    /unsafe_build_pattern/,
  );
  let ast = { value: "a" };
  for (let i = 0; i < 66; i++) ast = { nodes: [ast] };
  assert.throws(() => guard.validateAst(ast), /unsafe_build_pattern/);
  assert.throws(
    () => guard.validateAst({ value: "a".repeat(1025) }),
    /unsafe_build_pattern/,
  );
  assert.throws(() => guard.validateAst({ nodes: 1 }), /unsafe_build_pattern/);
  assert.throws(() => guard.validateAst([]), /unsafe_build_pattern/);
  let calls = 0;
  const wrapped = guard.wrap(() => ++calls, "index");
  assert.throws(() => wrapped(new Array(65).fill("a")), /unsafe_build_pattern/);
  assert.throws(() => wrapped("{".repeat(33)), /unsafe_build_pattern/);
  assert.equal(calls, 0);
  assert.equal(wrapped(["a", "b"]), 1);
  assert.throws(() => guard.wrap(null, "index"), /unsafe_build_pattern/);
});

test("real CommonJS and ESM brace entry points and internal walkers are guarded", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "safe-build-test-"));
  try {
    const script = path.join(directory, "entry.mjs");
    fs.writeFileSync(
      script,
      `import {createRequire} from 'node:module';const r=createRequire(${JSON.stringify(path.join(ROOT, "package.json"))});const b=r('braces');const deep='{'.repeat(33)+'a'+'}'.repeat(33);if(b.expand('{a,b}').join(',')!=='a,b')throw Error('normal behavior changed');for(const fn of [b,b.create,b.compile,b.expand,b.stringify,b.parse]){let rejected=false;try{fn(deep)}catch(e){rejected=e.code==='UNSAFE_BUILD_PATTERN'}if(!rejected)throw Error('unguarded method')}const internal=r('braces/lib/compile');let a={type:'text',value:'a'};for(let i=0;i<66;i++)a={nodes:[a]};try{internal(a);throw Error('unguarded AST')}catch(e){if(e.code!=='UNSAFE_BUILD_PATTERN')throw e}console.log('guarded');`,
    );
    const result = runSafeBuildCommand({
      args: [script],
      cwd: ROOT,
      stdio: "pipe",
    });
    assert.equal(result.stdout.trim(), "guarded");
    assert.ok(fs.existsSync(PRELOAD));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("guarded processes time out and cannot carry parent production credentials", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "safe-build-test-"));
  try {
    const script = path.join(directory, "env.mjs");
    fs.writeFileSync(
      script,
      "console.log(JSON.stringify({secret:process.env.RENDER_API_KEY,profile:process.env.HOME}));",
    );
    const result = runSafeBuildCommand({
      args: [script],
      stdio: "pipe",
      sourceEnv: { PATH: process.env.PATH, RENDER_API_KEY: "fake-live-secret" },
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.secret, undefined);
    assert.equal(fs.existsSync(payload.profile), false);
    fs.writeFileSync(script, "setTimeout(()=>{},30000);");
    assert.throws(
      () =>
        runSafeBuildCommand({ args: [script], stdio: "pipe", timeoutMs: 100 }),
      /build_timeout/,
    );
    fs.writeFileSync(script, "process.exit(1);");
    assert.throws(
      () => runSafeBuildCommand({ args: [script], stdio: "pipe" }),
      /guarded_build_failed/,
    );
    assert.throws(
      () => runSafeBuildCommand({ args: [], timeoutMs: 300001 }),
      /invalid_build_command/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("build inputs and commands remain allowlisted", () => {
  assert.equal(assertBuildInputs(ROOT), true);
  for (const kind of [
    "app",
    "extensions",
    "typegen",
    "function-test",
    "generate",
  ])
    assert.ok(buildCommand(kind, ROOT).args.length > 0);
  assert.throws(() => buildCommand("release", ROOT), /unknown_build_kind/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "safe-build-test-"));
  try {
    fs.mkdirSync(
      path.join(directory, "extensions/marketplace-purchase-control"),
      { recursive: true },
    );
    const file = path.join(
      directory,
      "extensions/marketplace-purchase-control/package.json",
    );
    fs.writeFileSync(
      file,
      JSON.stringify({
        codegen: { schema: "schema.graphql", documents: "src/*.graphql" },
      }),
    );
    assert.equal(assertBuildInputs(directory), true);
    fs.writeFileSync(path.join(directory, ".env.production"), "FAKE=test");
    assert.throws(
      () => assertBuildInputs(directory),
      /build_dotenv_not_allowed/,
    );
    fs.unlinkSync(path.join(directory, ".env.production"));
    fs.writeFileSync(
      file,
      JSON.stringify({
        codegen: { schema: "schema.graphql", documents: "external/*" },
      }),
    );
    assert.throws(
      () => assertBuildInputs(directory),
      /unreviewed_build_patterns/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

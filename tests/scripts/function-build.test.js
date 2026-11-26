import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import crypto from "node:crypto";
import yaml from "js-yaml";
import {
  verifyFunctionBuildConfig,
  verifyFunctionBuildSources,
  stageFinalFunction,
  FUNCTION_BUILD_INPUT,
  inspectFinalFunction,
} from "../../scripts/security/function-build.mjs";
const root = path.resolve(import.meta.dirname, "../.."),
  extension = path.join(root, "extensions/marketplace-purchase-control");
const config = fs.readFileSync(path.join(extension, "shopify.extension.toml"));
test("custom build disables both implicit JavaScript compilation and CLI wasm-opt fallback", () => {
  assert.equal(
    verifyFunctionBuildConfig(config).extensions[0].build.wasm_opt,
    false,
  );
  for (const value of [
    config.toString().replace("wasm_opt = false", "wasm_opt = true"),
    config.toString().replace("wasm_opt = false", ""),
    config
      .toString()
      .replace("node ../../scripts/security/function-build.mjs", ""),
    config.toString().replace("dist/function.wasm", "dist/unreviewed.wasm"),
    config + "\nextra = true\n",
  ])
    assert.throws(
      () => verifyFunctionBuildConfig(Buffer.from(value)),
      /config_changed/,
    );
  assert.equal(FUNCTION_BUILD_INPUT.artifact, 13504146003);
});
function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()),
    dir = fs.mkdtempSync(path.join(parent, "function-build-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(dir)), parent);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
test("source bindings include all source/query/schema/tests/fixtures and reject changes or extras", (t) => {
  const dir = fixture(t);
  fs.cpSync(extension, dir, {
    recursive: true,
    filter: (f) =>
      !/(?:[\\/])(?:node_modules|dist|generated)(?:[\\/]|$)/.test(f),
  });
  const relative = [
    ...fs.readdirSync(path.join(dir, "src")).map((n) => "src/" + n),
    ...fs
      .readdirSync(path.join(dir, "tests/fixtures"))
      .map((n) => "tests/fixtures/" + n),
    "schema.graphql",
    "tests/default.test.js",
  ];
  const candidate = {
    bindings: relative.map((p) => ({
      path: p,
      sha256: crypto
        .createHash("sha256")
        .update(
          fs.readFileSync(path.join(dir, p), "utf8").replaceAll("\r\n", "\n"),
        )
        .digest("hex"),
    })),
  };
  assert.equal(verifyFunctionBuildSources(dir, candidate), relative.length);
  fs.writeFileSync(path.join(dir, "src/extra.js"), "unreviewed");
  assert.throws(
    () => verifyFunctionBuildSources(dir, candidate),
    /inventory_changed/,
  );
  fs.unlinkSync(path.join(dir, "src/extra.js"));
  fs.appendFileSync(path.join(dir, "src/index.js"), "changed");
  assert.throws(
    () => verifyFunctionBuildSources(dir, candidate),
    /source_changed/,
  );
  candidate.bindings[0].path = "../outside";
  assert.throws(
    () => verifyFunctionBuildSources(dir, candidate),
    /bindings_invalid/,
  );
});
test("atomic staging does not follow hardlinked outputs or corrupt previous output on rejection", (t) => {
  const dir = fixture(t),
    bytes = Buffer.from("synthetic verified input");
  stageFinalFunction(dir, bytes);
  assert.deepEqual(
    fs.readFileSync(path.join(dir, "dist/function.wasm")),
    bytes,
  );
  stageFinalFunction(dir, Buffer.from("next"));
  assert.equal(
    fs.readFileSync(path.join(dir, "dist/function.wasm"), "utf8"),
    "next",
  );
  fs.linkSync(path.join(dir, "dist/function.wasm"), path.join(dir, "other"));
  assert.throws(() => stageFinalFunction(dir, bytes), /file_invalid/);
  assert.equal(fs.readFileSync(path.join(dir, "other"), "utf8"), "next");
});

test("an unrelated or edited test receipt is never accepted as a build input", (t) => {
  const dir = fixture(t),
    run = path.join(dir, "function-final-tests/run-synthetic");
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(
    path.join(run, "receipt.json"),
    JSON.stringify({ productionApproved: true }),
  );
  assert.throws(() => inspectFinalFunction(root, dir), /receipt_changed/);
  fs.mkdirSync(path.join(dir, "function-final-tests/run-extra"));
  assert.throws(() => inspectFinalFunction(root, dir), /input_invalid/);
});

test("international proof builds are manual-only and require current incident/admission before any native build", () => {
  const workflow = yaml.load(
    fs.readFileSync(
      path.join(root, ".github/workflows/international-proof-artifact.yml"),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read", actions: "read" });
  const steps = workflow.jobs.artifact.steps,
    runs = steps.map((s) => s.run || "");
  const install = runs.indexOf("npm ci --ignore-scripts --no-audit --no-fund");
  const incident = runs.indexOf("node scripts/security/incident-audit.mjs");
  const admission = runs.findIndex((s) =>
    s.includes("assertProductionBuildAdmission();"),
  );
  const generate = runs.indexOf(
    "node scripts/security/safe-build.mjs generate",
  );
  assert.ok(
    install >= 0 &&
      incident > install &&
      admission > incident &&
      generate > admission,
  );
  assert.ok(runs.indexOf("npm run build:extensions") > generate);
  assert.ok(!runs.includes("npm run build:production"));
  assert.ok(
    !runs.some(
      (s) => s.includes("shopify app release") || s.includes("migrate deploy"),
    ),
  );
});

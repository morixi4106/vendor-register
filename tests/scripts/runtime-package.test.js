import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRuntimePackagePlan,
  activateRuntimeDependencies,
  readRuntimePlan,
} from "../../scripts/security/runtime-package.mjs";
import {
  inspectRuntimeToolchain,
  assertRuntimeToolchain,
} from "../../scripts/security/runtime-toolchain.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
function pkg(root, location, name, version = "1.0.0") {
  const directory = path.join(root, "node_modules", location);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name, version }),
  );
  return directory;
}

test("runtime plan removes workspaces and development tools without changing production pins", () => {
  const plan = readRuntimePlan(ROOT);
  assert.equal(plan.manifest.workspaces, undefined);
  assert.equal(plan.manifest.devDependencies, undefined);
  assert.equal(
    plan.lockfile.packages["extensions/account-home-entry"],
    undefined,
  );
  assert.equal(plan.lockfile.packages["node_modules/braces"], undefined);
  assert.equal(plan.lockfile.packages["node_modules/@shopify/cli"], undefined);
  assert.equal(
    plan.lockfile.packages["node_modules/@prisma/client"].version,
    "6.19.3",
  );
});

test("runtime plan rejects unresolved, linked, extraneous and forbidden production paths", () => {
  const manifest = {
    name: "fixture",
    version: "1.0.0",
    dependencies: { safe: "1.0.0" },
  };
  const original = {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: manifest.dependencies },
      "node_modules/safe": { version: "1.0.0" },
    },
  };
  assert.equal(createRuntimePackagePlan(manifest, original).packageCount, 1);
  const unresolved = structuredClone(original);
  delete unresolved.packages["node_modules/safe"];
  assert.throws(
    () => createRuntimePackagePlan(manifest, unresolved),
    /runtime_graph_unresolved/,
  );
  const bad = structuredClone(original);
  bad.packages["node_modules/safe"].extraneous = true;
  assert.throws(
    () => createRuntimePackagePlan(manifest, bad),
    /unsafe_runtime_package_metadata/,
  );
  const forbidden = structuredClone(original);
  forbidden.packages["node_modules/safe"].name = "braces";
  assert.throws(
    () => createRuntimePackagePlan(manifest, forbidden),
    /runtime_toolchain_not_clean/,
  );
});

test("runtime inspection detects nested targets and aliases, not just declared dependency names", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "runtime-check-test-"),
  );
  try {
    pkg(directory, "safe", "safe");
    assert.equal(assertRuntimeToolchain(directory).ok, true);
    pkg(directory, "safe/node_modules/alias", "braces", "3.0.3");
    pkg(directory, "@graphql-tools/utils", "@graphql-tools/utils", "12.0.3");
    const report = inspectRuntimeToolchain(directory);
    assert.deepEqual(report.forbiddenPackages, [
      "@graphql-tools/utils",
      "braces",
    ]);
    assert.throws(
      () => assertRuntimeToolchain(directory),
      /runtime_toolchain_not_clean/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime activation uses validated paths and preserves original modules on rejected staging", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "runtime-check-test-"),
  );
  try {
    const root = path.join(directory, "root"),
      stage = path.join(directory, "stage");
    fs.mkdirSync(root);
    fs.mkdirSync(stage);
    pkg(root, "braces", "braces", "3.0.3");
    pkg(stage, "safe", "safe");
    assert.throws(
      () => activateRuntimeDependencies(root, stage),
      /runtime_prisma_client_missing/,
    );
    assert.ok(fs.existsSync(path.join(root, "node_modules/braces")));
    fs.mkdirSync(path.join(stage, "node_modules/.prisma/client"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(stage, "node_modules/.prisma/client/index.js"),
      "export {};",
    );
    assert.equal(activateRuntimeDependencies(root, stage).ok, true);
    assert.equal(fs.existsSync(path.join(root, "node_modules/braces")), false);
    assert.ok(fs.existsSync(path.join(root, "node_modules/safe")));
    assert.deepEqual(fs.readdirSync(path.join(root, ".audit")), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime startup rejects outside module lookup paths", () => {
  const previous = process.env.NODE_PATH;
  try {
    process.env.NODE_PATH = "outside";
    assert.throws(
      () => assertRuntimeToolchain(ROOT),
      /runtime_node_path_not_allowed/,
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = previous;
  }
});

test(
  "runtime activation preserves relative executable links",
  { skip: process.platform === "win32" },
  () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "runtime-check-test-"),
    );
    try {
      const root = path.join(directory, "root"),
        stage = path.join(directory, "stage");
      fs.mkdirSync(root);
      fs.mkdirSync(stage);
      const safe = pkg(stage, "safe", "safe");
      fs.writeFileSync(path.join(safe, "index.js"), "export {};");
      fs.mkdirSync(path.join(stage, "node_modules/.bin"));
      fs.symlinkSync(
        "../safe/index.js",
        path.join(stage, "node_modules/.bin/safe"),
      );
      fs.mkdirSync(path.join(stage, "node_modules/.prisma/client"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(stage, "node_modules/.prisma/client/index.js"),
        "export {};",
      );
      activateRuntimeDependencies(root, stage);
      assert.equal(
        fs.readlinkSync(path.join(root, "node_modules/.bin/safe")),
        "../safe/index.js",
      );
      fs.rmSync(stage, { recursive: true, force: true });
      assert.ok(fs.existsSync(path.join(root, "node_modules/.bin/safe")));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

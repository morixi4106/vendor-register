import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRuntimePackagePlan,
  activateRuntimeDependencies,
  readRuntimePlan,
  assertRuntimeNativeArtifacts,
  prepareRuntimePackage,
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

const digest = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const clientEngine =
  process.platform === "win32"
    ? ".prisma/client/query_engine-windows.dll.node"
    : ".prisma/client/libquery_engine-debian-openssl-3.0.x.so.node";
const schemaEngine =
  process.platform === "win32"
    ? "@prisma/engines/schema-engine-windows.exe"
    : "@prisma/engines/schema-engine-debian-openssl-3.0.x";

function approvedNative(root, stage, generated = true) {
  pkg(stage, "@prisma/engines", "@prisma/engines", "6.19.3");
  const bytes = Buffer.concat([
    Buffer.from(process.platform === "win32" ? "4d5a" : "7f454c46", "hex"),
    Buffer.from("synthetic-test-fixture-not-executable"),
  ]);
  for (const relative of [schemaEngine, ...(generated ? [clientEngine] : [])]) {
    const file = path.join(stage, "node_modules", relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  const sourceCommit = "c".repeat(40);
  const sbom = JSON.stringify({
    bomFormat: "CycloneDX",
    components: [{ type: "library", name: "synthetic-test-fixture" }],
    metadata: {
      component: {
        hashes: [{ alg: "SHA-256", content: digest(bytes) }],
        externalReferences: [
          {
            type: "vcs",
            url: `https://github.com/example/fixture/commit/${sourceCommit}`,
          },
        ],
      },
    },
  });
  const security = path.join(root, "security");
  fs.mkdirSync(path.join(security, "native-sbom"), { recursive: true });
  fs.writeFileSync(path.join(security, "native-sbom/fixture.json"), sbom);
  const policy = {
    schemaVersion: 1,
    incident: "2026-10-runtime",
    approvedArtifacts: [
      {
        sha256: digest(bytes),
        platform: process.platform,
        arch: process.arch,
        sourceCommit,
        sbom: "security/native-sbom/fixture.json",
        sbomSha256: digest(sbom),
      },
    ],
  };
  fs.writeFileSync(
    path.join(security, "native-artifacts.json"),
    JSON.stringify(policy),
  );
  return { bytes, policy };
}

function temporaryRoot(t) {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "runtime-native-test-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function generationFixture(t) {
  const root = temporaryRoot(t);
  const manifest = {
    name: "runtime-native-fixture",
    version: "1.0.0",
    dependencies: { safe: "1.0.0" },
  };
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: manifest.dependencies },
      "node_modules/safe": { version: "1.0.0" },
    },
  };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
  fs.cpSync(
    path.join(ROOT, "vendor/deepmerge"),
    path.join(root, "vendor/deepmerge"),
    { recursive: true },
  );
  fs.mkdirSync(path.join(root, "prisma"));
  fs.writeFileSync(
    path.join(root, "prisma/schema.prisma"),
    "synthetic-not-executed",
  );
  const previous = process.env.npm_execpath;
  process.env.npm_execpath = process.execPath;
  t.after(() => {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
  });
  return root;
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
  for (const tool of ["vite", "vite-tsconfig-paths", "esbuild", "rollup"])
    assert.equal(plan.lockfile.packages[`node_modules/${tool}`], undefined);
  assert.equal(
    plan.lockfile.packages["node_modules/@prisma/client"].version,
    "6.19.3",
  );
});

test("the scoped minimatch backport cannot enter a runtime under a different folder name", (t) => {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "runtime-backport-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  pkg(root, "disguised-helper", "@oja/minimatch", "9.0.9-oja.1");
  const result = inspectRuntimeToolchain(root, { checkAncestors: false });
  assert.equal(result.ok, false);
  assert.deepEqual(result.forbiddenPackages, ["@oja/minimatch"]);
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
    approvedNative(root, stage);
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

test("runtime rejects build-only bundlers even when installed under aliases", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-bundler-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const tool of ["vite", "vite-tsconfig-paths", "esbuild", "rollup"])
    pkg(root, `alias-${tool}`, tool);
  assert.deepEqual(inspectRuntimeToolchain(root).forbiddenPackages, [
    "esbuild",
    "rollup",
    "vite",
    "vite-tsconfig-paths",
  ]);
});

test("partial copy failure cleans staged modules without removing original modules", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "runtime-check-test-"),
  );
  const originalCopy = fs.cpSync;
  try {
    const root = path.join(directory, "root"),
      stage = path.join(directory, "stage");
    fs.mkdirSync(root);
    fs.mkdirSync(stage);
    pkg(root, "original", "original");
    pkg(stage, "safe", "safe");
    fs.mkdirSync(path.join(stage, "node_modules/.prisma/client"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(stage, "node_modules/.prisma/client/index.js"),
      "export {};",
    );
    approvedNative(root, stage);
    fs.cpSync = (_source, destination) => {
      fs.mkdirSync(destination);
      fs.writeFileSync(path.join(destination, "partial"), "partial");
      throw new Error("copy failed");
    };
    assert.throws(
      () => activateRuntimeDependencies(root, stage),
      /copy failed/,
    );
    assert.ok(fs.existsSync(path.join(root, "node_modules/original")));
    assert.deepEqual(fs.readdirSync(path.join(root, ".audit")), []);
  } finally {
    fs.cpSync = originalCopy;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed final runtime check restores the original modules", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "runtime-check-test-"),
  );
  try {
    const parent = path.join(directory, "parent"),
      root = path.join(parent, "root"),
      stage = path.join(directory, "stage");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(stage);
    pkg(root, "original", "original");
    pkg(parent, "braces", "braces", "3.0.3");
    pkg(stage, "safe", "safe");
    fs.mkdirSync(path.join(stage, "node_modules/.prisma/client"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(stage, "node_modules/.prisma/client/index.js"),
      "export {};",
    );
    approvedNative(root, stage);
    assert.throws(
      () => activateRuntimeDependencies(root, stage),
      /runtime_toolchain_not_clean/,
    );
    assert.ok(fs.existsSync(path.join(root, "node_modules/original")));
    assert.equal(fs.existsSync(path.join(root, "node_modules/safe")), false);
    assert.deepEqual(fs.readdirSync(path.join(root, ".audit")), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
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
      approvedNative(root, stage);
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

test("runtime native admission requires both generated client and schema engine with unchanged SBOM", (t) => {
  const root = temporaryRoot(t);
  approvedNative(root, root, false);
  assert.throws(
    () => assertRuntimeNativeArtifacts(root),
    /runtime_native_artifacts_unreviewed/,
  );
  approvedNative(root, root);
  const evidence = assertRuntimeNativeArtifacts(root);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.artifactCount, 2);
  assert.equal(evidence.artifacts.length, 2);
  fs.appendFileSync(path.join(root, "security/native-sbom/fixture.json"), " ");
  assert.throws(
    () => assertRuntimeNativeArtifacts(root),
    /native_sbom_digest_mismatch/,
  );
});

test("unreviewed native staging is rejected before the original modules are touched", (t) => {
  const root = temporaryRoot(t),
    stage = temporaryRoot(t);
  pkg(root, "original", "original");
  pkg(stage, ".prisma/client", "generated-client");
  fs.writeFileSync(
    path.join(stage, "node_modules/.prisma/client/index.js"),
    "export {};",
  );
  const { policy } = approvedNative(root, stage);
  policy.approvedArtifacts = [];
  fs.writeFileSync(
    path.join(root, "security/native-artifacts.json"),
    JSON.stringify(policy),
  );
  assert.throws(
    () => activateRuntimeDependencies(root, stage),
    /runtime_native_artifacts_unreviewed/,
  );
  assert.ok(fs.existsSync(path.join(root, "node_modules/original")));
  assert.equal(fs.existsSync(path.join(root, ".audit")), false);
});

test("runtime native policy cannot be absent, malformed, or hard-linked", (t) => {
  const root = temporaryRoot(t);
  assert.throws(() => assertRuntimeNativeArtifacts(root), /ENOENT/);
  approvedNative(root, root);
  const policy = path.join(root, "security/native-artifacts.json");
  fs.writeFileSync(policy, "{}");
  assert.throws(
    () => assertRuntimeNativeArtifacts(root),
    /native_policy_invalid/,
  );
  approvedNative(root, root);
  fs.linkSync(policy, path.join(root, "linked-policy.json"));
  assert.throws(
    () => assertRuntimeNativeArtifacts(root),
    /runtime_native_policy_invalid/,
  );
});

test("runtime native policy cannot resolve through an out-of-root directory junction", (t) => {
  const root = temporaryRoot(t),
    outside = temporaryRoot(t);
  approvedNative(outside, root);
  fs.symlinkSync(
    path.join(outside, "security"),
    path.join(root, "security"),
    "junction",
  );
  assert.throws(
    () => assertRuntimeNativeArtifacts(root),
    /runtime_native_policy_invalid/,
  );
});

for (const mutation of [
  "changed-bytes",
  "extra-approved-binary",
  "changed-policy",
]) {
  test(`runtime activation rolls back after copying ${mutation}`, (t) => {
    const root = temporaryRoot(t),
      stage = temporaryRoot(t);
    pkg(root, "original", "original");
    pkg(stage, "safe", "safe");
    fs.mkdirSync(path.join(stage, "node_modules/.prisma/client"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(stage, "node_modules/.prisma/client/index.js"),
      "export {};",
    );
    const { bytes } = approvedNative(root, stage);
    const originalCopy = fs.cpSync;
    fs.cpSync = (source, destination, options) => {
      originalCopy(source, destination, options);
      if (mutation === "changed-bytes")
        fs.appendFileSync(path.join(destination, clientEngine), "changed");
      else if (mutation === "extra-approved-binary")
        fs.writeFileSync(path.join(destination, "extra.node"), bytes);
      else
        fs.appendFileSync(
          path.join(root, "security/native-artifacts.json"),
          " ",
        );
    };
    try {
      assert.throws(
        () => activateRuntimeDependencies(root, stage),
        mutation === "changed-bytes"
          ? /runtime_native_artifacts_unreviewed/
          : /runtime_native_inventory_changed/,
      );
    } finally {
      fs.cpSync = originalCopy;
    }
    assert.ok(fs.existsSync(path.join(root, "node_modules/original")));
    assert.equal(fs.existsSync(path.join(root, "node_modules/safe")), false);
    assert.deepEqual(fs.readdirSync(path.join(root, ".audit")), []);
  });
}

test("fresh unreviewed install cannot execute a generator or leave stale success evidence", (t) => {
  const root = generationFixture(t),
    commands = [];
  let stage;
  fs.mkdirSync(path.join(root, ".audit"));
  const output = path.join(root, ".audit/runtime-package-evidence.json");
  fs.writeFileSync(output, JSON.stringify({ ok: true, stale: true }));
  assert.throws(
    () =>
      prepareRuntimePackage({
        root,
        runCommand(command) {
          commands.push(command.args);
          stage = command.cwd;
          pkg(stage, "safe", "safe");
          approvedNative(root, stage, false);
          fs.writeFileSync(
            path.join(stage, "node_modules/safe/unapproved.wasm"),
            Buffer.from("0061736d01000000", "hex"),
          );
        },
      }),
    /runtime_native_artifacts_unreviewed/,
  );
  assert.equal(commands.length, 1);
  assert.ok(commands[0].includes("--ignore-scripts"));
  assert.equal(fs.existsSync(stage), false);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(path.join(root, "node_modules")), false);
});

test("generated engine bytes are checked before registry audit or success evidence", (t) => {
  const root = generationFixture(t),
    commands = [];
  let stage;
  assert.throws(
    () =>
      prepareRuntimePackage({
        root,
        runCommand(command) {
          commands.push(command.args);
          stage = command.cwd;
          if (commands.length === 1) {
            pkg(stage, "safe", "safe");
            approvedNative(root, stage, false);
          } else {
            approvedNative(root, stage);
            fs.appendFileSync(
              path.join(stage, "node_modules", clientEngine),
              "changed",
            );
          }
        },
      }),
    /runtime_native_artifacts_unreviewed/,
  );
  assert.equal(commands.length, 2);
  assert.ok(commands[1].includes("generate"));
  assert.equal(fs.existsSync(stage), false);
  assert.equal(
    fs.existsSync(path.join(root, ".audit/runtime-package-evidence.json")),
    false,
  );
});

test("runtime package evidence includes exact native inventory and policy without activation", (t) => {
  const root = generationFixture(t);
  let count = 0,
    stage;
  const evidence = prepareRuntimePackage({
    root,
    runCommand(command) {
      stage = command.cwd;
      count++;
      if (count === 1) {
        pkg(stage, "safe", "safe");
        approvedNative(root, stage, false);
      } else if (count === 2) approvedNative(root, stage);
      else return { stdout: JSON.stringify({ vulnerabilities: {} }) };
    },
  });
  assert.equal(count, 3);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.native.artifactCount, 2);
  assert.equal(evidence.native.policySha256.length, 64);
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(
        path.join(root, ".audit/runtime-package-evidence.json"),
        "utf8",
      ),
    ),
    evidence,
  );
  assert.equal(fs.existsSync(stage), false);
  assert.equal(fs.existsSync(path.join(root, "node_modules")), false);
});

for (const phase of ["generate", "audit"]) {
  test(`runtime rejects policy drift during ${phase} even when all binary bytes stay approved`, (t) => {
    const root = generationFixture(t);
    let count = 0;
    assert.throws(
      () =>
        prepareRuntimePackage({
          root,
          runCommand(command) {
            count++;
            if (count === 1) {
              pkg(command.cwd, "safe", "safe");
              approvedNative(root, command.cwd, false);
            } else if (count === 2) approvedNative(root, command.cwd);
            if (count === (phase === "generate" ? 2 : 3))
              fs.appendFileSync(
                path.join(root, "security/native-artifacts.json"),
                " ",
              );
            return { stdout: JSON.stringify({ vulnerabilities: {} }) };
          },
        }),
      /runtime_native_inventory_changed/,
    );
    assert.equal(count, phase === "generate" ? 2 : 3);
    assert.equal(
      fs.existsSync(path.join(root, ".audit/runtime-package-evidence.json")),
      false,
    );
  });
}

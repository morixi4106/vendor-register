import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { runSafeBuildCommand } from "../../scripts/security/safe-build.mjs";
import {
  readMinimatchPolicy,
  verifyMinimatchDirectory,
  verifyInstalledMinimatch,
  checkMinimatchUpstream,
} from "../../scripts/security/minimatch-backport.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SOURCE = path.join(ROOT, "vendor/minimatch");
const require = createRequire(import.meta.url);
const commonjs = require("../../vendor/minimatch/dist/commonjs/index.js");
const esm = await import("../../vendor/minimatch/dist/esm/index.js");
const policy = readMinimatchPolicy(ROOT);
const fixture = (t) => {
  const base = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(base, "minimatch-test-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(dir)), base);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
};

test("actual installed consumers resolve one hash-bound backport, not the original alias", () => {
  const result = verifyInstalledMinimatch(ROOT);
  assert.equal(result.packageName, "@oja/minimatch");
  assert.equal(result.version, "9.0.9-oja.1");
  for (const name of [
    "node_modules/@eslint/eslintrc",
    "node_modules/@react-router/fs-routes",
    "node_modules/graphql-config",
  ])
    assert.ok(result.consumers.includes(name));
  assert.equal(result.verifiedFiles, 30);
  const imported = require("minimatch");
  assert.equal(typeof imported.makeRe, "function");
  assert.equal(require("minimatch/package.json").name, "@oja/minimatch");
});

test("both module systems retain v9 exports and ordinary matching semantics", () => {
  for (const module of [commonjs, esm]) {
    for (const name of [
      "minimatch",
      "makeRe",
      "Minimatch",
      "AST",
      "braceExpand",
      "filter",
      "match",
      "escape",
      "unescape",
      "defaults",
    ])
      assert.equal(typeof module[name], "function", name);
    for (const [file, pattern, options, expected] of [
      ["routes/a.tsx", "routes/**/*.tsx", {}, true],
      ["routes/a.test.tsx", "**/*.test.tsx", {}, true],
      ["routes/.hidden.tsx", "**/*.tsx", {}, false],
      ["routes/.hidden.tsx", "**/*.tsx", { dot: true }, true],
      ["a.TSX", "*.tsx", { nocase: true }, true],
      ["a.js", "*.{js,ts}", {}, true],
      ["a.ts", "*.{js,ts}", {}, true],
      ["a.css", "*.{js,ts}", {}, false],
      ["a.test.js", "!*.test.js", {}, false],
      ["a.js", "!*.test.js", {}, true],
      ["a.jsx", "*.@(js|jsx)", {}, true],
      ["a.txt", "*.@(js|jsx)", {}, false],
    ])
      for (const optimizationLevel of [0, 1, 2])
        assert.equal(
          module.minimatch(file, pattern, { ...options, optimizationLevel }),
          expected,
        );
    assert.equal(module.makeRe("**/*.tsx").test("routes/index.tsx"), true);
    assert.equal(
      new module.Minimatch("**/*.js").makeRe().test("app/index.js"),
      true,
    );
    assert.deepEqual(module.braceExpand("a{b,c}"), ["ab", "ac"]);
    assert.deepEqual(module.match(["a.js", "b.css"], "*.js"), ["a.js"]);
    assert.equal(module.defaults({ nocase: true })("A.JS", "a.js"), true);
  }
});

test("ordinary globstar parent transforms agree across module systems", () => {
  for (const pattern of [
    "a/**/../b/c",
    "**/a/**/b",
    "a/./b/../c",
    "a/**/**/b",
  ]) {
    for (const file of ["a/b/c", "a/c", "a/b", "a/x/b/c", "b/c", "a/x/y/b"]) {
      assert.equal(
        new commonjs.Minimatch(pattern, { optimizationLevel: 2 }).match(file),
        new esm.Minimatch(pattern, { optimizationLevel: 2 }).match(file),
      );
    }
  }
});

test("hostile preprocessing is bounded in a credential-free memory-limited child", () => {
  for (const mode of ["commonjs", "esm"]) {
    const result = runSafeBuildCommand({
      args: [
        "--max-old-space-size=128",
        path.join(ROOT, "tests/fixtures/minimatch/preprocess.mjs"),
        mode,
      ],
      cwd: ROOT,
      stdio: "pipe",
      timeoutMs: 15000,
    });
    assert.deepEqual(JSON.parse(result.stdout), {
      limitRejected: true,
      largeSetPreserved: true,
    });
  }
});

test("ESM preprocessing has the same bound and preserves large input sets", () => {
  const matcher = new esm.Minimatch("**/a", { optimizationLevel: 2 });
  assert.ok(matcher.set.length <= 1000);
  const patterns = Array.from({ length: 1001 }, (_, i) => ["unique" + i]);
  matcher.partsMatch = () => {
    throw new Error("quadratic_comparison");
  };
  assert.equal(matcher.secondPhasePreProcess(patterns), patterns);
});

test("modified files, manifests, provenance, paths and hardlinks are rejected", (t) => {
  const root = fixture(t);
  const target = path.join(root, "copy");
  fs.cpSync(SOURCE, target, { recursive: true });
  for (const name of [
    "dist/commonjs/index.js",
    "dist/esm/index.js",
    "package.json",
    "provenance.json",
    "LICENSE",
  ]) {
    const file = path.join(target, name),
      bytes = fs.readFileSync(file);
    fs.appendFileSync(file, "\n");
    assert.throws(
      () => verifyMinimatchDirectory(target, policy),
      /minimatch_backport_digest_mismatch/,
    );
    fs.writeFileSync(file, bytes);
  }
  const changed = structuredClone(policy);
  changed.files[0].path = "../escape";
  assert.throws(
    () => verifyMinimatchDirectory(target, changed),
    /minimatch_backport_path_invalid/,
  );
  fs.linkSync(path.join(target, "LICENSE"), path.join(target, "LICENSE-link"));
  assert.throws(
    () => verifyMinimatchDirectory(target, policy),
    /minimatch_backport_file_invalid/,
  );
});

test("root policy cannot replace the original identity, revision or file inventory", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "security"));
  for (const change of [
    (p) => {
      p.upstream.commit = "0".repeat(40);
    },
    (p) => {
      p.packageName = "minimatch";
    },
    (p) => {
      p.files.pop();
    },
    (p) => {
      p.files[1] = p.files[0];
    },
    (p) => {
      p.tarball.path = "../archive.tgz";
    },
  ]) {
    const changed = structuredClone(policy);
    change(changed);
    fs.writeFileSync(
      path.join(root, "security/minimatch-backport.json"),
      JSON.stringify(changed),
    );
    assert.throws(
      () => readMinimatchPolicy(root),
      /minimatch_backport_policy_invalid/,
    );
  }
});

const response = (value) =>
  new Response(JSON.stringify(value), { status: 200 });
test("the original upstream identity is freshly queried, not hidden by the scoped name", async () => {
  const result = await checkMinimatchUpstream(policy, {
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.osv.dev/v1/query");
      assert.equal(options.redirect, "error");
      assert.deepEqual(JSON.parse(options.body), {
        package: { ecosystem: "npm", name: "minimatch" },
        version: "9.0.9",
      });
      return response({
        vulns: [
          { id: policy.advisory, modified: "2026-10-30T23:15:07.420159385Z" },
        ],
      });
    },
  });
  assert.deepEqual(result.coveredByVerifiedBackport, [policy.advisory]);
});

test("unknown or changed advisories, unavailable and malformed upstream checks fail closed", async () => {
  for (const [value, error] of [
    [{ vulns: [{ id: "GHSA-new-unknown" }] }, /advisory_unresolved/],
    [
      { vulns: [{ id: policy.advisory, modified: "2026-11-04T00:00:00Z" }] },
      /advisory_changed/,
    ],
    [{ vulns: null }, /audit_invalid/],
    [{ error: "unavailable" }, /audit_invalid/],
    [[], /audit_invalid/],
  ])
    await assert.rejects(
      checkMinimatchUpstream(policy, {
        fetchImpl: async () => response(value),
      }),
      error,
    );
  await assert.rejects(
    checkMinimatchUpstream(policy, {
      fetchImpl: async () => new Response("down", { status: 503 }),
    }),
    /audit_unavailable/,
  );
  await assert.rejects(
    checkMinimatchUpstream(policy, {
      fetchImpl: async () => new Response("x".repeat(1024 * 1024 + 1)),
    }),
    /audit_invalid/,
  );
  assert.deepEqual(
    (
      await checkMinimatchUpstream(policy, {
        fetchImpl: async () => response({}),
      })
    ).observedAdvisories,
    [],
  );
});

test("ESLint file overrides still use the backported matcher", async () => {
  const { ESLint } = require("eslint");
  const eslint = new ESLint({
    useEslintrc: false,
    baseConfig: {
      overrides: [
        {
          files: ["**/*.js"],
          excludedFiles: ["**/ignored/**"],
          rules: { "no-undef": "error" },
        },
      ],
    },
  });
  const [included] = await eslint.lintText("unknownName();", {
    filePath: "app/minimatch-probe.js",
  });
  assert.equal(included.errorCount, 1);
  const [excluded] = await eslint.lintText("unknownName();", {
    filePath: "app/ignored/minimatch-probe.js",
  });
  assert.equal(excluded.errorCount, 0);
});

test("GraphQL project document matching retains include/exclude behavior", async (t) => {
  const root = fixture(t);
  const { loadConfig } = require("graphql-config");
  const filepath = path.join(root, "graphql.config.json");
  fs.writeFileSync(
    filepath,
    JSON.stringify({
      schema: "schema.graphql",
      documents: ["queries/**/*.graphql"],
      include: ["queries/**"],
      exclude: ["queries/ignored/**"],
    }),
  );
  const config = await loadConfig({ filepath, rootDir: root });
  assert.equal(
    config.getDefault().match(path.join(root, "queries/cart.graphql")),
    true,
  );
  assert.equal(
    config.getDefault().match(path.join(root, "other/cart.js")),
    false,
  );
  assert.equal(
    config.getDefault().match(path.join(root, "queries/ignored/cart.js")),
    false,
  );
});

test("React Router ignored-route matching retains makeRe compatibility", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "routes"));
  for (const name of [
    "root.tsx",
    "routes/_index.tsx",
    "routes/products.$id.tsx",
    "routes/ignored.test.tsx",
    "routes/.hidden.tsx",
  ])
    fs.writeFileSync(
      path.join(root, name),
      "export default function Route() { return null; }\n",
    );
  const old = globalThis.__reactRouterAppDirectory;
  globalThis.__reactRouterAppDirectory = root;
  try {
    const { flatRoutes } = require("@react-router/fs-routes");
    const result = await flatRoutes({ ignoredRouteFiles: ["**/*.test.tsx"] });
    assert.equal(result.length, 2);
    assert.ok(result.some((route) => route.index === true));
    assert.ok(result.some((route) => route.path === "products/:id"));
    assert.equal(
      result.some(
        (route) =>
          route.file.includes("ignored") || route.file.includes("hidden"),
      ),
      false,
    );
  } finally {
    if (old === undefined) delete globalThis.__reactRouterAppDirectory;
    else globalThis.__reactRouterAppDirectory = old;
  }
});

test("installed verification rejects archive replacement, hidden lock copies and detached consumers", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "security"));
  fs.writeFileSync(
    path.join(root, "security/minimatch-backport.json"),
    JSON.stringify(policy),
  );
  fs.cpSync(SOURCE, path.join(root, "vendor/minimatch"), { recursive: true });
  fs.cpSync(SOURCE, path.join(root, "node_modules/minimatch"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, "node_modules/tool"));
  fs.writeFileSync(path.join(root, "node_modules/tool/package.json"), "{}");
  const lock = {
    packages: {
      "node_modules/minimatch": {
        name: policy.packageName,
        version: policy.version,
        resolved: `file:${policy.tarball.path}`,
      },
      "node_modules/tool": { dependencies: { minimatch: "*" } },
    },
  };
  const write = () =>
    fs.writeFileSync(
      path.join(root, "package-lock.json"),
      JSON.stringify(lock),
    );
  write();
  assert.equal(verifyInstalledMinimatch(root).consumers.length, 1);
  const archive = path.join(root, policy.tarball.path),
    bytes = fs.readFileSync(archive);
  fs.appendFileSync(archive, "tamper");
  assert.throws(() => verifyInstalledMinimatch(root), /archive_mismatch/);
  fs.writeFileSync(archive, bytes);
  lock.packages["node_modules/hidden/node_modules/minimatch"] = {
    name: "minimatch",
    version: "9.0.9",
  };
  write();
  assert.throws(() => verifyInstalledMinimatch(root), /lock_mismatch/);
  delete lock.packages["node_modules/hidden/node_modules/minimatch"];
  write();
  fs.cpSync(
    SOURCE,
    path.join(root, "node_modules/tool/node_modules/minimatch"),
    { recursive: true },
  );
  assert.throws(() => verifyInstalledMinimatch(root), /consumer_mismatch/);
});

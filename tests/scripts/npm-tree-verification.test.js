import assert from "node:assert/strict";
import test from "node:test";

import {
  collectNpmTreeEvidence,
  runNpmJsonCommand,
  verifyNpmTreeEvidence,
} from "../../scripts/security/npm-tree-verification.mjs";

function fixture() {
  const lockfile = {
    lockfileVersion: 3,
    name: "fixture",
    packages: {
      "": {
        dependencies: {
          app: "1.0.0",
        },
        name: "fixture",
        version: "0.0.0",
      },
      "node_modules/app": {
        dependencies: {},
        name: "app",
        version: "1.0.0",
      },
      "node_modules/brace-expansion": {
        dependencies: {},
        name: "brace-expansion",
        version: "2.1.2",
      },
      "node_modules/minimatch": {
        dependencies: {
          "brace-expansion": "^2.0.2",
        },
        dev: true,
        name: "minimatch",
        version: "9.0.9",
      },
    },
    version: "0.0.0",
  };
  const queryBrace = [
    {
      from: ["node_modules/minimatch"],
      location: "node_modules/brace-expansion",
      name: "brace-expansion",
      to: [],
      version: "2.1.2",
    },
  ];
  const queryMinimatch = [
    {
      from: ["node_modules/tool"],
      location: "node_modules/minimatch",
      name: "minimatch",
      to: ["node_modules/brace-expansion"],
      version: "9.0.9",
    },
  ];
  return {
    explainBrace: queryBrace,
    explainMinimatch: queryMinimatch,
    lockfile,
    lsTree: {
      dependencies: {
        tool: {
          dependencies: {
            minimatch: {
              dependencies: {
                "brace-expansion": {
                  version: "2.1.2",
                },
              },
              version: "9.0.9",
            },
          },
        },
      },
    },
    queryBrace,
    queryMinimatch,
    sbom: {
      components: [{ name: "app", version: "1.0.0" }],
      metadata: {
        component: {
          name: "fixture",
          version: "0.0.0",
        },
      },
    },
  };
}

test("accepts npm query, explain, ls, SBOM, and lockfile agreement", () => {
  const result = verifyNpmTreeEvidence(fixture());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.rootRuntimeToolchainCount, 0);
});

test("reports all independent evidence mismatches together", () => {
  const input = fixture();
  input.queryBrace = [];
  input.explainMinimatch[0].version = "9.0.8";
  input.lsTree.dependencies.tool.dependencies.minimatch.version = "9.0.8";
  input.sbom.components.push({
    name: "minimatch",
    version: "9.0.9",
  });
  input.sbom.metadata.component.version = "wrong";

  const result = verifyNpmTreeEvidence(input);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.includes("brace-expansion:npm_query_physical_count_mismatch"),
  );
  assert.ok(result.errors.includes("minimatch:npm_explain_node_mismatch"));
  assert.ok(result.errors.includes("minimatch:npm_ls_version_mismatch"));
  assert.ok(
    result.errors.includes("toolchain_target_present_in_production_sbom"),
  );
  assert.ok(result.errors.includes("production_sbom_root_mismatch"));
});

test("reports lockfile, query, relationship, runtime, and scoped SBOM mismatches", () => {
  const input = fixture();
  input.lockfile.packages["node_modules/brace-expansion"].version = "2.1.1";
  input.lockfile.packages["node_modules/duplicate/node_modules/minimatch"] = {
    name: "minimatch",
    version: "9.0.9",
  };
  input.lockfile.packages[""].dependencies.minimatch = "9.0.9";
  input.queryBrace[0] = {
    from: [],
    location: "node_modules/wrong-brace-expansion",
    name: "wrong-name",
    to: [],
    version: "2.1.1",
  };
  input.queryMinimatch = null;
  input.explainBrace = [];
  input.explainMinimatch = [];
  input.lsTree = {};
  input.sbom.components = [
    {
      group: "@scope",
      name: "unrelated",
      version: "1.0.0",
    },
    {
      name: "brace-expansion",
      version: "2.1.2",
    },
  ];

  const result = verifyNpmTreeEvidence(input);
  assert.equal(result.ok, false);
  for (const code of [
    "brace-expansion:lock_version_mismatch",
    "brace-expansion:npm_query_node_mismatch",
    "brace-expansion:npm_explain_node_mismatch",
    "minimatch:lock_physical_count_mismatch",
    "minimatch:brace_child_missing",
    "brace-expansion:minimatch_parent_missing",
    "brace-expansion:npm_ls_version_mismatch",
    "minimatch:npm_ls_version_mismatch",
    "minimatch:root_runtime_reachable",
    "toolchain_target_present_in_production_sbom",
  ]) {
    assert.ok(result.errors.includes(code), code);
  }
});

test("rejects invalid npm evidence limits", () => {
  assert.throws(
    () =>
      runNpmJsonCommand(["query", "#minimatch"], {
        cwd: ".",
        description: "fixture",
        limits: {
          maxBufferBytes: 0,
        },
        spawn() {
          throw new Error("spawn must not run");
        },
      }),
    /limit maxBufferBytes is invalid/,
  );
});

test("fails closed for oversized and invalid npm JSON output", () => {
  const spawn = () => ({
    error: null,
    status: 0,
    stderr: "",
    stdout: '{"large":"123456789"}',
  });
  assert.throws(
    () =>
      runNpmJsonCommand(["query", "#minimatch"], {
        cwd: ".",
        description: "fixture",
        limits: {
          maxJsonBytes: 8,
        },
        spawn,
      }),
    /size limit/,
  );
  assert.throws(
    () =>
      runNpmJsonCommand(["query", "#minimatch"], {
        cwd: ".",
        description: "fixture",
        spawn: () => ({
          error: null,
          status: 0,
          stderr: "",
          stdout: "not-json",
        }),
      }),
    /invalid JSON/,
  );
});

test("fails closed when an npm command fails or times out", () => {
  assert.throws(
    () =>
      runNpmJsonCommand(["query", "#minimatch"], {
        cwd: ".",
        description: "fixture",
        spawn: () => ({
          error: null,
          status: 1,
          stderr: "failure",
          stdout: "",
        }),
      }),
    /exit code 1/,
  );
  assert.throws(
    () =>
      runNpmJsonCommand(["query", "#minimatch"], {
        cwd: ".",
        description: "fixture",
        spawn: () => ({
          error: new Error("timed out"),
        }),
      }),
    /could not start/,
  );
});

test("collects all npm evidence before comparing it", () => {
  const data = fixture();
  const outputs = new Map([
    ["explain brace-expansion --json", data.explainBrace],
    ["explain minimatch --json", data.explainMinimatch],
    ["ls minimatch brace-expansion --all --json", data.lsTree],
    ["query #brace-expansion", data.queryBrace],
    ["query #minimatch", data.queryMinimatch],
    ["sbom --omit=dev --sbom-format cyclonedx", data.sbom],
  ]);
  const seen = [];
  const result = collectNpmTreeEvidence({
    cwd: ".",
    lockfile: data.lockfile,
    run(args) {
      const key = args.join(" ");
      seen.push(key);
      return structuredClone(outputs.get(key));
    },
  });

  assert.equal(result.ok, true);
  assert.equal(seen.length, 6);
});

test("handles absent optional npm evidence without throwing", () => {
  const input = fixture();
  input.queryBrace = [null];
  input.queryMinimatch = undefined;
  input.explainBrace = undefined;
  input.explainMinimatch = [null];
  input.lsTree = null;
  input.sbom = null;
  delete input.lockfile.name;
  delete input.lockfile.version;

  const result = verifyNpmTreeEvidence(input);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("brace-expansion:npm_query_node_mismatch"));
  assert.ok(
    result.errors.includes("minimatch:npm_query_physical_count_mismatch"),
  );
  assert.ok(result.errors.includes("production_sbom_root_mismatch"));
});

test("uses the platform npm executable when npm_execpath is absent", () => {
  const originalNpmExecPath = process.env.npm_execpath;
  try {
    delete process.env.npm_execpath;
    let observedCommand = null;
    let observedArgs = null;
    const result = runNpmJsonCommand(["query", "#minimatch"], {
      cwd: ".",
      description: "fixture",
      spawn(command, args) {
        observedCommand = command;
        observedArgs = args;
        return {
          error: null,
          status: 0,
          stdout: "[]",
        };
      },
    });
    assert.deepEqual(result, []);
    assert.equal(
      observedCommand,
      process.platform === "win32" ? "npm.cmd" : "npm",
    );
    assert.deepEqual(observedArgs, ["query", "#minimatch"]);
  } finally {
    if (originalNpmExecPath === undefined) {
      delete process.env.npm_execpath;
    } else {
      process.env.npm_execpath = originalNpmExecPath;
    }
  }
});

test("rejects empty successful npm output as invalid JSON", () => {
  assert.throws(
    () =>
      runNpmJsonCommand(["query", "#minimatch"], {
        cwd: ".",
        description: "fixture",
        spawn: () => ({
          error: null,
          status: 0,
          stdout: undefined,
        }),
      }),
    /invalid JSON/u,
  );
});

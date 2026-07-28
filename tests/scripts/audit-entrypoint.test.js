import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  evaluateProductionAuditReport,
  loadRiskDefinition,
  readJson,
} from "../../scripts/audit-production-dependencies.mjs";
import {
  cleanAuditArtifacts,
  listGitTrackedFiles,
  resolveCleanupTarget,
} from "../../scripts/security/clean-audit-artifacts.mjs";

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "audit-entrypoint-"));
}

test("readJson accepts bounded regular JSON and rejects unsafe inputs", () => {
  const directory = temporaryDirectory();
  try {
    const valid = path.join(directory, "valid.json");
    const empty = path.join(directory, "empty.json");
    const invalid = path.join(directory, "invalid.json");
    const large = path.join(directory, "large.json");
    const notAFile = path.join(directory, "directory.json");
    fs.writeFileSync(valid, '{"ok":true}');
    fs.writeFileSync(empty, "");
    fs.writeFileSync(invalid, "{");
    fs.writeFileSync(large, '{"large":"123456789"}');
    fs.mkdirSync(notAFile);

    assert.deepEqual(readJson(valid, "fixture", { maxBytes: 1024 }), {
      ok: true,
    });
    assert.throws(
      () => readJson(empty, "fixture", { maxBytes: 1024 }),
      /read safely/,
    );
    assert.throws(
      () => readJson(large, "fixture", { maxBytes: 8 }),
      /read safely/,
    );
    assert.throws(
      () => readJson(invalid, "fixture", { maxBytes: 1024 }),
      /invalid JSON/,
    );
    assert.throws(
      () => readJson(notAFile, "fixture", { maxBytes: 1024 }),
      /read safely/,
    );
    assert.throws(
      () =>
        readJson(path.join(directory, "missing.json"), "fixture", {
          maxBytes: 1024,
        }),
      /read safely/,
    );
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("loadRiskDefinition validates scope, LF, sorting, and uniqueness", () => {
  const directory = temporaryDirectory();
  try {
    const decisionDirectory = path.join(
      directory,
      "security",
      "risk-decisions",
    );
    fs.mkdirSync(decisionDirectory, { recursive: true });
    const snapshotRelative = "security/risk-decisions/GHSA.approved-paths.txt";
    const snapshotPath = path.join(directory, snapshotRelative);
    const riskPath = path.join(decisionDirectory, "GHSA.json");
    const writeRisk = (approvedPathsFile = snapshotRelative) =>
      fs.writeFileSync(
        riskPath,
        JSON.stringify({
          approvedPathsFile,
        }),
      );

    fs.writeFileSync(snapshotPath, "a\nb");
    writeRisk();
    assert.deepEqual(
      loadRiskDefinition(riskPath, directory).approvedPathLines,
      ["a", "b"],
    );

    fs.writeFileSync(snapshotPath, "b\na");
    assert.throws(
      () => loadRiskDefinition(riskPath, directory),
      /sorted and unique/,
    );

    fs.writeFileSync(snapshotPath, "a\n");
    assert.throws(
      () => loadRiskDefinition(riskPath, directory),
      /sorted and unique/,
    );

    fs.writeFileSync(snapshotPath, "a\r\nb");
    assert.throws(() => loadRiskDefinition(riskPath, directory), /LF newlines/);

    writeRisk("../outside.txt");
    assert.throws(
      () => loadRiskDefinition(riskPath, directory),
      /outside its scope/,
    );

    writeRisk();
    fs.rmSync(snapshotPath);
    assert.throws(
      () => loadRiskDefinition(riskPath, directory),
      /could not be read/,
    );

    fs.mkdirSync(snapshotPath);
    assert.throws(
      () => loadRiskDefinition(riskPath, directory),
      /not a regular file/,
    );

    fs.rmSync(snapshotPath, { recursive: true });
    fs.writeFileSync(snapshotPath, "");
    assert.throws(
      () => loadRiskDefinition(riskPath, directory),
      /invalid size/,
    );
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test(
  "readJson and risk snapshots reject symbolic links",
  { skip: process.platform === "win32" },
  () => {
    const directory = temporaryDirectory();
    try {
      const target = path.join(directory, "target.json");
      const link = path.join(directory, "link.json");
      fs.writeFileSync(target, '{"ok":true}');
      fs.symlinkSync(target, link);
      assert.throws(
        () => readJson(link, "fixture", { maxBytes: 1024 }),
        /read safely/,
      );

      const decisionDirectory = path.join(
        directory,
        "security",
        "risk-decisions",
      );
      fs.mkdirSync(decisionDirectory, { recursive: true });
      const snapshotTarget = path.join(directory, "snapshot.txt");
      const snapshotLink = path.join(decisionDirectory, "paths.txt");
      fs.writeFileSync(snapshotTarget, "a");
      fs.symlinkSync(snapshotTarget, snapshotLink);
      const riskPath = path.join(decisionDirectory, "risk.json");
      fs.writeFileSync(
        riskPath,
        JSON.stringify({
          approvedPathsFile: "security/risk-decisions/paths.txt",
        }),
      );
      assert.throws(
        () => loadRiskDefinition(riskPath, directory),
        /not a regular file/,
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  },
);

test("independent npm tree failure blocks an otherwise empty audit", () => {
  const lockfile = {
    lockfileVersion: 3,
    packages: {
      "": {
        dependencies: {},
        name: "fixture",
        version: "0.0.0",
      },
    },
  };
  const result = evaluateProductionAuditReport(
    {
      vulnerabilities: {},
    },
    {
      artifactReport: {
        ok: true,
        targetMatches: [],
      },
      lockfile,
      npmTreeReport: {
        errors: ["fixture"],
        ok: false,
      },
      risk: {
        status: "proposed",
      },
    },
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.toolchain.blocking.some(
      (item) => item.code === "npm_tree_independent_verification_failed",
    ),
  );
  assert.equal(result.checks.npmTreeVerification, "failed");
  assert.equal(result.checks.productionSbom, "passed");
  assert.deepEqual(result.errors, [
    "npm_tree:fixture",
    "npm_tree_independent_verification_failed",
  ]);
});

test("unresolved root production edges block the runtime audit", () => {
  const lockfile = {
    lockfileVersion: 3,
    packages: {
      "": {
        dependencies: {
          missing: "1.0.0",
        },
        name: "fixture",
        version: "0.0.0",
      },
    },
  };
  const result = evaluateProductionAuditReport(
    {
      vulnerabilities: {},
    },
    {
      artifactReport: {
        ok: true,
        targetMatches: [],
      },
      lockfile,
      npmTreeReport: {
        errors: [],
        ok: true,
      },
      risk: {
        status: "proposed",
      },
    },
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.runtime.blocking.some(
      (item) => item.code === "runtime_dependency_graph_unresolved",
    ),
  );
  assert.equal(result.checks.lockfileGraph, "failed");
  assert.equal(result.checks.rootRuntimeReachability, "failed");
});

test("an empty resolved audit passes without independent evidence input", () => {
  const result = evaluateProductionAuditReport(
    {
      vulnerabilities: {},
    },
    {
      artifactReport: {
        ok: true,
        targetMatches: [],
      },
      lockfile: {
        lockfileVersion: 3,
        packages: {
          "": {
            dependencies: {},
          },
        },
      },
      risk: null,
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.checks.npmTreeVerification, "skipped");
  assert.equal(result.checks.productionSbom, "skipped");
  assert.equal(result.checks.riskAcceptance, "skipped");
  assert.equal(result.checks.upstreamUrls, "skipped");
  assert.deepEqual(result.errors, []);
});

test("cleanup helper only removes explicit generated targets", () => {
  const directory = temporaryDirectory();
  try {
    const generated = [
      "extensions/account-home-entry/manifest.json",
      "extensions/account-home-page/manifest.json",
    ];
    for (const relativePath of generated) {
      const absolutePath = path.join(directory, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, "{}");
    }
    const preserved = path.join(directory, "keep.txt");
    fs.writeFileSync(preserved, "keep");
    const staleBundle = path.join(directory, ".shopify", "deploy-bundle.br");
    fs.mkdirSync(path.dirname(staleBundle), { recursive: true });
    fs.writeFileSync(staleBundle, "stale");

    const dryRun = cleanAuditArtifacts({
      includeBuildDirectories: true,
      listTrackedFiles: () => [],
      repositoryRoot: directory,
    });
    assert.equal(dryRun.applied, false);
    assert.ok(dryRun.targets.includes(".shopify/deploy-bundle.br"));
    assert.ok(
      generated.every((item) => fs.existsSync(path.join(directory, item))),
    );
    assert.equal(fs.existsSync(staleBundle), true);

    const cleaned = cleanAuditArtifacts({
      apply: true,
      includeBuildDirectories: true,
      listTrackedFiles: () => [],
      repositoryRoot: directory,
    });
    assert.equal(cleaned.applied, true);
    assert.ok(
      generated.every((item) => !fs.existsSync(path.join(directory, item))),
    );
    assert.equal(fs.existsSync(staleBundle), false);
    assert.equal(fs.readFileSync(preserved, "utf8"), "keep");
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("cleanup rejects root, empty, absolute, and traversal targets", () => {
  const directory = temporaryDirectory();
  try {
    for (const unsafePath of ["", ".", "..", "../outside", directory]) {
      assert.throws(
        () => resolveCleanupTarget(directory, unsafePath),
        /Refusing to clean unsafe path/u,
      );
    }
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("cleanup rejects tracked targets before deleting any target", () => {
  const directory = temporaryDirectory();
  try {
    const firstManifest = path.join(
      directory,
      "extensions/account-home-entry/manifest.json",
    );
    fs.mkdirSync(path.dirname(firstManifest), { recursive: true });
    fs.writeFileSync(firstManifest, "{}");

    assert.throws(
      () =>
        cleanAuditArtifacts({
          apply: true,
          listTrackedFiles: (_root, relativePath) =>
            relativePath.includes("account-home-page")
              ? ["extensions/account-home-page/manifest.json"]
              : [],
          repositoryRoot: directory,
        }),
      /Refusing to clean tracked path/u,
    );
    assert.equal(fs.existsSync(firstManifest), true);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("cleanup rejects symlinked or junction cleanup targets", () => {
  const directory = temporaryDirectory();
  const externalDirectory = temporaryDirectory();
  try {
    const buildPath = path.join(directory, "build");
    fs.symlinkSync(
      externalDirectory,
      buildPath,
      process.platform === "win32" ? "junction" : "dir",
    );

    assert.throws(
      () =>
        cleanAuditArtifacts({
          apply: true,
          includeBuildDirectories: true,
          listTrackedFiles: () => [],
          repositoryRoot: directory,
        }),
      /symbolic link or junction/u,
    );
    assert.equal(fs.existsSync(externalDirectory), true);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
    fs.rmSync(externalDirectory, { force: true, recursive: true });
  }
});

test("cleanup Git inspection fails closed and parses tracked files", () => {
  const success = listGitTrackedFiles(
    "C:\\fixture",
    "build",
    (_command, args, options) => {
      assert.deepEqual(args.slice(0, 4), [
        "-C",
        "C:\\fixture",
        "ls-files",
        "--",
      ]);
      assert.equal(options.shell, false);
      return {
        error: null,
        status: 0,
        stdout: "build/a.js\r\nbuild/b.js\n\n",
      };
    },
  );
  assert.deepEqual(success, ["build/a.js", "build/b.js"]);

  assert.throws(
    () =>
      listGitTrackedFiles(".", "build", () => ({
        error: new Error("cannot spawn"),
        status: null,
      })),
    /Unable to verify tracked cleanup targets: cannot spawn/u,
  );
  assert.throws(
    () =>
      listGitTrackedFiles(".", "build", () => ({
        error: null,
        status: 2,
        stdout: "",
      })),
    /git exited 2/u,
  );
});

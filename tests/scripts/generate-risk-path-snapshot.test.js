import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateRiskPathSnapshot } from "../../scripts/security/generate-risk-path-snapshot.mjs";

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "risk-path-snapshot-"));
}

function lockfileFixture({
  rootDependency = false,
  unresolvedDependency = false,
} = {}) {
  return {
    lockfileVersion: 3,
    name: "fixture",
    packages: {
      "": {
        dependencies: rootDependency
          ? {
              "brace-expansion": "2.1.2",
            }
          : {},
        devDependencies: rootDependency
          ? {}
          : {
              tool: "1.0.0",
            },
        name: "fixture",
        version: "1.0.0",
      },
      "node_modules/brace-expansion": {
        name: "brace-expansion",
        version: "2.1.2",
      },
      "node_modules/tool": {
        dependencies: {
          "brace-expansion": "2.1.2",
          ...(unresolvedDependency
            ? {
                missing: "9.9.9",
              }
            : {}),
        },
        dev: true,
        name: "tool",
        version: "1.0.0",
      },
    },
    version: "1.0.0",
  };
}

test("writes a deterministic dev-only risk path snapshot", () => {
  const directory = temporaryDirectory();
  try {
    const decisionsDirectory = path.join(
      directory,
      "security",
      "risk-decisions",
    );
    const lockfilePath = path.join(directory, "package-lock.json");
    const outputPath = path.join(decisionsDirectory, "approved-paths.txt");
    fs.mkdirSync(decisionsDirectory, { recursive: true });
    fs.writeFileSync(
      lockfilePath,
      JSON.stringify(lockfileFixture()),
      "utf8",
    );

    const result = generateRiskPathSnapshot({
      decisionsDirectory,
      lockfilePath,
      outputPath,
      repositoryRoot: directory,
    });

    assert.equal(result.count, 1);
    assert.match(result.pathSetSha256, /^[A-F0-9]{64}$/u);
    assert.equal(
      result.relativeOutputPath,
      "security/risk-decisions/approved-paths.txt",
    );
    assert.match(
      fs.readFileSync(outputPath, "utf8"),
      /^root-development\|tool@1\.0\.0\[node_modules\/tool\] -> brace-expansion@2\.1\.2\[node_modules\/brace-expansion\]\|devDependency -> dependency$/u,
    );
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("derives default paths from an explicitly supplied repository root", () => {
  const directory = temporaryDirectory();
  try {
    fs.writeFileSync(
      path.join(directory, "package-lock.json"),
      JSON.stringify(lockfileFixture()),
      "utf8",
    );

    const result = generateRiskPathSnapshot({
      repositoryRoot: directory,
    });

    assert.equal(result.count, 1);
    assert.equal(
      result.relativeOutputPath,
      "security/risk-decisions/GHSA-mh99-v99m-4gvg.approved-paths.txt",
    );
    assert.equal(
      fs.existsSync(
        path.join(
          directory,
          "security",
          "risk-decisions",
          "GHSA-mh99-v99m-4gvg.approved-paths.txt",
        ),
      ),
      true,
    );
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("rejects outputs outside the decision directory or with unsafe types", () => {
  const directory = temporaryDirectory();
  try {
    const decisionsDirectory = path.join(
      directory,
      "security",
      "risk-decisions",
    );
    const lockfilePath = path.join(directory, "package-lock.json");
    fs.mkdirSync(decisionsDirectory, { recursive: true });
    fs.writeFileSync(
      lockfilePath,
      JSON.stringify(lockfileFixture()),
      "utf8",
    );

    for (const outputPath of [
      path.join(directory, "outside.txt"),
      decisionsDirectory,
      path.join(decisionsDirectory, "snapshot.json"),
    ]) {
      assert.throws(
        () =>
          generateRiskPathSnapshot({
            decisionsDirectory,
            lockfilePath,
            outputPath,
            repositoryRoot: directory,
          }),
        /Risk path snapshot must remain/u,
      );
    }
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("fails closed for unresolved and root-production dependency paths", () => {
  const directory = temporaryDirectory();
  try {
    const decisionsDirectory = path.join(
      directory,
      "security",
      "risk-decisions",
    );
    const lockfilePath = path.join(directory, "package-lock.json");
    const outputPath = path.join(decisionsDirectory, "snapshot.txt");
    fs.mkdirSync(decisionsDirectory, { recursive: true });

    fs.writeFileSync(
      lockfilePath,
      JSON.stringify(lockfileFixture({ unresolvedDependency: true })),
      "utf8",
    );
    assert.throws(
      () =>
        generateRiskPathSnapshot({
          decisionsDirectory,
          lockfilePath,
          outputPath,
          repositoryRoot: directory,
        }),
      /unresolved dependency graph/u,
    );

    fs.writeFileSync(
      lockfilePath,
      JSON.stringify(lockfileFixture({ rootDependency: true })),
      "utf8",
    );
    assert.throws(
      () =>
        generateRiskPathSnapshot({
          decisionsDirectory,
          lockfilePath,
          outputPath,
          repositoryRoot: directory,
        }),
      /root production dependency path/u,
    );
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("rejects unsafe and malformed lockfiles and existing output links", () => {
  const directory = temporaryDirectory();
  try {
    const decisionsDirectory = path.join(
      directory,
      "security",
      "risk-decisions",
    );
    const lockfilePath = path.join(directory, "package-lock.json");
    const outputPath = path.join(decisionsDirectory, "snapshot.txt");
    fs.mkdirSync(decisionsDirectory, { recursive: true });

    fs.writeFileSync(lockfilePath, "{", "utf8");
    assert.throws(
      () =>
        generateRiskPathSnapshot({
          decisionsDirectory,
          lockfilePath,
          outputPath,
          repositoryRoot: directory,
        }),
      /invalid JSON/u,
    );

    fs.writeFileSync(lockfilePath, "", "utf8");
    assert.throws(
      () =>
        generateRiskPathSnapshot({
          decisionsDirectory,
          lockfilePath,
          outputPath,
          repositoryRoot: directory,
        }),
      /lockfile is unsafe/u,
    );

    fs.rmSync(lockfilePath);
    fs.mkdirSync(lockfilePath);
    assert.throws(
      () =>
        generateRiskPathSnapshot({
          decisionsDirectory,
          lockfilePath,
          outputPath,
          repositoryRoot: directory,
        }),
      /lockfile is unsafe/u,
    );

    fs.rmSync(lockfilePath, { recursive: true });
    fs.writeFileSync(
      lockfilePath,
      JSON.stringify(lockfileFixture()),
      "utf8",
    );
    fs.mkdirSync(outputPath);
    assert.throws(
      () =>
        generateRiskPathSnapshot({
          decisionsDirectory,
          lockfilePath,
          outputPath,
          repositoryRoot: directory,
        }),
      /Risk path snapshot must remain/u,
    );
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

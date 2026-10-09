import assert from "node:assert/strict";
import test from "node:test";
import { classifyMaintenanceCandidate } from "../../scripts/security/maintenance-candidate.mjs";

function fixture() {
  const beforeManifest = {
    name: "test",
    version: "1.0.0",
    dependencies: { safe: "1.0.0" },
    devDependencies: { prettier: "3.8.0", protected: "1.0.0" },
    scripts: { start: "node server.mjs" },
  };
  const beforeLock = {
    lockfileVersion: 3,
    packages: {
      "": {
        dependencies: beforeManifest.dependencies,
        devDependencies: beforeManifest.devDependencies,
      },
      "node_modules/safe": { version: "1.0.0" },
      "node_modules/prettier": {
        version: "3.8.0",
        integrity: "sha512-YWJj",
        resolved: "https://registry.npmjs.org/prettier/-/prettier-3.8.0.tgz",
        dev: true,
      },
      "node_modules/protected": { version: "1.0.0", dev: true },
    },
  };
  const afterManifest = structuredClone(beforeManifest);
  afterManifest.devDependencies.prettier = "3.8.1";
  const afterLock = structuredClone(beforeLock);
  afterLock.packages[""].devDependencies = structuredClone(
    afterManifest.devDependencies,
  );
  afterLock.packages["node_modules/prettier"].version = "3.8.1";
  afterLock.packages["node_modules/prettier"].integrity = "sha512-ZGVm";
  afterLock.packages["node_modules/prettier"].resolved =
    "https://registry.npmjs.org/prettier/-/prettier-3.8.1.tgz";
  return {
    paths: ["package.json", "package-lock.json"],
    beforeManifest,
    afterManifest,
    beforeLock,
    afterLock,
  };
}

test("only a single registry-sourced development patch with an unchanged runtime is eligible", () => {
  assert.equal(classifyMaintenanceCandidate(fixture()).eligible, true);
});
test("protected files, manifests, dependency ranges and runtime changes are not automatic", () => {
  for (const change of [
    (f) => f.paths.push("server.mjs"),
    (f) => (f.afterManifest.scripts.start = "changed"),
    (f) => (f.afterManifest.devDependencies.extra = "1.0.0"),
    (f) => (f.afterManifest.devDependencies.protected = "1.0.1"),
    (f) => (f.afterManifest.devDependencies.prettier = "*"),
    (f) => (f.afterLock.packages["node_modules/safe"].version = "1.0.1"),
    (f) => (f.afterLock.packages["node_modules/extra"] = { version: "1.0.0" }),
    (f) => (f.afterLock.packages["node_modules/prettier"].version = "3.9.0"),
    (f) =>
      (f.afterLock.packages["node_modules/prettier"].version = "3.8.1-beta.1"),
    (f) =>
      (f.afterLock.packages["node_modules/prettier"].name = "aliased-package"),
    (f) =>
      (f.afterLock.packages["node_modules/prettier"].hasInstallScript = true),
    (f) =>
      (f.afterLock.packages["node_modules/prettier"].resolved =
        "https://other.example.test/package.tgz"),
    (f) =>
      (f.afterLock.packages["node_modules/prettier"].integrity = "missing"),
    (f) => (f.afterLock.packages[""].dependencies = { changed: "1.0.0" }),
  ]) {
    const f = fixture();
    change(f);
    assert.equal(classifyMaintenanceCandidate(f).eligible, false);
  }
  assert.equal(classifyMaintenanceCandidate({}).eligible, false);
});

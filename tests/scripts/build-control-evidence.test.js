import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BUILD_CONTROL_FILES,
  buildControlFingerprint,
  verifyBuildControlEvidence,
} from "../../scripts/security/build-control-evidence.mjs";
import { readRuntimePlan } from "../../scripts/security/runtime-package.mjs";
import { assertProductionBuildAdmission } from "../../scripts/security/production-build.mjs";
import {
  BRACES_ADVISORY_ID,
  BRACES_CONDITION_POLICY,
} from "../../scripts/security/toolchain-risk-scope.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-evidence-test-"));
  for (const file of BUILD_CONTROL_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "fixture\n");
  }
  const manifest = {
    name: "fixture",
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
  fs.mkdirSync(path.join(root, ".audit"));
  const plan = readRuntimePlan(root);
  const risk = {
    buildControlSha256: buildControlFingerprint(root),
    runtimeManifestSha256: plan.manifestSha256,
    runtimeLockfileSha256: plan.lockfileSha256,
  };
  const evidence = {
    schemaVersion: 1,
    ok: true,
    auditOk: true,
    packageCount: 1,
    forbiddenPackages: [],
    manifestSha256: plan.manifestSha256,
    lockfileSha256: plan.lockfileSha256,
  };
  fs.writeFileSync(
    path.join(root, ".audit/runtime-package-evidence.json"),
    JSON.stringify(evidence),
  );
  return { root, risk, evidence };
}

test("runtime evidence must match current controls, runtime manifests and actual clean-audit status", () => {
  const { root, risk, evidence } = fixture();
  try {
    assert.equal(verifyBuildControlEvidence(root, risk).ok, true);
    const file = path.join(root, ".audit/runtime-package-evidence.json");
    for (const change of [
      { ok: false },
      { auditOk: false },
      { packageCount: 0 },
      { forbiddenPackages: ["braces"] },
      { manifestSha256: "wrong" },
      { lockfileSha256: "wrong" },
      { schemaVersion: 2 },
    ]) {
      fs.writeFileSync(file, JSON.stringify({ ...evidence, ...change }));
      assert.equal(verifyBuildControlEvidence(root, risk).ok, false);
    }
    fs.writeFileSync(file, JSON.stringify(evidence));
    assert.equal(
      verifyBuildControlEvidence(root, {
        ...risk,
        runtimeManifestSha256: "wrong",
      }).ok,
      false,
    );
    fs.writeFileSync(file, "x".repeat(16001));
    assert.equal(verifyBuildControlEvidence(root, risk).ok, false);
    fs.unlinkSync(file);
    assert.equal(verifyBuildControlEvidence(root, risk).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("condition-bound control fingerprints exempt only the five approved development version fields", () => {
  const { root } = fixture();
  const risk = {
    advisoryId: BRACES_ADVISORY_ID,
    packageName: "braces",
    policy: BRACES_CONDITION_POLICY,
  };
  try {
    const file = path.join(root, "package.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.devDependencies = { prettier: "3.8.0", protected: "1.0.0" };
    fs.writeFileSync(file, JSON.stringify(manifest));
    const original = buildControlFingerprint(root, risk);
    manifest.devDependencies.prettier = "3.8.1";
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.equal(buildControlFingerprint(root, risk), original);
    manifest.devDependencies.protected = "1.0.1";
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.notEqual(buildControlFingerprint(root, risk), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("control fingerprints normalize checkout line endings but reject changed code and unsafe files", () => {
  const { root, risk } = fixture();
  try {
    const file = path.join(root, "server.mjs");
    fs.writeFileSync(file, "fixture\r\n");
    assert.equal(buildControlFingerprint(root), risk.buildControlSha256);
    fs.writeFileSync(file, "changed\n");
    assert.equal(
      verifyBuildControlEvidence(root, risk).reason,
      "build_controls_changed",
    );
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    assert.throws(
      () => buildControlFingerprint(root),
      /unsafe_build_control_source/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("production build rejects an unapproved proposal before running any build or module activation", () => {
  const { root } = fixture();
  try {
    const directory = path.join(root, "security/risk-decisions");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "paths.txt"), "path");
    fs.writeFileSync(
      path.join(directory, "GHSA-vfj7-8cjw-p6xm.json"),
      JSON.stringify({
        status: "proposed",
        packageName: "braces",
        advisoryId: "GHSA-VFJ7-8CJW-P6XM",
        approvedPathsFile: "security/risk-decisions/paths.txt",
      }),
    );
    assert.throws(
      () => assertProductionBuildAdmission(root),
      /production_build_risk_not_approved/,
    );
    assert.equal(fs.existsSync(path.join(root, "node_modules")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

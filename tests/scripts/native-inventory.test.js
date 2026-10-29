import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectNativeInventory,
  evaluateNativeInventory,
} from "../../scripts/security/native-inventory.mjs";
import {
  validateRegistryAudit,
  writeIncidentEvidence,
} from "../../scripts/security/incident-audit.mjs";

const emptyPolicy = {
  schemaVersion: 1,
  incident: "2026-10-runtime",
  approvedArtifacts: [],
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-inventory-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relative, bytes) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

test("native inventory hashes real bytes and excludes script wrappers", (t) => {
  const root = fixture(t);
  const bytes = Buffer.concat([
    Buffer.from("MZ"),
    Buffer.from("binary go1.23.12 wasmtime-39.0.1"),
  ]);
  write(root, "node_modules/@esbuild/win32-x64/esbuild.exe", bytes);
  write(
    root,
    "node_modules/esbuild/bin/esbuild",
    "#!/usr/bin/env node\nconsole.log('wrapper');",
  );
  if (process.platform !== "win32") {
    fs.mkdirSync(path.join(root, "node_modules/.bin"));
    fs.symlinkSync(
      "../esbuild/bin/esbuild",
      path.join(root, "node_modules/.bin/esbuild"),
    );
  }
  const inventory = collectNativeInventory(root);
  assert.equal(inventory.artifacts.length, 1);
  assert.equal(
    inventory.artifacts[0].sha256,
    crypto.createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(inventory.artifacts[0].versionHints, [
    "go1.23.12",
    "wasmtime-39.0.1",
  ]);
  const result = evaluateNativeInventory(inventory, root, emptyPolicy);
  assert.equal(result.ok, false);
  assert.ok(
    result.blocking.some((item) => item.code === "native_artifact_unreviewed"),
  );
  assert.ok(result.blocking.some((item) => item.role === "function-runner"));
});

test("missing tools and unknown executable formats cannot pass", (t) => {
  const root = fixture(t);
  let inventory = collectNativeInventory(root);
  assert.ok(
    evaluateNativeInventory(inventory, root, emptyPolicy).blocking.some(
      (item) => item.code === "native_inventory_modules_missing",
    ),
  );
  write(root, "node_modules/tool/tool.exe", "not a native executable");
  inventory = collectNativeInventory(root);
  assert.ok(inventory.problems.includes("native_inventory_header_invalid"));
  assert.equal(
    evaluateNativeInventory(inventory, root, emptyPolicy).complete,
    false,
  );
  assert.throws(
    () =>
      evaluateNativeInventory(
        { ...inventory, arch: "unknown" },
        root,
        emptyPolicy,
      ),
    /native_inventory_invalid/,
  );
  assert.throws(
    () =>
      evaluateNativeInventory(inventory, root, {
        ...emptyPolicy,
        ignore: true,
      }),
    /native_policy_invalid/,
  );
});

test("inventory rejects mismatched platforms, duplicate paths and traversal", (t) => {
  const root = fixture(t);
  write(root, "node_modules/native/native.node", Buffer.from("MZabcd"));
  const inventory = collectNativeInventory(root);
  for (const patch of [
    { platform: "unknown" },
    { sha256: "invalid" },
    { path: "node_modules/../../outside.exe" },
  ]) {
    const changed = structuredClone(inventory);
    Object.assign(changed.artifacts[0], patch);
    assert.throws(
      () => evaluateNativeInventory(changed, root, emptyPolicy),
      /native_inventory_artifact_invalid/,
    );
  }
  inventory.artifacts.push(inventory.artifacts[0]);
  assert.throws(
    () => evaluateNativeInventory(inventory, root, emptyPolicy),
    /native_inventory_artifact_invalid/,
  );
});

test("native approval needs a digest-bound SBOM and exact source commit", (t) => {
  const root = fixture(t);
  write(root, "node_modules/native/native.node", Buffer.from("MZabcd"));
  const inventory = collectNativeInventory(root);
  const approval = {
    sha256: inventory.artifacts[0].sha256,
    platform: process.platform,
    arch: process.arch,
    sourceCommit: "a".repeat(40),
    sbom: "security/native-sbom/fixture.json",
    sbomSha256: "b".repeat(64),
  };
  write(root, approval.sbom, "{}");
  assert.throws(
    () =>
      evaluateNativeInventory(inventory, root, {
        ...emptyPolicy,
        approvedArtifacts: [approval],
      }),
    /native_sbom_digest_mismatch/,
  );
  approval.sbomSha256 = crypto.createHash("sha256").update("{}").digest("hex");
  assert.throws(
    () =>
      evaluateNativeInventory(inventory, root, {
        ...emptyPolicy,
        approvedArtifacts: [approval],
      }),
    /native_sbom_binding_invalid/,
  );
});

test("out-of-root junctions and linked evidence directories are rejected", (t) => {
  const root = fixture(t);
  const outside = fixture(t);
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(outside, path.join(root, "node_modules/escape"), "junction");
  assert.throws(
    () => collectNativeInventory(root),
    /native_inventory_path_escape/,
  );
  fs.symlinkSync(outside, path.join(root, ".audit"), "junction");
  assert.throws(
    () => writeIncidentEvidence(root, { ok: true }),
    /incident_evidence_path_invalid/,
  );
  assert.equal(
    fs.existsSync(path.join(outside, "october-incident.json")),
    false,
  );
});

test("approval is bound to exact bytes and cannot hide a changed tool", (t) => {
  const root = fixture(t);
  const bytes = Buffer.from("MZapproved-test-fixture");
  for (const relative of [
    "prisma/schema-engine.exe",
    "@esbuild/win32-x64/esbuild.exe",
    "tools/function-runner.exe",
    "tools/javy-x64.exe",
  ])
    write(root, `node_modules/${relative}`, bytes);
  const inventory = collectNativeInventory(root);
  const digest = inventory.artifacts[0].sha256;
  const sourceCommit = "c".repeat(40);
  const sbom = JSON.stringify({
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    metadata: {
      component: {
        hashes: [{ alg: "SHA-256", content: digest }],
        externalReferences: [
          {
            type: "vcs",
            url: `https://github.com/example/fixture/commit/${sourceCommit}`,
          },
        ],
      },
    },
    components: [{ type: "library", name: "test-fixture", version: "1.0.0" }],
  });
  const approval = {
    sha256: digest,
    platform: process.platform,
    arch: process.arch,
    sourceCommit,
    sbom: "security/native-sbom/fixture.json",
    sbomSha256: crypto.createHash("sha256").update(sbom).digest("hex"),
  };
  write(root, approval.sbom, sbom);
  const policy = { ...emptyPolicy, approvedArtifacts: [approval] };
  assert.equal(evaluateNativeInventory(inventory, root, policy).ok, true);
  assert.throws(
    () =>
      evaluateNativeInventory(inventory, root, {
        ...policy,
        approvedArtifacts: [approval, approval],
      }),
    /native_approval_duplicate/,
  );
  write(
    root,
    "node_modules/tools/function-runner.exe",
    Buffer.from("MZchanged-test-fixture"),
  );
  assert.equal(
    evaluateNativeInventory(collectNativeInventory(root), root, policy).ok,
    false,
  );
  write(root, approval.sbom, sbom.replace(sourceCommit, "d".repeat(40)));
  assert.throws(
    () => evaluateNativeInventory(inventory, root, policy),
    /native_sbom_digest_mismatch/,
  );
});

test("incident evidence preserves unresolved and external unknown states", (t) => {
  const root = fixture(t);
  const report = {
    ok: false,
    incidentClosed: false,
    externalVerification: { production: "NOT_VERIFIED" },
  };
  writeIncidentEvidence(root, report);
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(root, ".audit/october-incident.json"), "utf8"),
    ),
    report,
  );
});

test("missing, malformed and inconsistent advisory feeds fail closed", () => {
  const clean = {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0,
      },
    },
  };
  assert.equal(validateRegistryAudit(clean).ok, true);
  for (const report of [
    null,
    {},
    { vulnerabilities: {} },
    { ...clean, error: { code: "ENETUNREACH" } },
    { ...clean, vulnerabilities: [] },
  ])
    assert.throws(
      () => validateRegistryAudit(report),
      /incident_npm_audit_invalid/,
    );
  for (const report of [
    { ...clean, vulnerabilities: { vulnerable: {} } },
    {
      ...clean,
      metadata: {
        vulnerabilities: { ...clean.metadata.vulnerabilities, high: 1 },
      },
    },
  ])
    assert.throws(
      () => validateRegistryAudit(report),
      /incident_npm_advisories_unresolved/,
    );
});

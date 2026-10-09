import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readRuntimePlan } from "./runtime-package.mjs";

export const BUILD_CONTROL_FILES = Object.freeze([
  ".github/workflows/quality.yml",
  "package.json",
  "server.mjs",
  "scripts/security/braces-guard.cjs",
  "scripts/security/braces-build-preload.mjs",
  "scripts/security/safe-build.mjs",
  "scripts/security/runtime-package.mjs",
  "scripts/security/runtime-toolchain.mjs",
  "scripts/security/toolchain-targets.mjs",
  "scripts/security/production-build.mjs",
  "scripts/security/build-control-evidence.mjs",
  "scripts/security/toolchain-risk-scope.mjs",
  "scripts/security/risk-acceptance-provenance.mjs",
  "scripts/security/audit-policy.mjs",
]);

export function buildControlFingerprint(root) {
  const hash = crypto.createHash("sha256");
  for (const filename of BUILD_CONTROL_FILES) {
    const location = path.join(root, filename);
    const stat = fs.lstatSync(location);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new Error("unsafe_build_control_source");
    hash.update(filename + "\n");
    hash.update(fs.readFileSync(location, "utf8").replaceAll("\r\n", "\n"));
    hash.update("\n");
  }
  return hash.digest("hex").toUpperCase();
}

export function verifyBuildControlEvidence(root, risk) {
  try {
    if (buildControlFingerprint(root) !== risk.buildControlSha256)
      return { ok: false, reason: "build_controls_changed" };
    const filename = path.join(root, ".audit/runtime-package-evidence.json");
    const stats = fs.lstatSync(filename);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16_000)
      return { ok: false, reason: "runtime_evidence_unsafe" };
    const evidence = JSON.parse(fs.readFileSync(filename, "utf8"));
    const plan = readRuntimePlan(root);
    if (
      evidence.schemaVersion !== 1 ||
      evidence.ok !== true ||
      evidence.auditOk !== true ||
      !Number.isInteger(evidence.packageCount) ||
      evidence.packageCount < 1 ||
      JSON.stringify(evidence.forbiddenPackages) !== "[]" ||
      evidence.manifestSha256 !== plan.manifestSha256 ||
      evidence.lockfileSha256 !== plan.lockfileSha256 ||
      risk.runtimeManifestSha256 !== plan.manifestSha256 ||
      risk.runtimeLockfileSha256 !== plan.lockfileSha256
    )
      return { ok: false, reason: "runtime_evidence_mismatch" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "build_control_evidence_unavailable" };
  }
}

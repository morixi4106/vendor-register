import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateToolchainRiskDefinition } from "./audit-policy.mjs";
import { loadRiskDefinition } from "../audit-production-dependencies.mjs";
import { buildControlFingerprint } from "./build-control-evidence.mjs";
import { readRuntimePlan, prepareRuntimePackage } from "./runtime-package.mjs";
import { isConditionBoundRisk } from "./toolchain-risk-scope.mjs";
import {
  assertBuildInputs,
  buildCommand,
  runSafeBuildCommand,
} from "./safe-build.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function assertProductionBuildAdmission(root = ROOT, now = new Date()) {
  const risk = loadRiskDefinition(undefined, root);
  const validation = validateToolchainRiskDefinition(risk, { now });
  if (!validation.ok) throw new Error("production_build_risk_not_approved");
  const lockfile = JSON.parse(
    fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
  );
  const braces = lockfile.packages["node_modules/braces"];
  const parent = lockfile.packages["node_modules/micromatch"];
  const plan = readRuntimePlan(root);
  if (
    braces?.version !== "3.0.3" ||
    (!isConditionBoundRisk(risk) &&
      crypto
        .createHash("sha256")
        .update(JSON.stringify(lockfile))
        .digest("hex")
        .toUpperCase() !== risk.lockfileSha256) ||
    braces.integrity !== risk.packageIntegrity ||
    parent?.version !== "4.0.8" ||
    buildControlFingerprint(root, risk) !== risk.buildControlSha256 ||
    plan.manifestSha256 !== risk.runtimeManifestSha256 ||
    plan.lockfileSha256 !== risk.runtimeLockfileSha256
  )
    throw new Error("production_build_evidence_changed");
  return true;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length > 2)
      throw new Error("unexpected_production_build_arguments");
    assertProductionBuildAdmission();
    assertBuildInputs();
    runSafeBuildCommand(buildCommand("generate"));
    runSafeBuildCommand(buildCommand("app"));
    prepareRuntimePackage({ activate: true });
    console.log(
      "Production runtime dependencies verified; build tools removed.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

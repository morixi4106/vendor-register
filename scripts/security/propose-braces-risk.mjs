import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BRACES_RISK_RELATIVE_PATH,
  BRACES_ADVISORY_ID,
  BRACES_MAX_DURATION_MS,
} from "./toolchain-risk-scope.mjs";
import { generateRiskPathSnapshot } from "./generate-risk-path-snapshot.mjs";
import { verifyBuildArtifacts } from "./artifact-reachability.mjs";
import {
  buildControlFingerprint,
  verifyBuildControlEvidence,
} from "./build-control-evidence.mjs";
import { readRuntimePlan } from "./runtime-package.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export function proposeBracesRisk(root = ROOT, now = new Date()) {
  const output = path.join(root, BRACES_RISK_RELATIVE_PATH);
  if (
    fs.existsSync(output) &&
    (!fs.lstatSync(output).isFile() || fs.lstatSync(output).isSymbolicLink())
  )
    throw new Error("unsafe_risk_proposal_path");
  const previous = fs.existsSync(output)
    ? JSON.parse(fs.readFileSync(output, "utf8"))
    : null;
  if (previous && previous.status !== "proposed")
    throw new Error("existing_risk_cannot_be_replaced");
  const lock = JSON.parse(
    fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
  );
  const braces = lock.packages["node_modules/braces"];
  if (braces?.version !== "3.0.3") throw new Error("proposal_version_changed");
  const artifacts = verifyBuildArtifacts({ rootDirectory: root });
  if (!artifacts.ok) throw new Error("proposal_artifact_verification_failed");
  const paths = generateRiskPathSnapshot({
    repositoryRoot: root,
    targetName: "braces",
    targetVersion: "3.0.3",
    outputPath: output.replace(/\.json$/, ".approved-paths.txt"),
  });
  const plan = readRuntimePlan(root);
  const evidence = {
    ...previous?.artifactEvidenceSha256ByPlatform,
    linux: previous?.artifactEvidenceSha256ByPlatform?.linux ?? null,
    win32: previous?.artifactEvidenceSha256ByPlatform?.win32 ?? null,
  };
  evidence[process.platform] = artifacts.artifactSetSha256;
  const proposed = {
    status: "proposed",
    advisoryId: BRACES_ADVISORY_ID,
    packageName: "braces",
    allowedVersions: ["3.0.3"],
    packageIntegrity: braces.integrity,
    requiredParent: {
      packageName: "micromatch",
      allowedVersions: ["4.0.8"],
      expectedPhysicalInstallCount: 1,
    },
    approvedPathsFile: paths.relativeOutputPath,
    approvedPathCount: paths.count,
    approvedPathSetSha256: paths.pathSetSha256,
    lockfileSha256: crypto
      .createHash("sha256")
      .update(JSON.stringify(lock))
      .digest("hex")
      .toUpperCase(),
    proposedAt: previous?.proposedAt || now.toISOString(),
    expiresAt:
      previous?.expiresAt ||
      new Date(now.getTime() + BRACES_MAX_DURATION_MS).toISOString(),
    buildControlSha256: buildControlFingerprint(root),
    runtimeManifestSha256: plan.manifestSha256,
    runtimeLockfileSha256: plan.lockfileSha256,
    artifactEvidenceSha256ByPlatform: evidence,
    upstreamUrls: [
      "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
      "https://github.com/micromatch/braces/issues/70",
    ],
    rationale:
      "Proposal only: exact reviewed build-tool dependency, guarded inputs and isolated credentials, bounded build resources, clean audited runtime installation, and no application or artifact reachability. Explicit owner acceptance is required and expiry cannot extend automatically.",
  };
  if (!verifyBuildControlEvidence(root, proposed).ok)
    throw new Error("proposal_runtime_evidence_missing");
  fs.writeFileSync(output, JSON.stringify(proposed, null, 2) + "\n");
  return {
    status: proposed.status,
    pathCount: proposed.approvedPathCount,
    expiresAt: proposed.expiresAt,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(JSON.stringify(proposeBracesRisk()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

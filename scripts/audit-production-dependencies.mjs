import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { splitAuditVulnerabilitiesByReachability } from "./security/audit-report.mjs";
import {
  evaluateRuntimeAudit,
  evaluateToolchainAudit,
} from "./security/audit-policy.mjs";
import { verifyBuildArtifacts } from "./security/artifact-reachability.mjs";
import { collectReachableLocations } from "./security/package-lock-graph.mjs";
import { collectNpmTreeEvidence } from "./security/npm-tree-verification.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const LOCKFILE_PATH = path.join(REPOSITORY_ROOT, "package-lock.json");
const TOOLCHAIN_RISK_PATH = path.join(
  REPOSITORY_ROOT,
  "security",
  "risk-decisions",
  "GHSA-mh99-v99m-4gvg.json",
);
const MAX_LOCKFILE_BYTES = 20 * 1024 * 1024;
const MAX_RISK_FILE_BYTES = 1024 * 1024;
const MAX_PATH_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export function readJson(filePath, description, { maxBytes }) {
  let source;
  try {
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("path is not a regular file");
    }
    if (stats.size === 0 || stats.size > maxBytes) {
      throw new Error(`file size is outside 1..${maxBytes} bytes`);
    }
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`${description} could not be read safely.`);
  }

  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${description} contains invalid JSON.`);
  }
}

export function loadRiskDefinition(
  riskPath = TOOLCHAIN_RISK_PATH,
  repositoryRoot = REPOSITORY_ROOT,
) {
  const risk = readJson(riskPath, "Toolchain risk definition", {
    maxBytes: MAX_RISK_FILE_BYTES,
  });
  const relativePath = String(risk.approvedPathsFile || "")
    .replaceAll("\\", "/")
    .trim();
  if (
    !relativePath.startsWith("security/risk-decisions/") ||
    relativePath.startsWith("/") ||
    relativePath.split("/").includes("..")
  ) {
    throw new Error("Toolchain approved path snapshot is outside its scope.");
  }

  const snapshotPath = path.resolve(repositoryRoot, relativePath);
  const relativeResolved = path.relative(repositoryRoot, snapshotPath);
  if (relativeResolved.startsWith("..") || path.isAbsolute(relativeResolved)) {
    throw new Error("Toolchain approved path snapshot escaped the repository.");
  }

  let stats;
  try {
    stats = fs.lstatSync(snapshotPath);
  } catch {
    throw new Error("Toolchain approved path snapshot could not be read.");
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Toolchain approved path snapshot is not a regular file.");
  }
  if (stats.size === 0 || stats.size > MAX_PATH_SNAPSHOT_BYTES) {
    throw new Error("Toolchain approved path snapshot has an invalid size.");
  }

  const source = fs.readFileSync(snapshotPath, "utf8");
  if (source.includes("\r")) {
    throw new Error("Toolchain approved path snapshot must use LF newlines.");
  }
  const approvedPathLines = source.split("\n");
  if (
    approvedPathLines.some((line) => line.length === 0) ||
    JSON.stringify(approvedPathLines) !==
      JSON.stringify(
        [...new Set(approvedPathLines)].sort((left, right) =>
          left.localeCompare(right, "en"),
        ),
      )
  ) {
    throw new Error(
      "Toolchain approved path snapshot must be sorted and unique.",
    );
  }

  return {
    ...risk,
    approvedPathLines,
  };
}

/* node:coverage disable */
function runNpmAudit() {
  const args = ["audit", "--json"];
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath
    ? process.execPath
    : process.platform === "win32"
      ? "npm.cmd"
      : "npm";
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : args;

  return spawnSync(command, commandArgs, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    shell: false,
  });
}
/* node:coverage enable */

export function evaluateProductionAuditReport(
  report,
  { artifactReport, lockfile, now = new Date(), npmTreeReport, risk },
) {
  const runtimeGraph = collectReachableLocations(lockfile, {
    scopes: new Set(["root-production"]),
  });
  const split = splitAuditVulnerabilitiesByReachability(
    report,
    runtimeGraph.reachable,
  );

  const runtime = evaluateRuntimeAudit(report, split.runtime, {
    now,
    unresolvedAuditPackages: split.unresolved,
  });
  if (runtimeGraph.unresolvedRequiredEdges.length > 0) {
    runtime.ok = false;
    runtime.blocking.push({
      code: "runtime_dependency_graph_unresolved",
      packageName: null,
      severity: "critical",
    });
  }

  const toolchain = evaluateToolchainAudit({
    artifactReport,
    lockfile,
    nonRuntimeVulnerabilities: split.nonRuntime,
    now,
    report,
    risk,
  });
  if (npmTreeReport && !npmTreeReport.ok) {
    toolchain.ok = false;
    toolchain.blocking.push({
      code: "npm_tree_independent_verification_failed",
      packageName: null,
      severity: "critical",
    });
  }

  const runtimeBlockingCodes = new Set(
    runtime.blocking.map((item) => item.code),
  );
  const toolchainBlockingCodes = new Set(
    toolchain.blocking.map((item) => item.code),
  );
  const riskErrors = new Set(toolchain.riskValidation?.errors || []);
  const npmTreeErrors = new Set(npmTreeReport?.errors || []);
  const targetMatches = Array.isArray(artifactReport?.targetMatches)
    ? artifactReport.targetMatches
    : [];
  const artifactClasses = new Map(
    (artifactReport?.artifactClasses || []).map((item) => [item.id, item]),
  );
  const nonRuntimeHighOrCritical = Object.values(split.nonRuntime || {}).some(
    (vulnerability) =>
      ["high", "critical"].includes(
        String(vulnerability?.severity || "").toLowerCase(),
      ),
  );
  const status = (passed) => (passed ? "passed" : "failed");
  const riskStatus = (passed) =>
    nonRuntimeHighOrCritical ? status(passed) : "skipped";
  const artifactClassStatus = (...ids) =>
    status(
      ids.every((id) => {
        const artifactClass = artifactClasses.get(id);
        return (
          artifactClass &&
          artifactClass.actualCount >= artifactClass.expectedMinimumCount
        );
      }),
    );
  const checks = {
    artifactReachability: status(Boolean(artifactReport?.ok)),
    directSourceImports: status(
      !targetMatches.some((match) =>
        String(match.evidence || "").startsWith("source-"),
      ),
    ),
    expiry: riskStatus(
      !riskErrors.has("expiry_exceeds_policy") &&
        !riskErrors.has("risk_expired"),
    ),
    functionJavaScript: artifactClassStatus("shopify-function-javascript"),
    functionWasm: artifactClassStatus("shopify-function-wasm"),
    lockfileGraph: status(
      runtimeGraph.unresolvedRequiredEdges.length === 0 &&
        !toolchainBlockingCodes.has("dependency_graph_unresolved") &&
        !toolchainBlockingCodes.has("dependency_path_enumeration_failed"),
    ),
    newAdvisories: status(
      !runtimeBlockingCodes.has("runtime_high_or_critical") &&
        !runtimeBlockingCodes.has("runtime_advisory_not_allowed") &&
        !toolchainBlockingCodes.has("advisory_chain_unresolved") &&
        !toolchainBlockingCodes.has("unexpected_high_or_critical"),
    ),
    npmTreeVerification: npmTreeReport
      ? status(npmTreeReport.ok)
      : "skipped",
    pathPolicy: riskStatus(
      !riskErrors.has("path_fingerprint_invalid") &&
        !toolchainBlockingCodes.has("dependency_paths_added") &&
        !toolchainBlockingCodes.has("dependency_graph_unresolved") &&
        !toolchainBlockingCodes.has("root_runtime_path_detected"),
    ),
    productionSbom: npmTreeReport
      ? status(
          !npmTreeErrors.has(
            "toolchain_target_present_in_production_sbom",
          ) && !npmTreeErrors.has("production_sbom_root_mismatch"),
        )
      : "skipped",
    remixArtifacts: artifactClassStatus(
      "remix-server-entry",
      "remix-server-chunks",
      "remix-client-entry",
      "remix-client-runtime-manifest",
      "remix-client-route-bundles",
      "remix-client-styles",
    ),
    riskAcceptance: riskStatus(!riskErrors.has("risk_not_accepted")),
    rootRuntimeReachability: status(
      !runtimeBlockingCodes.has("runtime_dependency_graph_unresolved") &&
        !toolchainBlockingCodes.has("root_runtime_path_detected"),
    ),
    sourceMaps: artifactClassStatus("source-maps"),
    uiExtensionBundles: artifactClassStatus(
      "ui-extension-entry-bundles",
      "ui-extension-page-bundles",
      "ui-extension-metafiles",
    ),
    upstreamUrls: riskStatus(!riskErrors.has("upstream_urls_invalid")),
  };
  const errors = [
    ...new Set([
      ...runtime.blocking.map((item) => item.code),
      ...toolchain.blocking.map((item) => item.code),
      ...(npmTreeReport?.errors || []).map((error) => `npm_tree:${error}`),
    ]),
  ].sort();

  return {
    checks,
    errors,
    ok: runtime.ok && toolchain.ok,
    runtime,
    split,
    toolchain,
  };
}

/* node:coverage disable */
function printBlocking(section, items) {
  if (items.length === 0) return;
  console.error(`${section}:`);
  for (const item of items) {
    const packageText = item.packageName ? ` ${item.packageName}` : "";
    console.error(`- ${item.code}:${packageText} (${item.severity})`);
  }
}

function printWarnings(section, items) {
  if (items.length === 0) return;
  console.warn(`${section}:`);
  for (const item of items) {
    const packageText = item.packageName ? ` ${item.packageName}` : "";
    const countText = Number.isInteger(item.count)
      ? `, count=${item.count}`
      : "";
    console.warn(
      `- ${item.code}:${packageText} (${item.severity}${countText})`,
    );
  }
}

function printArtifactSummary(artifactReport) {
  console.log(
    `Verified ${artifactReport.artifacts.length} build artifacts for toolchain reachability (set SHA-256 ${artifactReport.artifactSetSha256}).`,
  );
  for (const artifact of artifactReport.artifacts.filter((item) =>
    item.path.startsWith(".shopify/deploy-bundle/"),
  )) {
    console.log(
      `- ${artifact.path}: ${artifact.size} bytes, SHA-256 ${artifact.sha256}`,
    );
  }
}

export function main() {
  let lockfile;
  let risk;
  try {
    lockfile = readJson(LOCKFILE_PATH, "package-lock.json", {
      maxBytes: MAX_LOCKFILE_BYTES,
    });
    risk = loadRiskDefinition();
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  const audit = runNpmAudit();
  if (audit.error) {
    console.error(`Dependency audit could not start: ${audit.error.message}`);
    return 1;
  }

  let report;
  try {
    report = JSON.parse(audit.stdout || "");
  } catch {
    console.error("Dependency audit returned invalid JSON.");
    return 1;
  }

  let artifactReport;
  try {
    artifactReport = verifyBuildArtifacts({
      rootDirectory: REPOSITORY_ROOT,
    });
  } catch (error) {
    console.error(
      `Build artifact verification failed safely (${error.code || "UNKNOWN"}).`,
    );
    return 1;
  }
  let npmTreeReport;
  try {
    npmTreeReport = collectNpmTreeEvidence({
      cwd: REPOSITORY_ROOT,
      lockfile,
    });
  } catch (error) {
    console.error(`Independent npm tree verification failed: ${error.message}`);
    return 1;
  }
  const evaluation = evaluateProductionAuditReport(report, {
    artifactReport,
    lockfile,
    npmTreeReport,
    risk,
  });

  printArtifactSummary(artifactReport);
  console.log(
    JSON.stringify(
      {
        checks: evaluation.checks,
        errors: evaluation.errors,
      },
      null,
      2,
    ),
  );
  printBlocking("Deployable runtime audit failed", evaluation.runtime.blocking);
  printBlocking(
    "Non-runtime toolchain audit failed",
    evaluation.toolchain.blocking,
  );
  printWarnings(
    "Non-runtime toolchain audit warning",
    evaluation.toolchain.warnings,
  );
  if (!npmTreeReport.ok) {
    for (const error of npmTreeReport.errors) {
      console.error(`- independent npm tree mismatch: ${error}`);
    }
  } else {
    console.log(
      `Independent npm tree verification passed (${npmTreeReport.summary.productionSbomComponentCount} production SBOM components).`,
    );
  }

  if (!artifactReport.ok) {
    for (const artifact of artifactReport.missingArtifacts) {
      console.error(`- missing artifact: ${artifact}`);
    }
    for (const artifact of artifactReport.invalidArtifacts) {
      console.error(`- invalid artifact: ${artifact}`);
    }
    for (const match of artifactReport.targetMatches) {
      console.error(
        `- toolchain target ${match.target} found in ${match.artifact} (${match.evidence})`,
      );
    }
  }

  if (!evaluation.ok) return 1;

  if (evaluation.runtime.allowed.length > 0) {
    console.warn(
      `Temporary React Router moderate exception active until ${evaluation.runtime.exceptionExpiresAt}.`,
    );
  }
  if (evaluation.toolchain.accepted.length > 0) {
    console.warn(
      `Temporary non-runtime toolchain acceptance active until ${risk.expiresAt}.`,
    );
  }

  console.log("Dependency and build-artifact security audit passed.");
  return 0;
}

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  process.exitCode = main();
}
/* node:coverage enable */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNodeRuntime } from "./node-runtime.mjs";
import { verifyPatchedMergePackage } from "./vendor-patches.mjs";
import {
  collectNativeInventory,
  evaluateNativeInventory,
} from "./native-inventory.mjs";
import { runSafeBuildCommand } from "./safe-build.mjs";
import { verifyRebuiltEsbuild } from "./rebuild-esbuild.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function validateRegistryAudit(audit) {
  if (
    !audit ||
    audit.error ||
    audit.auditReportVersion !== 2 ||
    !audit.vulnerabilities ||
    typeof audit.vulnerabilities !== "object" ||
    Array.isArray(audit.vulnerabilities) ||
    !audit.metadata?.vulnerabilities
  )
    throw new Error("incident_npm_audit_invalid");
  if (
    Object.keys(audit.vulnerabilities).length ||
    ["info", "low", "moderate", "high", "critical", "total"].some(
      (level) => audit.metadata.vulnerabilities[level] !== 0,
    )
  )
    throw new Error("incident_npm_advisories_unresolved");
  return { ok: true, vulnerabilities: 0 };
}

function sourceBinding(root) {
  const options = {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    env: {
      PATH: process.env.PATH || process.env.Path,
      SystemRoot: process.env.SystemRoot,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
    },
  };
  const commit = execFileSync("git", ["rev-parse", "HEAD"], options).trim();
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new Error("incident_source_commit_invalid");
  return {
    commit,
    dirty:
      execFileSync(
        "git",
        ["status", "--porcelain", "--untracked-files=normal"],
        options,
      ).trim().length > 0,
  };
}

export function auditIncident(root = ROOT) {
  const node = assertNodeRuntime();
  const module = path.join(root, "node_modules/deepmerge");
  const backport = verifyPatchedMergePackage(
    module,
    JSON.parse(fs.readFileSync(path.join(module, "package.json"), "utf8")),
  );
  const npmPath = fs.realpathSync(
    process.env.npm_execpath ||
      path.join(
        path.dirname(process.execPath),
        "node_modules/npm/bin/npm-cli.js",
      ),
  );
  const expected = [
    path.join(
      path.dirname(process.execPath),
      "node_modules/npm/bin/npm-cli.js",
    ),
    path.resolve(
      path.dirname(process.execPath),
      "../lib/node_modules/npm/bin/npm-cli.js",
    ),
  ];
  if (
    !expected.some(
      (file) => fs.existsSync(file) && fs.realpathSync(file) === npmPath,
    )
  )
    throw new Error("incident_npm_cli_not_verified");
  const result = runSafeBuildCommand({
    args: [
      npmPath,
      "audit",
      "--json",
      "--ignore-scripts",
      "--registry=https://registry.npmjs.org",
    ],
    cwd: root,
    stdio: "pipe",
    timeoutMs: 120_000,
  });
  const audit = JSON.parse(result.stdout);
  const npm = validateRegistryAudit(audit);
  const go = verifyRebuiltEsbuild(root);
  const policyBytes = fs.readFileSync(
    path.join(root, "security/native-artifacts.json"),
  );
  const inventory = collectNativeInventory(root);
  const native = evaluateNativeInventory(
    inventory,
    root,
    JSON.parse(policyBytes),
  );
  return {
    schemaVersion: 1,
    incident: "2026-10-runtime",
    observedAt: new Date().toISOString(),
    scope: "candidate-build-and-dependencies",
    ok: native.ok,
    incidentClosed: false,
    go,
    source: sourceBinding(root),
    lockfileSha256: hash(fs.readFileSync(path.join(root, "package-lock.json"))),
    nodePolicySha256: hash(
      fs.readFileSync(path.join(root, "security/node-runtime.json")),
    ),
    vendorPolicySha256: hash(
      fs.readFileSync(path.join(root, "security/vendor-patches.json")),
    ),
    nativePolicySha256: hash(policyBytes),
    node,
    backport,
    npm: {
      ...npm,
      reportSha256: hash(result.stdout),
      registry: "https://registry.npmjs.org",
    },
    native,
    inventory,
    externalVerification: {
      production: "NOT_VERIFIED",
      workstation: "NOT_VERIFIED",
      providers: "NOT_VERIFIED",
    },
  };
}

export function writeIncidentEvidence(root, report) {
  const directory = path.join(root, ".audit");
  fs.mkdirSync(directory, { recursive: true });
  if (
    fs.lstatSync(directory).isSymbolicLink() ||
    fs.realpathSync(directory) !== path.join(fs.realpathSync(root), ".audit")
  )
    throw new Error("incident_evidence_path_invalid");
  const target = path.join(directory, "october-incident.json");
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())
    throw new Error("incident_evidence_path_invalid");
  fs.writeFileSync(target, JSON.stringify(report, null, 2) + "\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 2)
      throw new Error("unexpected_incident_audit_arguments");
    const report = auditIncident();
    writeIncidentEvidence(ROOT, report);
    console.log(
      JSON.stringify({
        ok: report.ok,
        incidentClosed: false,
        npm: report.npm,
        artifactCount: report.native.artifactCount,
        blocking: report.native.blocking,
      }),
    );
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

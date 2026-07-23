import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const EXCEPTION_EXPIRES_AT = "2026-09-30";
const ALLOWED_PACKAGES = new Set([
  "@remix-run/react",
  "react-router",
  "react-router-dom",
]);
const ALLOWED_ADVISORIES = new Set([
  "GHSA-WRJC-X8RR-H8H6",
  "GHSA-337J-9HXR-RHXG",
  "GHSA-JJMJ-JMHJ-QWJ2",
]);
const NEVER_ALLOW_SEVERITIES = new Set(["high", "critical"]);

function extractAdvisoryId(url) {
  const match = String(url || "").match(/GHSA-[a-z0-9-]+/i);
  return match ? match[0].toUpperCase() : null;
}

function isExceptionExpired(now) {
  const expiresAt = new Date(`${EXCEPTION_EXPIRES_AT}T23:59:59.999Z`);
  return Number.isNaN(expiresAt.getTime()) || now.getTime() > expiresAt.getTime();
}

export function evaluateProductionAuditReport(
  report,
  { now = new Date() } = {},
) {
  const vulnerabilities =
    report?.vulnerabilities && typeof report.vulnerabilities === "object"
      ? report.vulnerabilities
      : {};
  const blocking = [];
  const allowed = [];
  const exceptionExpired = isExceptionExpired(now);

  for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
    const severity = String(vulnerability?.severity || "unknown").toLowerCase();
    const via = Array.isArray(vulnerability?.via) ? vulnerability.via : [];
    const advisoryIds = via
      .filter((item) => item && typeof item === "object")
      .map((item) => extractAdvisoryId(item.url))
      .filter(Boolean);
    const dependencyLinks = via.filter((item) => typeof item === "string");

    const hasUnknownAdvisory = advisoryIds.some(
      (advisoryId) => !ALLOWED_ADVISORIES.has(advisoryId),
    );
    const hasUnknownDependencyLink = dependencyLinks.some(
      (dependencyName) => !ALLOWED_PACKAGES.has(dependencyName),
    );
    const canUseException =
      !exceptionExpired &&
      severity === "moderate" &&
      ALLOWED_PACKAGES.has(packageName) &&
      !hasUnknownAdvisory &&
      !hasUnknownDependencyLink &&
      (advisoryIds.length > 0 || dependencyLinks.length > 0);

    if (NEVER_ALLOW_SEVERITIES.has(severity) || !canUseException) {
      blocking.push({
        packageName,
        severity,
        advisoryIds,
      });
      continue;
    }

    allowed.push({
      packageName,
      severity,
      advisoryIds,
    });
  }

  return {
    ok: blocking.length === 0,
    exceptionExpiresAt: EXCEPTION_EXPIRES_AT,
    allowed,
    blocking,
  };
}

function runNpmAudit() {
  const args = ["audit", "--omit=dev", "--json"];
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath
    ? process.execPath
    : process.platform === "win32"
      ? "npm.cmd"
      : "npm";
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : args;

  return spawnSync(command, commandArgs, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    shell: false,
  });
}

export function main() {
  const audit = runNpmAudit();
  if (audit.error) {
    console.error(`Production dependency audit could not start: ${audit.error.message}`);
    return 1;
  }

  let report;
  try {
    report = JSON.parse(audit.stdout || "");
  } catch {
    console.error("Production dependency audit returned invalid JSON.");
    return 1;
  }

  const evaluation = evaluateProductionAuditReport(report);
  if (!evaluation.ok) {
    console.error("Production dependency audit found a blocking advisory:");
    for (const item of evaluation.blocking) {
      const advisoryText = item.advisoryIds.length
        ? ` (${item.advisoryIds.join(", ")})`
        : "";
      console.error(`- ${item.packageName}: ${item.severity}${advisoryText}`);
    }
    return 1;
  }

  if (evaluation.allowed.length > 0) {
    console.warn(
      `Temporary React Router advisory exception active until ${evaluation.exceptionExpiresAt}.`,
    );
    for (const item of evaluation.allowed) {
      const advisoryText = item.advisoryIds.length
        ? ` (${item.advisoryIds.join(", ")})`
        : "";
      console.warn(`- ${item.packageName}: ${item.severity}${advisoryText}`);
    }
  } else {
    console.log("Production dependency audit passed with no vulnerabilities.");
  }

  return 0;
}

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  process.exitCode = main();
}

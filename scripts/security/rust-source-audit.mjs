import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import toml from "toml";
import { assertNodeRuntime } from "./node-runtime.mjs";
import { checkedNativeDirectory } from "./rebuild-esbuild.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCES = Object.freeze({
  prisma: {
    repository: "prisma/prisma-engines",
    commit: "c2990dca591cba766e3b7ef5d9e8a84796e47ab7",
  },
  "function-runner": {
    repository: "Shopify/function-runner",
    commit: "47dca499b04de5158822cc451cd4daf61dfd0fd0",
  },
  javy: {
    repository: "bytecodealliance/javy",
    commit: "66f04f1fa2065123e0f712cddcee20770f58b13e",
  },
});
const digest = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

export function rustRegistryPackages(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 2 * 1024 * 1024)
    throw new Error("rust_lock_invalid");
  const lock = toml.parse(text);
  if (
    !Array.isArray(lock.package) ||
    !lock.package.length ||
    lock.package.length > 2000
  )
    throw new Error("rust_lock_invalid");
  const packages = [];
  const unresolved = [];
  const seen = new Set();
  for (const pkg of lock.package) {
    if (
      typeof pkg.name !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(pkg.name) ||
      typeof pkg.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.+-]+)?$/.test(pkg.version)
    )
      throw new Error("rust_lock_package_invalid");
    if (!pkg.source) continue;
    if (
      pkg.source !== "registry+https://github.com/rust-lang/crates.io-index"
    ) {
      unresolved.push({
        name: pkg.name,
        version: pkg.version,
        reason: "non_registry_source_requires_review",
      });
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(pkg.checksum || ""))
      throw new Error("rust_lock_checksum_missing");
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) throw new Error("rust_lock_duplicate");
    seen.add(key);
    packages.push({
      name: pkg.name,
      version: pkg.version,
      checksum: pkg.checksum,
    });
  }
  if (!packages.length) throw new Error("rust_lock_registry_empty");
  return { packages, unresolved };
}

async function boundedText(response, maxBytes) {
  if (!response.ok) throw new Error("native_advisory_source_unavailable");
  let text = "";
  const decoder = new TextDecoder();
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("native_advisory_response_limit");
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

export async function scanRustLockfile(text, { fetchImpl = fetch } = {}) {
  const { packages, unresolved } = rustRegistryPackages(text);
  const findings = [];
  for (let offset = 0; offset < packages.length; offset += 100) {
    const batch = packages.slice(offset, offset + 100);
    const response = await fetchImpl("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        queries: batch.map((pkg) => ({
          package: { ecosystem: "crates.io", name: pkg.name },
          version: pkg.version,
        })),
      }),
    });
    const result = JSON.parse(await boundedText(response, 5 * 1024 * 1024));
    if (
      !Array.isArray(result.results) ||
      result.results.length !== batch.length
    )
      throw new Error("native_advisory_response_invalid");
    result.results.forEach((entry, index) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        Object.keys(entry).some(
          (key) => !["vulns", "next_page_token"].includes(key),
        ) ||
        entry.next_page_token ||
        (entry.vulns !== undefined && !Array.isArray(entry.vulns))
      )
        throw new Error("native_advisory_response_incomplete");
      for (const vulnerability of entry.vulns || []) {
        if (
          !vulnerability ||
          !/^(RUSTSEC-\d{4}-\d{4}|GHSA-[a-z0-9-]+|CVE-\d{4}-\d+)$/.test(
            vulnerability.id || "",
          ) ||
          !Number.isFinite(Date.parse(vulnerability.modified))
        )
          throw new Error("native_advisory_entry_invalid");
        findings.push({
          package: batch[index].name,
          version: batch[index].version,
          advisory: vulnerability.id,
          modified: vulnerability.modified,
        });
      }
    });
  }
  return {
    schemaVersion: 1,
    sourceAuditOk: !findings.length && !unresolved.length,
    artifactStatus: "NOT_VERIFIED",
    observedAt: new Date().toISOString(),
    advisorySource: "https://api.osv.dev",
    lockfileSha256: digest(text),
    packageCount: packages.length,
    packages,
    findings,
    unresolved,
  };
}

export async function assessRustSources(root = ROOT) {
  assertNodeRuntime();
  const directory = checkedNativeDirectory(root, ".audit/rust-source");
  const reports = [];
  for (const [role, source] of Object.entries(SOURCES)) {
    const response = await fetch(
      `https://raw.githubusercontent.com/${source.repository}/${source.commit}/Cargo.lock`,
      { redirect: "error", signal: AbortSignal.timeout(60_000) },
    );
    const text = await boundedText(response, 2 * 1024 * 1024);
    const report = { ...(await scanRustLockfile(text)), role, source };
    for (const [name, bytes] of [
      [`${role}-Cargo.lock`, text],
      [`${role}-assessment.json`, JSON.stringify(report, null, 2) + "\n"],
    ]) {
      const target = path.join(directory, name);
      if (
        fs.existsSync(target) &&
        (fs.lstatSync(target).isSymbolicLink() ||
          fs.lstatSync(target).nlink !== 1)
      )
        throw new Error("native_build_path_invalid");
      fs.writeFileSync(target, bytes);
    }
    reports.push({
      role,
      sourceAuditOk: report.sourceAuditOk,
      packageCount: report.packageCount,
      findings: report.findings,
      unresolved: report.unresolved,
    });
  }
  return {
    ok: reports.every((report) => report.sourceAuditOk),
    artifactStatus: "NOT_VERIFIED",
    reports,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 2)
      throw new Error("unexpected_rust_assessment_arguments");
    const report = await assessRustSources();
    console.log(
      JSON.stringify({
        ...report,
        reports: report.reports.map(
          ({ role, sourceAuditOk, packageCount, findings, unresolved }) => ({
            role,
            sourceAuditOk,
            packageCount,
            advisoryMatchCount: findings.length,
            unresolvedSourceCount: unresolved.length,
          }),
        ),
      }),
    );
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

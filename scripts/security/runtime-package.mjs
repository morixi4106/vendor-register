import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectReachableLocations } from "./package-lock-graph.mjs";
import {
  inspectRuntimeToolchain,
  assertRuntimeToolchain,
} from "./runtime-toolchain.mjs";
import { TOOLCHAIN_TARGETS } from "./toolchain-targets.mjs";
import { runSafeBuildCommand } from "./safe-build.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FORBIDDEN = new Set([
  ...TOOLCHAIN_TARGETS,
  "@shopify/cli",
  "@shopify/shopify_function",
  "@shopify/ui-extensions",
]);
const sha = (value) =>
  crypto.createHash("sha256").update(value).digest("hex").toUpperCase();

export function createRuntimePackagePlan(manifest, lockfile) {
  const graph = collectReachableLocations(lockfile, {
    scopes: new Set(["root-production"]),
    includeOptionalPeers: true,
  });
  if (graph.unresolvedRequiredEdges.length)
    throw new Error("runtime_graph_unresolved");
  const runtimeManifest = {
    name: manifest.name,
    version: manifest.version,
    private: true,
    type: manifest.type,
    engines: manifest.engines,
    dependencies: manifest.dependencies,
    optionalDependencies: manifest.optionalDependencies,
    peerDependencies: manifest.peerDependencies,
    peerDependenciesMeta: manifest.peerDependenciesMeta,
    overrides: manifest.overrides,
  };
  const rootMetadata = {
    name: manifest.name,
    version: manifest.version,
    ...runtimeManifest,
  };
  delete rootMetadata.private;
  delete rootMetadata.type;
  delete rootMetadata.overrides;
  const packages = { "": rootMetadata };
  for (const location of [...graph.reachable].sort()) {
    if (!location) continue;
    if (
      !location.startsWith("node_modules/") ||
      location.split("/").includes("..")
    )
      throw new Error("unsafe_runtime_package_location");
    const metadata = lockfile.packages[location];
    if (!metadata || metadata.link || metadata.extraneous)
      throw new Error("unsafe_runtime_package_metadata");
    const name =
      metadata.name ||
      location.slice(
        location.lastIndexOf("node_modules/") + "node_modules/".length,
      );
    if (FORBIDDEN.has(name)) throw new Error("runtime_toolchain_not_clean");
    const copy = { ...metadata };
    delete copy.dev;
    delete copy.devOptional;
    packages[location] = copy;
  }
  const runtimeLockfile = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages,
  };
  return {
    manifest: runtimeManifest,
    lockfile: runtimeLockfile,
    manifestSha256: sha(JSON.stringify(runtimeManifest)),
    lockfileSha256: sha(JSON.stringify(runtimeLockfile)),
    packageCount: Object.keys(packages).length - 1,
  };
}

export function readRuntimePlan(root = ROOT) {
  return createRuntimePackagePlan(
    JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")),
    JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")),
  );
}

export function activateRuntimeDependencies(root, stage) {
  const resolvedRoot = fs.realpathSync(root);
  const target = path.join(resolvedRoot, "node_modules");
  const prepared = path.join(fs.realpathSync(stage), "node_modules");
  if (
    path.relative(resolvedRoot, target) !== "node_modules" ||
    prepared === target ||
    fs.lstatSync(prepared).isSymbolicLink()
  )
    throw new Error("unsafe_runtime_activation");
  if (
    fs.existsSync(target) &&
    (fs.lstatSync(target).isSymbolicLink() ||
      fs.realpathSync(target) !== target)
  )
    throw new Error("unsafe_runtime_activation");
  assertRuntimeToolchain(stage);
  if (!fs.existsSync(path.join(prepared, ".prisma/client/index.js")))
    throw new Error("runtime_prisma_client_missing");
  const auditDirectory = path.join(resolvedRoot, ".audit");
  fs.mkdirSync(auditDirectory, { recursive: true });
  if (fs.realpathSync(auditDirectory) !== auditDirectory)
    throw new Error("unsafe_runtime_activation");
  const suffix = crypto.randomUUID();
  const replacement = path.join(
    auditDirectory,
    `runtime-replacement-${suffix}`,
  );
  const backup = path.join(auditDirectory, `runtime-backup-${suffix}`);
  for (const location of [replacement, backup]) {
    if (path.dirname(location) !== auditDirectory || fs.existsSync(location))
      throw new Error("unsafe_runtime_activation");
  }
  let backedUp = false;
  let installed = false;
  let completed = false;
  try {
    fs.cpSync(prepared, replacement, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup);
      backedUp = true;
    }
    fs.renameSync(replacement, target);
    installed = true;
    const inspection = assertRuntimeToolchain(resolvedRoot);
    completed = true;
    return inspection;
  } catch (error) {
    if (installed) fs.rmSync(target, { recursive: true, force: true });
    if (backedUp) {
      fs.renameSync(backup, target);
      backedUp = false;
    }
    throw error;
  } finally {
    for (const location of [
      replacement,
      ...(!backedUp || completed ? [backup] : []),
    ]) {
      if (fs.existsSync(location)) {
        if (
          fs.lstatSync(location).isSymbolicLink() ||
          path.dirname(fs.realpathSync(location)) !== auditDirectory
        )
          throw new Error("unsafe_runtime_cleanup");
        fs.rmSync(location, { recursive: true, force: true });
      }
    }
  }
}

export function prepareRuntimePackage({
  root = ROOT,
  activate = false,
  runCommand = runSafeBuildCommand,
} = {}) {
  const plan = readRuntimePlan(root);
  if (fs.existsSync(path.join(root, ".audit/runtime-package-evidence.json"))) {
    const previous = path.join(root, ".audit/runtime-package-evidence.json");
    if (fs.lstatSync(previous).isSymbolicLink())
      throw new Error("runtime_evidence_unsafe");
    fs.unlinkSync(previous);
  }
  const tempBase = fs.realpathSync(os.tmpdir());
  const stage = fs.mkdtempSync(path.join(tempBase, "vendor-register-runtime-"));
  try {
    fs.writeFileSync(
      path.join(stage, "package.json"),
      JSON.stringify(plan.manifest, null, 2) + "\n",
    );
    fs.writeFileSync(
      path.join(stage, "package-lock.json"),
      JSON.stringify(plan.lockfile, null, 2) + "\n",
    );
    const npmCli = process.env.npm_execpath;
    if (!npmCli || !fs.existsSync(npmCli))
      throw new Error("npm_cli_unavailable");
    runCommand({
      args: [
        npmCli,
        "ci",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      cwd: stage,
      timeoutMs: 300_000,
    });
    fs.mkdirSync(path.join(stage, "prisma"));
    fs.copyFileSync(
      path.join(root, "prisma/schema.prisma"),
      path.join(stage, "prisma/schema.prisma"),
    );
    runCommand({
      args: [
        path.join(stage, "node_modules/prisma/build/index.js"),
        "generate",
        "--schema=prisma/schema.prisma",
      ],
      cwd: stage,
    });
    const installedLock = JSON.parse(
      fs.readFileSync(path.join(stage, "package-lock.json"), "utf8"),
    );
    if (sha(JSON.stringify(installedLock)) !== plan.lockfileSha256)
      throw new Error("runtime_lockfile_changed");
    const audit = runCommand({
      args: [npmCli, "audit", "--omit=dev", "--json"],
      cwd: stage,
      stdio: "pipe",
    });
    const auditReport = JSON.parse(audit.stdout);
    if (
      !auditReport.vulnerabilities ||
      Object.keys(auditReport.vulnerabilities).length ||
      auditReport.error
    )
      throw new Error("runtime_dependency_audit_failed");
    const inspection = inspectRuntimeToolchain(stage);
    if (!inspection.ok || inspection.packageCount < 1)
      throw new Error("runtime_toolchain_not_clean");
    const evidence = {
      schemaVersion: 1,
      ok: true,
      auditOk: true,
      packageCount: inspection.packageCount,
      forbiddenPackages: inspection.forbiddenPackages,
      manifestSha256: plan.manifestSha256,
      lockfileSha256: plan.lockfileSha256,
    };
    if (activate) activateRuntimeDependencies(root, stage);
    else {
      const output = path.join(root, ".audit/runtime-package-evidence.json");
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
    }
    return evidence;
  } finally {
    if (
      path.dirname(fs.realpathSync(stage)) !== tempBase ||
      !path.basename(stage).startsWith("vendor-register-runtime-")
    )
      throw new Error("unsafe_runtime_cleanup");
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length > 2)
      throw new Error("runtime_activation_requires_release_gate");
    console.log(JSON.stringify(prepareRuntimePackage()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

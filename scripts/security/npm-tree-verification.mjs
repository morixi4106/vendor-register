import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  collectReachableLocations,
  normalizePackageLocation,
  packageLocationsByName,
} from "./package-lock-graph.mjs";

export const DEFAULT_NPM_TREE_LIMITS = Object.freeze({
  maxBufferBytes: 20 * 1024 * 1024,
  maxJsonBytes: 20 * 1024 * 1024,
  timeoutMs: 120_000,
});

const TARGETS = Object.freeze({
  "brace-expansion": "2.1.4",
  minimatch: "9.0.9",
});

function mergeLimits(overrides = {}) {
  const limits = { ...DEFAULT_NPM_TREE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`npm tree limit ${name} is invalid.`);
    }
  }
  return limits;
}

function parseBoundedJson(source, description, maxJsonBytes) {
  const text = String(source || "");
  if (Buffer.byteLength(text, "utf8") > maxJsonBytes) {
    throw new Error(`${description} exceeded the JSON size limit.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${description} returned invalid JSON.`);
  }
}

function npmCommand() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return {
      argsPrefix: [npmExecPath],
      command: process.execPath,
    };
  }
  return {
    argsPrefix: [],
    command: process.platform === "win32" ? "npm.cmd" : "npm",
  };
}

export function runNpmJsonCommand(
  args,
  { cwd, description, limits: limitOverrides, spawn = spawnSync } = {},
) {
  const limits = mergeLimits(limitOverrides);
  const npm = npmCommand();
  const result = spawn(npm.command, [...npm.argsPrefix, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: limits.maxBufferBytes,
    shell: false,
    timeout: limits.timeoutMs,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`${description} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${description} failed with exit code ${result.status}.`);
  }
  return parseBoundedJson(result.stdout, description, limits.maxJsonBytes);
}

function normalizeQueryNode(node) {
  return {
    from: Array.isArray(node?.from)
      ? [...new Set(node.from.map(normalizePackageLocation))].sort()
      : [],
    location: normalizePackageLocation(node?.location),
    name: String(node?.name || ""),
    to: Array.isArray(node?.to)
      ? [...new Set(node.to.map(normalizePackageLocation))].sort()
      : [],
    version: String(node?.version || ""),
  };
}

function collectLsVersions(node, output = new Map()) {
  if (!node || typeof node !== "object") return output;
  for (const [name, dependency] of Object.entries(node.dependencies || {})) {
    if (TARGETS[name]) {
      if (!output.has(name)) output.set(name, new Set());
      output.get(name).add(String(dependency?.version || ""));
    }
    collectLsVersions(dependency, output);
  }
  return output;
}

function sbomComponentName(component) {
  const group = String(component?.group || "").trim();
  const name = String(component?.name || "").trim();
  return group ? `${group}/${name}` : name;
}

export function verifyNpmTreeEvidence({
  explainBrace,
  explainMinimatch,
  lockfile,
  lsTree,
  queryBrace,
  queryMinimatch,
  sbom,
}) {
  const errors = [];
  const queryByName = {
    "brace-expansion": queryBrace,
    minimatch: queryMinimatch,
  };
  const explainByName = {
    "brace-expansion": explainBrace,
    minimatch: explainMinimatch,
  };

  for (const [name, version] of Object.entries(TARGETS)) {
    const lockLocations = packageLocationsByName(lockfile, name);
    if (lockLocations.length !== 1) {
      errors.push(`${name}:lock_physical_count_mismatch`);
      continue;
    }
    if (
      String(lockfile.packages[lockLocations[0]]?.version || "") !== version
    ) {
      errors.push(`${name}:lock_version_mismatch`);
    }

    const queryNodes = Array.isArray(queryByName[name])
      ? queryByName[name].map(normalizeQueryNode)
      : [];
    if (queryNodes.length !== 1) {
      errors.push(`${name}:npm_query_physical_count_mismatch`);
    } else {
      const node = queryNodes[0];
      if (
        node.location !== lockLocations[0] ||
        node.name !== name ||
        node.version !== version
      ) {
        errors.push(`${name}:npm_query_node_mismatch`);
      }
    }

    const explainNodes = Array.isArray(explainByName[name])
      ? explainByName[name].map(normalizeQueryNode)
      : [];
    if (
      explainNodes.length !== 1 ||
      explainNodes[0]?.location !== lockLocations[0] ||
      explainNodes[0]?.name !== name ||
      explainNodes[0]?.version !== version
    ) {
      errors.push(`${name}:npm_explain_node_mismatch`);
    }
  }

  const minimatchNode = Array.isArray(queryMinimatch)
    ? queryMinimatch.map(normalizeQueryNode)[0]
    : null;
  const braceNode = Array.isArray(queryBrace)
    ? queryBrace.map(normalizeQueryNode)[0]
    : null;
  if (!minimatchNode?.to.includes("node_modules/brace-expansion")) {
    errors.push("minimatch:brace_child_missing");
  }
  if (!braceNode?.from.includes("node_modules/minimatch")) {
    errors.push("brace-expansion:minimatch_parent_missing");
  }

  const lsVersions = collectLsVersions(lsTree);
  for (const [name, version] of Object.entries(TARGETS)) {
    const versions = [...(lsVersions.get(name) || [])].sort();
    if (versions.length !== 1 || versions[0] !== version) {
      errors.push(`${name}:npm_ls_version_mismatch`);
    }
  }

  const rootRuntime = collectReachableLocations(lockfile, {
    scopes: new Set(["root-production"]),
  });
  for (const name of Object.keys(TARGETS)) {
    const runtimeLocations = packageLocationsByName(lockfile, name).filter(
      (location) => rootRuntime.reachable.has(location),
    );
    if (runtimeLocations.length > 0) {
      errors.push(`${name}:root_runtime_reachable`);
    }
  }

  const sbomComponents = Array.isArray(sbom?.components) ? sbom.components : [];
  const sbomTargets = sbomComponents
    .map((component) => ({
      name: sbomComponentName(component),
      version: String(component?.version || ""),
    }))
    .filter((component) => TARGETS[component.name]);
  if (sbomTargets.length > 0) {
    errors.push("toolchain_target_present_in_production_sbom");
  }
  const lockfileRootName = String(
    lockfile?.name || lockfile?.packages?.[""]?.name || "",
  );
  const lockfileRootVersion = String(
    lockfile?.version || lockfile?.packages?.[""]?.version || "",
  );
  const expectedRootBomRef = `${lockfileRootName}@${lockfileRootVersion}`;
  if (
    !lockfileRootName ||
    !lockfileRootVersion ||
    String(sbom?.metadata?.component?.["bom-ref"] || "") !==
      expectedRootBomRef ||
    String(sbom?.metadata?.component?.version || "") !== lockfileRootVersion
  ) {
    errors.push("production_sbom_root_mismatch");
  }

  return {
    errors: [...new Set(errors)].sort(),
    ok: errors.length === 0,
    summary: {
      braceExpansionPhysicalCount: packageLocationsByName(
        lockfile,
        "brace-expansion",
      ).length,
      minimatchPhysicalCount: packageLocationsByName(lockfile, "minimatch")
        .length,
      productionSbomComponentCount: sbomComponents.length,
      rootRuntimeToolchainCount: Object.keys(TARGETS).filter((name) =>
        packageLocationsByName(lockfile, name).some((location) =>
          rootRuntime.reachable.has(location),
        ),
      ).length,
    },
  };
}

export function collectNpmTreeEvidence({
  cwd,
  limits,
  lockfile,
  run = runNpmJsonCommand,
}) {
  const execute = (args, description) =>
    run(args, {
      cwd,
      description,
      limits,
    });
  const evidence = {
    explainBrace: execute(
      ["explain", "brace-expansion", "--json"],
      "npm explain brace-expansion",
    ),
    explainMinimatch: execute(
      ["explain", "minimatch", "--json"],
      "npm explain minimatch",
    ),
    lsTree: execute(
      ["ls", "minimatch", "brace-expansion", "--all", "--json"],
      "npm ls toolchain targets",
    ),
    queryBrace: execute(
      ["query", "#brace-expansion"],
      "npm query brace-expansion",
    ),
    queryMinimatch: execute(["query", "#minimatch"], "npm query minimatch"),
    sbom: execute(
      ["sbom", "--omit=dev", "--sbom-format", "cyclonedx"],
      "npm production SBOM",
    ),
  };
  return verifyNpmTreeEvidence({
    ...evidence,
    lockfile,
  });
}

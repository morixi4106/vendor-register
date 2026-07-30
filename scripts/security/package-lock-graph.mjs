import { createHash } from "node:crypto";
import path from "node:path";

const EDGE_GROUPS = [
  ["dependency", "dependencies"],
  ["optionalDependency", "optionalDependencies"],
  ["peerDependency", "peerDependencies"],
];

export const DEFAULT_GRAPH_LIMITS = Object.freeze({
  maxDepth: 256,
  maxEdges: 250_000,
  maxNodes: 50_000,
  maxPathBytes: 256 * 1024,
  maxPaths: 10_000,
  timeoutMs: 120_000,
});

function graphError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function normalizePackageLocation(value) {
  const normalized = String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");

  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw graphError(
      "UNSAFE_PACKAGE_LOCATION",
      `Unsafe package location: ${normalized}`,
    );
  }

  return normalized;
}

function mergeLimits(overrides = {}) {
  const limits = { ...DEFAULT_GRAPH_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw graphError(
        "INVALID_GRAPH_LIMIT",
        `Graph limit ${name} must be a positive safe integer.`,
      );
    }
  }
  return limits;
}

function createGraphState(lockfile, overrides, clock = Date.now) {
  if (lockfile?.lockfileVersion !== 3) {
    throw graphError(
      "UNSUPPORTED_LOCKFILE_VERSION",
      "Only npm package-lock version 3 is supported.",
    );
  }

  const packages = lockfile?.packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    throw graphError(
      "INVALID_PACKAGES_GRAPH",
      "package-lock.json does not contain a packages graph.",
    );
  }

  const limits = mergeLimits(overrides);
  const packageLocations = Object.keys(packages);
  if (packageLocations.length > limits.maxNodes) {
    throw graphError(
      "GRAPH_NODE_LIMIT_EXCEEDED",
      `Dependency node count exceeded the safety limit (${limits.maxNodes}).`,
    );
  }

  for (const location of packageLocations) {
    normalizePackageLocation(location);
    const metadata = packages[location];
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw graphError(
        "INVALID_PACKAGE_METADATA",
        `Package metadata is invalid at ${location || "(root)"}.`,
      );
    }
  }

  return {
    clock,
    deadline: clock() + limits.timeoutMs,
    edgeCount: 0,
    limits,
    packages,
  };
}

function assertGraphBudget(state) {
  if (state.clock() > state.deadline) {
    throw graphError(
      "GRAPH_TIMEOUT",
      "Dependency graph analysis exceeded its time limit.",
    );
  }
}

function countEdge(state) {
  state.edgeCount += 1;
  if (state.edgeCount > state.limits.maxEdges) {
    throw graphError(
      "GRAPH_EDGE_LIMIT_EXCEEDED",
      `Dependency edge count exceeded the safety limit (${state.limits.maxEdges}).`,
    );
  }
}

function resolveLinkedLocation(packages, location) {
  let current = normalizePackageLocation(location);
  const visited = new Set();

  while (packages[current]?.link === true) {
    if (visited.has(current)) {
      throw graphError(
        "CYCLIC_PACKAGE_LINK",
        `Cyclic package link detected at ${current}.`,
      );
    }
    visited.add(current);

    const resolved = packages[current]?.resolved;
    if (typeof resolved !== "string" || resolved.length === 0) {
      throw graphError(
        "UNRESOLVED_PACKAGE_LINK",
        `Package link ${current} has no resolved target.`,
      );
    }
    current = normalizePackageLocation(resolved);
    if (!packages[current]) {
      throw graphError(
        "MISSING_PACKAGE_LINK_TARGET",
        `Package link ${location} points to missing target ${current}.`,
      );
    }
  }

  return current;
}

export function getPackageName(location, metadata = {}) {
  if (metadata.name) return metadata.name;

  const normalized = normalizePackageLocation(location);
  const marker = "/node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  const tail =
    markerIndex >= 0
      ? normalized.slice(markerIndex + marker.length)
      : normalized.replace(/^node_modules\//, "");
  const parts = tail.split("/");

  if (parts[0]?.startsWith("@")) {
    return parts[1] ? `${parts[0]}/${parts[1]}` : parts[0];
  }

  return parts[0] || "";
}

export function resolveDependencyLocation(
  packages,
  fromLocation,
  dependencyName,
) {
  let current = normalizePackageLocation(fromLocation);

  while (true) {
    const candidate = path.posix.join(current, "node_modules", dependencyName);
    if (packages[candidate]) {
      return resolveLinkedLocation(packages, candidate);
    }
    if (!current) return null;

    const parent = path.posix.dirname(current);
    current = parent === "." ? "" : parent;
  }
}

function getDependencyEdges(state, location) {
  assertGraphBudget(state);
  const metadata = state.packages[location] || {};
  const edges = new Map();

  for (const [edgeType, property] of EDGE_GROUPS) {
    const dependencies = metadata[property] || {};
    if (typeof dependencies !== "object" || Array.isArray(dependencies)) {
      throw graphError(
        "INVALID_DEPENDENCY_MAP",
        `Invalid ${property} at ${location || "(root)"}.`,
      );
    }

    for (const dependencyName of Object.keys(dependencies).sort()) {
      countEdge(state);
      const isOptionalPeer =
        edgeType === "peerDependency" &&
        metadata.peerDependenciesMeta?.[dependencyName]?.optional === true;
      const effectiveType = isOptionalPeer ? "peerOptional" : edgeType;
      const key = `${dependencyName}:${effectiveType}`;
      if (edges.has(key)) continue;

      edges.set(key, {
        dependencyName,
        edgeType: effectiveType,
        optional: edgeType === "optionalDependency" || isOptionalPeer,
        resolvedLocation: resolveDependencyLocation(
          state.packages,
          location,
          dependencyName,
        ),
      });
    }
  }

  return [...edges.values()];
}

function workspaceLocations(lockfile) {
  const packages = lockfile?.packages || {};
  return Object.keys(packages)
    .filter(
      (location) =>
        location &&
        !normalizePackageLocation(location).includes("node_modules") &&
        packages[location] &&
        packages[location].link !== true,
    )
    .sort();
}

function addDependencyEntries({
  dependencies,
  entries,
  fromLocation,
  optional = false,
  packages,
  peerDependenciesMeta,
  rootEdgeType,
  scope,
}) {
  if (!dependencies) return;
  if (typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw graphError(
      "INVALID_DEPENDENCY_MAP",
      `Invalid dependency map at ${fromLocation || "(root)"}.`,
    );
  }

  for (const dependencyName of Object.keys(dependencies).sort()) {
    const key = `${scope}:${rootEdgeType}:${dependencyName}`;
    if (entries.has(key)) continue;
    entries.set(key, {
      dependencyName,
      optional:
        optional || peerDependenciesMeta?.[dependencyName]?.optional === true,
      resolvedLocation: resolveDependencyLocation(
        packages,
        fromLocation,
        dependencyName,
      ),
      rootEdgeType,
      scope,
    });
  }
}

export function createDependencyEntries(
  lockfile,
  { limits, state: existingState } = {},
) {
  const state = existingState || createGraphState(lockfile, limits);
  const root = state.packages[""] || {};
  const entries = new Map();
  const add = (input) =>
    addDependencyEntries({
      ...input,
      entries,
      packages: state.packages,
    });

  add({
    dependencies: root.dependencies,
    fromLocation: "",
    rootEdgeType: "dependency",
    scope: "root-production",
  });
  add({
    dependencies: root.optionalDependencies,
    fromLocation: "",
    optional: true,
    rootEdgeType: "optionalDependency",
    scope: "root-production",
  });
  add({
    dependencies: root.peerDependencies,
    fromLocation: "",
    peerDependenciesMeta: root.peerDependenciesMeta,
    rootEdgeType: "peerDependency",
    scope: "root-production",
  });
  add({
    dependencies: root.devDependencies,
    fromLocation: "",
    rootEdgeType: "devDependency",
    scope: "root-development",
  });

  for (const location of workspaceLocations(lockfile)) {
    const metadata = state.packages[location] || {};
    add({
      dependencies: metadata.dependencies,
      fromLocation: location,
      rootEdgeType: "dependency",
      scope: `workspace:${location}`,
    });
    add({
      dependencies: metadata.optionalDependencies,
      fromLocation: location,
      optional: true,
      rootEdgeType: "optionalDependency",
      scope: `workspace:${location}`,
    });
    add({
      dependencies: metadata.peerDependencies,
      fromLocation: location,
      peerDependenciesMeta: metadata.peerDependenciesMeta,
      rootEdgeType: "peerDependency",
      scope: `workspace:${location}`,
    });
    add({
      dependencies: metadata.devDependencies,
      fromLocation: location,
      rootEdgeType: "devDependency",
      scope: `workspace-development:${location}`,
    });
  }

  return [...entries.values()].sort((left, right) =>
    `${left.scope}:${left.rootEdgeType}:${left.dependencyName}`.localeCompare(
      `${right.scope}:${right.rootEdgeType}:${right.dependencyName}`,
    ),
  );
}

function nodeDescriptor(packages, location) {
  const metadata = packages[location] || {};
  return {
    dev: metadata.dev === true,
    devOptional: metadata.devOptional === true,
    extraneous: metadata.extraneous === true,
    inBundle: metadata.inBundle === true,
    location: normalizePackageLocation(location),
    name: getPackageName(location, metadata),
    optional: metadata.optional === true,
    version: metadata.version || null,
  };
}

export function serializeDependencyPath(dependencyPath) {
  const nodeText = dependencyPath.nodes
    .map(
      (node) =>
        `${node.name}@${node.version || "(workspace)"}[${normalizePackageLocation(
          node.location,
        )}]`,
    )
    .join(" -> ");
  return `${dependencyPath.scope}|${nodeText}|${dependencyPath.edgeTypes.join(
    " -> ",
  )}`;
}

export function canonicalDependencyPathLines(paths) {
  return [...new Set(paths.map(serializeDependencyPath))].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
}

export function hashDependencyPathLines(lines) {
  const canonical = [...new Set(lines.map(String))].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  return createHash("sha256")
    .update(canonical.join("\n"), "utf8")
    .digest("hex")
    .toUpperCase();
}

export function hashDependencyPaths(paths) {
  return hashDependencyPathLines(canonicalDependencyPathLines(paths));
}

export function enumerateDependencyPaths(
  lockfile,
  {
    clock = Date.now,
    includeOptionalPeers = false,
    limits,
    maxPaths,
    targetName,
    targetVersion = null,
  },
) {
  const effectiveLimits = {
    ...(limits || {}),
    ...(maxPaths === undefined ? {} : { maxPaths }),
  };
  const state = createGraphState(lockfile, effectiveLimits, clock);
  const paths = [];
  const unresolvedRequiredEdges = [];
  const cycles = [];

  const visit = ({ active, depth, edgeTypes, entry, location, nodes }) => {
    assertGraphBudget(state);
    if (depth > state.limits.maxDepth) {
      throw graphError(
        "GRAPH_DEPTH_LIMIT_EXCEEDED",
        `Dependency depth exceeded the safety limit (${state.limits.maxDepth}).`,
      );
    }
    if (!location) {
      if (!entry.optional) {
        unresolvedRequiredEdges.push({
          dependencyName: entry.dependencyName,
          fromLocation: "",
          scope: entry.scope,
        });
      }
      return;
    }

    const effectiveLocation = resolveLinkedLocation(state.packages, location);
    const descriptor = nodeDescriptor(state.packages, effectiveLocation);
    const nextNodes = [...nodes, descriptor];
    const versionMatches =
      targetVersion === null || descriptor.version === targetVersion;

    if (descriptor.name === targetName && versionMatches) {
      const dependencyPath = {
        edgeTypes,
        nodes: nextNodes,
        scope: entry.scope,
      };
      const serializedBytes = Buffer.byteLength(
        serializeDependencyPath(dependencyPath),
        "utf8",
      );
      if (serializedBytes > state.limits.maxPathBytes) {
        throw graphError(
          "GRAPH_PATH_SIZE_LIMIT_EXCEEDED",
          `Dependency path exceeded the safety limit (${state.limits.maxPathBytes} bytes).`,
        );
      }
      paths.push(dependencyPath);
      if (paths.length > state.limits.maxPaths) {
        throw graphError(
          "GRAPH_PATH_LIMIT_EXCEEDED",
          `Dependency path count exceeded the safety limit (${state.limits.maxPaths}).`,
        );
      }
    }

    if (active.has(effectiveLocation)) {
      cycles.push([...active, effectiveLocation]);
      return;
    }
    const nextActive = new Set(active);
    nextActive.add(effectiveLocation);

    for (const edge of getDependencyEdges(state, effectiveLocation)) {
      if (edge.edgeType === "peerOptional" && !includeOptionalPeers) continue;
      if (!edge.resolvedLocation) {
        if (!edge.optional) {
          unresolvedRequiredEdges.push({
            dependencyName: edge.dependencyName,
            fromLocation: effectiveLocation,
            scope: entry.scope,
          });
        }
        continue;
      }

      visit({
        active: nextActive,
        depth: depth + 1,
        edgeTypes: [...edgeTypes, edge.edgeType],
        entry,
        location: edge.resolvedLocation,
        nodes: nextNodes,
      });
    }
  };

  for (const entry of createDependencyEntries(lockfile, { state })) {
    visit({
      active: new Set(),
      depth: 1,
      edgeTypes: [entry.rootEdgeType],
      entry,
      location: entry.resolvedLocation,
      nodes: [],
    });
  }

  const uniquePaths = [
    ...new Map(
      paths.map((dependencyPath) => [
        serializeDependencyPath(dependencyPath),
        dependencyPath,
      ]),
    ).values(),
  ].sort((left, right) =>
    serializeDependencyPath(left).localeCompare(
      serializeDependencyPath(right),
      "en",
    ),
  );

  return {
    cycles,
    pathLines: canonicalDependencyPathLines(uniquePaths),
    paths: uniquePaths,
    pathSetSha256: hashDependencyPaths(uniquePaths),
    unresolvedRequiredEdges: [
      ...new Map(
        unresolvedRequiredEdges.map((edge) => [
          `${edge.scope}:${edge.fromLocation}:${edge.dependencyName}`,
          edge,
        ]),
      ).values(),
    ].sort((left, right) =>
      `${left.scope}:${left.fromLocation}:${left.dependencyName}`.localeCompare(
        `${right.scope}:${right.fromLocation}:${right.dependencyName}`,
        "en",
      ),
    ),
  };
}

export function collectReachableLocations(
  lockfile,
  {
    clock = Date.now,
    includeOptionalPeers = false,
    limits,
    scopes = new Set(["root-production"]),
  } = {},
) {
  const state = createGraphState(lockfile, limits, clock);
  const reachable = new Set();
  const unresolvedRequiredEdges = [];
  const queue = createDependencyEntries(lockfile, { state })
    .filter((entry) => scopes.has(entry.scope))
    .map((entry) => ({
      dependencyName: entry.dependencyName,
      fromLocation: "",
      location: entry.resolvedLocation,
      optional: entry.optional,
      scope: entry.scope,
    }));
  let cursor = 0;

  while (cursor < queue.length) {
    assertGraphBudget(state);
    const current = queue[cursor];
    cursor += 1;
    if (!current.location) {
      if (!current.optional) {
        unresolvedRequiredEdges.push({
          dependencyName: current.dependencyName,
          fromLocation: current.fromLocation,
          scope: current.scope,
        });
      }
      continue;
    }

    const effectiveLocation = resolveLinkedLocation(
      state.packages,
      current.location,
    );
    if (reachable.has(effectiveLocation)) continue;
    if (reachable.size >= state.limits.maxNodes) {
      throw graphError(
        "GRAPH_NODE_LIMIT_EXCEEDED",
        `Reachable node count exceeded the safety limit (${state.limits.maxNodes}).`,
      );
    }

    reachable.add(effectiveLocation);
    for (const edge of getDependencyEdges(state, effectiveLocation)) {
      if (edge.edgeType === "peerOptional" && !includeOptionalPeers) continue;
      queue.push({
        dependencyName: edge.dependencyName,
        fromLocation: effectiveLocation,
        location: edge.resolvedLocation,
        optional: edge.optional,
        scope: current.scope,
      });
    }
  }

  return {
    reachable,
    unresolvedRequiredEdges,
  };
}

export function packageLocationsByName(lockfile, packageName, { limits } = {}) {
  const state = createGraphState(lockfile, limits);
  return Object.entries(state.packages)
    .filter(([location, metadata]) => {
      if (!location) return false;
      const effectiveLocation = resolveLinkedLocation(state.packages, location);
      return (
        effectiveLocation === location &&
        getPackageName(location, metadata) === packageName
      );
    })
    .map(([location]) => normalizePackageLocation(location))
    .sort((left, right) => left.localeCompare(right, "en"));
}

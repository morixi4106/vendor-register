import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalDependencyPathLines,
  collectReachableLocations,
  createDependencyEntries,
  enumerateDependencyPaths,
  getPackageName,
  hashDependencyPathLines,
  normalizePackageLocation,
  packageLocationsByName,
  resolveDependencyLocation,
  serializeDependencyPath,
} from "../../scripts/security/package-lock-graph.mjs";

function baseLockfile() {
  return {
    lockfileVersion: 3,
    packages: {
      "": {
        dependencies: {
          "alias-target": "npm:target@1.0.0",
          "local-file": "file:packages/local-file",
          prod: "1.0.0",
          "test-workspace": "file:extensions/test",
        },
        devDependencies: {
          devtool: "1.0.0",
        },
        optionalDependencies: {
          optionalRoot: "1.0.0",
        },
      },
      "extensions/test": {
        dependencies: {
          target: "1.0.0",
        },
        devDependencies: {
          devtool: "1.0.0",
        },
        name: "test-workspace",
        version: "1.0.0",
      },
      "node_modules/alias-target": {
        name: "target",
        version: "1.0.0",
      },
      "node_modules/cycle-a": {
        dependencies: {
          "cycle-b": "1.0.0",
        },
        version: "1.0.0",
      },
      "node_modules/cycle-b": {
        dependencies: {
          "cycle-a": "1.0.0",
        },
        version: "1.0.0",
      },
      "node_modules/devtool": {
        devOptional: true,
        version: "1.0.0",
      },
      "node_modules/local-file": {
        dependencies: {
          target: "1.0.0",
        },
        resolved: "file:packages/local-file",
        version: "1.0.0",
      },
      "node_modules/optionalRoot": {
        optional: true,
        version: "1.0.0",
      },
      "node_modules/prod": {
        dependencies: {
          "cycle-a": "1.0.0",
          target: "2.0.0",
        },
        peerDependencies: {
          "@scope/peer": "1.0.0",
          missingOptionalPeer: "1.0.0",
        },
        peerDependenciesMeta: {
          missingOptionalPeer: {
            optional: true,
          },
        },
        version: "1.0.0",
      },
      "node_modules/prod/node_modules/target": {
        version: "2.0.0",
      },
      "node_modules/@scope/peer": {
        version: "1.0.0",
      },
      "node_modules/target": {
        version: "1.0.0",
      },
      "node_modules/test-workspace": {
        link: true,
        resolved: "extensions/test",
      },
    },
  };
}

test("normalizes platform separators and rejects unsafe locations", () => {
  assert.equal(
    normalizePackageLocation(
      "node_modules\\@scope\\package\\node_modules\\target",
    ),
    "node_modules/@scope/package/node_modules/target",
  );
  assert.throws(
    () => normalizePackageLocation("../outside"),
    /Unsafe package location/,
  );
  assert.throws(
    () => normalizePackageLocation("C:\\outside"),
    /Unsafe package location/,
  );
});

test("derives scoped and unscoped package names", () => {
  assert.equal(
    getPackageName("node_modules/@scope/package", {}),
    "@scope/package",
  );
  assert.equal(
    getPackageName("node_modules/alias", { name: "target" }),
    "target",
  );
});

test("resolves nested dependencies and workspace links", () => {
  const lockfile = baseLockfile();
  assert.equal(
    resolveDependencyLocation(lockfile.packages, "node_modules/prod", "target"),
    "node_modules/prod/node_modules/target",
  );
  assert.equal(
    resolveDependencyLocation(lockfile.packages, "", "test-workspace"),
    "extensions/test",
  );
});

test("classifies root, optional, development, and workspace entries", () => {
  const entries = createDependencyEntries(baseLockfile());
  assert.ok(
    entries.some(
      (entry) =>
        entry.dependencyName === "prod" &&
        entry.scope === "root-production" &&
        entry.rootEdgeType === "dependency",
    ),
  );
  assert.ok(
    entries.some(
      (entry) =>
        entry.dependencyName === "optionalRoot" &&
        entry.optional === true &&
        entry.rootEdgeType === "optionalDependency",
    ),
  );
  assert.ok(
    entries.some(
      (entry) =>
        entry.dependencyName === "devtool" &&
        entry.scope === "root-development",
    ),
  );
  assert.ok(
    entries.some(
      (entry) =>
        entry.dependencyName === "target" &&
        entry.scope === "workspace:extensions/test",
    ),
  );
});

test("enumerates alias, file, nested duplicate, peer, and workspace paths", () => {
  const report = enumerateDependencyPaths(baseLockfile(), {
    targetName: "target",
  });
  const lines = report.pathLines.join("\n");

  assert.match(
    lines,
    /root-production\|target@1\.0\.0\[node_modules\/alias-target\]/,
  );
  assert.match(lines, /local-file@1\.0\.0.*target@1\.0\.0/s);
  assert.match(lines, /prod@1\.0\.0.*target@2\.0\.0/s);
  assert.match(lines, /workspace:extensions\/test\|target@1\.0\.0/);
  assert.equal(report.unresolvedRequiredEdges.length, 0);
  assert.ok(report.cycles.length > 0);
});

test("optional peers are skipped unless explicitly included", () => {
  const withoutOptional = enumerateDependencyPaths(baseLockfile(), {
    targetName: "missingOptionalPeer",
  });
  assert.equal(withoutOptional.unresolvedRequiredEdges.length, 0);

  const withOptional = enumerateDependencyPaths(baseLockfile(), {
    includeOptionalPeers: true,
    targetName: "missingOptionalPeer",
  });
  assert.equal(withOptional.unresolvedRequiredEdges.length, 0);
});

test("reports a missing required node", () => {
  const lockfile = baseLockfile();
  lockfile.packages["node_modules/prod"].dependencies.missing = "1.0.0";
  const report = enumerateDependencyPaths(lockfile, {
    targetName: "target",
  });
  assert.ok(
    report.unresolvedRequiredEdges.some(
      (edge) =>
        edge.fromLocation === "node_modules/prod" &&
        edge.dependencyName === "missing",
    ),
  );
});

test("deduplicates and hashes canonical path lines independent of order", () => {
  const first = {
    edgeTypes: ["dependency"],
    nodes: [
      {
        location: "node_modules\\target",
        name: "target",
        version: "1.0.0",
      },
    ],
    scope: "root-production",
  };
  const second = {
    edgeTypes: ["devDependency"],
    nodes: [
      {
        location: "node_modules/target",
        name: "target",
        version: "1.0.0",
      },
    ],
    scope: "root-development",
  };
  const canonical = canonicalDependencyPathLines([second, first, first]);

  assert.equal(canonical.length, 2);
  assert.equal(canonical[0], serializeDependencyPath(second));
  assert.equal(
    hashDependencyPathLines(canonical),
    hashDependencyPathLines([...canonical].reverse()),
  );
});

test("collects root runtime reachability without dev-only nodes", () => {
  const result = collectReachableLocations(baseLockfile());
  assert.ok(result.reachable.has("node_modules/prod"));
  assert.ok(result.reachable.has("node_modules/prod/node_modules/target"));
  assert.ok(!result.reachable.has("node_modules/devtool"));
});

test("finds duplicate versions and npm aliases by their actual package name", () => {
  const locations = packageLocationsByName(baseLockfile(), "target");
  assert.deepEqual(locations, [
    "node_modules/alias-target",
    "node_modules/prod/node_modules/target",
    "node_modules/target",
  ]);
});

test("fails closed for malformed and unsupported lockfiles", () => {
  assert.throws(
    () => enumerateDependencyPaths({}, { targetName: "target" }),
    (error) => error.code === "UNSUPPORTED_LOCKFILE_VERSION",
  );
  assert.throws(
    () =>
      enumerateDependencyPaths(
        { lockfileVersion: 2, packages: {} },
        { targetName: "target" },
      ),
    (error) => error.code === "UNSUPPORTED_LOCKFILE_VERSION",
  );
  assert.throws(
    () =>
      enumerateDependencyPaths(
        { lockfileVersion: 3, packages: [] },
        { targetName: "target" },
      ),
    (error) => error.code === "INVALID_PACKAGES_GRAPH",
  );
});

test("fails closed when graph safety limits are exceeded", () => {
  const lockfile = baseLockfile();
  assert.throws(
    () =>
      enumerateDependencyPaths(lockfile, {
        limits: { maxNodes: 2 },
        targetName: "target",
      }),
    (error) => error.code === "GRAPH_NODE_LIMIT_EXCEEDED",
  );
  assert.throws(
    () =>
      enumerateDependencyPaths(lockfile, {
        limits: { maxEdges: 1 },
        targetName: "target",
      }),
    (error) => error.code === "GRAPH_EDGE_LIMIT_EXCEEDED",
  );
  assert.throws(
    () =>
      enumerateDependencyPaths(lockfile, {
        limits: { maxDepth: 1 },
        targetName: "target",
      }),
    (error) => error.code === "GRAPH_DEPTH_LIMIT_EXCEEDED",
  );
  assert.throws(
    () =>
      enumerateDependencyPaths(lockfile, {
        limits: { maxPathBytes: 10 },
        targetName: "target",
      }),
    (error) => error.code === "GRAPH_PATH_SIZE_LIMIT_EXCEEDED",
  );
  assert.throws(
    () =>
      enumerateDependencyPaths(lockfile, {
        limits: { maxPaths: 1 },
        targetName: "target",
      }),
    (error) => error.code === "GRAPH_PATH_LIMIT_EXCEEDED",
  );
});

test("fails closed for invalid limits, metadata, and dependency maps", () => {
  const base = {
    lockfileVersion: 3,
    packages: {
      "": {
        dependencies: {
          target: "1.0.0",
        },
      },
      "node_modules/target": {
        name: "target",
        version: "1.0.0",
      },
    },
  };
  assert.throws(
    () =>
      enumerateDependencyPaths(base, {
        limits: { maxNodes: 0 },
        targetName: "target",
      }),
    (error) => error.code === "INVALID_GRAPH_LIMIT",
  );

  const metadata = structuredClone(base);
  metadata.packages["node_modules/target"] = null;
  assert.throws(
    () =>
      enumerateDependencyPaths(metadata, {
        targetName: "target",
      }),
    (error) => error.code === "INVALID_PACKAGE_METADATA",
  );

  const dependencyMap = structuredClone(base);
  dependencyMap.packages[""].dependencies = [];
  assert.throws(
    () =>
      enumerateDependencyPaths(dependencyMap, {
        targetName: "target",
      }),
    (error) => error.code === "INVALID_DEPENDENCY_MAP",
  );
});

test("fails closed for timeout, depth, path size, and path count limits", () => {
  const lockfile = {
    lockfileVersion: 3,
    packages: {
      "": {
        dependencies: {
          first: "1.0.0",
          second: "1.0.0",
        },
      },
      "node_modules/first": {
        dependencies: {
          target: "1.0.0",
        },
        name: "first",
        version: "1.0.0",
      },
      "node_modules/second": {
        dependencies: {
          target: "1.0.0",
        },
        name: "second",
        version: "1.0.0",
      },
      "node_modules/target": {
        name: "target",
        version: "1.0.0",
      },
    },
  };
  let ticks = 0;
  assert.throws(
    () =>
      enumerateDependencyPaths(lockfile, {
        clock: () => {
          ticks += 1;
          return ticks === 1 ? 0 : 2;
        },
        limits: { timeoutMs: 1 },
        targetName: "target",
      }),
    (error) => error.code === "GRAPH_TIMEOUT",
  );
  assert.throws(
    () =>
      enumerateDependencyPaths(lockfile, {
        limits: { maxDepth: 1 },
        targetName: "target",
      }),
    (error) => error.code === "GRAPH_DEPTH_LIMIT_EXCEEDED",
  );
  assert.throws(
    () =>
      enumerateDependencyPaths(lockfile, {
        limits: { maxPathBytes: 10 },
        targetName: "target",
      }),
    (error) => error.code === "GRAPH_PATH_SIZE_LIMIT_EXCEEDED",
  );
  assert.throws(
    () =>
      enumerateDependencyPaths(lockfile, {
        limits: { maxPaths: 1 },
        targetName: "target",
      }),
    (error) => error.code === "GRAPH_PATH_LIMIT_EXCEEDED",
  );
});

test("fails closed when reachable-node limits are exceeded", () => {
  const lockfile = {
    lockfileVersion: 3,
    packages: {
      "": {
        dependencies: {
          first: "1.0.0",
        },
      },
      "node_modules/first": {
        dependencies: {
          second: "1.0.0",
        },
        name: "first",
        version: "1.0.0",
      },
      "node_modules/second": {
        name: "second",
        version: "1.0.0",
      },
    },
  };
  assert.throws(
    () =>
      collectReachableLocations(lockfile, {
        limits: { maxNodes: 1 },
      }),
    (error) => error.code === "GRAPH_NODE_LIMIT_EXCEEDED",
  );
});

test("fails closed for a linked package without a resolved target", () => {
  const lockfile = {
    lockfileVersion: 3,
    packages: {
      "": {
        dependencies: {
          workspace: "file:workspace",
        },
      },
      "node_modules/workspace": {
        link: true,
      },
    },
  };
  assert.throws(
    () =>
      enumerateDependencyPaths(lockfile, {
        targetName: "target",
      }),
    (error) => error.code === "UNRESOLVED_PACKAGE_LINK",
  );
});

test("fails closed for missing and cyclic workspace link targets", () => {
  const missing = baseLockfile();
  missing.packages["node_modules/test-workspace"].resolved =
    "extensions/missing";
  assert.throws(
    () => createDependencyEntries(missing),
    (error) => error.code === "MISSING_PACKAGE_LINK_TARGET",
  );

  const cyclic = baseLockfile();
  cyclic.packages["extensions/test"].link = true;
  cyclic.packages["extensions/test"].resolved = "node_modules/test-workspace";
  assert.throws(
    () => createDependencyEntries(cyclic),
    (error) => error.code === "CYCLIC_PACKAGE_LINK",
  );
});

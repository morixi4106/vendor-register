import { isDeepStrictEqual } from "node:util";
import semver from "semver";
import { createRuntimePackagePlan } from "./runtime-package.mjs";

export const AUTO_PATCH_DEPENDENCIES = Object.freeze([
  "prettier",
  "@types/eslint",
  "@types/node",
  "@types/react",
  "@types/react-dom",
]);

export function classifyMaintenanceCandidate({
  paths,
  beforeManifest,
  afterManifest,
  beforeLock,
  afterLock,
  allowBatch = false,
}) {
  try {
    if (
      !Array.isArray(paths) ||
      !paths.length ||
      paths.some((p) => !["package.json", "package-lock.json"].includes(p))
    )
      return { eligible: false, reason: "protected_files_changed" };
    const { devDependencies: beforeDev, ...beforeProtected } = beforeManifest;
    const { devDependencies: afterDev, ...afterProtected } = afterManifest;
    if (
      !isDeepStrictEqual(beforeProtected, afterProtected) ||
      !isDeepStrictEqual(
        Object.keys(beforeDev).sort(),
        Object.keys(afterDev).sort(),
      )
    )
      return { eligible: false, reason: "protected_manifest_changed" };
    if (
      Object.keys(beforeDev).some(
        (name) =>
          beforeDev[name] !== afterDev[name] &&
          !AUTO_PATCH_DEPENDENCIES.includes(name),
      )
    )
      return { eligible: false, reason: "dependency_not_allowlisted" };
    if (
      !isDeepStrictEqual(
        { ...beforeLock, packages: null },
        { ...afterLock, packages: null },
      ) ||
      !isDeepStrictEqual(
        Object.keys(beforeLock.packages).sort(),
        Object.keys(afterLock.packages).sort(),
      )
    )
      return { eligible: false, reason: "dependency_graph_changed" };
    const changed = Object.keys(beforeLock.packages).filter(
      (p) =>
        p && !isDeepStrictEqual(beforeLock.packages[p], afterLock.packages[p]),
    );
    if (
      !changed.length ||
      changed.length > (allowBatch ? AUTO_PATCH_DEPENDENCIES.length : 1)
    )
      return { eligible: false, reason: "not_one_patch" };
    for (const location of changed) {
      if (!location.startsWith("node_modules/"))
        return { eligible: false, reason: "dependency_graph_changed" };
      const name = location.slice("node_modules/".length);
      const oldPackage = beforeLock.packages[location];
      const newPackage = afterLock.packages[location];
      const oldVersion = semver.parse(oldPackage.version);
      const newVersion = semver.parse(newPackage.version);
      if (
        !AUTO_PATCH_DEPENDENCIES.includes(name) ||
        !oldVersion ||
        !newVersion ||
        newVersion.prerelease.length ||
        oldVersion.major !== newVersion.major ||
        oldVersion.minor !== newVersion.minor ||
        newVersion.patch <= oldVersion.patch ||
        !/^([~^])?\d+\.\d+\.\d+$/.test(afterDev[name]) ||
        !semver.satisfies(newVersion.version, afterDev[name]) ||
        (newPackage.name && newPackage.name !== name) ||
        newPackage.hasInstallScript ||
        !/^sha512-[A-Za-z0-9+/]+=*$/.test(newPackage.integrity || "") ||
        new URL(newPackage.resolved).origin !== "https://registry.npmjs.org"
      )
        return { eligible: false, reason: "patch_constraints_failed" };
    }
    const beforeRoot = { ...beforeLock.packages[""], devDependencies: null };
    const afterRoot = { ...afterLock.packages[""], devDependencies: null };
    if (
      !isDeepStrictEqual(beforeRoot, afterRoot) ||
      !isDeepStrictEqual(afterLock.packages[""].devDependencies, afterDev)
    )
      return { eligible: false, reason: "root_lock_metadata_changed" };
    const beforePlan = createRuntimePackagePlan(beforeManifest, beforeLock);
    const afterPlan = createRuntimePackagePlan(afterManifest, afterLock);
    if (
      beforePlan.manifestSha256 !== afterPlan.manifestSha256 ||
      beforePlan.lockfileSha256 !== afterPlan.lockfileSha256
    )
      return { eligible: false, reason: "runtime_dependencies_changed" };
    return {
      eligible: true,
      dependencies: changed.map((location) => ({
        name: location.slice("node_modules/".length),
        from: beforeLock.packages[location].version,
        to: afterLock.packages[location].version,
      })),
    };
  } catch {
    return { eligible: false, reason: "candidate_invalid" };
  }
}

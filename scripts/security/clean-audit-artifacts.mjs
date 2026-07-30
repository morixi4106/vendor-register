import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..", "..");

const GENERATED_MANIFESTS = [
  "extensions/account-home-entry/manifest.json",
  "extensions/account-home-page/manifest.json",
];

const BUILD_DIRECTORIES = [
  ".shopify/deploy-bundle",
  ".shopify/deploy-bundle.br",
  "build",
  "extensions/account-home-entry/dist",
  "extensions/account-home-page/dist",
  "extensions/marketplace-purchase-control/dist",
];

export function resolveCleanupTarget(repositoryRoot, relativePath) {
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const normalizedRelativePath = String(relativePath || "")
    .replaceAll("\\", "/")
    .trim();
  if (
    !normalizedRelativePath ||
    normalizedRelativePath === "." ||
    path.isAbsolute(normalizedRelativePath) ||
    path.posix.isAbsolute(normalizedRelativePath) ||
    normalizedRelativePath.split("/").includes("..")
  ) {
    throw new Error(`Refusing to clean unsafe path: ${relativePath}`);
  }

  const absolutePath = path.resolve(root, normalizedRelativePath);
  const relative = path.relative(root, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to clean unsafe path: ${relativePath}`);
  }

  let currentPath = root;
  for (const segment of relative.split(path.sep)) {
    currentPath = path.join(currentPath, segment);
    let stats;
    try {
      stats = fs.lstatSync(currentPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Refusing to clean symbolic link or junction: ${normalizedRelativePath}`,
      );
    }
  }

  let resolvedTarget = null;
  try {
    resolvedTarget = fs.realpathSync(absolutePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (resolvedTarget) {
    const resolvedRelative = path.relative(root, resolvedTarget);
    if (
      !resolvedRelative ||
      resolvedRelative.startsWith("..") ||
      path.isAbsolute(resolvedRelative)
    ) {
      throw new Error(
        `Refusing to clean a target outside the repository: ${normalizedRelativePath}`,
      );
    }
  }

  return {
    absolutePath,
    relativePath: normalizedRelativePath,
    repositoryRoot: root,
  };
}

export function listGitTrackedFiles(
  repositoryRoot,
  relativePath,
  spawn = spawnSync,
) {
  const pathspecs = [
    `:(literal)${relativePath}`,
    `:(glob)${relativePath.replace(/\/+$/u, "")}/**`,
  ];
  const result = spawn(
    "git",
    ["-C", repositoryRoot, "ls-files", "--", ...pathspecs],
    {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Unable to verify tracked cleanup targets: ${
        result.error?.message || `git exited ${result.status}`
      }`,
    );
  }
  return String(result.stdout || "")
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function cleanAuditArtifacts({
  apply = false,
  includeBuildDirectories = false,
  listTrackedFiles = listGitTrackedFiles,
  repositoryRoot = REPOSITORY_ROOT,
} = {}) {
  const targets = [
    ...GENERATED_MANIFESTS,
    ...(includeBuildDirectories ? BUILD_DIRECTORIES : []),
  ];
  const verifiedTargets = targets.map((relativePath) => {
    const target = resolveCleanupTarget(repositoryRoot, relativePath);
    const trackedFiles = listTrackedFiles(
      target.repositoryRoot,
      target.relativePath,
    );
    if (trackedFiles.length > 0) {
      throw new Error(
        `Refusing to clean tracked path ${target.relativePath}: ${trackedFiles.join(
          ", ",
        )}`,
      );
    }
    return target;
  });

  if (apply) {
    for (const target of verifiedTargets) {
      fs.rmSync(target.absolutePath, {
        force: true,
        recursive: true,
      });
    }
  }

  return {
    applied: Boolean(apply),
    targets: verifiedTargets.map((target) => target.relativePath),
  };
}

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
/* node:coverage disable */
if (isMainModule) {
  const knownArguments = new Set(["--all", "--apply"]);
  const unknownArguments = process.argv
    .slice(2)
    .filter((argument) => !knownArguments.has(argument));
  if (unknownArguments.length > 0) {
    throw new Error(`Unknown cleanup argument: ${unknownArguments.join(", ")}`);
  }
  const includeBuildDirectories = process.argv.includes("--all");
  const apply = process.argv.includes("--apply");
  const result = cleanAuditArtifacts({ apply, includeBuildDirectories });
  const action = result.applied ? "REMOVE" : "DRY-RUN";
  for (const target of result.targets) {
    console.log(`${action} ${target}`);
  }
}
/* node:coverage enable */

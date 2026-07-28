import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  enumerateDependencyPaths,
  hashDependencyPathLines,
} from "./package-lock-graph.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..", "..");
const DEFAULT_OUTPUT = path.join(
  REPOSITORY_ROOT,
  "security",
  "risk-decisions",
  "GHSA-mh99-v99m-4gvg.approved-paths.txt",
);
const MAX_LOCKFILE_BYTES = 20 * 1024 * 1024;

function assertOutputPath(outputPath, decisionsDirectory) {
  const relative = path.relative(decisionsDirectory, outputPath);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    path.extname(outputPath) !== ".txt" ||
    (fs.existsSync(outputPath) &&
      (!fs.lstatSync(outputPath).isFile() ||
        fs.lstatSync(outputPath).isSymbolicLink()))
  ) {
    throw new Error(
      "Risk path snapshot must remain in security/risk-decisions.",
    );
  }
}

function readLockfile(lockfilePath) {
  const stats = fs.lstatSync(lockfilePath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size < 1 ||
    stats.size > MAX_LOCKFILE_BYTES
  ) {
    throw new Error("Risk path snapshot lockfile is unsafe.");
  }
  try {
    return JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
  } catch {
    throw new Error("Risk path snapshot lockfile is invalid JSON.");
  }
}

export function generateRiskPathSnapshot({
  repositoryRoot = REPOSITORY_ROOT,
  decisionsDirectory = path.join(
    repositoryRoot,
    "security",
    "risk-decisions",
  ),
  lockfilePath = path.join(repositoryRoot, "package-lock.json"),
  outputPath =
    repositoryRoot === REPOSITORY_ROOT
      ? DEFAULT_OUTPUT
      : path.join(
          decisionsDirectory,
          "GHSA-mh99-v99m-4gvg.approved-paths.txt",
        ),
} = {}) {
  assertOutputPath(outputPath, decisionsDirectory);
  const lockfile = readLockfile(lockfilePath);
  const report = enumerateDependencyPaths(lockfile, {
    targetName: "brace-expansion",
    targetVersion: "2.1.2",
  });

  if (report.unresolvedRequiredEdges.length > 0) {
    throw new Error("Cannot snapshot an unresolved dependency graph.");
  }
  if (report.paths.some((item) => item.scope === "root-production")) {
    throw new Error("Cannot snapshot a root production dependency path.");
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, report.pathLines.join("\n"), {
    encoding: "utf8",
    flag: "w",
  });

  return {
    count: report.pathLines.length,
    pathSetSha256: hashDependencyPathLines(report.pathLines),
    relativeOutputPath: path
      .relative(repositoryRoot, outputPath)
      .replaceAll("\\", "/"),
  };
}

/* node:coverage disable */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = generateRiskPathSnapshot();
  console.log(JSON.stringify(result, null, 2));
}
/* node:coverage enable */

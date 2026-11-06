import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectNpmTreeEvidence } from "./npm-tree-verification.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
if (process.argv.length !== 2 || !process.env.npm_execpath)
  throw new Error("Run the npm tree verifier through npm run audit:npm-tree.");
const report = collectNpmTreeEvidence({
  cwd: root,
  lockfile: JSON.parse(
    fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
  ),
});
const directory = path.join(root, ".audit");
fs.mkdirSync(directory, { recursive: true });
if (fs.lstatSync(directory).isSymbolicLink())
  throw new Error("npm_tree_evidence_path_invalid");
const file = path.join(directory, "minimatch-npm-tree.json");
if (
  fs.existsSync(file) &&
  (!fs.lstatSync(file).isFile() ||
    fs.lstatSync(file).nlink !== 1 ||
    fs.lstatSync(file).isSymbolicLink())
)
  throw new Error("npm_tree_evidence_path_invalid");
fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (!report.ok) process.exitCode = 1;

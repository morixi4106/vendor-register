import fs from "node:fs";
import path from "node:path";
import { TOOLCHAIN_TARGETS } from "./toolchain-targets.mjs";

const FORBIDDEN = new Set([
  ...TOOLCHAIN_TARGETS,
  "@shopify/cli",
  "@shopify/shopify_function",
  "@shopify/ui-extensions",
]);

export function inspectRuntimeToolchain(root, { checkAncestors = true } = {}) {
  const findings = new Set();
  const visited = new Set();
  let packageCount = 0;
  function walk(directory, depth = 0) {
    if (!fs.existsSync(directory)) return;
    if (
      depth > 32 ||
      visited.size >= 2000 ||
      fs.lstatSync(directory).isSymbolicLink()
    )
      throw new Error("unsafe_runtime_dependency_tree");
    const base = fs.realpathSync(directory);
    if (visited.has(base)) throw new Error("unsafe_runtime_dependency_tree");
    visited.add(base);
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const location = path.join(base, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("unsafe_runtime_dependency_tree");
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        walk(location, depth + 1);
        continue;
      }
      const metadataPath = path.join(location, "package.json");
      const stats = fs.lstatSync(metadataPath);
      if (
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.size > 1024 * 1024 ||
        ++packageCount > 2000
      )
        throw new Error("unsafe_runtime_dependency_tree");
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      if (FORBIDDEN.has(metadata.name) || FORBIDDEN.has(entry.name))
        findings.add(metadata.name || entry.name);
      walk(path.join(location, "node_modules"), depth + 1);
    }
  }
  let directory = fs.realpathSync(root);
  do {
    walk(path.join(directory, "node_modules"));
    if (!checkAncestors || path.dirname(directory) === directory) break;
    directory = path.dirname(directory);
  } while (true);
  return {
    ok: findings.size === 0,
    packageCount,
    forbiddenPackages: [...findings].sort(),
  };
}

export function assertRuntimeToolchain(root, options) {
  if (process.env.NODE_PATH) throw new Error("runtime_node_path_not_allowed");
  const report = inspectRuntimeToolchain(root, options);
  if (!report.ok) throw new Error("runtime_toolchain_not_clean");
  return report;
}

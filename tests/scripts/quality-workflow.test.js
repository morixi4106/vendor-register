import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..", "..");
const QUALITY_WORKFLOW_PATH = path.join(
  REPOSITORY_ROOT,
  ".github",
  "workflows",
  "quality.yml",
);

function readTopLevelMapping(source, key) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((line) => line === `${key}:`);
  assert.notEqual(start, -1, `${key} must be a top-level workflow mapping`);

  const entries = new Map();
  for (const line of lines.slice(start + 1)) {
    if (line && !line.startsWith(" ")) break;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const match = /^ {2}([a-z-]+): (read|write|none)$/.exec(line);
    assert.ok(match, `unsupported ${key} entry: ${line}`);
    assert.equal(entries.has(match[1]), false, `duplicate ${key}.${match[1]}`);
    entries.set(match[1], match[2]);
  }
  return entries;
}

test("Quality workflow grants only the read permissions required by CI", () => {
  const source = fs.readFileSync(QUALITY_WORKFLOW_PATH, "utf8");
  const permissions = readTopLevelMapping(source, "permissions");

  assert.deepEqual(Object.fromEntries(permissions), {
    actions: "read",
    contents: "read",
    "pull-requests": "read",
  });
  assert.equal(
    [...permissions.values()].some((permission) => permission === "write"),
    false,
  );
  assert.equal(permissions.has("issues"), false);
});

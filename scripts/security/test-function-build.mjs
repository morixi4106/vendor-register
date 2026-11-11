import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { inspectFinalFunction, stageFinalFunction } from "./function-build.mjs";
if (
  process.argv.length !== 2 ||
  process.env.CI !== "true" ||
  process.env.GITHUB_ACTIONS !== "true"
)
  throw new Error("function_build_probe_arguments_invalid");
const root = path.resolve(import.meta.dirname, "../.."),
  candidate = inspectFinalFunction(root);
const base = path.join(root, ".audit/function-build-probe");
fs.mkdirSync(base);
const work = fs.mkdtempSync(path.join(base, "run-"));
stageFinalFunction(work, candidate.bytes);
assert.deepEqual(
  fs.readFileSync(path.join(work, "dist/function.wasm")),
  candidate.bytes,
);
fs.writeFileSync(
  path.join(work, "receipt.json"),
  JSON.stringify(
    {
      ...candidate.evidence,
      scope:
        "isolated staged output only; existing incident and release admission remain mandatory",
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(candidate.evidence));

import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Minimatch } =
  process.argv[2] === "esm"
    ? await import("../../../vendor/minimatch/dist/esm/index.js")
    : require("../../../vendor/minimatch/dist/commonjs/index.js");
const pattern = Array(30).fill("**/../a/b").join("/");
assert.throws(() => new Minimatch(pattern, { optimizationLevel: 2 }), {
  name: "RangeError",
  message: "glob preprocessing limit exceeded",
});
const matcher = new Minimatch("**/a", { optimizationLevel: 2 });
const large = Array.from({ length: 1001 }, (_, i) => ["p" + i]);
matcher.partsMatch = () => {
  throw new Error("quadratic_comparison_was_not_skipped");
};
assert.equal(matcher.secondPhasePreProcess(large), large);
const existing = Array.from({ length: 1001 }, (_, i) => ["p" + i]);
assert.equal(matcher.firstPhasePreProcess(existing).length, 1001);
console.log(JSON.stringify({ limitRejected: true, largeSetPreserved: true }));

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
const input = JSON.parse(
  fs.readFileSync(process.env.OJA_PRISMA_PROBE_INPUT, "utf8"),
);
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const client = path.join(
  input.project,
  "node_modules/@prisma/client/default.js",
);
assert.equal(hash(fs.readFileSync(input.library)), input.librarySha256);
registerHooks({
  resolve(specifier, context, next) {
    return next(
      specifier === "@prisma/client" ? pathToFileURL(client).href : specifier,
      context,
    );
  },
});
const original = process.dlopen;
process.dlopen = function (module, filename, ...args) {
  assert.equal(fs.realpathSync(filename), fs.realpathSync(input.library));
  assert.equal(hash(fs.readFileSync(filename)), input.librarySha256);
  const result = Reflect.apply(original, this, [module, filename, ...args]);
  fs.appendFileSync(
    path.join(input.project, "international-native-loads.jsonl"),
    JSON.stringify({ sha256: input.librarySha256 }) + "\n",
  );
  return result;
};
globalThis.fetch = () => {
  throw new Error("international_database_probe_network_forbidden");
};

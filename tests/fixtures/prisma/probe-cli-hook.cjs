const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const input = JSON.parse(fs.readFileSync(process.env.OJA_PRISMA_PROBE_INPUT, "utf8"));
const original = childProcess.spawn;
childProcess.spawn = function(command, ...args) {
  if (path.basename(command).includes("schema-engine")) {
    const file = fs.realpathSync(command);
    const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (path.toNamespacedPath(file) !== path.toNamespacedPath(fs.realpathSync(input.schema)) || digest !== input.schemaSha256)
      throw new Error("prisma_probe_unexpected_schema_engine");
    fs.appendFileSync(path.join(input.project, "schema-engine-invocations.jsonl"), JSON.stringify({ sha256: digest }) + "\n");
  }
  return Reflect.apply(original, this, [command, ...args]);
};

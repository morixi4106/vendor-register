import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (file) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));

test("Effect ReDoS fix stays pinned without downgrading Prisma or session storage", () => {
  const manifest = read("package.json");
  assert.equal(manifest.overrides.effect, "3.22.1");
  assert.equal(manifest.resolutions.effect, "3.22.1");
  assert.equal(
    read("package-lock.json").packages["node_modules/effect"].version,
    "3.22.1",
  );
  assert.equal(read("node_modules/effect/package.json").version, "3.22.1");
  assert.equal(manifest.dependencies.prisma, "6.19.3");
  assert.equal(
    manifest.dependencies["@shopify/shopify-app-session-storage-prisma"],
    "11.0.0",
  );
});

test("actual patched Effect matcher rejects the advisory's ambiguous template input in a bounded child", () => {
  const code = `
    import * as Schema from "effect/Schema";
    const matches = Schema.is(Schema.TemplateLiteral(
      Schema.String, ":", Schema.String, ":", Schema.String, "X"
    ));
    console.log(JSON.stringify({
      valid: matches("a:b:cX"), empty: matches("::X"),
      invalid: matches("a:b:c"), repeated: matches(":".repeat(20000))
    }));
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    {
      cwd: ROOT,
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH },
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 1024 * 1024,
      shell: false,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    valid: true,
    empty: true,
    invalid: false,
    repeated: false,
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import {
  stageVendorPatches,
  verifyPatchedMergePackage,
} from "../../scripts/security/vendor-patches.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const source = path.join(ROOT, "vendor/deepmerge");

test("the Polaris consumer resolves the reviewed backport, not a hidden vulnerable copy", () => {
  const require = createRequire(
    path.join(ROOT, "node_modules/@shopify/polaris-tokens/package.json"),
  );
  const directory = path.dirname(require.resolve("deepmerge/package.json"));
  const metadata = require("deepmerge/package.json");
  assert.equal(verifyPatchedMergePackage(directory, metadata).ok, true);
  const result = require("deepmerge")(
    Object.create(null),
    JSON.parse('{"__proto__":{"isAdmin":true}}'),
  );
  assert.equal(result.isAdmin, undefined);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
});

test("runtime staging verifies the archive and actual source before copying", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-patch-test-"));
  try {
    fs.mkdirSync(path.join(base, "input/vendor"), { recursive: true });
    fs.cpSync(source, path.join(base, "input/vendor/deepmerge"), {
      recursive: true,
    });
    const stage =
      fs.mkdirSync(path.join(base, "stage")) || path.join(base, "stage");
    stageVendorPatches(path.join(base, "input"), stage);
    const archive = "vendor/deepmerge/oja-deepmerge-4.3.1-oja.1.tgz";
    assert.deepEqual(
      fs.readFileSync(path.join(stage, archive)),
      fs.readFileSync(path.join(ROOT, archive)),
    );
    fs.appendFileSync(path.join(base, "input", archive), "tamper");
    assert.throws(
      () => stageVendorPatches(path.join(base, "input"), stage),
      /vendor_patch_tarball_mismatch/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("patch identity, source, entry-point manifest and provenance cannot be substituted", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-patch-test-"));
  try {
    const target = path.join(base, "copy");
    fs.cpSync(source, target, { recursive: true });
    const metadata = JSON.parse(
      fs.readFileSync(path.join(target, "package.json")),
    );
    assert.throws(
      () =>
        verifyPatchedMergePackage(target, { ...metadata, name: "deepmerge" }),
      /identity_mismatch/,
    );
    assert.throws(
      () =>
        verifyPatchedMergePackage(target, { ...metadata, version: "4.3.1" }),
      /identity_mismatch/,
    );
    fs.appendFileSync(path.join(target, "index.cjs"), "\n");
    assert.throws(
      () => verifyPatchedMergePackage(target, metadata),
      /source_mismatch/,
    );
    fs.copyFileSync(
      path.join(source, "index.cjs"),
      path.join(target, "index.cjs"),
    );
    fs.appendFileSync(path.join(target, "provenance.json"), "\n");
    assert.throws(
      () => verifyPatchedMergePackage(target, metadata),
      /provenance_mismatch/,
    );
    fs.copyFileSync(
      path.join(source, "provenance.json"),
      path.join(target, "provenance.json"),
    );
    fs.writeFileSync(
      path.join(target, "package.json"),
      JSON.stringify({ ...metadata, exports: "./unreviewed.cjs" }),
    );
    assert.throws(
      () => verifyPatchedMergePackage(target, metadata),
      /manifest_mismatch/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

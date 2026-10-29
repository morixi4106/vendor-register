import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkedNativeDirectory,
  nativeBuildEnvironment,
  validateGoBuildInfo,
  validateGoSarif,
  validateRebuildPolicy,
  verifyRebuiltEsbuild,
} from "../../scripts/security/rebuild-esbuild.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const policy = JSON.parse(
  fs.readFileSync(path.join(ROOT, "security/esbuild-rebuild.json"), "utf8"),
);

test("native rebuild policy rejects unknown fields, old compilers and unbound binaries", () => {
  assert.equal(validateRebuildPolicy(policy), policy);
  for (const patch of [
    { ignore: true },
    { goVersion: "1.23.12" },
    { sourceCommit: "invalid" },
    { binarySha256: {} },
    { archives: { ...policy.archives, darwin: {} } },
  ])
    assert.throws(
      () => validateRebuildPolicy({ ...policy, ...patch }),
      /esbuild_rebuild_policy_invalid/,
    );
});

test("native compiler processes receive no production credentials or override flags", () => {
  const env = nativeBuildEnvironment("/isolated", {
    Path: "system",
    DATABASE_URL: "secret",
    GITHUB_TOKEN: "secret",
    NODE_OPTIONS: "injected",
    GOFLAGS: "injected",
    GOTOOLCHAIN: "auto",
    GOPROXY: "untrusted",
    GOSUMDB: "off",
  });
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.GOFLAGS, "");
  assert.equal(env.GOTOOLCHAIN, "local");
  assert.equal(env.GOSUMDB, "sum.golang.org");
  assert.equal(env.GOPROXY, "https://proxy.golang.org");
});

test("Go build metadata must bind version, architecture and trimmed static build", () => {
  const info = {
    GoVersion: "go1.27.3",
    Path: "github.com/evanw/esbuild/cmd/esbuild",
    Main: { Path: "github.com/evanw/esbuild", Version: "(devel)" },
    Settings: [
      { Key: "GOOS", Value: "linux" },
      { Key: "GOARCH", Value: "amd64" },
      { Key: "CGO_ENABLED", Value: "0" },
      { Key: "-trimpath", Value: "true" },
    ],
  };
  assert.equal(validateGoBuildInfo(info, "linux", policy), true);
  assert.throws(
    () =>
      validateGoBuildInfo({ ...info, GoVersion: "go1.23.12" }, "linux", policy),
    /native_go_build_info_invalid/,
  );
  assert.throws(
    () => validateGoBuildInfo(info, "win32", policy),
    /native_go_build_info_invalid/,
  );
  assert.throws(
    () =>
      validateGoBuildInfo(
        { ...info, Deps: [{ Path: "replacement", Version: "1.0.0" }] },
        "linux",
        policy,
      ),
    /native_go_build_info_invalid/,
  );
});

test("missing scan output and all advisory severities block native acceptance", () => {
  const clean = {
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "govulncheck" } }, results: [] }],
  };
  assert.equal(validateGoSarif(clean), true);
  for (const invalid of [
    {},
    { ...clean, runs: [] },
    { ...clean, runs: [clean.runs[0], clean.runs[0]] },
    { version: "2.1.0", runs: [{ tool: { driver: { name: "govulncheck" } } }] },
  ])
    assert.throws(() => validateGoSarif(invalid), /native_go_scan_invalid/);
  assert.throws(
    () =>
      validateGoSarif({
        ...clean,
        runs: [
          {
            ...clean.runs[0],
            results: [{ level: "note", ruleId: "GO-fixture" }],
          },
        ],
      }),
    /native_go_advisories_unresolved/,
  );
});

test("native outputs cannot traverse or follow an external directory junction", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-path-test-"));
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), "native-outside-test-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, ".audit"), "junction");
  for (const relative of [
    "../outside",
    ".audit/native-cache",
    "./unsafe",
    "C:\\outside",
  ])
    assert.throws(
      () => checkedNativeDirectory(root, relative),
      /native_build_path_invalid/,
    );
});

test("installed esbuild requires fresh exact binary and scan receipts", (t) => {
  const actual = verifyRebuiltEsbuild(ROOT);
  assert.equal(actual.goVersion, "1.27.3");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-receipt-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(
    path.join(ROOT, ".audit/native-esbuild"),
    checkedNativeDirectory(root, ".audit/native-esbuild"),
    { recursive: true },
  );
  const name = `esbuild-${process.platform}-x64${process.platform === "win32" ? ".exe" : ""}`;
  assert.equal(verifyRebuiltEsbuild(root, { installed: false }).ok, true);
  const target = path.join(root, `.audit/native-esbuild/${name}.receipt.json`);
  const original = JSON.parse(fs.readFileSync(target, "utf8"));
  for (const patch of [
    { observedAt: "2020-01-01T00:00:00.000Z" },
    { observedAt: "2099-01-01T00:00:00.000Z" },
    { binarySha256: "a".repeat(64) },
    { platform: "unknown" },
    { policySha256: "a".repeat(64) },
  ]) {
    fs.writeFileSync(target, JSON.stringify({ ...original, ...patch }));
    assert.throws(
      () => verifyRebuiltEsbuild(root, { installed: false }),
      /native_go_receipt_invalid_or_stale/,
    );
  }
  fs.writeFileSync(target, JSON.stringify(original));
  fs.writeFileSync(
    path.join(root, `.audit/native-esbuild/${name}.sarif`),
    "{}",
  );
  assert.throws(
    () => verifyRebuiltEsbuild(root, { installed: false }),
    /native_go_scan_digest_mismatch/,
  );
});

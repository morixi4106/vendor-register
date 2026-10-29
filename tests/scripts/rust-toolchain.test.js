import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import {
  validateRustToolchainPolicy,
  rustBuildEnvironment,
  downloadRustInput,
  checkRustSourceTree,
} from "../../scripts/security/rust-toolchain.mjs";

const policy = JSON.parse(
  fs.readFileSync(
    new URL("../../security/rust-toolchain.json", import.meta.url),
    "utf8",
  ),
);

test("Rust toolchain accepts only the pinned release and complete component hashes", () => {
  assert.equal(validateRustToolchainPolicy(policy), policy);
  for (const patch of [
    { version: "1.90.0" },
    { date: "2026-01-01" },
    { targets: {} },
    { trust: true },
  ])
    assert.throws(
      () => validateRustToolchainPolicy({ ...policy, ...patch }),
      /rust_toolchain_policy_invalid/,
    );
});

test("Rust subprocesses cannot inherit credentials, compiler injection or disabled TLS", () => {
  const env = rustBuildEnvironment("/private", "/tools", {
    PATH: "system",
    DATABASE_URL: "secret",
    GITHUB_TOKEN: "secret",
    CARGO_HTTP_SSL_VERIFY: "false",
    RUSTC_WRAPPER: "injected",
    CARGO_ENCODED_RUSTFLAGS: "injected",
    RUSTUP_TOOLCHAIN: "nightly",
  });
  for (const name of [
    "DATABASE_URL",
    "GITHUB_TOKEN",
    "RUSTC_WRAPPER",
    "CARGO_ENCODED_RUSTFLAGS",
    "RUSTUP_TOOLCHAIN",
  ])
    assert.equal(env[name], undefined);
  assert.equal(env.CARGO_HTTP_SSL_VERIFY, "true");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_CEILING_DIRECTORIES, "/private");
  assert.equal(env.CARGO_INCREMENTAL, "0");
});

test("native source cannot follow a junction outside its verified archive", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rust-source-test-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rust-outside-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, "injected"), "junction");
  assert.throws(
    () => checkRustSourceTree(root),
    /rust_archive_link_not_allowed/,
  );
});

test("cached compiler archives are always hashed and unknown download origins fail", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rust-download-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "fixture.tar.xz");
  fs.writeFileSync(target, "fixture");
  const sha = crypto.createHash("sha256").update("fixture").digest("hex");
  await downloadRustInput(
    "https://static.rust-lang.org/dist/fixture",
    target,
    sha,
  );
  await assert.rejects(
    downloadRustInput(
      "https://static.rust-lang.org/dist/fixture",
      target,
      "a".repeat(64),
    ),
    /rust_download_digest_mismatch/,
  );
  await assert.rejects(
    downloadRustInput(
      "https://static.rust-lang.org.evil.test/fixture",
      target,
      sha,
    ),
    /rust_download_policy_invalid/,
  );
});

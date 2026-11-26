import assert from "node:assert/strict";
import test from "node:test";
import {
  rustRegistryPackages,
  scanRustLockfile,
} from "../../scripts/security/rust-source-audit.mjs";

const lock = `version = 4
[[package]]
name = "fixture"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${"a".repeat(64)}"
`;

test("Rust source audit keeps git dependencies unresolved and requires registry checksums", () => {
  assert.equal(rustRegistryPackages(lock).packages.length, 1);
  assert.throws(
    () => rustRegistryPackages(lock.replace(/checksum = .*/, "")),
    /rust_lock_checksum_missing/,
  );
  assert.throws(
    () => rustRegistryPackages(lock + lock.slice(lock.indexOf("[[package]]"))),
    /rust_lock_duplicate/,
  );
  const mixed = rustRegistryPackages(
    lock +
      '\n[[package]]\nname="git-fixture"\nversion="1.0.0"\nsource="git+https://github.com/example/fixture#abc"\n',
  );
  assert.equal(mixed.unresolved.length, 1);
});

test("registry results cannot certify a native binary", async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://api.osv.dev/v1/querybatch");
    assert.equal(
      JSON.parse(options.body).queries[0].package.ecosystem,
      "crates.io",
    );
    return new Response(JSON.stringify({ results: [{}] }));
  };
  const result = await scanRustLockfile(lock, { fetchImpl });
  assert.equal(result.sourceAuditOk, true);
  assert.equal(result.artifactStatus, "NOT_VERIFIED");
});

test("known advisories, unavailable feeds and truncated pages remain blocked", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        results: [
          {
            vulns: [
              { id: "RUSTSEC-2026-0377", modified: "2026-10-20T00:00:00Z" },
            ],
          },
        ],
      }),
    );
  assert.equal(
    (await scanRustLockfile(lock, { fetchImpl })).sourceAuditOk,
    false,
  );
  for (const body of [
    {},
    { results: [] },
    { results: [null] },
    { results: [{ next_page_token: "more" }] },
    { results: [{ vulns: [{ id: "unverified", modified: "invalid" }] }] },
  ])
    await assert.rejects(
      scanRustLockfile(lock, {
        fetchImpl: async () => new Response(JSON.stringify(body)),
      }),
    );
  await assert.rejects(
    scanRustLockfile(lock, {
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    }),
    /native_advisory_source_unavailable/,
  );
});

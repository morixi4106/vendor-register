// Historical candidate receipt validation. Release inputs are bound by the main source policy.
import assert from "node:assert/strict";
import { rustTestTotals } from "./test-prisma-source.mjs";

const HASH = /^[a-f0-9]{64}$/;
const baselineNames = [
  "mixed_unicode_indentation_panics_before_fix",
  "nonbreaking_space_indentation_panics_before_fix",
  "first_line_content_is_trimmed_before_fix",
];
const regressionNames = [
  "mixed_unicode_indentation_is_safe",
  "unicode_whitespace_is_content_not_indentation",
  "first_line_content_and_trailing_spaces_are_preserved",
  "only_ascii_blank_boundary_lines_are_removed",
  "empty_and_ascii_whitespace_only_strings_are_empty",
  "tab_and_space_indentation_counts_characters",
  "carriage_return_line_endings_are_normalized",
  "escaped_triple_quotes_are_decoded_on_every_line",
  "unicode_indent_corpus_covers_query_and_schema_entries",
];
export function validateGraphqlStringPolicy(p) {
  assert.deepEqual(
    Object.keys(p).sort(),
    [
      "schemaVersion",
      "basePolicySha256",
      "commonBeforeSha256",
      "commonAfterSha256",
      "patch",
      "baseline",
      "regressions",
      "baselineTests",
      "regressionTests",
      "productionPatchApplied",
      "wholeEngineVerified",
      "productionApproved",
    ].sort(),
  );
  assert.equal(p.schemaVersion, 1);
  assert.equal(
    p.basePolicySha256,
    "2da8f59fe8bf52764c1097bbf5f77766313ea7e9bd94857aa0f6c9cee904d217",
  );
  assert.equal(
    p.commonBeforeSha256,
    "e17bfd404e1746db94962fa77002168c9e32731f4bb00edfeae0a0810d96c8c9",
  );
  assert.match(p.commonAfterSha256, HASH);
  assert.notEqual(p.commonBeforeSha256, p.commonAfterSha256);
  for (const [key, file] of [
    ["patch", "vendor/native/prisma/graphql-strings.patch"],
    ["baseline", "tests/fixtures/prisma/graphql-string-baseline.rs"],
    ["regressions", "tests/fixtures/prisma/graphql-string-regressions.rs"],
  ]) {
    assert.deepEqual(Object.keys(p[key]).sort(), ["path", "sha256"]);
    assert.equal(p[key].path, file);
    assert.match(p[key].sha256, HASH);
  }
  assert.equal(p.baselineTests, 3);
  assert.equal(p.regressionTests, 9);
  for (const key of [
    "productionPatchApplied",
    "wholeEngineVerified",
    "productionApproved",
  ])
    assert.equal(p[key], false);
  return p;
}

export function verifyGraphqlStringOutput(output, phase) {
  assert.ok(["baseline", "regressions"].includes(phase));
  const names = phase === "baseline" ? baselineNames : regressionNames;
  const totals = rustTestTotals(output, names.length);
  assert.equal(totals.passed, names.length);
  assert.equal(totals.failed, 0);
  assert.equal(totals.ignored, 0);
  const observed = [
    ...output.matchAll(/test oja_string_review::([a-z_0-9]+) \.\.\. ok/g),
  ].map((m) => m[1]);
  assert.deepEqual(observed.sort(), [...names].sort());
  return totals;
}

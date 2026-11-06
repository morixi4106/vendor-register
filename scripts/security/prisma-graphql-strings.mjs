import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { prismaSourceInput, rustTestTotals } from "./test-prisma-source.mjs";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
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

function sourceInventory(base) {
  const files = [];
  const walk = (dir, prefix = "") => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      assert.ok(!e.isSymbolicLink());
      const relative = prefix + e.name,
        full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, relative + "/");
      else {
        const s = fs.lstatSync(full);
        assert.ok(s.isFile() && s.nlink === 1 && s.size < 1_000_000);
        files.push({ path: relative, sha256: sha(fs.readFileSync(full)) });
      }
    }
  };
  walk(base);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function testGraphqlStringCandidate({ root, source, cargo, execute }) {
  const policyFile = path.join(root, "security/prisma-graphql-strings.json");
  const policyBytes = fs.readFileSync(policyFile);
  const policy = validateGraphqlStringPolicy(JSON.parse(policyBytes));
  assert.equal(
    sha(
      fs.readFileSync(path.join(root, "security/prisma-source-contracts.json")),
    ),
    policy.basePolicySha256,
  );
  const patch = prismaSourceInput(root, policy.patch);
  const baseline = prismaSourceInput(root, policy.baseline);
  const regressions = prismaSourceInput(root, policy.regressions);
  const src = path.join(source, "vendor/graphql/src");
  const before = sourceInventory(src);
  const commonFile = path.join(src, "common.rs"),
    libFile = path.join(src, "lib.rs");
  const common = fs.readFileSync(commonFile),
    lib = fs.readFileSync(libFile);
  assert.equal(sha(common), policy.commonBeforeSha256);
  const fixture = path.join(src, "oja_string_review.rs");
  assert.ok(!fs.existsSync(fixture));
  const attach = (bytes) => {
    fs.writeFileSync(fixture, bytes, { flag: "wx" });
    fs.writeFileSync(
      libFile,
      Buffer.concat([
        lib,
        Buffer.from("\n#[cfg(test)]\nmod oja_string_review;\n"),
      ]),
    );
  };
  let result;
  try {
    attach(baseline);
    const red = execute(
      cargo,
      [
        "test",
        "--locked",
        "-p",
        "graphql-parser",
        "--lib",
        "oja_string_review",
      ],
      source,
      "graphql-strings-baseline",
      900_000,
    );
    const baselineTotals = verifyGraphqlStringOutput(red, "baseline");
    fs.unlinkSync(fixture);
    fs.writeFileSync(libFile, lib);
    assert.deepEqual(sourceInventory(src), before);
    for (const check of [true, false])
      execute(
        "git",
        [
          "-c",
          "core.autocrlf=false",
          "apply",
          ...(check ? ["--check"] : []),
          path.join(root, policy.patch.path),
        ],
        path.join(source, "vendor/graphql"),
        `graphql-strings-patch-${check}`,
      );
    assert.equal(sha(fs.readFileSync(commonFile)), policy.commonAfterSha256);
    const after = sourceInventory(src);
    assert.deepEqual(
      after,
      before.map((f) =>
        f.path === "common.rs" ? { ...f, sha256: policy.commonAfterSha256 } : f,
      ),
    );
    attach(regressions);
    const green = execute(
      cargo,
      [
        "test",
        "--locked",
        "-p",
        "graphql-parser",
        "--lib",
        "oja_string_review",
      ],
      source,
      "graphql-strings-regressions",
      900_000,
    );
    const regressionTotals = verifyGraphqlStringOutput(green, "regressions");
    const all = execute(
      cargo,
      ["test", "--locked", "-p", "graphql-parser", "--lib"],
      source,
      "graphql-strings-all-units",
      900_000,
    );
    const allUnits = rustTestTotals(all, 61);
    assert.equal(allUnits.failed, 0);
    assert.equal(allUnits.ignored, 0);
    result = {
      policySha256: sha(policyBytes),
      basePolicySha256: policy.basePolicySha256,
      patchSha256: sha(patch),
      commonBeforeSha256: sha(common),
      commonAfterSha256: policy.commonAfterSha256,
      baselineSha256: sha(baseline),
      regressionsSha256: sha(regressions),
      before,
      after,
      baseline: baselineTotals,
      regressions: regressionTotals,
      allUnits,
      scope:
        "Candidate string decoder only; original native engine input and artifact pins remain unchanged",
      productionPatchApplied: false,
      wholeEngineVerified: false,
      productionApproved: false,
    };
  } finally {
    fs.writeFileSync(commonFile, common);
    fs.writeFileSync(libFile, lib);
    if (fs.existsSync(fixture)) fs.unlinkSync(fixture);
    assert.deepEqual(sourceInventory(src), before);
  }
  return { ...result, baseSourceRestored: true };
}

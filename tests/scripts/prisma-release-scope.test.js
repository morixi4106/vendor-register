import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import test from "node:test";
import { bindPrismaReleaseScope } from "../../scripts/security/prisma-release-scope.mjs";
const ledger = JSON.parse(
  fs.readFileSync(
    new URL("../../security/prisma-release-scope.json", import.meta.url),
  ),
);
const identities = ledger.groups.flatMap((g) =>
  g.packages.map((name) => ({
    name,
    repository: g.repository,
    commit: g.commit,
    reviewStatus: "UNREVIEWED",
    pathsFromReleaseRoots: Object.fromEntries(
      ["query-engine-node-api", "schema-engine-cli"].map((root) => [
        root,
        g.releaseRoots.includes(root) ? [root, name] : null,
      ]),
    ),
  })),
);
test("all thirteen original identities have explicit bounded evidence, release scope and remaining work without approval", () => {
  const report = bindPrismaReleaseScope(identities, ledger);
  assert.equal(report.originalUnreviewed, 13);
  assert.equal(report.releaseGraphIncluded, 12);
  assert.equal(
    report.entries.find((e) => e.name === "barrel").releaseScope,
    "OUTSIDE_RELEASE_GRAPH",
  );
  assert.equal(report.productionApproved, false);
  assert.equal(report.wholeEngineVerified, false);
});
test("missing identities, source substitutions, changed release reachability and approval flips are rejected", () => {
  for (const mutate of [
    (l) => l.groups.pop(),
    (l) => l.groups[0].packages.push("unexpected"),
    (l) => (l.groups[0].commit = "0".repeat(40)),
    (l) => l.groups[0].releaseRoots.push("query-engine-node-api"),
    (l) => (l.sourceReviewComplete = true),
    (l) => (l.productionApproved = true),
    (l) => (l.wholeEngineVerified = true),
    (l) => (l.groups[0].evidence = "https://example.invalid/unbound"),
    (l) => (l.groups[0].remaining = ""),
  ]) {
    const value = structuredClone(ledger);
    mutate(value);
    assert.throws(() => bindPrismaReleaseScope(identities, value));
  }
  assert.throws(() => bindPrismaReleaseScope(identities.slice(1), ledger));
  const promoted = structuredClone(identities);
  promoted[0].reviewStatus = "APPROVED";
  assert.throws(() => bindPrismaReleaseScope(promoted, ledger));
});

test("owned GraphQL review binds all runtime inputs and selected JSON client without promoting source admission", () => {
  const read = (file) =>
    fs.readFileSync(new URL(`../../${file}`, import.meta.url));
  const sha = (bytes) =>
    crypto.createHash("sha256").update(bytes).digest("hex");
  const policyBytes = read("security/prisma-source-contracts.json");
  const policy = JSON.parse(policyBytes);
  const review = JSON.parse(
    read("security/reviews/prisma-graphql-owned-source.json"),
  );
  assert.equal(review.enginePolicySha256, sha(policyBytes));
  assert.equal(review.repository, policy.graphqlSource.repository);
  assert.equal(review.commit, policy.graphqlSource.commit);
  assert.equal(review.archiveSha256, policy.graphqlSource.sha256);
  assert.equal(review.ownedRuntimeStatus, "READ_WITH_FINDINGS");
  const paths = [
    "common",
    "format",
    "helpers",
    "lib",
    "position",
    "tokenizer",
  ].map((name) => `src/${name}.rs`);
  for (const group of ["query", "schema"])
    for (const name of ["ast", "error", "format", "grammar", "mod"])
      paths.push(`src/${group}/${name}.rs`);
  assert.deepEqual(review.files.map((file) => file.path).sort(), paths.sort());
  for (const file of review.files) {
    assert.match(file.originalGitBlob, /^[a-f0-9]{40}$/);
    assert.match(file.originalSha256, /^[a-f0-9]{64}$/);
    const selected = policy.graphqlSource.sourceFiles.find(
      (input) => input.path === file.path,
    );
    assert.equal(file.adoptedSha256, selected?.sha256 ?? file.originalSha256);
  }
  assert.equal(review.consumers.length, 4);
  assert.equal(new Set(review.consumers.map((file) => file.path)).size, 4);
  assert.equal(review.engineCommit, policy.source.commit);
  assert.equal(review.application.lineEndings, "LF");
  assert.equal(
    review.application.sha256,
    sha(
      Buffer.from(
        read(review.application.path).toString("utf8").replace(/\r\n/g, "\n"),
      ),
    ),
  );
  assert.equal(
    review.application.clientRuntimeSha256,
    sha(read(review.application.clientRuntimePath)),
  );
  assert.equal(review.application.observedConstructorProtocol, "json");
  assert.equal(review.findings.length, 4);
  assert.deepEqual(
    review.findings.map((finding) => finding.evidence),
    [
      "ACTUAL_WINDOWS_NATIVE",
      "ACTUAL_WINDOWS_NATIVE",
      "SOURCE_ONLY",
      "SOURCE_ONLY",
    ],
  );
  for (const key of [
    "sourceReviewComplete",
    "wholeEngineVerified",
    "productionApproved",
  ])
    assert.equal(review[key], false);
  assert.equal(policy.graphqlSource.reviewStatus, "UNREVIEWED");
});

test("selected PostgreSQL TLS/auth review binds its exact scope without approving the four identities", () => {
  const read = (file) =>
    fs.readFileSync(new URL(`../../${file}`, import.meta.url));
  const policyBytes = read("security/prisma-source-contracts.json");
  const policy = JSON.parse(policyBytes);
  const review = JSON.parse(
    read("security/reviews/prisma-postgres-tls-auth.json"),
  );
  assert.equal(
    review.enginePolicySha256,
    crypto.createHash("sha256").update(policyBytes).digest("hex"),
  );
  assert.equal(review.repository, policy.postgresSource.repository);
  assert.equal(review.commit, policy.postgresSource.commit);
  assert.equal(review.archiveSha256, policy.postgresSource.sha256);
  assert.equal(review.engineCommit, policy.source.commit);
  assert.equal(review.selectedPathStatus, "READ_WITH_FINDINGS");
  assert.deepEqual(
    review.files.map((entry) => entry.path).sort(),
    [
      "postgres-native-tls/Cargo.toml",
      "postgres-native-tls/src/lib.rs",
      "tokio-postgres/src/connect_tls.rs",
      "tokio-postgres/src/connect_raw.rs",
      "postgres-protocol/src/authentication/sasl.rs",
    ].sort(),
  );
  for (const entry of review.files) {
    assert.match(entry.originalGitBlob, /^[a-f0-9]{40}$/);
    assert.match(entry.originalSha256, /^[a-f0-9]{64}$/);
    assert.equal(
      entry.adoptedSha256,
      policy.postgresSource.sourceFiles.find(
        (input) => input.path === entry.path,
      )?.sha256,
    );
    assert.ok(entry.readScope);
  }
  assert.equal(review.consumers.length, 2);
  assert.deepEqual(
    review.findings.map((entry) => entry.evidence),
    ["SOURCE_ONLY", "SOURCE_ONLY", "COMPILED_RUST_LIBRARY_BOTH_PLATFORMS"],
  );
  assert.equal(review.grammarCorrection.newRegressions, 8);
  assert.equal(review.grammarCorrection.postgresRegressions, 32);
  assert.equal(review.grammarCorrection.bothPlatformSourceTestsVerified, true);
  assert.equal(review.grammarCorrection.releaseNativeAdoptionVerified, false);
  assert.equal(
    review.grammarCorrection.fixtureSha256,
    crypto
      .createHash("sha256")
      .update(read("tests/fixtures/prisma/postgres-scram-grammar.rs"))
      .digest("hex"),
  );
  for (const key of [
    "productionConfigurationObserved",
    "productionConnectionVerified",
    "sourceReviewComplete",
    "wholeEngineVerified",
    "productionApproved",
  ])
    assert.equal(review[key], false);
  assert.equal(policy.postgresSource.reviewStatus, "UNREVIEWED");
});

test("SQLite backport source adoption cannot be mistaken for compiled native or production adoption", () => {
  const read = (file) =>
    fs.readFileSync(new URL(`../../${file}`, import.meta.url));
  const review = JSON.parse(read("security/reviews/prisma-sqlite-wal.json"));
  const policy = read("security/prisma-source-contracts.json");
  assert.equal(
    review.enginePolicySha256,
    crypto.createHash("sha256").update(policy).digest("hex"),
  );
  assert.equal(review.status, "SOURCE_ADOPTED_PENDING_NATIVE");
  assert.equal(review.advisory, "RUSTSEC-2026-0459");
  assert.equal(review.version, "0.30.1");
  assert.equal(review.sqliteVersion, "3.46.0");
  assert.equal(review.artifacts.length, 2);
  assert.equal(review.sourceApplicabilityChecked, true);
  assert.equal(
    review.candidatePatchSha256,
    crypto
      .createHash("sha256")
      .update(read(review.candidatePatch))
      .digest("hex"),
  );
  assert.equal(policy.toString().includes(review.candidatePatch), true);
  assert.equal(review.sourcePatchAdopted, true);
  for (const key of [
    "compiledRegressionPassed",
    "newNativeBuildCompleted",
    "productionExposureConfirmed",
    "productionPatched",
    "productionApproved",
  ])
    assert.equal(review[key], false);
  const sqlite = JSON.parse(policy).sqliteSource;
  assert.equal(sqlite.version, "0.30.1");
  assert.equal(sqlite.sha256, review.archiveSha256);
  assert.equal(sqlite.advisory.id, review.advisory);
  assert.equal(sqlite.advisory.sha256, review.parsedAdvisoryJsonSha256);
});

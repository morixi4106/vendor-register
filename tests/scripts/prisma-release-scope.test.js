import assert from "node:assert/strict";
import fs from "node:fs";
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

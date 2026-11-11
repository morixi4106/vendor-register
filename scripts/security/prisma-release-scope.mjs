import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { prismaGitIdentities } from "./prisma-git-assessment.mjs";
const ROOT = path.resolve(import.meta.dirname, "../.."),
  sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const roots = ["query-engine-node-api", "schema-engine-cli"];
export function bindPrismaReleaseScope(identities, ledger) {
  if (
    ledger?.schemaVersion !== 1 ||
    [
      ledger.sourceReviewComplete,
      ledger.wholeEngineVerified,
      ledger.productionApproved,
    ].some((v) => v !== false) ||
    !Array.isArray(ledger.groups) ||
    ledger.groups.length !== 7 ||
    identities.length !== 13
  )
    throw new Error("prisma_release_scope_invalid");
  const names = ledger.groups.flatMap((g) => g.packages);
  if (
    new Set(names).size !== 13 ||
    names.length !== 13 ||
    new Set(identities.map((e) => e.name)).size !== 13
  )
    throw new Error("prisma_release_scope_inventory_changed");
  const entries = identities.map((entry) => {
    const group = ledger.groups.find((g) => g.packages.includes(entry.name));
    if (
      !group ||
      entry.reviewStatus !== "UNREVIEWED" ||
      entry.repository !== group.repository ||
      entry.commit !== group.commit ||
      ![group.completed, group.remaining].every(
        (s) => typeof s === "string" && s.length > 40,
      ) ||
      !/^https:\/\/github\.com\/morixi4106\/vendor-register\/(?:actions\/runs\/[0-9]+|pull\/59#issuecomment-[0-9]+)$/.test(
        group.evidence,
      )
    )
      throw new Error("prisma_release_scope_unbound");
    assert.deepEqual(
      Object.keys(entry.pathsFromReleaseRoots).sort(),
      [...roots].sort(),
    );
    const included = roots.filter(
      (root) => entry.pathsFromReleaseRoots[root] !== null,
    );
    if (included.join() !== group.releaseRoots.join())
      throw new Error("prisma_release_scope_graph_changed");
    return {
      ...entry,
      releaseScope: included.length
        ? "RELEASE_GRAPH_INCLUDED"
        : "OUTSIDE_RELEASE_GRAPH",
      boundedEvidence: group.evidence,
      completed: group.completed,
      remaining: group.remaining,
    };
  });
  return {
    entries,
    originalGitIdentities: 13,
    releaseGraphIncluded: entries.filter(
      (e) => e.releaseScope === "RELEASE_GRAPH_INCLUDED",
    ).length,
    originalUnreviewed: 13,
    sourceReviewComplete: false,
    wholeEngineVerified: false,
    productionApproved: false,
    scope:
      "Fixed metadata normal/build dependency paths, not binary reachability or an approval/admission policy",
  };
}
function read(file, limit = 10 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > limit
  )
    throw new Error("prisma_release_scope_file_invalid");
  return fs.readFileSync(file);
}
export function inspectPrismaReleaseScope(metadataFile, root = ROOT) {
  const ledger = JSON.parse(
      read(path.join(root, "security/prisma-release-scope.json")),
    ),
    policyBytes = read(
      path.join(root, "security/prisma-source-contracts.json"),
    ),
    metadataBytes = read(metadataFile);
  if (
    sha(policyBytes) !== ledger.enginePolicySha256 ||
    !Object.values(ledger.metadata).includes(sha(metadataBytes))
  )
    throw new Error("prisma_release_scope_evidence_changed");
  const policy = JSON.parse(policyBytes),
    result = bindPrismaReleaseScope(
      prismaGitIdentities(
        policy,
        read(path.join(root, policy.lockfile.path)),
        JSON.parse(metadataBytes),
      ),
      ledger,
    );
  return {
    ...result,
    metadataSha256: sha(metadataBytes),
    enginePolicySha256: sha(policyBytes),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--metadata")
      throw new Error("prisma_release_scope_arguments_invalid");
    console.log(
      JSON.stringify(
        inspectPrismaReleaseScope(path.resolve(process.argv[3])),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

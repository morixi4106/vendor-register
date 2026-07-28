# Security toolchain evidence: 2026-07-28

This record captures the local evidence used to design the fail-closed
dependency audit. It is not a permanent allowlist and must not be used to
extend the expiry without a fresh review.

## Environment

- Git revision investigated: `4a41edcdd0a3dd6c415a095eca50419cffedbb9f`
- Node.js: `24.13.1`
- npm: `11.8.0`
- Clean install command: `npm ci`
- Production app build: `npm run build`
- Shopify build:
  `npm exec --offline -- shopify app build --config production --no-color --skip-dependencies-installation`

## Dependency path inventory

The lockfile parser enumerated every reachable path to both
`minimatch@9.0.9` and `brace-expansion@2.1.2`.

| Scope                                    | Path count |
| ---------------------------------------- | ---------: |
| Root production                          |          0 |
| Root development                         |        121 |
| `account-home-entry` workspace           |          1 |
| `account-home-page` workspace            |          1 |
| `marketplace-purchase-control` workspace |          2 |
| Total                                    |        125 |

Of the 125 paths, 109 include at least one required peer-dependency edge.
No path includes an optional dependency, optional peer, or extraneous package
in the reviewed lockfile. These edge classes are not mutually exclusive with
the root/workspace scopes above.

- `minimatch@9.0.9` path-set SHA-256:
  `F3916DFAAE43BAEFEF44A4C8CF66E23CE8993788FA8733CFFE78DDAA5B12CF76`
- `brace-expansion@2.1.2` path-set SHA-256:
  `EB886FD2CAB6919948F0C4C3633DF0297C75F521BC84D5805DFC95A7E8F48352`

The complete, normalized path list is stored alongside the proposed risk
decision. The audit rejects any newly introduced path. If known paths
disappear, the audit succeeds with a reduction warning; if the advisory
disappears, no exception is required. It never updates the snapshot in CI.

## UI extension artifact evidence

The following complete SHA-256 values were recorded after the production
Shopify build used for the implementation check:

| Artifact                      |   Bytes | SHA-256                                                            |
| ----------------------------- | ------: | ------------------------------------------------------------------ |
| account-home-entry bundle     |  24,803 | `E500FA0DD1A8B92E316A7AC65E1EB645108645BF60B2FC2378EF95547E42EE2F` |
| account-home-entry source map | 197,639 | `0BDF46570CEEC519A74356D80FC371917B7753C4F9212D8B6810EAA518CD9113` |
| account-home-entry metafile   |  27,044 | `EEB27AC9C8DC6ED510E511D00C4AFC990126A49CD3E470E3421E5DA6A1C38ED5` |
| account-home-page bundle      |  22,430 | `C45B52F7E58087DD72704D9C5EA7715C059E818E9D0D61DE4AAABD1A01563CDB` |
| account-home-page source map  | 189,869 | `730CBDE51FA2D6339B3EB969842DBE1D9EBD7E6A86A1D9F68DC49E0BA43D4341` |
| account-home-page metafile    |  26,688 | `001F698614C1701963C6D1699C18DE8A04B7387C609F71C6C20904F36FC29784` |

These hashes are evidence for one reproducible run, not fixed CI expectations.
The automated audit instead checks every metafile input, external import, and
target package marker on every build.

## Final artifact verification

The verifier checks:

- direct imports in the application and extension source trees;
- every Remix server JavaScript artifact;
- every Remix client JavaScript and CSS artifact;
- Function JavaScript and WASM outputs;
- UI bundles, source maps, and metafiles;
- when a Shopify deploy package is supplied for verification, its deploy-bundle
  manifest, required module handles, and every file referenced by the manifest.

The Shopify CLI `app build` command used here produces the extension `dist`
outputs but does not retain a deploy-bundle directory. Build-only audits
therefore require every extension `dist` output and treat a deploy bundle as
optional. A deployment-package audit must opt into strict deploy-bundle
verification; once opted in, a missing or malformed bundle fails closed.

The implementation runs recorded in the proposed risk decision found no target
toolchain package in 136 artifacts. Build bytes differ across the supported
Windows development and Linux CI environments, so the decision records an
exact artifact-set SHA-256 for each supported platform:

| Platform | Artifact-set SHA-256                                               |
| -------- | ------------------------------------------------------------------ |
| Linux    | `EF426851D1D2A2F4CAED031AE65DF3604E96296988FD16BCF384464D2DB5081F` |
| Windows  | `CD60A21E6C79EB963AC87347910B5ACE96EF5D765F2662D9799831A7FF95BBD9` |

The exact artifact count and the current platform's artifact-set SHA-256 are
recomputed after every clean build and must match the human-reviewed evidence
before an accepted decision can pass. An unlisted platform fails closed.

Artifact hashes may legitimately change with source, Shopify CLI, or build
environment changes. Presence, manifest integrity, imports, metafile inputs,
and package markers are the CI gates.

### Reconciliation with the earlier 144-artifact run

The archived console output from the earlier run was parsed and compared by
exact path with the clean 136-artifact inventory:

- previous count: 144;
- current count: 136;
- common paths: 136;
- current-only paths: 0;
- previous-only paths: 8.

The eight previous-only paths were:

```text
.shopify/deploy-bundle/078e786b-ef41-b43e-c173-b38649de9b2fc2d4c1d1/dist/index.wasm
.shopify/deploy-bundle/93a58859-4221-3f8f-d67d-76e0cc411028b8a30857/dist/account-home-entry.js
.shopify/deploy-bundle/93a58859-4221-3f8f-d67d-76e0cc411028b8a30857/dist/account-home-entry.metafile.json
.shopify/deploy-bundle/93a58859-4221-3f8f-d67d-76e0cc411028b8a30857/manifest.json
.shopify/deploy-bundle/c0c47251-e3f7-1a1f-5841-f4f757a37d3c61194410/dist/account-home-page.js
.shopify/deploy-bundle/c0c47251-e3f7-1a1f-5841-f4f757a37d3c61194410/dist/account-home-page.metafile.json
.shopify/deploy-bundle/c0c47251-e3f7-1a1f-5841-f4f757a37d3c61194410/manifest.json
.shopify/deploy-bundle/manifest.json
```

These were stale packaging copies of outputs already present in the extension
`dist` directories, plus packaging manifests. The current Shopify build does
not retain this directory. No current artifact was removed from the scanner:
all 136 current paths were also present in the 144-path run. A strict
deployment-package audit can still require the deploy bundle explicitly.

The clean inventory is classified as follows:

| Required class                |   Count |
| ----------------------------- | ------: |
| Remix server entry            |       1 |
| Remix server chunks           |       1 |
| Remix client entry            |       1 |
| Remix client runtime manifest |       1 |
| Remix client route bundles    |     123 |
| Remix client styles           |       1 |
| Shopify Function JavaScript   |       1 |
| Shopify Function WASM         |       1 |
| UI extension entry bundle     |       1 |
| UI extension page bundle      |       1 |
| UI extension metafiles        |       2 |
| UI extension source maps      |       2 |
| **Total**                     | **136** |

## Independent npm verification

The audit also compares the lockfile analysis with npm's own `explain`,
`query`, and `ls` views. A production-only CycloneDX SBOM must omit the
toolchain targets. Any disagreement is blocking.

A clean `npm ci` reported 37 advisory-affected package nodes (32 high and
5 moderate). `npm audit --omit=dev --json` still reported 10 nodes (7 high and
3 moderate) because npm includes production dependencies of extension
workspaces in that view. Those counts are not treated as a clean result.
Instead, the lockfile graph independently proves that the high-severity
Shopify toolchain chain has zero paths from the root production dependency
set, while the artifact scanner proves that it is absent from generated
runtime and extension outputs. The three moderate nodes are the separately
documented, time-bounded Remix / React Router exception.

The current SBOM is generated only by:

```text
npm sbom --omit=dev --sbom-format cyclonedx
```

It contains 84 entries in `components`, identifies
`vendor-register@0.0.0` as its root component, and has canonical component-set
SHA-256
`3F4AEED4C510F902A72CEFFF87FBB8CDA18D9FECB250043F2D213A22199D6A9B`.
The target toolchain packages are absent.

An older externally reported count of 63 components did not include an
archived CycloneDX document or component list, so its 21-component difference
cannot be reconstructed safely. It is not used as evidence or as an expected
count. The reproducible 84-component npm command and root identity above are
the current baseline; changes are checked semantically for target-package
presence and root agreement rather than accepted by count alone.

## Production-audit test coverage

Every listed implementation file is explicitly passed through
`--test-coverage-include`, so an unloaded helper cannot disappear from the
coverage denominator.

| File                                |      Lines |   Branches |  Functions | Uncovered lines                             |
| ----------------------------------- | ---------: | ---------: | ---------: | ------------------------------------------- |
| `audit-production-dependencies.mjs` |     98.92% |     90.14% |     86.36% | 75-76, 194-195, 207                         |
| `artifact-reachability.mjs`         |     98.00% |     92.07% |    100.00% | 107-111, 113-117, 191-194, 356-358, 492-493 |
| `audit-policy.mjs`                  |    100.00% |     88.10% |    100.00% | none                                        |
| `audit-report.mjs`                  |    100.00% |     94.03% |    100.00% | none                                        |
| `clean-audit-artifacts.mjs`         |     95.51% |     88.37% |    100.00% | 41-42, 52-53, 74-77                         |
| `generate-risk-path-snapshot.mjs`   |    100.00% |     92.00% |    100.00% | none                                        |
| `npm-tree-verification.mjs`         |    100.00% |     90.00% |    100.00% | none                                        |
| `package-lock-graph.mjs`            |     97.80% |     91.30% |    100.00% | 436-444, 598-602                            |
| `risk-acceptance-provenance.mjs`    |     99.21% |     86.16% |     96.30% | 318-319, 341-342                            |
| `scan-security-documents.mjs`       |    100.00% |    100.00% |    100.00% | none                                        |
| **Aggregate**                       | **98.72%** | **90.05%** | **97.96%** |                                             |

The uncovered cleanup lines are secondary containment checks for filesystem
states that are prevented by the earlier normalized-path and realpath checks.
They remain fail-closed. Branch coverage below 90% in `audit-policy.mjs` is
from combinations inside compound validation expressions; malformed
definitions, exact expiry boundaries, new High advisories, and simultaneous
independent failures have direct tests.

## Intentional test skips

The full Windows run has exactly three intentional skips:

1. `readJson and risk snapshots reject symbolic links` in
   `tests/scripts/audit-entrypoint.test.js`. It is skipped only when
   `process.platform === "win32"` because creating file symlinks may require
   Windows Developer Mode or elevated privilege. The cleanup suite separately
   creates and rejects a Windows directory junction, so Windows cleanup-link
   containment is exercised. This test runs on Ubuntu.
2. `rejects symlinks in audited trees` in
   `tests/scripts/artifact-reachability.test.js`. It has the same Windows-only
   symlink-creation constraint and runs on Ubuntu. Archive limits, traversal,
   regular-file checks, and Windows path normalization are not skipped.
3. `getVendorOrdersPageData returns mapped orders when read_draft_orders is
granted` in `tests/services/vendorManagement.server.test.js`. This is an
   explicitly disabled legacy Draft Order path. Public Draft Order checkout is
   disabled and this skip is unrelated to the security audit. It remains
   visible rather than being counted as executed coverage.

## Verification status

Local verification on Windows with Node.js `24.13.1` and npm `11.8.0`:

- PASS: Prisma format, validate, and client generation;
- PASS: lint with zero errors (28 pre-existing warnings);
- PASS: text-encoding and security-document secret/PII scans;
- PASS: 701 of 704 application tests, with three intentional skips;
- PASS: all 30 Checkout Function tests;
- PASS: 138 of 140 production-audit tests, with two Windows-only
  symlink tests skipped;
- PASS: production-audit coverage at 98.72% lines, 90.05% branches, and
  97.96% functions, including all ten audit implementation files;
- PASS: production Shopify extension build and Remix build;
- PASS: clean artifact verification for 136 artifacts and 84 production SBOM
  components;
- PASS: no generated extension manifest or stale Shopify deploy-bundle archive
  remains after cleanup;
- PASS: no whitespace errors from `git diff --check`.

The earlier branch revision was exercised by the GitHub-hosted Ubuntu Quality
workflow. The current acceptance-provenance revision remains UNVERIFIED on
Ubuntu until it is pushed and that workflow runs again. The policy remains
intentionally blocking because the upstream report URLs are empty and the
proposed decision has not been accepted by a human reviewer.

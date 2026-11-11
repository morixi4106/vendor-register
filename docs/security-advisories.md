# Production dependency advisories

## Runtime Package Native Admission: 2026-11-11

The incident check inspects the build tree, while runtime packaging installs a
different dependency tree. Registry audit success alone previously allowed that
new tree to produce runtime success evidence without checking its native bytes.
This is a candidate packaging gap, not proof of production exploitation.

Reuse the existing exact native hash/platform/source/SBOM checks before executing
the staged generator, after generation/audit, and before/after activation. Require
the packaged schema engine and real generated client engine; reject all other
unapproved native artifacts, not just Prisma. Bind the policy and full inventory
to evidence and compare copies. On failure restore original modules and leave
no stale success receipt. Build-inventory requirements and all approval gates
are unchanged; no real candidate artifact is newly approved.

Tests use synthetic non-executable native-header fixtures, not release binaries.
Actual native source/client/database verification remains separately recorded.
Local1713 tests:1704 pass/0 fail/9 platform skips; audit187 pass/3 platform skips,
coverage98.71/92.60/98.61; focused38 pass/1 platform skip; build/lint/text and
architecture checks pass. A separate actual script-disabled install of172
production packages rejects12 unapproved Prisma WASMs and the missing packaged
schema executable before generation. Original native inventory is unchanged,
temporary staging removed, no activation or runtime-success receipt written.
This negative rehearsal does not approve a full production package.
See [adoption prerequisites and production boundary](operations/runtime-native-adoption.md).
Whole-source/native/provider/production approval remains false.

## GraphQL Parser Depth Candidate: 2026-11-05

The exact previously verified Windows release library aborts an isolated child
on a 5000-level GraphQL selection, after a successful synthetic SQLite SELECT1
control. Depth0/32 controls complete, including the subsequent SELECT1. This is
not proof of public HTTP exploitability or an observation against production.

Keep the original Prisma graphql-parser fork and ordered AST representation.
An explicit pinned source patch adds an iterative preflight using its original
lexer, before both recursive query and schema parsing. Limit combined delimiter
nesting to50, consistent with the maintained parser's
[upstream security fix](https://github.com/graphql-rust/graphql-parser/commit/d19155f5f9206662964e388e80c68b85f3edb09a).
Strings, block strings and comments use the original lexer, not a second parser
or a bracket-counting regex. Grammar and AST conversion remain unchanged.
No new byte/token limit or protocol/dialect removal. Inputs beyond this nesting
limit now return a parse error rather than entering recursive parsing.

Add18 actual-parser regressions, the original library unit suite and separate
non-promoting Linux/Windows CI. Native probes additionally require six excessive
input families to reject without panic, three quoted/block/comment cases to
pass and18 successful before/after database controls. Source/module/patch/lock/
metadata bindings and rejected receipt tests remain mandatory. Move one Git
identity to a bound path without approving it: three Git plus ten Git-derived
paths still mean13 UNREVIEWED identities. Registry dependency graph is unchanged.

Actual new parser/native CI and artifact comparisons are not completed at this
implementation point. Whole-engine/native admission and production approval
remain false. The old database-lab native artifact pin must reject this changed
recipe until a newly verified native input is available; do not waive it. No
production migration/deployment, Shopify, financial or notification change.

## Original Git Dependency Assessment: 2026-11-05

Keep all13 Prisma Git-derived packages explicitly UNREVIEWED, including the9
converted to patched local paths. The source/native assessment now queries
their original declared crate versions and all6 exact Git commits using the
[official OSV API](https://google.github.io/osv.dev/post-v1-querybatch/).
Retain the complete advisory payloads with canonical SHA256 digests, query
results, policy-bound lock identity, target metadata hash, resolved features,
direct consumers and paths from both release roots. Bind the assessment digest
in the source receipt. Fail on unavailable feeds, omitted pages, malformed or
changed payloads, changed source commits and detached metadata.

Fresh local assessments against the previously prepared locked Linux/Windows
metadata both find6 advisory IDs against2 original PostgreSQL crate versions:
the three known row/hstore/SCRAM issues with RustSec/GHSA aliases. Exact commit
queries find no matches. This is not fork equivalence or a new compilation,
source review, patch approval, or proof that the remaining packages are safe.
Canonical payload digests agree across both assessments. Object key reordering
does not change the digest; changes to body, references or affected ranges do.

The barrel dependency has no non-dev graph path from either release root;
graphql-parser reaches the query library; Tiberius and its procedural macro
reach both roots. These are Cargo graph paths with unioned features and build
dependencies, not executable reachability or permission to remove dialects.
Existing source fixes, binary digests, locks, production controls and native
admission gates are unchanged. sourceReviewed=false, sourceAuditOk=false,
wholeEngineVerified=false and productionApproved=false remain. Independent CI
artifact verification for this new assessment is still required.

## Prisma Native Probe Candidate: 2026-11-05

Add a separate, non-promoting native probe workflow. Reuse the exact source
archive, explicit patches, fixed compiler, locked graphs and real metadata
checks from the source-contract pipeline. Build the actual default-feature
query-engine-node-api and schema-engine-cli with a debug profile, not a release
or a production replacement. Fresh registry findings block native execution;
unreviewed Git provenance and whole-engine/native production approval stay open.

On both OSs, generate a private Prisma6.19.3 client and apply two synthetic
migrations twice to a disposable SQLite database. Check actual N-API loading,
CRUD/CUID, parameterized queries, unique errors, batch and interactive commit/
rollback, reconnect and cleanup. A loader hook hashes the library actually
loaded; a separate CLI spawn hook hashes each actual schema-engine invocation.
Bind both compiled binaries, fixture scripts, workflow, source policy and locks
to the receipt. Missing checks, changed binaries or production approval claims
cannot become a passing probe report. Installed application engines, generated
application client, application schema and real databases are not replaced.

Linux additionally uses an immutable official PostgreSQL17.11 service image,
random runner loopback port, synthetic database/account and SCRAM host auth.
No external database URL is accepted. PostgreSQL mode requires explicit CI
context; children inherit only the existing credential-free build environment.
Private explicit Prisma configuration disables dotenv loading and client
auto-installation. Verify real SCRAM authentication and rejection of a separate
synthetic role with100001 iterations, without exposing its verifier. This is
not TLS, PgBouncer, production SCRAM configuration, application migrations or
release-profile verification. A fixture-development run with the original
installed engine is diagnostic only and never patched-native proof.

CI execution and independent artifact comparison must complete before claiming
these native probes passed. Existing incident/native promotion gates, main,
production, Shopify, financial operations and notification suppression remain
unchanged.

## Minimatch Advisory Re-review: 2026-11-05

Re-reviewed [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)
after its November4 update stopped the existing gate. Comparing the official
advisory-database revisions dbeae43fd24e3702e6d80fe80d1a08adc3c44122 and
db6b565eb01ac6a316283ef3d177ce76b587c7d0 shows three changed fields:
modified, affected and references. The introduced version changes from0 to7.0.0;
two introducing commits are added. The description and
[fix77a0f5c](https://github.com/isaacs/minimatch/commit/77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8)
are unchanged. Original9.0.9 remains affected; narrowing is not clearance.

Keep the existing hash-bound @oja/minimatch9.0.9-oja.1 bytes, archive and API.
Both CommonJS and ESM cap generated alternatives at1000, explicitly rejecting
further amplification with RangeError, and skip quadratic second-phase work
above1000 existing alternatives without truncation. The official v11 fix uses
its braceExpandMax option for the first bound; the local v9 bound/error behavior
is an intentional, previously documented compatibility difference, not an
upstream release or an assurance about every possible resource-exhaustion path.

The fresh original-identity OSV query now binds the entire reviewed advisory
through recursive object-key-sorted JSON SHA256, including affected ranges,
description, references, aliases, severity and modified timestamp. Arrays retain
their order. Policy pins modified2026-11-04T17:01:25.850114200Z and digest
2e09f17fa14e2cf81498f498fe06d7acc24c72ef6ee883e02da2aae2e7dad2a6.
Tests retain the full reviewed response as an offline fixture. Any content
change, unknown advisory, missing expected advisory, duplicate, paginated or
malformed response fails closed. A valid empty response also requires review:
the pinned reviewed range still includes v9. Network failure never grants
approval. Splitting the dedicated workflow's version/install commands prevents
a Windows shell from hiding the earlier command's exit status.

Local and CI results are recorded separately in the launch handoff and PR59.
This re-review does not approve native artifacts, close the whole incident,
merge main, deploy production, release Shopify or resume notification emails.

## Prisma CLI Parser Migration: 2026-11-04

Replace the actual query-engine, schema-engine and prisma-fmt consumers of
structopt/clap2 with pinned clap4.6.7/derive/env. Bind all three manifests,
entry points and parser implementations in the source policy, and require
their actual Cargo metadata to resolve the pinned registry parser/features.
Legacy structopt/ansi_term/proc-macro-error reintroduction is rejected. Keep
the Prisma client/schema and installed engines unchanged; this is a source
candidate, not an upstream engine release or native approval.

The engine graph changes from623 registry/11 raw matches to612/8. Removed
entries include maintenance notices, not three independently exploitable CVEs.
The remaining atty entries are reached through the existing criterion benchmark,
with old HTTP, rand and paste entries still visible. Eight Cargo Git identities
plus five Git-derived path identities remain UNREVIEWED. Contract graph351 is
unchanged; its zero registry matches still do not grant source review.

New contracts compile the actual three CLI entry points and exercise only the
oja_cli_contracts namespace, never executing database commands. They cover
flags, defaults, nested subcommands, base64/plain input, real datasource/extension
types, datamodel files, isolated child environment/precedence and help/version.
Retain legacy argument-error exit1/help-version exit0 rather than adopting
clap4's changed error exit2. Help/error layout may change; output bytes are not
claimed identical. No service/database, destructive subcommand, migration,
installed engine or production operation is part of these tests.

Minimum CLI tests are query9/schema9/fmt5, separate from56 existing contracts
and upstream-library tests. The first full compilation exposed the existing
Tiberius BigDecimal0.4 versus engine BigDecimal0.3 mismatch. Bridge only the
MSSQL conversion boundary through exact integer mantissa/exponent pairs;
do not change the engine-wide decimal type, downgrade the driver or remove
MSSQL/TLS features. Bind this additional source file (23 total) and add five
actual TDS round-trip/null/scale/range contracts without a server. The old
driver's documented out-of-range panic is retained, not silently rounded or
claimed fixed. The failed first CI is not compatibility evidence.

Node binding/rejection tests22 pass. Actual local
compilation cannot run because this PC lacks link.exe; use the existing
Windows/Linux source-contract CI without adding a PC-wide toolchain, skipping
tests, changing risk acceptance or weakening native admission. CI results must
be checked before claiming this candidate's parser compatibility verified.

Sources: [structopt maintenance notice](https://rustsec.org/advisories/RUSTSEC-2022-0104.html),
[clap derive reference](https://docs.rs/clap/4.6.7/clap/_derive/index.html).

## Minimatch Distributed-JS Backport: 2026-11-04

GHSA-g3hv-75wg-m249 / CVE-2026-118764 affects installed minimatch9.0.9.
The registry reported18 affected dependency entries from one direct advisory,
not18 independent CVEs. Upstream11.0.1 fixes it, but11 removes makeRe and other
v9 APIs used by the installed React Router/GraphQL/ESLint toolchain. Preserve
those consumers with the explicit, ISC-licensed local @oja/minimatch9.0.9-oja.1
backport, installed under the minimatch alias. This is not an upstream release
or a claimed rebuild of the upstream TypeScript source.

Bind the original9.0.9 archive/revision, official fix revision, local tarball,
both ESM/CommonJS distributions, license and provenance through30 file hashes.
The first-phase amplifier explicitly rejects preprocessing above1000 generated
alternatives with RangeError; it must not silently truncate or change a match.
The second-phase pairwise deduplication is skipped above1000 alternatives while
preserving preexisting nonamplifying sets. A naive partial-cap approach was
rejected after differential testing found changed results. The final local
comparison agrees with upstream9 for7153 ordinary cases and intentionally
rejects two over-budget cases. This is bounded compatibility, not a claim that
arbitrarily expensive patterns remain accepted. Child tests have128MiB memory
and15-second limits in both module modes.

The installed-byte gate checks all30 files and every actual consumer's resolved
entry point, not just a manifest version. The npm tree verifier includes the
scoped identity in query/lock/SBOM checks; the runtime packager forbids both
names. Only four unchanged vendored distribution files disable the project's
no-useless-escape style rule to retain upstream regex bytes; other lint rules,
application lint, coverage and security admission rules remain enforced.

Registry audit is insufficient for a renamed package. Every backport gate
freshly queries OSV for the original minimatch9.0.9 identity. The existing
advisory stays visible in the receipt, bound to its reviewed modification
timestamp; a new/changed advisory, unavailable response, altered file, hidden
lock copy or detached consumer fails closed. Production incident admission,
Quality checks and the dedicated Windows/Linux workflow run this gate without
continue-on-error. No historical risk acceptance, native approval, expiry or
required-check bypass was added. Cross-platform CI results must be recorded
separately from these local implementation checks.

Local full Node tests:1200 passed,5 existing platform skips,0 failed. App build,
actual Function GraphQL typegen and npm tree/SBOM checks pass; npm registry
audit reports0, separately from the observed original advisory covered by the
verified backport. A fresh isolated runtime install has172 packages, audit0,
no forbidden build packages and activate=false. The incident audit now passes
npm/backport checks and still refuses unresolved native artifacts. Whole-engine
Prisma/NAPI, isolated DB/migrations, Javy/Function/provider and live-runtime
evidence remain incomplete. No main merge, deployment/settings/Shopify release,
financial action or monitoring-mail restart.

Sources: [advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249),
[official fix](https://github.com/isaacs/minimatch/commit/77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8),
[v11 API changes](https://github.com/isaacs/minimatch/blob/v11.0.4/changelog.md).

## Prisma CUID Source Follow-Up: 2026-11-04

Add an explicit archive/patch-bound override of Prisma's existing cuid-rust
revision dc68c4f47a3dbcd511f605135ac7c948775a3ab9. The source archive matches
the existing pinned Cargo checkout for all23 Rust/manifest files. All four
packages are marked +oja.1; only five manifests change. Remove cuid1's unused
base36 dependency, which transitively selected failure/failure_derive. Its real
conversion already uses cuid-util, not base36. Pin the existing WASM
getrandom0.2.17/js resolution rather than changing the entropy backend or
removing WASM support. No ID-generation implementation, app/client/schema,
installed engine, database or existing identifier changes.

Full frozen graph: **623 registry packages /11 observed OSV matches** versus
the preceding same-day633/15. Four raw matches disappear with the obsolete
failure dependency, not four unique proven exploits. Eight Cargo Git entries
plus five explicitly UNREVIEWED Git-derived path packages still total13.
Contract registry351 has zero observed matches, but its five unresolved
Git-derived identities retain sourceAuditOk=false, contractSourceReviewed=false,
NOT_VERIFIED and productionApproved=false. Original MongoDB/mysql_common
identities remain separately scanned. No ignores, native approval or gate change.

The fixture adds14 CUID compatibility tests, bringing its minimum to56.
It compiles actual CUID libraries and covers base36 known boundaries/full-width
round trips, v1/v2 formats, slugs, small serial/threaded batches, constructors,
callbacks and invalid lengths. Sample noncollisions do not prove uniqueness,
cryptographic security or expose real customer IDs. Hashes and actual Cargo
metadata bind the unchanged generator modules, query-core/query-structure
consumers and all four local packages. Node rejection tests refuse unused/mixed
overrides, old failure/base36 graphs, missing source hashes, false source-review
status and loss of the pinned WASM entropy feature. Fresh native CI remains
required; previous42-test runs do not certify these changed inputs.

Native engine/NAPI/schema, isolated DB/migrations, remaining CLI/HTTP/source
review, Javy/Function/provider and live-runtime evidence remain incomplete.
No main merge, deployment/settings/Shopify release, financial action or mail restart.

The MySQL/Runner section below records the preceding candidate, not the CUID CI.

## Prisma MySQL source follow-up: 2026-11-04

Draft #59 adds explicit source overrides preserving Prisma's mysql_async
revision c4c841c9d03e361df7377264a075335a823534ee and mysql_common 0.29.2.
Custom versions use +oja.1; this is not an upstream release or an installed
engine. LRU 0.18.2 and lexical 7.0.5 replace old driver/parser dependencies.
Common uses sha1 0.11.0 / sha2 0.11.1, with unchanged algorithms and known-value
tests. Bindgen 0.72.1 replaces the old build dependency. Default native TLS,
vendored OpenSSL, numeric features and optional connectors are retained.

The frozen full graph now has 633 registry packages / 15 observed OSV matches,
plus 12 Cargo Git identities and one explicitly UNREVIEWED Git-derived path
override. The previous graph had 639/21/13; these are raw matching counts with
aliases/maintenance information, not a count of independently exploitable CVEs.
The contract registry graph has 338 packages / zero observed matches. It still
includes the unreviewed Git-derived source; path conversion is not source review.
Receipts explicitly retain contractSourceReviewed=false, the original Git
revision/review status, total unreviewed Git counts, NOT_VERIFIED and denied
production/whole-engine approval. Original registry overrides are freshly
scanned independently. No advisory exclusions or approval-table changes.
Contract assessments explicitly retain the unresolved Git-derived identity and
sourceAuditOk=false, separately from registryAuditOk=true; the legacy source
success flag is not left green after path conversion.

Seventeen Node binding/rejection tests pass. The new Rust test definitions cover
real cache behavior, numeric conversion, authentication vectors and unchanged
DER/RSA/OAEP source tests. The fixture uses Rust 2021 to include unchanged legacy
RSA source syntax; original driver/engine editions are not changed. Initial CI
compiled both real MySQL libraries but found Rust 2024's reserved `gen` keyword
in the included RSA tests. Tests are retained, not skipped. Compilation and
execution require fresh Windows/Linux CI evidence; prior results are not reused. No connection or
real database is created. Metadata refuses unsafe upstream test/nightly features
and diagnostic hooks in the full engine. The upstream MySQL test downloader is
retained as source, not invoked or approved. Full native/NAPI/schema/isolated
database/migration and remaining dependency work is still incomplete. No app
Prisma/client/schema, production configuration/deployment, financial action or
notification changes.

Fresh Runner source checks on 2026-11-04 detected a new advisory against the
previously tested Wasmtime 36.0.19: [RUSTSEC-2026-0424](https://rustsec.org/advisories/RUSTSEC-2026-0424.html),
issued after the prior verification. The candidate now selects fixed 36.0.20,
including the archive/patch-bound cache source, and is versioned 9.2.2+oja.2.
All existing features and cache/profiler behavior are retained. The frozen graph
again has 426 registry packages / zero fresh observed matches. Old 36.0.19
receipts are historical, not current approval; full new binary/tests evidence is
required. The existing source gate rejected the new advisory without an ignore
or severity exception. Neither candidate has native/production approval.

## Prisma source-contract and compression candidate: 2026-10-30

Draft #59 adds an explicit patch of the engine source bound to Prisma 6.19.3,
without changing application dependencies, generated client, schema or database.
Query-core uses LRU 0.18.2 and a tested nonzero-capacity adapter. Migration
checksums use sha2 0.11.1; the source-contract crate includes the actual engine
modules and tests SHA-256, line endings and historical unpadded checksums.

The follow-up adds an explicit MongoDB 3.9.1+oja.1 source override using zstd
0.14.3 / zstd-safe 8.2.0. Its original registry archive, patch, manifests and
unchanged compression modules are hash-bound. All three compression algorithms
remain enabled. The contract fixture compiles the complete MongoDB library and
uses an opt-in diagnostic feature to exercise its real methods without a server.
That feature is rejected in complete-engine metadata. The upstream MongoDB
identity is independently scanned, not silently omitted as a local dependency.

The complete frozen candidate has 639 registry packages, 21 observed OSV matches
and 13 unreviewed Git-sourced packages. The separate 243-package contract graph
has no observed matches or non-registry sources. The 34-to-21 raw-match reduction
includes aliases/maintenance information, not 13 independently confirmed CVEs.
The contract graph does not certify the engine. Source preparation hash-binds
archives, patches, both lockfiles, module contents and the official Rust compiler
policy. Metadata checks actual resolved dependencies and refuses Git revisions
absent from the frozen lockfile. Node rejection tests pass 14 cases. The previous
stage's Windows/Linux result was 11 contract and 18 library tests per OS; new
compression compilation/tests require a new CI run, not reuse of that evidence.

`native:prisma-contracts -- --upstream-units` tests query-core/schema-connector
libraries in an isolated build home without database or production credentials.
The full source findings stay in uploaded evidence. Every receipt retains
NOT_VERIFIED, wholeEngineVerified=false and productionApproved=false, even if
all source tests pass. NAPI, isolated PostgreSQL/migration tests and remaining
engine dependencies are still required. Existing native/build/migration gates,
approval tables and production configuration are unchanged. Query-core declares
its existing IndexMap serde requirement explicitly for standalone library tests.

## Function Runner source rebuild candidate: 2026-10-29

The follow-up recipe pins official Rust 1.99.1 compiler/Cargo/std archives and
rebuilds Shopify's fixed source with Wasmtime 36.0.19. Cache/profiler features
are retained using two explicit source overrides: sha2 0.11 / zstd 0.14.3 and
rustc-hash 2.1.3. The generated lock has 426 registry packages including the
overrides' test dependencies, no advisory
matches in the observed OSV response and no git dependencies. Source, original
crate archives, patches and lock bytes are hash-bound; custom versions use
`+oja.1`. This is not an upstream release and not an advisory exclusion.

Source-only resolution has been reproduced locally with sanitized credentials
and verified tools. CI builds the native executable on Windows/Linux, tests
both modified components, then exercises WASI JSON I/O, stable nonzero fuel,
traps, environment isolation and profiling. Receipts explicitly retain
`artifactStatus=NOT_VERIFIED` / `productionApproved=false`: complete extension
ABI/fuel fixtures, embedded-provider provenance and native approval remain
separate. No existing native gate/approval was weakened. Prisma/Javy and live
runtime verification remain unresolved. PC-wide Rust installation is not used.

## Native remediation and authorized workstation updates: 2026-10-29

Follow-up to draft #59. This is still not a deployable, incident-closed release.

- Rebuild the existing esbuild 0.25.12 source commit
  `208f539945b145e7c9d6d844290f81c3fe5af320` with official Go 1.27.3.
  Source and compiler archives are digest-pinned; build processes receive no
  production credentials, module checksum verification stays enabled and CGO
  is disabled. Windows and Linux x64 outputs are byte-digest pinned. The
  upstream JavaScript API/protocol version remains 0.25.12, while the SBOM and
  installed `oja-rebuild-receipt.json` explicitly identify the local rebuild.
  This is not an unmodified npm binary or an upstream esbuild release.
- Fresh `native:esbuild` rebuilds both target binaries, inspects Go build
  metadata and scans each actual binary with pinned govulncheck v1.9.0 against
  the official database. All severities block; absent/malformed results fail.
  Locally both binaries scan clean and repeated Windows-host builds reproduce
  the expected hashes. The installed Windows binary uses Go 1.27.3. Current
  source, policy, binary, SBOM and scan hashes plus a 24-hour receipt are checked
  by the incident gate. No Javy, Runner or Prisma approval was invented.
- CI now performs these rebuilds on fresh Linux/Windows workers and uploads
  outputs and provenance; a source-only Rust advisory job captures complete
  upstream Cargo.lock graphs. Source audit success never certifies a binary.
  The local Rust assessment still fails. Prisma has 595 registry packages and
  12 non-registry sources needing review; examined Runner/Javy source graphs
  have 432/491 registry packages. Advisory matches include aliases, development
  dependencies and maintenance notices, not independent exploited CVEs.
- The current Prisma 6.19.3 source graph includes rustls 0.23.34,
  rustls-webpki 0.103.7 and webpki-roots 1.0.3. Actual target features, linked
  binaries and certificate stores still require verification. The updated
  assessment finds October certificate distrust advisories, including
  [RUSTSEC-2026-0381](https://rustsec.org/advisories/RUSTSEC-2026-0381.html) and
  [RUSTSEC-2026-0382](https://rustsec.org/advisories/RUSTSEC-2026-0382.html).
  Do not treat the 0.26.11 compatibility wrapper as safe when its resolved 1.x
  parent is old. Upstream main alone is not clean: the examined Runner source
  still selects Wasmtime 36.0.14; Javy's full lock graph includes older Wasmtime
  entries despite newer workspace constraints. Resolve complete build graphs
  and compatibility before promoting custom Rust binaries.
- After explicit user approval for PC-wide updates, the signed official Node
  MSI and .NET installers completed with exit 0 and no restart. Default Node is
  24.22.1 with the approved executable hash. x64 Core/Desktop are 8.0.33/9.0.22;
  the previously missed x86 Core/ASP.NET Core/Desktop families are now 8.0.33.
  Installer hashes match signed Node checksums / Microsoft's release metadata,
  and Authenticode was Valid for OpenJS Foundation/Microsoft. The installers'
  normal upgrade behavior replaced some old patches; no separate manual
  uninstall or forced application restart was performed. x64 Core 8.0.14
  remains. Old-version-pinned and self-contained apps are not certified merely
  by installing current shared runtimes.

Local follow-up checks: 1,153 tests pass, four existing Windows skips; app build
with rebuilt esbuild, lint, text/architecture and unchanged audit coverage
thresholds pass. The incident inventory now recognizes the rebuilt esbuild,
but 24 other local native artifacts remain unreviewed and Javy/Runner are
missing from the fresh install. New CI results must be checked separately.
The actual native/package findings remain blockers; no main merge, production
deployment, Shopify release, migration or notification restart was performed.

## October incident candidate implementation: 2026-10-29

This is an **incomplete, non-deployable security candidate**, on
`agent/october-runtime-security`, based on main `3c3c527`. It does not include
the unfinished international feature/migration stack. Nothing in this change
authorizes deployment, Shopify release, transactions, notifications, global
workstation installation, or new vulnerability exceptions.

### Implemented and locally verified

- Pin Node `24.22.1` using `.node-version`, package engine minimum, and CI.
  `security/node-runtime.json` binds the official Linux/Windows x64 executable
  digests to the release archives. `runtime:version`, guarded builds and server
  startup reject old, unknown or substituted executables. The local test/build
  Node was unpacked separately; the PC's global Node installation is unchanged.
- The official release archive checksums were verified against the detached
  signature using Node release key
  `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`. Windows Authenticode was Valid
  (OpenJS Foundation). Brotli's `1.2.0` version string is not proof of missing
  fixes: the Node security release contains a backport. See the
  [official release](https://nodejs.org/en/blog/release/v24.22.1/) and
  [release keys](https://github.com/nodejs/release-keys).
- Update body-parser `1.20.9`, qs `6.17.1`, Vite `6.4.5`, Vitest `4.1.12` and
  TOML `5.0.1`, preserving unrelated application/Shopify/Prisma pins.
- Backport the deepmerge prototype-key guard explicitly as
  `@oja/deepmerge@4.3.1-oja.1`. MIT source, license, upstream commit and advisory
  provenance are in `vendor/deepmerge`. This is **not** an upstream fixed
  release. The root override uses the vendored tarball for every consumer.
  Tests and digest checks verify source, manifest, provenance, tarball and the
  physically installed Polaris consumer. Do not rename unpatched code or treat
  its absence from the npm advisory index as patch verification. See
  [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4).
- Move vite-tsconfig-paths to development dependencies. The isolated runtime
  has 172 installed packages with no Vite, esbuild, Rollup or Shopify compiler.
  Patched-fork staging, lockfile identity and physical runtime inspection pass.
- Pin Node-24-based GitHub action revisions and verify the job Node executable
  separately. Action-internal runtime binaries and provider infrastructure are
  **not** proven patched merely by their `node24` metadata.
- Replace the floating Alpine Docker base with the official
  `24.22.1-bookworm-slim` manifest digest. Route its build through the production
  gate and exclude local secrets/evidence. Docker is unavailable on this PC;
  this image and its OS packages have **not** been built or security-scanned.

### Gates and remaining work

`npm run audit:incident` runs a fresh all-dependency registry audit, verifies
the actual patched fork and Node executable, and inventories native bytes.
The report binds the observed Git commit/dirty state, lockfile and policy
digests, platform and artifact hashes. Version strings are only hints, not
proof that a compiler, enabled feature set or bundled library is safe.

The local registry audit reports zero advisories at all severities. This does
**not** resolve native or provider findings. The incident command exits 1:
25 native artifacts remain unreviewed, and a fresh ignore-scripts install has
no downloaded Javy/Function Runner. Missing tools are blockers, not exemptions.
`security/native-artifacts.json` intentionally has no fabricated approvals.
A future approval requires an exact binary digest and source-commit-bound SBOM;
the SBOM also needs actual RustSec/Go/feature/applicability review. A structured
SBOM alone is not a vulnerability scan or a trusted production attestation.

The local esbuild binary still identifies Go `1.23.12`; Prisma binary hints
include rustls `0.23.34`/`0.26.4`. Their complete native SBOMs/applicability are
not verified. The examined CLI `5.0.0` still selects Function Runner `9.2.2`,
whose source Cargo.lock includes Wasmtime `39.0.1`. Therefore a CLI upgrade is
not claimed as remediation. Obtain or reproducibly build reviewed patched
native tools, then verify ABI, fuel accounting and all Function/WASM fixtures.
Do not manufacture approvals or extend the old build exception to unblock it.

CI blocks before Function execution/build; `build:production` and the production
migration workflow also reject unresolved incident inventory. A separate CI
matrix checks the pinned Node/backport/inventory tests on Linux and Windows.
These workflow edits are candidates,
not evidence that Linux/Windows CI has run. Existing main protection, audit
coverage thresholds, quiet prelaunch notifications and auto-merge settings are
unchanged. `incidentClosed` remains false; production, workstation and provider
verification are separate NOT_VERIFIED fields.

Local verification with the signed portable Node: 1,144 application tests pass
(four existing Windows skips),
lint, text/architecture checks, audit-test coverage thresholds, app build,
Function GraphQL type generation (no generated diff), and isolated runtime
check pass. The payout fixture clock is deterministic, with a regression that
still rejects evidence older than 90 days. Function execution/extension rebuild
and a container build are not certified. The full production dependency/artifact
audit was run and fails: prior build-control evidence no longer matches, and
extension/WASM bundles and source-map evidence are missing. Its independent npm
tree check passes (138 production SBOM components). No old acceptance was
extended to bypass those failures. Fresh Linux/Windows CI still needs results;
the native incident gate deliberately fails and this branch must not be merged
or deployed yet.

### Next Three Actions

1. Resolve actual native tools and Prisma SBOM/applicability, including all
   applicable Wasmtime advisories, not just the npm graph.
2. Verify fresh Linux/Windows CI, Function/WASM, container/OS and production
   artifact audits with the reviewed native tools. Preserve the failing gate
   until evidence is complete; do not copy prior exception acceptance.
3. Separately obtain approved workstation/.NET changes and authenticated live
   Web/Cron runtime/provider evidence. Deployment and post-deployment validation
   require their own approval; keep notifications suppressed.

## Historical dependency refresh: 2026-10-08

2026-10-08: the dependency refresh on `agent/shopify-centered-privacy` pins
`proxy-addr` to `2.0.8`, `brace-expansion` to `2.1.7`, `@fastify/busboy` to
`3.2.2`, `@graphql-tools/executor-legacy-ws` to `1.1.37`, `shell-quote` to
`1.12.0`, and `source-map-js` to `1.2.2`.
These are available patch/minor fixes, not new risk exceptions.
Re-run the complete production audit before deployment; the September result
below is historical and does not establish the current dependency safety.
`braces` and `sprintf-js` have no newer published version at this check. The
first refresh still included older GraphQL Tools utility versions; the
follow-up below removes them.
The build-tool gate must not be relaxed or given fabricated acceptance.

The follow-up pins **all** GraphQL Tools utility instances to official
`12.0.3` and moves `@shopify/shopify_function@2.0.1` from the Function's
runtime dependency list to the root development tools. This keeps the Shopify
compiler unchanged while applying the root security override to its pinned
code-generation dependencies. Fresh-install regression tests verify every
physical utility version and the Function compiler's resolution path, and
exercise prototype-pollution protection in the actual patched merger.
Artifact scanning now explicitly rejects `braces`, `micromatch`, `fast-glob`
and `@graphql-tools/utils` in application imports and deployable artifacts,
with regression tests for accidental runtime inclusion.

The audit now applies an archived exception only if its exact package and
advisory are requested. A different or unresolved High/Critical remains
blocked, including when the historical record has expired. This removes
irrelevant expiry/version errors; it does not accept new vulnerabilities.

The remaining High leaf is `braces@3.0.3`
([GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)).
The published advisory lists no patched version, and the upstream
[issue #70](https://github.com/micromatch/braces/issues/70) remains open.
Do not relabel, rename or silently accept this dependency to pass CI.
`sprintf-js@1.1.3` remains a reported Moderate build-tool advisory, not a
claim of zero vulnerabilities. No new exception or production switch is
approved by these dependency changes.

## Previous clean audit

As of 2026-09-29, the production dependency audit passes without an active
runtime or Shopify build-tool exception:

- the application framework has been migrated from Remix 2 and React Router 6
  to React Router 7;
- the former React Router moderate-advisory exception has been removed from
  the audit policy;
- the Shopify extension build graph resolves `brace-expansion` to `2.1.4`;
- `npm audit` reports no known vulnerabilities;
- production server, client, Checkout Function, and Customer Account extension
  artifacts are scanned for unexpected dependency reachability.

Runtime vulnerabilities fail CI. There is no severity-based runtime exception.

## Historical Shopify build-tool acceptance

The repository retains the accepted
`security/risk-decisions/GHSA-mh99-v99m-4gvg.json` record and its approved-path
snapshot as audit provenance. They document the temporary review of
`brace-expansion@2.1.2` in Shopify-owned build dependencies and must not be
treated as an active exception now that the lockfile is patched.

The original upstream reports remain available at:

- <https://github.com/Shopify/shopify-function-javascript/issues/129>
- <https://community.shopify.dev/t/ui-extensions-toolchain-installs-brace-expansion-2-1-2-affected-by-ghsa-mh99-v99m-4gvg/36425>

The dated investigation and artifact evidence remain in
`docs/security-toolchain-evidence-2026-07-28.md`.

## Update procedure

1. Regenerate `package-lock.json` with the repository's pinned Node and npm
   versions.
2. Run `npm ci`, the root build, and the production Shopify app build.
3. Run `npm run audit:production`.
4. Reject the change if an affected package is production-runtime reachable,
   unresolved, extraneous, or present in a deployable artifact.
5. Do not add or extend a dependency exception merely to make CI pass. A new
   exception requires a separate, time-bounded review with upstream tracking,
   complete path evidence, and explicit approval provenance.

`postcss` remains pinned to `8.5.24` through both `overrides` and `resolutions`.

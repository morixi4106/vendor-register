# Production dependency advisories

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

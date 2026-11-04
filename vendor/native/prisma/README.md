# Prisma Source Candidate

This is an explicit patch of the engine source used by Prisma 6.19.3, not an
upstream Prisma release or an installed replacement.

The CLI follow-up replaces structopt/clap2 at the actual query-engine,
schema-engine and prisma-fmt consumers with pinned clap4.6.7/derive/env.
The policy binds their manifests, parser modules and actual Cargo resolutions.
Database commands are only parsed in the new CLI contract namespace, never
executed. Flags, environment precedence, JSON/base64/file inputs and legacy
argument-error exit1/help-version exit0 are checked separately from full engine
or database approval. Help/error formatting is not byte-identical to clap2.
The complete graph still retains benchmark/HTTP/crypto notices and unreviewed
Git sources. Native, migration and production approval remain false.

The CUID follow-up uses Prisma's exact cuid-rust revision, with all four
packages archive/patch/hash-bound and versioned +oja.1. Only manifests change:
remove cuid1's unused base36 dependency (which pulled in failure), and pin the
existing WASM getrandom 0.2.17/js resolution instead of the broad version "0".
Every ID-generation source module remains unchanged. No ID algorithm, format,
randomness source, existing row, client, schema or database is migrated.
The contract fixture adds 14 tests of the actual CUID libraries: base36
boundaries/full-width round trips, v1/v2 formats, small batches/threads, slugs,
custom lengths/callbacks and invalid lengths. Finite noncollision samples are
compatibility evidence, not proof of global uniqueness or cryptographic safety.
The four Git-derived package identities remain UNREVIEWED in assessments and
receipts, alongside mysql_async and the eight remaining Cargo Git entries.
Moving those packages to paths does not reduce the total unreviewed count13.
Registry graph623/matches11 and contract registry351/matches0 do not establish
full-source review, NAPI, database, WASM or production compatibility.

The MySQL follow-up retains Prisma's exact mysql_async Git revision as an
archive/patch-bound 0.31.3+oja.1 source, plus mysql_common 0.29.2+oja.1. Both use
lexical 7.0.5; the driver uses LRU 0.18.2 and common uses sha1 0.11.0 / sha2
0.11.1. Bindgen's build dependency is updated to 0.72.1 without removing TLS,
vendored-OpenSSL support, numeric features, algorithms or optional connectors.
Cache and conversion implementations remain unchanged; diagnostic code invokes
the real statement packet parser and cache without constructing a connection.

The fixture adds cache eviction/zero-capacity/index cleanup, numeric boundary,
server-version and known authentication-vector tests, and directly includes the
unchanged DER/RSA/OAEP source tests. The diagnostic driver feature is rejected
in complete-engine metadata. The upstream `test`/`nightly` feature, which would
download/build an old unpinned MySQL distribution, is rejected in both graphs;
its existing code is hash-bound but neither executed nor certified here.

Moving a Git dependency to a local path does not review it: receipts retain the
original repository/revision as UNREVIEWED, count it alongside remaining Cargo
Git sources, set contractSourceReviewed=false and retain production denial.
A zero registry-advisory scan is not a zero-unreviewed-source claim. Contract
assessments retain the unresolved Git-derived identity and sourceAuditOk=false,
separately from registryAuditOk=true. Rust 2021 is used for the fixture to include
the unchanged legacy RSA tests; original engine/driver editions are unchanged.
The original
registry identities of MongoDB and mysql_common are also separately scanned.

- Query-core uses patched LRU 0.18.2. Zero cache capacity falls back to Prisma's
  existing default of 100; positive capacities and eviction behavior are tested.
- Migration checksums use sha2 0.11.1, preserving existing SHA-256, line-ending
  and historical unpadded-checksum behavior.
- The small Rust contract crate includes the actual patched engine modules.
  Node tests bind source, patch, compiler policy and both frozen lockfiles.
- Query-core explicitly declares its existing IndexMap serialization requirement
  so library tests do not depend on feature unification from an unrelated binary.
- Complete-engine findings and non-registry sources remain in a separate fresh
  assessment. A clean contract scan never approves or filters the engine graph.
- MongoDB 3.9.1 is an archive/patch-bound source override, versioned 3.9.1+oja.1,
  with zstd 0.14.3 / zstd-safe 8.2.0. All three existing compression algorithms
  stay enabled. Metadata rejects an unused override, an old transitive zstd or
  a diagnostic test hook enabled in the complete-engine graph.
- The contract fixture builds the actual MongoDB library and calls its existing
  compressor/decompressor methods through a separate, non-default diagnostic
  feature. Tests cover flags, payloads, levels, multi-buffer and empty messages,
  corrupt/truncated input, compressor IDs, zlib and snappy. No server or database
  is contacted. These are compatibility/error-path checks, not proof of every
  advisory's exploitability or memory safety.
- The original MongoDB registry identity is separately scanned on each run, so
  a path override does not hide later advisories against its upstream version.
  MongoDB remains an external dependency, as in the original registry graph;
  it is not added as a Prisma workspace member with unrelated upstream dev tests.

`npm run native:prisma-contracts` compiles only the source contracts.
`--upstream-units` additionally tests the query-core and schema-connector
libraries with all logical SQL dialects and metrics enabled. This is a unit-test
feature selection, not removal of native connectors from the complete engine
graph. `--assess-only` resolves and scans without compiling tests.
All outputs remain under ignored `.audit/native-prisma/`; no application
dependencies, schema, generated client, engine binaries or databases are changed.

Receipts always retain `NOT_VERIFIED`, `wholeEngineVerified=false` and
`productionApproved=false`. These tests do not establish NAPI compatibility,
SQL/database behavior, migration safety or production release approval. The
existing incident/build/migration gates and native-approval table are unchanged.

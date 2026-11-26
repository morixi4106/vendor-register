# Prisma Source Candidate

This is an explicit patch of the engine source used by Prisma 6.19.3, not an
upstream Prisma release or an installed replacement.

The PostgreSQL follow-up retains Prisma's pgbouncer-mode fork at
`d18e6fc2e549887161161025494f1db3b1b26cac`. An explicit patch backports the
official RUSTSEC-2026-0178/0179/0180 fixes: reject mismatched DataRow counts,
cap SCRAM iterations at 100,000 before hashing, and validate hstore lengths.
It also rejects impossible hstore pair counts before a consumer can reserve
from their size hint. A database configured above that SCRAM limit will now
return an authentication error; deployed settings have not been inspected.

Four fork packages are versioned +oja.1 and wired to the real engine consumers.
PgBouncer, TLS, crypto and statement source remains unchanged. The archive's
14 known relative license links are materialized as byte-identical regular
license files on both OSes; no symlink is followed or accepted in the build tree.
The recipe binds 21 fork files and 43 engine files plus both frozen locks.
Diagnostic hooks are opt-in, disabled by default and rejected in engine metadata.

Twenty-four actual-library regressions cover normal SCRAM proofs/channel
binding, the iteration boundary/errors/state, hstore round trips/counts/lengths/
truncation and a bounded mutation corpus, Row/SimpleQueryRow counts/accessors,
and retained PgBouncer config/TLS types. They use fake credentials and bytes,
not a server or TLS handshake. Finite debug tests do not certify general DoS,
all PostgreSQL parsing, native/NAPI, migrations or deployed behavior.
Original Git declared versions are independently queried against OSV as registry
identities, without fabricated registry checksums or claims of equivalence.
Those matches and all four Git-derived identities remain visible and UNREVIEWED.
Current engine603/contract368 registry scans are separate from four remaining
Cargo Git entries plus nine path-converted identities: total13 is unchanged.
No receipt approves the whole engine or production.

The CLI follow-up replaces structopt/clap2 at the actual query-engine,
schema-engine and prisma-fmt consumers with pinned clap4.6.7/derive/env.
The policy binds their manifests, parser modules and actual Cargo resolutions.
Database commands are only parsed in the new CLI contract namespace, never
executed. Flags, environment precedence, JSON/base64/file inputs and legacy
argument-error exit1/help-version exit0 are checked separately from full engine
or database approval. Help/error formatting is not byte-identical to clap2.
The complete graph still retains unreviewed Git sources. A registry scan without
matches does not establish native, migration or production approval.

The maintenance follow-up retains the `paste` import alias but resolves it to
the official pastey 0.2.3 registry package. All three original macro consumers
and their test sources remain present. Eight additional contracts cover the
existing item/expr aliases, generated names, nested repetitions, case modifiers,
lifetimes, documentation and literal segments. The actual quaint, query-engine
and migration test consumers are also compiled with all native SQL dialects;
their database-dependent tests are not executed by this source-only workflow.

Both original benchmarks use official codspeed-criterion-compat 6.0.0 with its
matching CodSpeed and walltime packages, keeping default plotting, parallelism
and cargo-bench features. All original benchmark bodies and names are unchanged.
They run in correctness-only test mode: six schema cases and five query-planning
cases must each succeed. This is not a timing, instrumentation-service or live
database benchmark approval. Fixed locks and actual metadata reject legacy
atty/paste/criterion0.4, detached aliases/consumers and disabled benchmark features.
The original upstream source scan remains separate and is not suppressed.

Full CLI compilation also checks the existing MSSQL numeric boundary. Tiberius
uses BigDecimal0.4 while the engine retains0.3. Convert exact integer mantissa
and exponent pairs only at that boundary, preserving engine representation and
all connector/TLS features. Five real TDS conversion contracts run without a
server; unsupported numeric ranges retain the driver's documented failure.

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

The initial Windows-authentication follow-up retains winauth 0.0.5 as an explicit,
archive/hash-bound 0.0.5+oja.1 override and pins rand 0.8.8, already used by the
other engine consumers. The NTLM/crypto/Windows SSPI implementation is unchanged;
only the manifest and additive, disabled-by-default diagnostic entry point change.
The original declared MIT/Apache-2.0 license and source metadata are preserved.
The original registry identity is separately scanned, not hidden by a path name.
Windows metadata must bind the actual fixed-Git Tiberius consumer to this source,
rand's standard entropy backend and winapi SSPI features. All existing MSSQL/TLS
features remain enabled, and diagnostic hooks are rejected in the engine graph.

Eight offline contracts check the actual password/crypto vectors, channel-binding
layouts, real random nonce/session-key generation, response/key consistency,
negotiate/error states and a synthetic NTLMv2 exchange with SPN/CBT/MIC verification.
Windows builds also compile and exercise builder-only SSPI configuration, never
calling build() or acquiring an OS account. No real credentials, SQL server or
network authentication are used. These tests are not a live SSPI/domain-login,
entropy-quality, complete NTLM parser or end-to-end SQL compatibility approval.
Existing upstream credential-dependent unit tests and old HTTP example/dev
dependencies remain intact but are not selected or certified by these graphs.
Existing parser TODO/panic branches are not fixed by a rand dependency update.

The parser follow-up versions that explicit source as 0.0.5+oja.2. Decode only
checked slices of the supplied challenge: ignore unused/empty fields and MaxLen
as specified by MS-NLMP, support either payload order/padding, reject overlapping
or header/out-of-buffer ranges, and never allocate a skip buffer from an offset.
TargetInfo is bounded by its declared length; every AV value is bounded by AvLen,
fixed-width values require exact lengths, and EOL must end the declared sequence.
Unsupported SingleHost AV data now returns an error instead of panicking. Unknown
flags/AV IDs remain rejected; no new SingleHost or OEM authentication is added.

Serialize Unicode lengths as actual UTF-16 bytes and reject 16-bit wire-length
overflow instead of truncating. Keep a failed challenge out of the authentication
transcript; only successful encoding commits it. Preserve the original SSPI,
MD4/MD5/HMAC/RC4 implementations, randomness, SPN/CBT/MIC and required flags.
Add 24 actual-library regressions, including the original empty-target exchange,
offset/length/truncation/scalar/UTF-16 errors, either field order, Unicode output,
oversized response rejection, failure/retry MIC consistency and a deterministic
4096-input mutation corpus. Require all 24 named tests in addition to the full
contract suite. Finite corpus/debug tests are not exhaustive fuzzing, optimized-
binary, live SSPI/domain/SQL, complete protocol, password-zeroization or general
DoS approval. Parsing allocations are bounded by supplied data, not proof that
all callers impose an overall incoming-token limit.

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

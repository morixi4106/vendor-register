# Prisma Source Candidate

This is an explicit patch of the engine source used by Prisma 6.19.3, not an
upstream Prisma release or an installed replacement.

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

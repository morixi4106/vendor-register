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

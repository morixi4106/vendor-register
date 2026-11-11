# SQLite WAL Advisory And Native Adoption Blocker

Date: 2026-11-11. Status: BLOCKING_UNFIXED. This is not a waiver or a patch.

## Evidence

Both actual native jobs43016958931 stopped before compiling the new release
artifacts with prisma_native_registry_advisories_unresolved. Their independently
digest-checked artifacts contain the same libsqlite3-sys0.30.1 finding,
RUSTSEC-2026-0459, modified November9. The engine graph has603 registry entries
and one match; the smaller contract graph has368 and zero matches. No new native
receipt/binary exists in these failed artifacts. Do not promote old42300766846
native bytes or update their source-policy label to claim the SCRAM repair.

The original crate archive matches the exact engine lock checksum. Its27 archive
entries were checked before extraction; bundled SQLite is3.46.0 and the actual
sqlite3WalReadFrame function still has the affected partial-read behavior. The
adjacent JSON binds archive/amalgamation/function, original advisory payload,
official repair commit and both failed artifacts. Old verified Windows/Linux
metadata includes bundled SQLite along normal/build paths to N-API, schema CLI
and query engine, not prisma-fmt. That metadata is historical, not a new build.

[RustSec's advisory](https://rustsec.org/advisories/RUSTSEC-2026-0459.html) describes
a memory-disclosure issue when a process opens an untrusted SQLite database and
sibling WAL whose page sizes differ. This is not proof of a remote attack,
production exposure, compromise or data loss in this application. The application
schema selects PostgreSQL; that does not remove the compiled SQLite dependency
or establish every runtime/input path as safe.

## Repair Decision

[SQLite's official change](https://github.com/sqlite/sqlite/commit/e5bf119821f25be1d7f10ef0a2edbe175289166e)
initializes the output-buffer tail when its size exceeds a WAL frame, and then
reads only the frame size. A check-only application of those exact C changes to
the pinned original amalgamation succeeds. The source remains unchanged and
no fixed C/native code has been compiled. Applicability is not completion.
The exact proposed C delta is saved as sqlite-wal.candidate.patch under the
existing vendor/native/prisma directory and hash-bound in the adjacent JSON.
It is intentionally not referenced by the active source build policy yet.

The advisory identifies fixed libsqlite3-sys0.39 or newer. At this observation,
rusqlite0.41.1 uses0.39, while released SQLx0.9.0 requires less than0.38 and the
current0.8.6 uses0.30.1. Therefore a direct replacement is not a compatible
lock-only update. Do not silently change SQLx's allowed range, disable WAL,
switch to an unverified system SQLite, change release features or suppress the
finding to unblock compilation.

The preferred bounded next implementation is a reviewed path override for the
current crate with the exact upstream C repair. Keep its original registry
identity, checksum and full advisory record visible; a path conversion or
renamed version is not evidence of a fix. The build must verify exact original
archive and all adopted source hashes and reject any unrelated/new advisory.
This is a proposed implementation, not an existing exception/admission rule.

## Required Verification

1. Compile the actual bound C function with deterministic prefilled output:
   demonstrate the old mismatch leaving the tail unchanged and the fixed code
   zeroing it. Cover equal/smaller buffers, supported page sizes and underlying
   IO errors. This must test the real function/source, not a JS reimplementation.
2. Rebuild actual N-API/schema artifacts on both OSes using the unchanged original
   release profile/compiler/default features. Preserve SCRAM32 named regressions,
   existing JSON/GraphQL/client/SQLite/migrations/transactions, Linux strict TLS
   and certificate/hostname/plaintext rejection. Independently check bytes,
   metadata/source identity, raw logs and receipts before native pin adoption.
3. With those verified bytes, rerun both PG majors/both poolers/55 app migrations/
   92 models/populated upgrade/actual app suites and isolated Debian runtime.
   Only then update the immutable input binding and resolve its intentional
   source mismatch. Keep all original13 Git identities/whole-engine/production
   approvals false until separately reviewed.

Live TLS/configuration, actual process/Node/DB/backup/restore/rollback, provider,
checkout/financial/SALE/legal evidence remain separate. No deployment, access,
environment, financial transaction or prelaunch mail resumption is authorized.

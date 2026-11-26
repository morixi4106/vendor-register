# CUID Selected-Use Source Review

Source: `prisma/cuid-rust@dc68c4f47a3dbcd511f605135ac7c948775a3ab9`.
Packages: cuid, cuid-util, cuid1, cuid2. Review date: 2026-11-07 JST.
Binding: `security/prisma-source-contracts.json`, unchanged policy2da8f59f,
source archiveee0c0f0a and patch68449e2b.

## Scope Read

All12 owned Rust files under the four `src` trees, all five workspace/package
manifests, and the pinned engine's generation/interactive-transaction consumers
were read. The12 Rust files are unchanged from the original complete Git tree;
the five manifest changes are the existing version/dependency patch. No owned
build.rs or proc-macro target is present. Binaries, benches, tests and WASM-only
dependencies are not the production library call surface reviewed here.

The original Git tree has40 files and is not truncated. Hash correspondence is
checked independently against the existing patched source policy. This review
does not claim that all40 documentation/test/benchmark files were reviewed or
that dependency behavior is proved safe by reading owned code.

## Selected Call Surface

- Schema defaults call only `cuid::cuid1()` or `cuid::cuid2()` with a schema-owned
  version. The application schema uses ordinary `cuid()` defaults, not a public
  configurable CUID constructor. Schema validity remains an engine prerequisite.
- The engine's interactive-transaction identifier calls fixed-default CUID2.
  Its use is separate from application authentication and single-use nonces.
- CUID1 uses a fixed-size counter, timestamp, truncated host/PID fingerprint and
  two RNG blocks. It exposes timing/host-derived metadata and is not a secret
  token design. CUID2 uses fixed24-character output, per-thread counter and
  SHA3-512 over timestamp/randomness/fingerprint. No cryptographic guarantee is
  inferred here from bounded collision tests.
- The sole owned unsafe block reverses a string created only from base36 ASCII
  digits. The preceding digit/radix operations preserve that UTF-8 invariant.
- Owned library code contains no network transport, command execution or file
  reads/writes. Hostname/PID/time/entropy are explicit environment inputs. Clock
  before the Unix epoch or an entropy failure remains an operational failure.

## Findings And Limits

1. CUID1 `is_cuid` slices at byte1 after checking byte length25/26. A multi-byte
   leading character with such a total byte length can panic at the UTF-8
   boundary. This is a source-derived finding, not a newly executed panic test.
   Bound selected production consumers do not directly call this validator;
   observed calls are in test code. Do not expose it to customer input. Fix and
   rebuild before a future use of this validator; no blanket library approval.
2. Slug APIs and CLI one-off counter/length customization are not the selected
   generation calls. Slugs provide weaker uniqueness, and arbitrary CUID2 lengths
   do not imply arbitrary digest length. Keep these out of authentication and
   public options without separate review.
3. This is a completed owned-source/selected-use review with recorded limits,
   not whole-library, transitive-dependency, artifact or production approval.
   Existing source/native contracts and actual default-generation probes remain
   evidence, not a substitute for this review or for remaining engine reviews.

The engine patch, Cargo locks, source bytes and native binary identities are
unchanged by this record. All original identity/admission approval flags remain
unchanged; the scope ledger distinguishes this read-through from still-open
artifact adoption and the other source groups.

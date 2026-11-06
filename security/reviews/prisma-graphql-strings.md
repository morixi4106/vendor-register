# GraphQL String Decoder Review

Source: `prisma/graphql-parser@6a3f58bd879065588e710cb02b5bd30c1ce182c3`.
Review date: 2026-11-07 JST. This is a selected decoder review, not full
parser, transitive dependency, native artifact or production approval.

## Source And Consumer

The existing depth patch does not change `src/common.rs`. Its original
SHA-256 is `e17bfd404e1746db94962fa77002168c9e32731f4bb00edfeae0a0810d96c8c9`.
Read-through covered common value/type/string parsing, tokenizer operations,
query/schema grammar entry points and the engine's GraphQL protocol adapter.
The adapter passes query text through `parse_query` before converting values.
This establishes a source call path, not public network reachability in the
deployed application. Prisma's ordinary JSON protocol is a separate path.

## Finding

`unquote_block_string` uses Unicode-aware `trim_start` to compute a byte
indentation length, then slices other lines at that byte offset. Mixed ASCII
and multi-byte whitespace can place that offset inside a UTF-8 character,
causing a panic. This is an availability finding; this review does not show
information disclosure, exploitation, or a live production incident.

The same implementation trims significant first-line spaces, keeps an extra
last newline, and does not normalize bare carriage returns as line breaks.
Those are data-correctness issues in the same decoder, not separate proven
security incidents. Ordinary escape and formatter semantics remain outside
this fix; this record must not be promoted to whole-parser approval.

## Candidate Fix And Tests

[GraphQL's BlockStringValue algorithm](https://spec.graphql.org/September2025/#BlockStringValue())
uses ASCII space/tab for indentation, preserves first-line content, normalizes
line terminators and removes blank boundary lines. The candidate patch follows
that algorithm without slicing through a Unicode character. Escaped triple
quotes are unescaped before line processing.

`vendor/native/prisma/graphql-strings.patch` changes only `src/common.rs`.
`security/prisma-graphql-strings.json` binds the base engine policy, original
and candidate bytes, patch, and both test fixtures. The existing GraphQL-only
isolated runner now first runs three diagnostic baseline tests against the
unchanged parser, including two caught panics, then nine fixed-decoder tests
and all library units with the candidate patch. The bounded corpus includes
96 indentation/Unicode combinations through both query and schema entries.
Counts for this corpus are not additional Rust test functions.

The runner checks every owned `src` file before/after patching, requires that
only common.rs changed, and restores the base source and fixture registration
even after an error. Its receipt distinguishes baseline, candidate and full
library results. Both OS jobs must pass; Node-only source/receipt tests are
not execution of Rust code.

## Adoption Is Still Required

The candidate patch is **not** part of `graphql.patch` or the native engine
policy. No release build automatically applies it. Existing engine/native/DB
pins still represent the old decoder; prior depth/DB success is not evidence
that this new bug is fixed in those binaries. Production/native approvals
remain false and must not be granted against that old input.

After the isolated replay succeeds, fold the reviewed fix into the actual
engine source policy, rebuild both release-native artifacts, independently
verify their new bytes, and refresh the DB/runtime evidence and fixed pins.
Do not weaken a binding to reuse an older binary. Remaining parser/driver
source reviews and provider provenance remain independent requirements.

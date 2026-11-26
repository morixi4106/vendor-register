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
and candidate bytes, patch, and both test fixtures. The historical GraphQL-only
isolated runner first ran three diagnostic baseline tests against the
unchanged parser, including two caught panics, then nine fixed-decoder tests
and all library units with the candidate patch. The bounded corpus includes
96 indentation/Unicode combinations through both query and schema entries.
Counts for this corpus are not additional Rust test functions.

That runner checked every owned `src` file before/after patching, required that
only common.rs changed, and restored the base source and fixture registration
even after an error. Its receipt distinguishes baseline, candidate and full
library results. Both OS jobs must pass; Node-only source/receipt tests are
not execution of Rust code.

## Actual Source Adoption

The reviewed decoder fix and its nine tests are now part of `graphql.patch`
and the main engine source policy. Ten byte-bound inputs include common.rs,
the test registration and the regression module. Existing dependency versions,
locks and depth50 behavior are unchanged. The old candidate policy/patch and
baseline fixture remain historical attribution, not the release recipe.

The actual source recipe runs the nine adopted string tests and all61 library
units without temporarily applying or restoring a candidate. The release
N-API probe also requires four actual GraphQL/SQL string results, including the
original failing Unicode patterns and bare-CR normalization, each bracketed by
healthy SELECT1 controls. Older depth-only reports are rejected.

[Release-native CI42300766846](https://github.com/morixi4106/vendor-register/actions/runs/42300766846)
rebuilt both platforms at373617a with the original fat-LTO release profiles.
Both actual binaries, source policy, compiler outputs, receipts and probe logs
were independently verified. Linux SQLite/strict-TLS PostgreSQL and Windows
SQLite passed Unicode4/control26; a fresh local Windows SQLite run also passed.
DB/runtime pins now select the new Linux artifact13544862506, N-APIee2bbaab and
schema c3ce1838, not the older depth-only artifact. Their separate final-head
database/container workflows must still succeed; this source record does not
substitute for those reports or imply production installation.

Production/native approvals remain false. Do not weaken a binding to reuse an
older binary or promote a selected regression test to whole-source approval.
Remaining parser/driver source reviews and provider provenance remain separate.

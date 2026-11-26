# GraphQL Owned Runtime And Selected-Use Review

Review date: 2026-11-11 JST. Origin and adopted byte inventories are in
`prisma-graphql-owned-source.json`. This record does not grant source, native,
transitive dependency or production approval.

## Completed Read-Through

Runtime portions of all16 original owned Rust files and the package manifest
were read: tokenizer, shared parsers, query/schema grammars and ASTs, helpers,
position/error/module glue, shared formatter and both document formatters.
Original files independently match the complete82-file Git/archive inventory;
adopted files match the current source policy or unchanged original bytes.
This is not a claim to have reviewed every test, benchmark or dependency.

The only owned unsafe operations transmute owned `Document<String>` lifetimes
to static. Their fields use owned String, numeric/bool, Pos, and recursively
owned Vec/IndexMap/Box values; no borrowed string survives this specialization.
This selected invariant is not a compiler or transitive-library safety proof.
Owned runtime code has no network, file IO, process creation or credentials.
The parser's depth50 lexical preflight bounds recursive grammar/parsed ASTs;
caller-manufactured ASTs and extreme local Style settings are separate APIs.

Four real engine consumers were read and matched to original Git blobs. The
N-API constructor fixes a protocol for the engine instance, defaulting to Json.
Request deserialization uses that saved protocol, not a body-supplied selector.
The GraphQL adapter parses queries and maps values directly; no formatter or
schema parser is called in this bound request path. This is source-path scope,
not a linker reachability or public-endpoint proof.

## Findings And Disposition

1. Ordinary GraphQL `\b` decodes to U+0010 instead of U+0008. The actual fixed
   Windows release artifact reproduces the wrong SQL string result in synthetic
   SQLite, with healthy controls before/after. It is not the earlier repaired
   block-string UTF-8 panic and is not shown to disclose information.
2. An explicitly escaped UTF-16 surrogate pair is rejected as an invalid code
   point in GraphQL. Raw UTF-8 and JSON strings are different cases. The actual
   artifact demonstrates a non-panic parse error and subsequent healthy query.
3. Formatter code uses decimal digits for unicode escapes, mishandles non-BMP
   escaping and may normalize significant multiline whitespace. Unnamed
   operation variable definitions are also not faithfully printed. These are
   source-derived correctness findings, not executed formatter regressions.
4. Legacy numeric exponent and string-control-character grammar is not full
   modern GraphQL conformance. Integer bounds return parse errors and non-finite
   floats are rejected by the selected engine adapter's BigDecimal conversion.
   This does not establish a production exploit or complete numeric testing.

The normative comparison is the
[GraphQL string-value specification](https://spec.graphql.org/September2025/#sec-String-Value).
No attempt is made to turn an older fork into a complete modern GraphQL server.
Correct the relevant issues and rebuild before enabling direct GraphQL clients
or exposing formatter APIs; this review is not blanket approval of those APIs.

## Actual Application Protocol And Regression

The bound application `app/db.server.js` creates the standard Prisma Client.
Installed/generated6.19.3 client code and the actual constructor were checked:
the instance uses JSON. A fresh, credential-free Windows SQLite diagnostic
preserves seven control/non-BMP values exactly, rejects a GraphQL-shaped envelope
even when it contains engineProtocol=graphql, and remains usable afterwards.
This is isolated execution, not observation of the deployed Render process.

The persistent native fixture now observes the actual client constructor without
changing its options or substituting its native engine. Nine parameterized
control/Unicode/mixed-string round-trips and two healthy controls must pass.
A GraphQL-shaped envelope must fail with the exact non-panic JsonBody InvalidArg
error. Receipts missing this JSON evidence, using GraphQL, shortening the corpus,
omitting rejection or losing controls are rejected. Existing depth/Unicode/TLS/
client/migration/transaction probes remain required.

These regression changes do not change engine source, features, locks, binary
pins, application behavior, access or deployment. Old receipts prove their old
tests only; fresh fixture/container reports establish the new protocol checks.
All original identity/admission flags remain unchanged. Remaining driver,
transitive/compiler/provider and live operational evidence is independent.

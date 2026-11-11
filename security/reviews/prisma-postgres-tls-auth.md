# Selected PostgreSQL TLS And Authentication Review

Date: 2026-11-11. Status: READ_WITH_FINDINGS, not driver/source approval.

## Bound Scope

The adjacent JSON fixes original Git blobs, original SHA-256, adopted SHA-256
and explicit read scope. The original PostgreSQL archive digest was checked;
each reviewed original file matches its original recursive Git tree blob.
Adopted files match the source policy hash in the adjacent JSON. The two original engine
consumer files match engine commit c2990dca; only the named methods/sections
were reviewed, not every query/cache/error path in those files.

Read: postgres-native-tls manifest and full owned runtime bridge,
tokio-postgres connect_tls/connect_raw, and postgres-protocol SCRAM runtime
before its test module. This is not a complete read of postgres-protocol,
postgres-types or tokio-postgres, nor their transitive crypto/OS/compiler code.

## Selected Path

- Quaint URL parsing defaults to TLS `prefer` and `accept_invalid_certs`.
  Native `sslmode` recognizes disable/prefer/require, not libpq's verify-ca/full.
  Unknown modes retain the current value; duplicate keys are processed in order.
  `host` query overrides the URL authority. Do not equate a provider URL with a
  proof of required TLS and certificate validation.
- `to_config` forwards TLS mode and channel-binding mode. The connector manager
  reads configured CA/identity files, adds the CA, and sets native-tls invalid
  certificate acceptance from sslaccept. The bridge forwards the domain to
  native-tls, wraps the stream in an8192-byte reader and delegates asynchronous
  IO. Channel binding uses the TLS server-end-point when available. OS trust,
  native-tls and crypto dependencies are separate review boundaries.
- connect_tls's Prefer path can return a plaintext stream when TLS is unavailable
  or the server declines. Require errors instead. A failed TLS handshake returns
  an error, not a plaintext retry. Startup/authentication follow TLS negotiation.
- connect_raw supports server-selected password, MD5 and SCRAM methods, rejects
  unsupported methods and requires the expected completion messages. It enforces
  required channel binding before weaker mechanisms. SCRAM chooses PLUS when
  available with binding and verifies the final server HMAC. This is not a claim
  that the deployment uses SCRAM/PLUS or has correct TLS settings.
- The previous SCRAM iteration ceiling and TLS-buffer fix remain unchanged.
  The initial TLS review made no source changes. The subsequent grammar repair
  below changes only the two parser functions and adds test-only contracts.

## Findings And Candidate Guard

The application uses its ordinary PrismaClient and schema DATABASE_URL, without
enforcing URL TLS parameters itself. The candidate's existing environment
readiness checks now include `database_tls_configuration`: unsafe/missing
settings fail in production and warn in other runtimes. Only explicit
sslmode=require/sslaccept=strict can pass this configuration check. Duplicate
security parameters, ignored case variants, host overrides, fragments, malformed
or oversized URLs and empty explicit CA paths cannot pass. Credentials,
hostnames, database names and certificate paths are never returned or logged.

This is a static prelaunch blocker, not interception of Prisma connections, a
runtime connection change, a CA installation, a network probe or automatic
sales authorization. A passing row explicitly says the actual endpoint,
certificate, hostname/trust and connection are still unverified. Existing
Prisma runtime queries continue unchanged. Check provider/internal-endpoint
support and conduct an authorized strict handshake before changing any live URL;
do not disable verification to recover a failed connection.

## Subsequent Grammar Correction

Candidate source policy e6510147 rejects zero/leading-zero iteration syntax
before salt decoding or password hashing, and corrects nonempty server-error
values while rejecting NUL/comma/empty/malformed UTF-8 input. The unchanged
cryptography, HMAC verification, state machine and iteration ceiling remain
bound. Nonce prefix checking is retained: [RFC5802](https://www.rfc-editor.org/rfc/rfc5802.html)
requires the client to check its original prefix, not an added client-side
minimum server-nonce length. The earlier source observation was not proof
of a nonce vulnerability.

Eight new Rust regressions plus the existing24 now require all32 exact test
names/successes, not just an arbitrary passing count. Actual source CI43016958532
passes both OSes, including128 library contracts, prior GraphQL/CLI/HTTP/NTLM/
benchmark correctness/consumer compilation. Both source artifacts/raw test names/
compiler/locks/metadata/source inputs were independently checked. This is not
a reproduced native authentication bypass or full SCRAM conformance claim.

Actual release-native adoption is not complete. Both native jobs43016958931
stop before compilation on the new libsqlite3-sys advisoryRUSTSEC-2026-0459;
see prisma-sqlite-wal.md. No replacement native binary was produced or adopted.
The old immutable input is retained, and its mismatch with the new candidate
source is intentionally still rejected. Do not suppress that check or relabel
historical native/DB/runtime evidence as proof of this grammar repair.

## Remaining Boundaries

The existing actual strict-TLS/native/PG17.11/18.6/pooler evidence applies only
to its explicit synthetic settings, not the unobserved production DATABASE_URL.
All13 original identities remain UNREVIEWED. Complete driver/parser/type review,
transitive/OS/compiler assurance, current live configuration/handshake, production
minor/schema history, backup and restore/rollback remain open. All source,
whole-engine and production approvals stay false. Keep prelaunch emails quiet;
no deploy, access/environment change, transaction or gate waiver is authorized.

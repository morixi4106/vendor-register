# International Checkout Result Intake

Implemented scope: 4C-2a, server-side nonfinancial result persistence and
validation. This document is not authorization to run a live checkout, migrate
production, publish, charge, refund, or send monitoring notifications.

## Implemented

- Migration `20261107000000_international_checkout_cases` adds a nullable plan
  summary and child cases. Old runs remain unverified; no passing state is
  backfilled. The previous four international migration bytes are unchanged.
- Each run has at most 2048 cases, enforced by bounded unique ordinals. Each
  expected case is at most 2048 bytes; each signed result is at most 4096 bytes.
  Composite tenant/run foreign keys, key/ordinal uniqueness, challenge timing
  and result-state constraints are enforced in PostgreSQL.
- `createInternationalCheckoutResultCommands` is an internal server API only.
  Initialization requires an already-authorized RUNNING nonfinancial run with
  the exact server-pinned plan hash and a current ACTIVE projection. It never
  starts a run or authorizes a market.
- Plan initialization is idempotent. A different plan, runner digest or
  environment cannot overwrite it. Each challenge is server-generated,
  monotonically sequenced, and valid for no more than 60 seconds, bounded by
  run/lease expiry. Concurrent requests converge through serializable retries.
- Results use the existing separate `checkoutVerifier` signature domain.
  A reviewed key must bind the executor, runner digest and environment. The
  default source-controlled trust registry remains empty. Publisher/observer
  credentials or signatures do not authorize this operation.
- Up to eight results per transaction are accepted atomically within 32 KB.
  Each binds shop, run, case, plan, scope, release, native/source hashes,
  generation, executor, code digest, environment, challenge, sequence and time.
  Key/dependency revocation, delivery changes, lease/generation/source changes,
  tampering and stale observations are rejected.
- Stage/outcome mismatches and `NOT_OBSERVED` are preserved as nonmatching
  results. A checkout-interaction observation is not completion evidence.
  Exact result retries return history only, including after STOP/expiry; they
  do not renew leases, write new times or re-arm a gate.
- Collection revalidates case-set integrity, result hashes, signatures and
  current dependencies. `preCloseComplete` means only that all required OPEN
  observations matched. Artifact, closure, completion and sale flags remain
  false. The service never writes PASSED, an attestation or a sale-ready proof.

## Privacy And Trust

The result schema accepts fixed identifiers, enums, UTC timestamps and digests,
not arbitrary notes, addresses, emails, checkout URLs, tokens, cookies or traces.
The managed runner must create session/evidence digests without retaining raw
checkout credentials. A signature attributes a claim to a reviewed executor;
it does not cryptographically attest to Shopify's screen contents. The future
runner must independently constrain navigation, actions and evidence capture.

ISOLATED_STORE and LIVE_STORE are separate signed environments. Synthetic tests
use ephemeral keys and synthetic records in isolated databases. They are not
evidence of an actual store, payment, refund or international sale.

## Still Closed

The source capability stays false. Authorization currently does not attach a
complete checkout plan, and this intake has no HTTP route, scheduler, browser
runner or installed production trust key. It cannot be enabled by an env flag.

Next integration must attach the server-generated plan to authorization/run
creation, authenticate the dedicated checkout principal and bind its code to
successful CI. Add the dedicated normal-close transition, immutable candidate,
same-release fresh readback, separately fenced old/new checkout challenges and
atomic finalization. CLOSED cases deliberately cannot use an OPEN lease.
General STOP, revocation, expiration and failed closure retain their existing
failure behavior. Do not promote an intake digest into a successful closure.

Artifact/WASM evidence, real browser observations, transaction correspondence,
financial reconciliation/refund coverage and final SALE proof remain separate
requirements. The international financial phase is not implemented here.

## Verification

Pure contract tests cover signed substitutions, privacy fields, stage/outcome
classification, signature-domain isolation, key scoping/revocation and exact
time boundaries. The isolated database workflow also runs
`tests/postgres/internationalCheckoutResults.test.js` on both pinned PostgreSQL
versions, alongside the previous three actual application suites, using the
same immutable patched N-API and private client. It covers concurrent
initialization/challenges/recording, atomic rollback, retries, dependency
revocation, STOP races, SQL constraints and tampering. Consult the current
launch progress memo and portable PR evidence for actual run conclusions;
the presence of these tests alone is not a passing result.

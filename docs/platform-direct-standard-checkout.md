# Platform-direct standard checkout

## Purpose

Domestic products sold directly by the platform use Shopify's standard product,
cart, checkout, order, inventory, and payment surfaces. The application does not
reimplement those commerce primitives.

Set the following production environment value only while every third-party
commerce flag remains disabled:

```text
PLATFORM_DIRECT_CHECKOUT_MODE=SHOPIFY_STANDARD_DIRECT
```

An unknown value, a missing value, or any enabled third-party commerce flag
falls back to `MARKETPLACE_VALIDATED`.

## Ownership boundaries

Shopify is the source of truth for:

- products, variants, inventory, carts, checkout, and orders;
- the selected payment gateway and Shopify order transactions;
- order financial status and the original transaction relationship used by a
  later refund.

KOMOJU is the source of truth when the purchaser selects a KOMOJU method for:

- card authorization and capture;
- provider settlement and refund processing;
- the provider transaction status shown in the KOMOJU merchant console.

This application is responsible for:

- authenticating and processing Shopify webhooks idempotently;
- projecting the paid Shopify order into `MarketplaceOrder`, `SellerOrder`,
  `PaymentAttempt`, SellerOrder Shadow, and the paid ledger;
- detecting projection mismatches without inventing payment truth;
- keeping third-party marketplace and EU commerce disabled until their strict
  workflow is separately approved.

## Domestic launch gate

The domestic platform-direct launch requires one new production payment after
the verification probe starts. The application detects the actual Shopify
Payments or KOMOJU method from the single successful Shopify transaction. The
probe passes only when that provider is explicitly configured and the same
Shopify order and transaction match:

- one production `PaymentAttempt`;
- the expected platform-direct `MarketplaceOrder` and `SellerOrder`;
- the expected product, quantity, currency, and amount;
- one paid ledger credit;
- a matching SellerOrder Shadow projection.

Payout arrival and refund completion are monitored operationally after launch.
They are not prerequisites for opening the domestic platform-direct store.
They remain mandatory before enabling seller settlement or treating a refund
workflow as verified.

The Production integrity monitor remains part of the launch gate. Before the
password is removed, a fresh full run may satisfy this gate only when the
storefront password page is its sole non-healthy result. A normal healthy or
recovered full run is required immediately after opening.

When the owner cannot perform the remaining manual smoke tests, the explicitly
authorized domestic autonomous launch path documented in
`docs/operations/domestic-autonomous-launch-authorization-2026-09-29.md` may
convert only its fixed allowlist of missing attestations to visible,
non-blocking warnings. It never converts a failed attestation to a pass. The
path requires continuous monitoring and automatically verifies the first paid
production order or applies the strong purchase hold.

The independent marketplace sale-eligibility watchdog and the Render/DB-down
publication-removal drill are supplemental in this mode. Standard Shopify
checkout does not depend on the Render application being reachable, and only
platform-direct products may be published. Both controls become mandatory
again before any marketplace checkout, seller settlement, public Draft Order,
or cross-border seller flow is enabled.

## Diagnostic attribution

Use identifiers and statuses, not assumptions, to locate a failure:

1. No Shopify order or successful Shopify transaction: inspect Shopify
   checkout and the selected Shopify Payments or KOMOJU gateway boundary.
2. Shopify reports a successful transaction but no `PaymentAttempt` exists:
   inspect webhook delivery and application projection; the probe retries the
   single-order projection idempotently.
3. `PaymentAttempt` exists but SellerOrder, Shadow, or ledger differs: the
   application projection is at fault and launch remains blocked.
4. Every application projection matches but a later provider refund or payout
   fails: inspect Shopify and the selected payment provider using the recorded
   transaction identifiers, while keeping the application ledger unreconciled
   until provider confirmation arrives.

This separation does not prove that an external provider is faultless. It
provides enough evidence to identify the system boundary where investigation
must continue.

## Re-entering marketplace mode

Before enabling third-party storefront checkout, domestic or cross-border
seller settlement, public Draft Orders, or EU marketplace sales:

1. restore `PLATFORM_DIRECT_CHECKOUT_MODE=MARKETPLACE_VALIDATED`;
2. deploy and confirm the strict checkout validation is active;
3. complete the strict replay, live-probe, refund, payout, and settlement
   evidence required by Production Readiness;
4. enable only the separately approved marketplace flags.

The standard direct mode must never be used to bypass marketplace obligations.

# Domestic autonomous launch authorization

## Decision record

On 2026-09-29, the store owner explicitly authorized Codex to complete the
remaining launch work without relying on later manual smoke tests. This record
does not state that unperformed checks passed. It permits a time-limited launch
decision with those checks still reported as warnings.

The authorization value is:

```text
OWNER_ACCEPTED_DOMESTIC_DIRECT_2026_09_29
```

## Allowed scope

- The production Shopify store identified by `SHOPIFY_PRIMARY_SHOP_DOMAIN`.
- Platform-owned products sold through Shopify standard checkout.
- Domestic delivery only.
- A first production order paid through a configured Shopify Payments or
  KOMOJU method within the configured verification ceiling. The ceiling is
  evidence scope for that first order, not a permanent storefront order
  limit.

The authorization does not include third-party stores, multi-seller checkout,
seller settlement, public Draft Orders, EU sales, international delivery, or
cross-border settlement. Those paths remain subject to their existing strict
evidence gates.

## Accepted unknowns

The following operational attestations may remain visible as unverified
warnings during the authorization window:

- legal disclosure and terms screen review;
- checkout price, shipping, and seller display review;
- unsupported sales surface review;
- emergency stop drill;
- refund liquidity review;
- administrator access and MFA review;
- privacy incident runbook review;
- purchaser and administrator email delivery review;
- the first platform-direct payment-flow verification.

A recorded `FAILED` attestation is never accepted by this authorization. New
or unknown readiness checks are never accepted automatically.

## Mandatory technical controls

The authorization becomes active only when all of these are true:

```text
DOMESTIC_AUTONOMOUS_LAUNCH_ENABLED=true
DOMESTIC_AUTONOMOUS_LAUNCH_AUTHORIZATION=OWNER_ACCEPTED_DOMESTIC_DIRECT_2026_09_29
DOMESTIC_AUTONOMOUS_LAUNCH_SCOPE=DOMESTIC_PLATFORM_DIRECT_ONLY
PLATFORM_DIRECT_CHECKOUT_MODE=SHOPIFY_STANDARD_DIRECT
PRODUCTION_INTEGRITY_MONITOR_ENABLED=true
DOMESTIC_AUTONOMOUS_LAUNCH_MAX_ORDER_AMOUNT=<positive JPY ceiling>
DOMESTIC_AUTONOMOUS_LAUNCH_AUTHORIZED_AT=<ISO-8601 timestamp>
DOMESTIC_AUTONOMOUS_LAUNCH_EXPIRES_AT=<ISO-8601 timestamp within 90 days>
```

Every third-party commerce flag must remain disabled. The authorization is
invalid if the checkout mode, scope, monitoring state, time window, or owner
authorization value changes.

## First-order verification

Before the storefront is opened, a full Production integrity monitor run arms
a release-bound production transaction probe. Arming does not claim that an
external payment method was manually verified. The first non-test paid order
on the production shop is attached to that probe. The application identifies
the provider and method from the single successful Shopify sale or capture,
requires the provider to be explicitly listed in `PAYMENT_PROVIDERS`, and
compares that transaction with the `PaymentAttempt`, `MarketplaceOrder`,
`SellerOrder`, line amounts, paid ledger credit, and SellerOrder Shadow.

Manual payments, test transactions, unknown methods, unconfigured providers,
and orders with more than one successful sale or capture do not satisfy the
probe. Shopify Payments card and wallet transactions require structured card
details. KOMOJU methods must be recognized by the payment projection before
they are accepted.

Temporary webhook projection lag is allowed only for the configured grace
period. A missing pre-armed probe, a second unexpected order, a release
mismatch, an amount above the configured ceiling, a persistent projection
mismatch, or an expired authorization invokes the existing strong emergency
hold. That hold is persisted first and then attempts to block Shopify checkout
and unpublish governed products.

This control cannot prevent an external card decline or a simultaneous outage
of Shopify, KOMOJU, and every monitoring path. It is intended to prevent an
application inconsistency from remaining silently open.

## Operating rules

- Run the Production integrity monitor every five minutes.
- Do not enable the independent marketplace watchdog with shared or overly
  broad credentials.
- Do not change the Render commit, Shopify App version, Function, Validation,
  or database schema while the first-order probe is pending.
- Do not extend the authorization by editing only the expiry timestamp. Create
  a new dated decision record and code review.
- Replace each warning with normal evidence when that evidence becomes
  available.

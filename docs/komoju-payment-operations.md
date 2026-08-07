# KOMOJU payment operations

KOMOJU remains a Shopify Checkout payment provider. The application does not
collect card or convenience-store credentials and does not replace Shopify's
checkout. It records the resulting Shopify order transactions so delayed
payments, refunds, and provider settlements can be reconciled safely.

## Runtime configuration

```text
PAYMENT_PROVIDERS=shopify_payments,komoju
KOMOJU_PAYMENT_OPERATIONS_ENABLED=true
PAYMENT_REFUND_CONFIRMATION_ENFORCED=true
```

`PAYMENT_PROVIDER` remains a legacy single-value fallback. New environments
must use `PAYMENT_PROVIDERS`.

## Order flow

1. `orders/create` records the payment attempt and its Shopify transaction.
2. Asynchronous KOMOJU methods remain pending and receive a 72-hour review
   deadline.
3. `orders/updated` refreshes the canonical Shopify transaction state.
4. `orders/paid` records the captured state and then runs the existing seller
   order and ledger flow.
5. No sale is credited from an order that has not reached Shopify's paid flow.

An unknown gateway or more than one active economic payment attempt opens an
operational review and is shown in `/app/payment-operations`.

## Refund flow

KOMOJU card and wallet methods may provide a Shopify-linked successful refund
transaction. Convenience-store, Pay-easy, and bank-transfer refunds require a
separate provider confirmation.

For those manual methods:

1. `refunds/create` stores a minimal refund snapshot and holds ledger changes.
2. A finance approver confirms the successful KOMOJU refund, provider
   reference, evidence location, and actual refund fee.
3. Only the claimed operation runs the existing idempotent refund settlement.
4. A duplicate webhook or concurrent confirmation cannot apply the ledger a
   second time.

Do not register a confirmation based only on a Shopify refund status. Verify
the refund in KOMOJU first.

## Settlement flow

The finance operator records the KOMOJU payout ID, gross sales, refunds, fees,
net deposit, payout date, bank deposit date, and private evidence reference.
Every payout must also select the captured `MarketplacePaymentAttempt` rows and
any applied refund rows that are included in the provider statement. The batch
is reconciled only when the selected rows prove both equations:

```text
gross - refunds - fees = net deposit
sum(selected captured attempts) = gross
sum(selected applied refunds) = refunds
```

The resulting `PaymentSettlementLine` rows retain the direct links to the
payment attempts and refund operations. A provider-level total without these
links is not accepted as payout evidence for the release probe.

Every new payout record requires the evidence file's 64-character SHA-256.
Once a batch is `RECONCILED`, it is append-only: an exact retry is idempotent,
but changing its payment, refund, amount, currency, date, or evidence is
rejected. The same evidence hash, payment attempt, or refund operation cannot
be assigned to another batch.

Evidence references must point to access-controlled storage. Do not paste
bank account numbers, customer details, API keys, or full payment credentials
into the application.

## Deployment order

1. Apply Prisma migrations through
   `20260807060000_harden_payment_settlement_evidence`.
2. Deploy the server code.
3. Deploy the Shopify app configuration so `orders/create` is subscribed.
4. Set the three environment variables above.
5. Open `/app/payment-operations` and run the backfill safety inspection. Run
   the backfill only when it reports safe production targets; zero targets
   requires no write.
6. Confirm Production readiness has no payment-operation failures.
7. Complete the single-payment release verification below.

## Single-payment release verification

The initial public scope is KOMOJU credit card only. Keep unverified KOMOJU
convenience-store, Pay-easy, bank-transfer, Paidy, smartphone-payment, and
Korean-card methods disabled in Shopify until each method receives its own
operational verification.

Before the initial live charge, choose exactly one payout-evidence strategy.

### Strategy A: use an existing reconciled payout

Use this when a previous KOMOJU payout has already reached the bank and the
application has reconciled it to at least one captured payment attempt. This is
the preferred one-charge path. A separate current unsettled balance at least
equal to the maximum planned charge is still required; an old deposited payout
does not itself provide current refund funds.

### Strategy B: use the new charge for payout evidence

Use this only when no existing payout is available. Before starting, record
private evidence that KOMOJU is live, only one KOMOJU card integration is
enabled, capture is automatic, unverified asynchronous methods are disabled,
and the release can remain frozen until bank deposit and refund complete.
Also confirm that other unsettled KOMOJU funds at least equal to the planned
maximum charge will remain available after the payout. The probe will not
permit refund until the payout batch is reconciled directly to this payment
attempt.

For either strategy, one live charge is sufficient only when every preflight
confirmation is complete:

1. Start `/app/production-transaction-probe` only after every automatic
   preflight check passes. Record the strategy, maximum order total, private
   settings evidence with its SHA-256, and confirmed refund reserve. The
   reserve is mandatory for both strategies.
2. Buy one approved platform-direct product through Shopify Checkout and
   choose KOMOJU credit card.
3. Attach that new Shopify order to the probe and wait for the paid webhook,
   SellerOrder, shadow check, paid ledger, structured card evidence, and the
   exact captured `MarketplacePaymentAttempt` match to pass.
4. For Strategy A, use the already reconciled payout. For Strategy B, wait for the bank
   deposit and register the KOMOJU payout in `/app/payment-operations`,
   selecting this exact payment attempt. Do not refund before the probe says
   the payout evidence passed.
5. Immediately before refund, record fresh evidence that the current KOMOJU
   unsettled balance still covers the full planned charge. The probe does not
   enter the refund stage until this second confirmation passes.
6. Fully refund the same order to the original card from Shopify Admin.
7. Wait for the linked successful refund transaction and refund ledger checks
   to pass. The release-bound probe must finish as `PASSED`.

Do not change the Render commit, Shopify app version, Function, Validation,
policy version, or migration while this verification is in progress. A release
change invalidates the probe and can make another live charge necessary.

This verification proves only KOMOJU card for a platform-direct, single-seller
order. Enabling another provider or payment method requires separate evidence;
do not reuse the card result for asynchronous methods.

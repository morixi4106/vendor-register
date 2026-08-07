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
The batch is reconciled only when:

```text
gross - refunds - fees = net deposit
```

Evidence references must point to access-controlled storage. Do not paste
bank account numbers, customer details, API keys, or full payment credentials
into the application.

## Deployment order

1. Apply Prisma migration `20260806120000_add_payment_operations`.
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

For the initial scope, one live charge is sufficient:

1. Start `/app/production-transaction-probe` only after every automatic
   preflight check passes.
2. Buy one approved platform-direct product through Shopify Checkout and
   choose KOMOJU credit card.
3. Attach that new Shopify order to the probe and wait for the paid webhook,
   SellerOrder, shadow check, and paid ledger checks to pass.
4. Fully refund the same order to the original card from Shopify Admin.
5. Wait for the linked successful refund transaction and refund ledger checks
   to pass. The release-bound probe must finish as `PASSED`.
6. When KOMOJU later deposits that charge, record the payout and bank evidence
   from the same charge. Do not create a second payment only for payout proof.

This verification proves only KOMOJU card for a platform-direct, single-seller
order. Enabling another provider or payment method requires separate evidence;
do not reuse the card result for asynchronous methods.

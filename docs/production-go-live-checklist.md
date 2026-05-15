# Production go-live checklist

This project currently uses Shopify checkout as the customer payment surface, then records seller balances in the app ledger. Seller payouts are recorded as manual bank or Wise transfers after the real transfer is completed outside the app.

## 1. Shopify Payments

- In Shopify Admin, open Settings > Payments.
- Activate Shopify Payments for the production store.
- Connect the real business payout bank account.
- If using Wise as the receiving account, enter the Wise account details only if Shopify accepts that account type for the store's region and currency.
- Run a small live order and confirm the Shopify payout can reach the account.

The app cannot verify this bank account through code, so this remains a manual production check.

## 2. Stripe live mode

Use live Stripe keys only when the platform is ready to create live connected accounts.

Required Render environment variables:

```text
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_...
STRIPE_PLATFORM_FEE_BPS=1000
```

Important notes:

- Test Stripe objects and connected accounts cannot be used in live mode.
- After switching to live keys, recreate seller connected accounts from the app.
- Register both platform webhooks and Connect webhooks in live mode.
- The Connect webhook endpoint must listen to events on connected accounts.

## 3. Seller payout operation

Current seller payout flow:

1. Shopify order paid webhook credits the seller ledger.
2. Refund, cancellation, and dispute webhooks reduce or hold the seller ledger.
3. Admin creates a payout run from the app.
4. Admin approves the payout run.
5. Admin sends money externally by bank transfer or Wise.
6. Admin marks the payout run as paid and records the external transfer ID.

The app does not currently send money through Wise API. Do not mark a payout run as paid until the real external transfer is completed.

## 4. App checks

Open Shopify Admin > vendor-register > Production readiness.

The page checks:

- Stripe key mode is live.
- Stripe secret and publishable keys match the same mode.
- Stripe platform and Connect webhook secrets are present.
- Shopify app scopes are configured and granted.
- Active sellers have Stripe account records.
- Sampled seller connected accounts can be retrieved with the current Stripe key.
- Wise payout remains a manual external operation.

## 5. Live smoke test

Before public launch:

1. Create or approve one real seller.
2. Complete live seller payment settings if Stripe account records are still required.
3. Register one low-value product.
4. Place one low-value real order.
5. Confirm `orders/paid` creates a seller ledger credit.
6. Refund one order and confirm the ledger debit.
7. Cancel one order and confirm no double debit.
8. Create, approve, externally transfer, and mark paid one payout run.
9. Confirm the payout ledger balance decreases by the payout amount.
10. Confirm Shopify payout reaches the platform bank or Wise receiving account.

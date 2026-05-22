# Production go-live checklist

This project currently uses Shopify checkout as the customer payment surface, then records seller balances in the app ledger. Seller payouts are either recorded as manual bank/Wise transfers or executed through an admin-approved Wise API payout run.

## 1. Shopify Payments

- In Shopify Admin, open Settings > Payments.
- Activate Shopify Payments for the production store.
- Connect the real business payout bank account.
- If using Wise as the receiving account, enter the Wise account details only if Shopify accepts that account type for the store's region and currency.
- Run a small live order and confirm the Shopify payout can reach the account.

The app cannot verify this bank account through code, so this remains a manual production check.

## 2. Production mode environment

Required Render environment variables for the current production payment path:

```text
PAYMENT_PROVIDER=shopify_payments
SELLER_PAYOUT_PROVIDER=manual
```

Use `SELLER_PAYOUT_PROVIDER=wise` only after Wise sandbox transfer, funding failure, webhook duplication, and ledger idempotency tests pass.

For Wise payout mode, configure:

```text
WISE_API_TOKEN=...
WISE_PROFILE_ID=...
WISE_API_BASE_URL=https://api.wise-sandbox.com
WISE_WEBHOOK_SECRET=...
WISE_SOURCE_CURRENCY=JPY
```

For live Wise funding, also set this only after a low-value live transfer is approved:

```text
WISE_LIVE_TRANSFERS_ENABLED=true
```

## 3. Stripe live mode

Stripe Connect is optional / legacy for the current production mode. Use live Stripe keys only when the platform intentionally switches to live Stripe Connect direct charges or Connect payouts.

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
- Seller-side Stripe onboarding is removed from the current production UI.
- After switching back to Stripe Connect, re-add the onboarding/admin routes intentionally and recreate seller connected accounts from the app.
- Register both platform webhooks and Connect webhooks in live mode.
- The Connect webhook endpoint must listen to events on connected accounts.

## 4. Seller payout operation

Manual seller payout flow:

1. Shopify order paid webhook credits the seller ledger.
2. Refund, cancellation, and dispute webhooks reduce or hold the seller ledger.
3. Admin creates a payout run from the app.
4. Admin approves the payout run.
5. Admin sends money externally by bank transfer or Wise.
6. Admin marks the payout run as paid and records the external transfer ID.

Do not mark a payout run as paid until the real external transfer is completed.

Wise payout target flow:

1. Shopify order paid webhook credits the seller ledger.
2. Refund, cancellation, and dispute webhooks reduce or hold the seller ledger.
3. App creates or admin creates a payout run only after hold and threshold checks.
4. Admin approves the payout run.
5. App creates Wise quote, creates Wise transfer, and funds it from Wise balance.
6. App stores Wise transfer ID and status on the payout run.
7. Admin polling marks the run paid or failed. Add verified Wise webhook handling later if needed.
8. App creates `payout_paid` only after Wise completion.

Do not enable live Wise funding from an automatic job until sandbox and dry-run tests are complete.

## 5. App checks

Open Shopify Admin > vendor-register > Production readiness.

The page checks:

- `PAYMENT_PROVIDER` is `shopify_payments`.
- `SELLER_PAYOUT_PROVIDER` is `manual` or `wise`.
- Stripe Connect is optional / legacy unless explicitly enabled.
- Stripe live keys are not blockers for Shopify Payments + manual/Wise payout mode.
- Shopify app scopes are configured and granted.
- Active sellers have the payout records required by the selected payout provider.
- Wise API env is configured when `SELLER_PAYOUT_PROVIDER=wise`.

## 6. Live smoke test

Before public launch:

1. Create or approve one real seller.
2. Register or verify the seller's payout recipient if Wise mode is enabled.
3. Register one low-value product.
4. Place one low-value real order.
5. Confirm `orders/paid` creates a seller ledger credit.
6. Refund one order and confirm the ledger debit.
7. Cancel one order and confirm no double debit.
8. Create, approve, externally transfer, and mark paid one payout run.
9. Confirm the payout ledger balance decreases by the payout amount.
10. Confirm Shopify payout reaches the platform bank or Wise receiving account.

For Wise mode, replace step 8 with a sandbox Wise transfer first, then a low-value live transfer only after explicit approval.

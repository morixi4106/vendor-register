# Production go-live checklist

## Shopify app version release boundary

`npm run deploy` only creates an unreleased Shopify app version. It must not
change the active checkout Function by itself.

An unreleased app version is not installed into the production shop. Never
claim that the new Function was tested in the production shop before the app
version was released.

1. Test the new Function in a development store, including all four checkout
   probes: direct product allowed, blocked product rejected, global stop
   rejected and recovery allowed.
2. Run `npm run deploy` to create the production app version without releasing
   it.
3. Inspect the generated app version, Function extensions, requested scopes and
   handle. Record the version in `SHOPIFY_APP_VERSION`.
4. Apply the compatible Render commit and Prisma migrations. Keep the
   production storefront password protected.
5. Inspect all existing validations owned by this app before release. Record
   their IDs, `enabled`, `functionHandle` and `blockOnFailure` values. A
   validation already bound to the same handle may start using the new Function
   as soon as the app version is released.
6. Release the staged Shopify version explicitly with
   `npm run deploy:shopify:release`.
7. Approve any additional scopes in the production shop.
8. Create or update the validation in the disabled state.
9. Synchronize every product projection and the shop-level purchase control,
   then read them back.
10. Enable the validation and run the four production probes while the
    storefront remains password protected.
11. Save the Release Manifest and separate evidence for each production probe.
12. Run the low-value real payment and refund test only after all probes pass.

If a probe fails, disable the new validation, establish a Shopify-side sales
stop, and release the previous app version. Do not restore sales merely because
the prior app version was restored.

Do not use `--allow-deletes` in an ordinary release. Keep the previous Shopify
app version available for rollback until the post-release probes pass.

For a future incompatible Function change, prefer a new handle such as
`marketplace-purchase-control-v2`, create a disabled validation for it, then
switch after evidence review. Do not rename the current handle during an
ordinary maintenance release.

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
PRODUCTION_PROBE_SIGNING_SECRET=<dedicated random secret, 32+ characters>
SALE_ELIGIBILITY_WATCHDOG_TOKEN=<different random secret, 32+ characters>
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

Before opening the store, deploy the Shopify app configuration and approve the
updated access scopes. The runtime, webhooks, and direct Admin API requests use
Shopify API `2026-04`. If Render defines `SCOPES`, it must include the scopes in
`shopify.app.toml`, including `read_publications` and `write_publications`.

If the scheduled FX refresh endpoint is used, configure a unique random secret
of at least 32 characters and send it as a Bearer token:

```text
FX_REFRESH_WORKER_TOKEN=...
```

Apply production database migrations before serving the new release. Do not
make application startup responsible for migration:

1. Record a recoverable database backup or snapshot reference.
2. Run the pre-migration operational audit.
3. Run `prisma migrate deploy` from the protected
   `.github/workflows/production-migration.yml` workflow.
4. Run the post-migration audit and verify expected tables, constraints, and
   row counts.
5. Deploy the application only after the migration job succeeds.

The GitHub `production` environment must protect `PRODUCTION_DATABASE_URL` and
require an authorized reviewer. Perform and record a restore drill before first
release and after material schema or backup-provider changes.

### Independent Shopify watchdog

The GitHub `production` environment must also contain:

```text
SALE_ELIGIBILITY_WATCHDOG_TOKEN=<same value configured on Render>
SHOPIFY_WATCHDOG_SHOP_DOMAIN=<production-shop.myshopify.com>
SHOPIFY_WATCHDOG_CLIENT_ID=<independent watchdog app client ID>
SHOPIFY_WATCHDOG_CLIENT_SECRET=<independent watchdog app client secret>
SALE_ELIGIBILITY_WATCHDOG_ENABLED=true
```

The watchdog app must be separate from the main application and limited to
`read_products`, `read_publications`, and `write_publications`. The workflow
must acquire and validate a short-lived Admin API token on each run; do not
store a generated Admin token as a long-lived secret. Before go-live, perform a
controlled Render/DB outage drill and prove that the watchdog can set the
merchant-owned purchase veto, unpublish all products, and verify zero remaining
publications. Prove separately that an evidence-backed recovery clears the veto
only after eligibility and publications are reverified. Save the workflow run
and recovery approval under
`INDEPENDENT_SALES_STOP_DRILL_COMPLETED`. Repeat the drill at least every 90
days.

### Unsupported sales surfaces

Before go-live, confirm and record `UNSUPPORTED_SALES_SURFACES_DISABLED`:

- Shopify POS sales of governed products are disabled or operationally
  prohibited.
- Shopify Admin Create Order and post-order line editing have a documented
  review and quarantine procedure.
- Subscription, pre-order, try-before-you-buy, and unapproved external order
  creation apps are absent or disabled.
- `orders/edited` and `orders/updated` webhooks are active, and periodic
  canonical order reconciliation has a fresh successful heartbeat.

Orders are linked by the Shopify order GID. This codebase does not depend on the
removed `checkout_id` field; do not add a guessed checkout identifier fallback.

### Purchase-control migration and activation

The Cart and Checkout Validation Function is fail-closed. Do not enable it
until every active product has a current eligibility projection.

The Function enforces explicit `ALLOWED` / `BLOCKED` decisions and a day-level
hard validity boundary. Shopify Function input does not provide an arbitrary
current UTC timestamp for comparing a dynamic minute-level expiry. Minute-level
freshness is therefore enforced by the external catalog watchdog: after the
critical freshness limit it writes the shop control as `BLOCKED`, keeps the
validation active and applies the platform emergency purchase stop. The
watchdog never restores sales automatically.

1. Capture the pre-migration counts:

   ```text
   npm run audit:operational-migration
   ```

2. Apply the migrations and Render release. Follow **Shopify app version release
   boundary** above to release the Function while the storefront is password
   protected, then leave the validation rule disabled.
3. Capture the post-migration counts with the same audit command. Investigate
   missing eligibility decisions or projections before continuing.
4. Approve the `read_validations` and `write_validations` scopes.
5. In **Production readiness**, run **Prepare validation while disabled**.
   This stages exactly one disabled validation, backfills product projections,
   synchronizes the shop-level control, and verifies the disabled rule.
6. Record the successful development-store Function replay in
   `CHECKOUT_VALIDATION_REPLAY_COMPLETED`.
7. Run **Enable after evidence review**. Activation is refused while the
   replay evidence is missing or expired.
8. In the real production shop, test the four production scenarios with the
   storefront password protected and bind their evidence to the active app
   version, Render commit, migration, Function, validation and projection
   versions.
9. Confirm all of the following before accepting orders:
   - Exactly one `Marketplace purchase control` validation exists.
   - It is enabled with `blockOnFailure`.
   - Its error history is empty.
   - Every eligible product has a non-expired, versioned projection.
   - The operational purchase control is `ALLOWED`.

Never enable the rule manually before step 7. Missing, malformed, expired, or
unknown-version projection data intentionally blocks checkout.

### Emergency procedure A: restore valid orders after a Function failure

Use this only when the Validation Function itself is incorrectly blocking
otherwise valid orders and sales should continue:

1. Open **Settings > Checkout > Checkout rules**.
2. Open **Marketplace purchase control**.
3. Click **Turn off**.
4. Record the incident time, operator, reason, and evidence reference.
5. Confirm that no separate application, database, compliance or product-safety
   incident requires sales to remain stopped.
6. Repair and replay the Function before reactivation.

Turning off this rule restores checkout; it is not a sales-stop operation.

### Emergency procedure B: stop sales while the app or database is unavailable

Do not turn off the Validation Function merely because the app is unavailable.
Keep the fail-closed rule enabled and independently stop sales in Shopify:

1. Enable Online Store password protection when the whole store must stop.
2. Set affected products to draft or unpublish them from every sales channel.
3. Disable affected Markets, shipping zones or delivery availability when the
   incident is country or route specific.
4. Verify from a private browser that checkout cannot complete.
5. Record the incident time, operator, affected scope and evidence reference.
6. Restore sales only after a different operator approves recovery and the
   application readiness page is green again.

If the Function is also malfunctioning, first establish the Shopify sales stop
above, and only then turn off the broken Checkout Rule.

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
